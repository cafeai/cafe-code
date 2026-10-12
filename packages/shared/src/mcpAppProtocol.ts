import {
  MCP_APP_MAX_CONTEXT_BYTES,
  MCP_APP_MAX_MESSAGE_BYTES,
  MCP_APP_PROTOCOL_VERSION,
  type McpAppPreviewReplay,
} from "@cafecode/contracts/mcpApps";

export type McpAppRequestId = string | number;
export interface McpAppRequest {
  readonly jsonrpc: "2.0";
  readonly id?: McpAppRequestId;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export const ownRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export { encodeBoundedMcpAppJson, readBoundedMcpAppJson } from "./mcpAppJson.ts";
import { encodeBoundedMcpAppJson, readBoundedMcpAppJson } from "./mcpAppJson.ts";

/** Check the real wire messages, not only their bare original objects. Envelope
 * nesting and punctuation consume the same finite native parsing allowance.
 * Unsupported originals fail before capture/publication rather than yielding a
 * ready-looking App whose required initial data cannot reach its document. */
export function encodeMcpAppReplay(
  originalInputJson: string,
  originalResultJson: string,
): readonly [string, string] | undefined {
  const input = readBoundedMcpAppJson(originalInputJson, MCP_APP_MAX_MESSAGE_BYTES - 1024);
  const result = readBoundedMcpAppJson(originalResultJson, MCP_APP_MAX_MESSAGE_BYTES - 1024);
  if (!input.ok || !ownRecord(input.value) || !result.ok || !ownRecord(result.value))
    return undefined;
  const inputMessage = encodeBoundedMcpAppJson({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-input",
    params: { arguments: input.value },
  });
  const resultMessage = encodeBoundedMcpAppJson({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: result.value,
  });
  return inputMessage && resultMessage ? [inputMessage, resultMessage] : undefined;
}

export function readMcpAppRequest(text: unknown): McpAppRequest | undefined {
  const parsed = readBoundedMcpAppJson(text);
  const value = parsed.ok ? ownRecord(parsed.value) : undefined;
  if (
    !value ||
    value.jsonrpc !== "2.0" ||
    typeof value.method !== "string" ||
    value.method.length > 100 ||
    Object.keys(value).some((key) => !["jsonrpc", "id", "method", "params"].includes(key)) ||
    ("id" in value &&
      !(
        (typeof value.id === "string" && value.id.length > 0 && value.id.length <= 128) ||
        (typeof value.id === "number" && Number.isSafeInteger(value.id))
      )) ||
    ("params" in value && !ownRecord(value.params))
  )
    return undefined;
  return value as unknown as McpAppRequest;
}

export const mcpAppSuccess = (id: McpAppRequestId, result: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id, result });
export const mcpAppFailure = (
  id: McpAppRequestId | null,
  code: -32600 | -32601 | -32602 | -32000,
  message:
    | "Invalid request"
    | "Unsupported method"
    | "Invalid parameters"
    | "Operation unavailable",
): string => JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

export type McpAppProtocolOutcome =
  | { readonly kind: "messages"; readonly messages: readonly string[] }
  | { readonly kind: "operation"; readonly request: McpAppRequest }
  | {
      readonly kind: "display";
      readonly id: McpAppRequestId;
      readonly mode: "inline" | "fullscreen";
    };

/**
 * Stable MCP Apps 2026-01-26 lifecycle. It never calls tools or grants consent.
 * Data replay is once per instance, after initialized, and in input/result order.
 * Bind one instance to an actual native document generation in the backend.
 * Reference: modelcontextprotocol/ext-apps specification/2026-01-26/apps.mdx.
 */
export class McpAppProtocolSession {
  private phase: "new" | "initializing" | "ready" | "closed" = "new";
  private replayed = false;
  private messages = 0;
  private displayModes: readonly ("inline" | "fullscreen")[] = ["inline"];
  private originalReplay: readonly [string, string] | undefined;
  private readonly context: Readonly<Record<string, unknown>>;
  private readonly preview: boolean;

  constructor(
    context: Readonly<Record<string, unknown>>,
    originalInputJson: string,
    originalResultJson: string,
    options: { readonly preview?: boolean } = {},
  ) {
    this.context = context;
    this.preview = options.preview === true;
    this.originalReplay = encodeMcpAppReplay(originalInputJson, originalResultJson);
    if (!this.originalReplay) this.phase = "closed";
  }

