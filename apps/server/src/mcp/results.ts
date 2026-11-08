import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Public failures are deliberately authored here or at a checked preflight;
 * dependency errors can contain credentials, SQL, paths or provider output. */
export class McpToolError extends Error {
  readonly code:
    | "invalid_request"
    | "not_found"
    | "conflict"
    | "unavailable"
    | "capacity"
    | "cancelled";
  readonly nextAction: string;
  constructor(
    code: "invalid_request" | "not_found" | "conflict" | "unavailable" | "capacity" | "cancelled",
    message: string,
    nextAction = "Correct the request or inspect the current state before trying another action.",
  ) {
    super(message);
    this.code = code;
    this.nextAction = nextAction;
  }
}

/** MCP clients differ in whether structuredContent reaches the model. Keep
 * actionable data identical in the JSON text fallback (MCP 2025-06-18 tools). */
export function jsonToolResult<T extends Record<string, unknown>>(value: T): CallToolResult {
  return { structuredContent: value, content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function normalizeToolResult(result: CallToolResult): CallToolResult {
  if (!result.structuredContent) return result;
  const text = JSON.stringify(result.structuredContent);
  if (Buffer.byteLength(text, "utf8") > 4_194_304)
    throw new McpToolError(
      "capacity",
      "The complete response exceeds the management size limit.",
      "Use a smaller discovery page, omit model options, or request fewer messages.",
    );
  return {
    ...result,
    content: [{ type: "text", text }, ...result.content.filter((entry) => entry.type !== "text")],
  };
}

export function toolFailure(error: unknown, mayHaveApplied = false): CallToolResult {
  const known = error instanceof McpToolError;
  const value = {
    error: {
      code: known ? error.code : "unavailable",
      message: known ? error.message : "Cafe management could not complete the request.",
      nextAction: known
        ? error.nextAction
        : "Read the current state; do not automatically repeat an uncertain action.",
      mayHaveApplied,
    },
  };
  return {
    isError: true,
    ...jsonToolResult(value),
  };
}
