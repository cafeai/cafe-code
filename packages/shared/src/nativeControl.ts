import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import catalog from "../../../native/cua-driver/catalog.json" with { type: "json" };
import release from "../../../native/cua-driver/release.json" with { type: "json" };

export const NATIVE_CONTROL_HOST_FILE = "native-control-host.json";
export const NATIVE_CONTROL_PATH = "/mcp/native-control";
export const NATIVE_CONTROL_AUDIENCE = "cafe-native-control";
export const NATIVE_CONTROL_VERSION = release.version;
export const NATIVE_CONTROL_SOURCE_COMMIT = release.sourceCommit;
export const NATIVE_CONTROL_ENVIRONMENT = Object.freeze({
  CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
  CUA_TELEMETRY_ENABLED: "0",
  CUA_TELEMETRY: "0",
  DO_NOT_TRACK: "1",
  CUA_DRIVER_RS_UPDATE_CHECK: "false",
  CUA_DRIVER_DISABLE_UNRESTRICTED: "1",
});

export interface NativeToolResult {
  readonly content: readonly Record<string, unknown>[];
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}
export const nativeControlError = (message: string): NativeToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

export const NATIVE_CONTROL_TOOLS = [
  {
    name: "health",
    description:
      "Check native desktop permissions and controller health before using desktop tools.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  ...catalog.tools,
  {
    name: "release_control",
    description:
      "Release desktop control after finishing a task so another Cafe conversation can use it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
] as const;
const names = new Set<string>(NATIVE_CONTROL_TOOLS.map((tool) => tool.name));
const reserved = new Set([
  "session",
  "session_id",
  "screenshot_out_file",
  "output_file",
  "_meta",
  "__proto__",
  "constructor",
  "prototype",
]);

export function validateNativeToolCall(name: unknown, input: unknown): Record<string, unknown> {
  if (
    typeof name !== "string" ||
    !names.has(name) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  )
    throw new Error("Unsupported native desktop tool or arguments.");
  const visit = (value: unknown, depth: number): void => {
    if (depth > 24) throw new Error("Native desktop arguments are too deeply nested.");
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (reserved.has(key))
          throw new Error("Native desktop transport and file-output arguments are reserved.");
        visit(item, depth + 1);
      }
  };
  visit(input, 0);
  if (JSON.stringify(input).length > 128 * 1024)
    throw new Error("Native desktop arguments are too large.");
  return input as Record<string, unknown>;
}

export interface NativeControlHostConnection {
  readonly generation: string;
  readonly url: string;
  readonly token: string;
}

export async function readNativeControlHost(
  path: string,
): Promise<NativeControlHostConnection | undefined> {
  const file = await fs
    .open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    .catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return undefined;
      throw new Error("The private desktop control connection is unavailable.");
    });
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 16 * 1024 ||
      (process.platform !== "win32" &&
        (stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0))
    )
      throw new Error("Invalid private desktop control connection.");
    const bytes = Buffer.alloc(16 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 16 * 1024) throw new Error("Invalid private desktop control connection.");
    const value = JSON.parse(
      bytes.subarray(0, bytesRead).toString("utf8"),
    ) as NativeControlHostConnection;
    const url = new URL(value.url);
    if (
      !/^[a-f0-9-]{36}$/u.test(value.generation) ||
      !/^[a-f0-9]{64}$/u.test(value.token) ||
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/native-control" ||
      !url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid private desktop control connection.");
    return value;
  } finally {
    await file.close();
  }
}

export async function requestNativeControlHost(
  connection: NativeControlHostConnection,
  operation: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${connection.url}/${operation}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${connection.token}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("The local desktop control host is unavailable.");
  }
  const result = await response.json();
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid desktop control host response.");
  return result as Record<string, unknown>;
}

export const nativeControlTokenDigest = (token: string) =>
  createHash("sha256").update("cafe-native-control-v1\0").update(token).digest("hex");

export function isNativeControlServer(name: string): boolean {
  return /^cafe-native-[A-Za-z0-9_-]{22}$/u.test(name);
}

/** Redact Cafe-owned Claude tool payloads before native logging or projection.
 * The provider's own model exchange already consumed its unmodified message. */
export class NativeDesktopPrivacy {
  private readonly toolIds = new Set<string>();
  private readonly streamIndexes = new Set<number>();
  private overflow = false;
  redact<T>(value: T): T {
    const walk = (item: unknown, depth: number): unknown => {
      if (depth > 32) return "[Desktop payload omitted]";
      if (Array.isArray(item)) return item.map((entry) => walk(entry, depth + 1));
      if (!item || typeof item !== "object") return item;
      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "";
      if (record.type === "tool_use" && /^mcp__cafe-native-[A-Za-z0-9_-]{22}__/u.test(name)) {
        if (typeof record.id === "string") {
          if (this.toolIds.size < 4096) this.toolIds.add(record.id);
          else this.overflow = true;
        }
        return { ...record, input: {} };
      }
      if (
        record.type === "tool_result" &&
        typeof record.tool_use_id === "string" &&
        (this.overflow || this.toolIds.has(record.tool_use_id))
      )
        return { ...record, content: "[Native desktop result]" };
      if (record.type === "content_block_start" && typeof record.index === "number") {
        const block = record.content_block as Record<string, unknown> | undefined;
        if (
          typeof block?.name === "string" &&
          /^mcp__cafe-native-[A-Za-z0-9_-]{22}__/u.test(block.name)
        )
          this.streamIndexes.add(record.index);
        else this.streamIndexes.delete(record.index);
      }
      if (
        record.type === "content_block_delta" &&
        typeof record.index === "number" &&
        this.streamIndexes.has(record.index)
      )
        return { ...record, delta: { type: "input_json_delta", partial_json: "" } };
      if (record.type === "content_block_stop" && typeof record.index === "number")
        this.streamIndexes.delete(record.index);
      return Object.fromEntries(
        Object.entries(record).map(([key, entry]) => [key, walk(entry, depth + 1)]),
      );
    };
    return walk(value, 0) as T;
  }
}