  receive(text: string): McpAppProtocolOutcome {
    // Per-document finite envelope count is independent from native rate limits.
    // Retirement, not an invisible fresh instance, is required on exhaustion.
    this.messages += 1;
    const request = readMcpAppRequest(text);
    const fail = (
      code: -32600 | -32601 | -32602 | -32000,
      message:
        | "Invalid request"
        | "Unsupported method"
        | "Invalid parameters"
        | "Operation unavailable",
    ): McpAppProtocolOutcome => ({
      kind: "messages",
      messages: request?.id === undefined ? [] : [mcpAppFailure(request.id, code, message)],
    });
    if (!request)
      return { kind: "messages", messages: [mcpAppFailure(null, -32600, "Invalid request")] };
    if (this.phase === "closed" || this.messages > 2048) {
      this.phase = "closed";
      return fail(-32000, "Operation unavailable");
    }
    if (request.method === "ui/initialize") {
      if (this.phase !== "new" || request.id === undefined)
        return fail(-32000, "Operation unavailable");
      const params = request.params;
      if (
        params?.protocolVersion !== MCP_APP_PROTOCOL_VERSION ||
        !ownRecord(params.appCapabilities) ||
        !ownRecord(params.appInfo)
      )
        return fail(-32602, "Invalid parameters");
      const capabilities = ownRecord(params.appCapabilities)!;
      const modes = capabilities.availableDisplayModes;
      if (
        modes !== undefined &&
        (!Array.isArray(modes) ||
          modes.length > 3 ||
          modes.some((mode) => !["inline", "fullscreen", "pip"].includes(mode)))
      )
        return fail(-32602, "Invalid parameters");
      this.displayModes =
        modes === undefined
          ? ["inline"]
          : modes.filter(
              (mode): mode is "inline" | "fullscreen" => mode === "inline" || mode === "fullscreen",
            );
      this.phase = "initializing";
      return {
        kind: "messages",
        messages: [
          mcpAppSuccess(request.id, {
            protocolVersion: MCP_APP_PROTOCOL_VERSION,
            hostInfo: { name: "Cafe Code", version: "1" },
            hostCapabilities: {
              ...(this.preview ? {} : { openLinks: {}, serverTools: {}, serverResources: {} }),
              sandbox: {
                permissions: {},
                csp: {
                  connectDomains: [],
                  resourceDomains: [],
                  frameDomains: [],
                  baseUriDomains: [],
                },
              },
            },
            hostContext: this.context,
          }),
        ],
      };
    }
    if (request.method === "ui/notifications/initialized") {
      if (request.id !== undefined || this.phase !== "initializing" || this.replayed)
        return fail(-32000, "Operation unavailable");
      if (!this.originalReplay) return fail(-32000, "Operation unavailable");
      const messages = this.originalReplay;
      this.originalReplay = undefined;
      this.phase = "ready";
      this.replayed = true;
      return {
        kind: "messages",
        messages,
      };
    }
    if (this.phase !== "ready") return fail(-32000, "Operation unavailable");
    if (request.method === "ping" && request.id !== undefined)
      return { kind: "messages", messages: [mcpAppSuccess(request.id, {})] };
    // Poster generation replays exact data only. It can neither acquire fresh
    // provider/server authority nor move a native view, send a chat or open a
    // link as a side effect of automatic publication capture.
    if (this.preview) return fail(-32000, "Operation unavailable");
    if (request.method === "ui/request-display-mode" && request.id !== undefined) {
      const mode = request.params?.mode;
      return (mode === "inline" || mode === "fullscreen") && this.displayModes.includes(mode)
        ? { kind: "display", id: request.id, mode }
        : fail(-32602, "Invalid parameters");
    }
    if (request.method === "ui/notifications/size-changed" && request.id === undefined) {
      // Native geometry remains trusted-owner clamped. Never interpret page
      // dimensions as a native window capability or allow arbitrary bounds.
      return { kind: "messages", messages: [] };
    }
    if (request.method === "notifications/message" && request.id === undefined)
      return { kind: "messages", messages: [] }; // Private page logs stay private.
    if (
      request.id !== undefined &&
      [
        "tools/call",
        "resources/read",
        "ui/message",
        "ui/update-model-context",
        "ui/open-link",
      ].includes(request.method)
    )
      return { kind: "operation", request };
    // Draft downloads/request-teardown and arbitrary management methods are not
    // advertised. Refuse explicitly instead of returning success-shaped stubs.
    return fail(-32601, "Unsupported method");
  }

  contextChanged(context: Readonly<Record<string, unknown>>): string | undefined {
    return this.phase === "ready"
      ? JSON.stringify({
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: context,
        })
      : undefined;
  }

  close(): void {
    this.phase = "closed";
    this.originalReplay = undefined;
  }

  get initialized(): boolean {
    return this.phase === "ready" && this.replayed;
  }
}

/** Complete data-only protocol for private App poster capture. It has no action
 * outcome or broker callback. A native owner must still observe replay/render
 * and retire the exact page before publishing capture bytes. */
export class McpAppPreviewProtocol {
  private readonly session: McpAppProtocolSession;
  constructor(replay: McpAppPreviewReplay) {
    this.session = new McpAppProtocolSession(
      {},
      replay.originalInputJson,
      replay.originalResultJson,
      { preview: true },
    );
  }
  receive(json: string): readonly string[] {
    const result = this.session.receive(json);
    return result.kind === "messages" ? result.messages : [];
  }
  get initialized(): boolean {
    return this.session.initialized;
  }
  close(): void {
    this.session.close();
  }
}

/** Credential-free exact destinations; no protocol-relative/file/data/LAN proxy. */
export function admittedMcpAppLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048 || /\s/u.test(value)) return undefined;
  // Refuse exact received C0/C1 controls; never normalize a private destination.
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return undefined;
  }
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function readMcpAppContext(params: unknown): string | undefined {
  const value = ownRecord(params);
  if (!value || Object.keys(value).some((key) => !["content", "structuredContent"].includes(key)))
    return undefined;
  if (value.content !== undefined && (!Array.isArray(value.content) || value.content.length > 32))
    return undefined;
  if (
    Array.isArray(value.content) &&
    value.content.some((block) => {
      const item = ownRecord(block);
      return (
        !item ||
        item.type !== "text" ||
        typeof item.text !== "string" ||
        Object.keys(item).some((key) => !["type", "text"].includes(key))
      );
    })
  )
    return undefined;
  if (value.structuredContent !== undefined && !ownRecord(value.structuredContent))
    return undefined;
  const json = JSON.stringify(value);
  return readBoundedMcpAppJson(json, MCP_APP_MAX_CONTEXT_BYTES).ok ? json : undefined;
}
