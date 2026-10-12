import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  VISUALIZATION_HOST_FILE,
  VISUALIZATION_HOST_MAX_BODY_BYTES,
  VISUALIZATION_HOST_PATH,
  VisualizationHostConnection,
  type VisualizationHostConnection as Connection,
} from "@cafecode/contracts/visualizationHost";

const decodeConnection = Schema.decodeUnknownResult(VisualizationHostConnection);

/** Response shape work is bounded before JSON.parse, even for a compromised local peer. */
function boundedJson(text: string): boolean {
  let depth = 0;
  let tokens = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') {
      quoted = true;
      tokens += 1;
    } else if (character === "{" || character === "[") {
      depth += 1;
      tokens += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      tokens += 1;
    } else if (character === "," || character === ":") tokens += 1;
    if (depth < 0 || depth > 16 || tokens > 4096) return false;
  }
  return !quoted && depth === 0;
}

/** Read only the exact private main-owned capability, never a symlink or ambient URL. */
export async function readVisualizationHost(stateDirectory: string): Promise<Connection | null> {
  let handle: fs.FileHandle | undefined;
  try {
    const path = join(stateDirectory, VISUALIZATION_HOST_FILE);
    const before = await fs.lstat(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > 1024 ||
      (process.platform !== "win32" &&
        (before.uid !== process.getuid!() || (before.mode & 0o077) !== 0))
    )
      return null;
    handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      opened.size > 1024
    )
      return null;
    const bytes = Buffer.alloc(1025);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1024) return null;
    const after = await fs.lstat(path);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.isSymbolicLink()) return null;
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    if (!boundedJson(text)) return null;
    const value = decodeConnection(JSON.parse(text));
    if (Result.isFailure(value)) return null;
    const url = new URL(value.success.url);
    if (url.port === "" || Number(url.port) > 65535) return null;
    return value.success;
  } catch {
    // Paths, credentials and received bytes never become diagnostic messages.
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Strictly local authenticated broker transport with bounded response copies and no redirects. */
export async function requestVisualizationHost(
  connection: Connection,
  method: "preview" | "prepareViewer" | "inspectViewer" | "revoke",
  payload: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const admitted = decodeConnection(connection);
  if (Result.isFailure(admitted) || Number(new URL(connection.url).port) > 65535)
    throw new Error("Visualization host is unavailable.");
  const body = JSON.stringify({ generation: connection.generation, method, payload });
  if (Buffer.byteLength(body, "utf8") > VISUALIZATION_HOST_MAX_BODY_BYTES)
    throw new Error("Visualization host request was refused.");
  const response = await fetch(connection.url, {
    method: "POST",
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(25_000)])
      : AbortSignal.timeout(25_000),
    headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
    body,
  });
  if (!response.ok || new URL(response.url).pathname !== VISUALIZATION_HOST_PATH || !response.body)
    throw new Error("Visualization host request was refused.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 24 * 1024 * 1024 || chunks.length >= 2048)
        throw new Error("Visualization host response was refused.");
      chunks.push(item.value);
    }
    const text = Buffer.concat(chunks, size).toString("utf8");
    if (!boundedJson(text)) throw new Error("Visualization host response was refused.");
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Visualization host response was refused.");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
