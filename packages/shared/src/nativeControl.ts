import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import catalog from "../../../native/cua-driver/catalog.json" with { type: "json" };
import release from "../../../native/cua-driver/release.json" with { type: "json" };
import { COMPUTER_CONTROL_TOOLS, validateComputerCall } from "./nativeComputer.ts";
export {
  decodeComputerSelect,
  decodeComputerObserve,
  decodeComputerAct,
  decodeComputerAdvanced,
  type ComputerSelect,
  type ComputerObserve,
  type ComputerAct,
  type ComputerAction,
} from "./nativeComputer.ts";

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

export const NATIVE_CONTROL_INSTRUCTIONS =
  "Enable this chat's Computer use control, check health, and finish with release_control. Bind the requested app with computer_select, then reuse its target handle with computer_observe and computer_act. Batch short predictable actions; each batch returns updated state. Use fresh element handles, or request view:both before screenshot-coordinate input. Accessibility-only observations clear pixel grounding. Cafe handles exact-window routing and definite before-input foreground recovery, which may change focus. Never repeat uncertain or partial input; inspect returned state first. Stable state does not prove task success: verify the requested result. Use open_url for the user's signed-in browser and computer_select with browser:true for supported DOM control. computer_advanced discovers uncommon reviewed operations on demand. Handles expire on release; select again during an active turn. No sleeps or repeated unchanged reads are needed.";

/** Defaults reduce image and tree tokens while callers retain explicit control
 * over capture/limits. Search traversal and response size are separate: a
 * narrow query must not miss a late control merely to save response tokens. */
export function nativeToolArguments(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (name === "get_window_state")
    return {
      include_screenshot: args.include_accessibility_tree === false,
      max_elements: typeof args.query === "string" ? 4000 : 2000,
      max_depth: 25,
      timeout_ms: typeof args.query === "string" ? 3000 : 1000,
      max_image_dimension: 1280,
      ...args,
    };
  if (name === "get_desktop_state") return { max_image_dimension: 1280, ...args };
  if (name === "get_browser_state")
    return { snapshot_format: "semantic_v2", include_screenshot: false, ...args };
  if (name === "verify_state") return { include_screenshot: false, ...args };
  return args;
}

/** MCP consumers must receive structured element tokens, browser refs and
 * window records in text content as well. Cua's count-only list text and AX
 * Markdown otherwise hide these fields from content-only clients. Emit one
 * JSON representation instead of duplicate Markdown/structured payloads,
 * preserving capture images and every machine-readable refusal/route field. */
export function compactNativeToolResult(result: NativeToolResult): NativeToolResult {
  if (result.isError || !result.structuredContent) return result;
  const {
    tree_markdown: _duplicateTree,
    _note: _duplicateNote,
    ...structured
  } = result.structuredContent;
  return {
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    content: [
      { type: "text", text: JSON.stringify(structured) },
      ...result.content.filter((part) => part.type !== "text"),
    ],
  };
}

export interface NativeToolResult {
  readonly content: readonly Record<string, unknown>[];
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}
export const nativeControlError = (message: string): NativeToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

// Cafe owns these conveniences. Generate upstream schemas without modifying
// them, then apply the same overrides at publication after every Cua upgrade.
function cafeNativeTool(tool: (typeof catalog.tools)[number]) {
  const inputSchema = structuredClone(tool.inputSchema);
  const properties = inputSchema.properties as Record<string, unknown>;
  if (
    ("delivery_mode" in properties || tool.name === "set_value") &&
    !tool.name.startsWith("browser_")
  ) {
    if ("delivery_mode" in properties) {
      properties.delivery_mode = {
        type: "string",
        enum: ["background", "foreground"],
        description:
          "Default background. Cafe retries definite targeting refusals in foreground, which can change focus. Set auto_foreground:false to keep background-only delivery.",
      };
      properties.auto_foreground = {
        type: "boolean",
        default: true,
        description:
          "Automatically use foreground delivery after a definite background targeting refusal. Never repeats an input with uncertain completion.",
      };
    }
    properties.observe_after = {
      type: "boolean",
      description:
        "Return a fresh compact window observation after this action, saving a separate read. Default true after automatic foreground fallback, false otherwise. New snapshots replace prior element tokens.",
    };
    properties.observe_query = {
      type: "string",
      description:
        "Optional text filter for observe_after. Searches broadly and returns matching elements with fresh tokens.",
    };
    properties.observe_screenshot = {
      type: "boolean",
      description:
        "Return a new screenshot with the observation. Coordinate input includes it automatically so later pixel actions have fresh grounding.",
    };
  }
  if (
    [
      "browser_click",
      "browser_type",
      "browser_pointer",
      "browser_navigate",
      "browser_set_input_files",
    ].includes(tool.name)
  ) {
    properties.observe_after = {
      type: "boolean",
      default: true,
      description:
        "Default true. Return a fresh semantic DOM observation of this exact tab after the action, including new refs. Set false to omit it.",
    };
    properties.observe_query = {
      type: "string",
      description: "Optional semantic text filter for the returned DOM observation.",
    };
  }
  if (tool.name === "get_browser_state") {
    properties.snapshot_format = {
      type: "string",
      enum: ["dom_refs_v1", "semantic_v2"],
      default: "semantic_v2",
      description:
        "Default semantic_v2: compact actionable refs and visible content. dom_refs_v1 is available for compatibility.",
    };
    properties.include_page_state = {
      type: "boolean",
      default: true,
      description:
        "In pid/window bind mode, include a semantic snapshot of the uniquely active tab. Default true. Set false to return only the binding and tab list.",
    };
  }
  if (tool.name === "get_window_state") {
    properties.include_screenshot = {
      type: "boolean",
      default: false,
      description:
        "Default false. Request true for a window screenshot to ground pixel actions. Defaults true when include_accessibility_tree:false.",
    };
    properties.max_elements = {
      type: "integer",
      minimum: 1,
      description:
        "AX traversal budget, independent of max_results. Default 4000 with query, 2000 otherwise. Query filters after traversal; raise this if search_truncated is true.",
    };
    properties.max_depth = {
      type: "integer",
      minimum: 1,
      default: 25,
      description: "AX traversal depth limit. Default 25.",
    };
    properties.max_results = {
      type: "integer",
      minimum: 1,
      maximum: 2000,
      default: 200,
      description:
        "Maximum elements returned; does not limit the AX search. Default 200. Increase when output_truncated is true.",
    };
    properties.timeout_ms = {
      type: "integer",
      minimum: 100,
      maximum: 120000,
      description: "AX walk budget in milliseconds. Default 3000 with query, 1000 otherwise.",
    };
    properties.window_id = {
      type: "integer",
      description:
        "Exact window ID. Omit to select a usable main window for pid; the result reports the selected window.",
    };
    inputSchema.required = ["pid"];
  }
  if (tool.name === "list_windows" || tool.name === "launch_app") {
    properties.max_windows = {
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 8,
      description:
        "Maximum window records returned. Default 8; total_window_count and windows_truncated describe omissions.",
    };
    properties.include_auxiliary_windows = {
      type: "boolean",
      default: false,
      description:
        "Include tiny preview, menu and completion windows. Default false; recommended_window favors a usable main window.",
    };
  }
  if (tool.name === "list_windows")
    properties.query = {
      type: "string",
      description: "Filter window titles and app names before limiting the returned records.",
    };
  return { ...tool, inputSchema };
}

