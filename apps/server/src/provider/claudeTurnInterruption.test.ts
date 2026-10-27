import type { SDKResultError } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { isClaudeStoppedExecutionResult } from "./claudeTurnInterruption.ts";

const result: SDKResultError = {
  type: "result",
  subtype: "error_during_execution",
  is_error: true,
  errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
  stop_reason: "tool_use",
  duration_ms: 1,
  duration_api_ms: 1,
  num_turns: 1,
  total_cost_usd: 0,
  usage: {
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    inference_geo: "global",
    input_tokens: 0,
    iterations: [],
    output_tokens: 0,
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: "standard",
    speed: "standard",
  },
  modelUsage: {},
  permission_denials: [],
  session_id: "00000000-0000-4000-8000-000000000001",
  uuid: "00000000-0000-4000-8000-000000000002",
};

describe("Claude's diagnostic-only Stop result", () => {
  it.each([null, "tool_use"])("recognizes accepted Stop during %s", (stopReason) => {
    expect(
      isClaudeStoppedExecutionResult(
        {
          ...result,
          stop_reason: stopReason,
          errors: [
            `[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=${stopReason}`,
          ],
        },
        true,
        false,
      ),
    ).toBe(true);
  });

  it("requires accepted Stop and no primary error", () => {
    expect(isClaudeStoppedExecutionResult(result, false, false)).toBe(false);
    expect(isClaudeStoppedExecutionResult(result, true, true)).toBe(false);
  });

  it.each<Partial<SDKResultError>>([
    { errors: [...result.errors, "Actual tool execution failure"] },
    { errors: ["Actual tool execution failure", ...result.errors] },
    { errors: [] },
    { errors: ["[ede_diagnostic] Actual tool execution failure"] },
    {
      errors: ["[ede_diagnostic] result_type=assistant last_content_type=n/a stop_reason=tool_use"],
    },
    { errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"] },
    { errors: [`${result.errors[0]}\nActual tool execution failure`] },
    { stop_reason: "end_turn" },
    { is_error: false },
    { subtype: "error_max_turns" },
    { terminal_reason: "api_error" },
    { terminal_reason: "turn_setup_failed" },
  ])("preserves a real or unrecognized failure: %j", (override) => {
    expect(isClaudeStoppedExecutionResult({ ...result, ...override }, true, false)).toBe(false);
  });

  it.each([401, 429, 529, null, "unknown"])("preserves reported API status %j", (status) => {
    const receivedExtension = { ...result, api_error_status: status };
    expect(isClaudeStoppedExecutionResult(receivedExtension, true, false)).toBe(false);
  });
});