export const NATIVE_CONTROL_TOOLS = [
  ...COMPUTER_CONTROL_TOOLS,
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
  ...catalog.tools.map(cafeNativeTool),
  {
    name: "open_url",
    description:
      "Open a web URL in the user's existing browser and return its exact window plus a fresh compact page observation. Handles window selection, native address-bar navigation and verification in one call. Prefer over launch_app urls or manual shortcuts for signed-in sites. Uses foreground input and can change focus. Specify pid/window_id or bundle_id when the browser is known; otherwise selects a running browser, falling back to Safari.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", description: "Absolute http or https URL." },
        pid: {
          type: "integer",
          minimum: 1,
          description: "Existing browser process. Takes precedence over bundle_id.",
        },
        window_id: {
          type: "integer",
          minimum: 1,
          description:
            "Exact browser window; requires pid. Otherwise selects a usable main window.",
        },
        bundle_id: {
          type: "string",
          description:
            "Browser bundle ID, e.g. com.kagi.kagimacOS or com.apple.Safari. Launches it if needed.",
        },
        target_id: {
          type: "string",
          description:
            "Prepared DOM browser target from get_browser_state. Requires tab_id; navigates that exact tab without native keyboard input.",
        },
        tab_id: {
          type: "string",
          description:
            "Exact tab on target_id. When supplied, open_url navigates this tab; omit new_tab or set false.",
        },
        new_tab: {
          type: "boolean",
          default: true,
          description: "Default true: open a new tab. False navigates the selected tab.",
        },
        query: {
          type: "string",
          description:
            "Optional text filter for the returned page observation, e.g. Account menu or subscribers.",
        },
        include_screenshot: {
          type: "boolean",
          default: false,
          description: "Include a window screenshot with the returned observation.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 2000,
          default: 200,
          description: "Maximum native AX elements in the returned page observation.",
        },
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
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
const defaultNames = new Set([
  "health",
  "computer_select",
  "computer_observe",
  "computer_act",
  "computer_advanced",
  "open_url",
  "release_control",
]);
export const NATIVE_CONTROL_DEFAULT_TOOLS = NATIVE_CONTROL_TOOLS.filter((tool) =>
  defaultNames.has(tool.name),
);
export const NATIVE_CONTROL_ADVANCED_TOOLS = NATIVE_CONTROL_TOOLS.filter(
  (tool) => !defaultNames.has(tool.name),
);
const names = new Set<string>(NATIVE_CONTROL_TOOLS.map((tool) => tool.name));
const reserved = new Set([
  "session",
  "session_id",
  "cursor_id",
  "debug_image_out",
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
        if (reserved.has(key) || key.startsWith("_"))
          throw new Error("Native desktop transport and file-output arguments are reserved.");
        visit(item, depth + 1);
      }
  };
  visit(input, 0);
  if (JSON.stringify(input).length > 128 * 1024)
    throw new Error("Native desktop arguments are too large.");
  validateComputerCall(name, input);
  if (name === "computer_advanced") {
    const args = input as Record<string, unknown>;
    if (args.operation === "call") {
      if (!NATIVE_CONTROL_ADVANCED_TOOLS.some((tool) => tool.name === args.name))
        throw new Error("Unsupported advanced computer operation.");
      validateNativeToolCall(args.name, args.arguments ?? {});
    }
  }
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
