import { describe, expect, it } from "vitest";
import {
  mergeClaudeCommandInspections,
  readClaudeCommandInspection,
  readClaudePublicSummary,
} from "./providerOperationVisibility";

function readCommandFields(data: Record<string, unknown>) {
  return readClaudeCommandInspection({
    itemType: "command_execution",
    data: {
      toolName: "Bash",
      commandInspectionVersion: 1,
      inspectionProvider: "claudeAgent",
      ...data,
    },
  });
}

function readCommandOutput(output: unknown) {
  return readCommandFields({ output });
}

describe("admitted Claude operation presentation", () => {
  it("reads only the disclosed summary contract and bounds inert text", () => {
    expect(readClaudePublicSummary({ detail: "hidden", signature: "private" })).toBeUndefined();
    expect(
      readClaudePublicSummary({ streamKind: "reasoning_text", detail: "private" }),
    ).toBeUndefined();
    expect(
      readClaudePublicSummary({
        streamKind: "reasoning_summary_text",
        summaryVersion: 1,
        provider: "claudeAgent",
        itemId: "block-0",
        truncated: false,
        status: "completed",
        detail: "\n ",
      }),
    ).toBeUndefined();
    const summary = readClaudePublicSummary({
      streamKind: "reasoning_summary_text",
      summaryVersion: 1,
      provider: "claudeAgent",
      itemId: "block-0",
      truncated: true,
      detail: `Checking files\n${"x".repeat(4_000)}`,
      status: "completed",
      signature: "never exposed",
      future: { reasoning: "never exposed" },
    });
    expect(summary?.text).toMatch(/^Checking files\n/);
    expect(summary?.text.length).toBeLessThanOrEqual(4_096);
    expect(summary?.truncated).toBe(true);
    expect(summary).not.toHaveProperty("signature");
    expect(summary).not.toHaveProperty("future");
    for (const summaryVersion of [undefined, 0, 2, "1", true])
      expect(
        readClaudePublicSummary({
          streamKind: "reasoning_summary_text",
          summaryVersion,
          provider: "claudeAgent",
          itemId: "block-0",
          status: "completed",
          truncated: false,
          detail: "Received text",
        }),
      ).toBeUndefined();
    expect(
      readClaudePublicSummary({
        streamKind: "reasoning_summary_text",
        summaryVersion: 1,
        provider: "codex",
        itemId: "block-0",
        status: "completed",
        truncated: false,
        detail: "Other provider text",
      }),
    ).toBeUndefined();
    const valid = {
      itemId: "block-0",
      summaryVersion: 1,
      provider: "claudeAgent",
      streamKind: "reasoning_summary_text",
      detail: "Received text",
      status: "completed",
      truncated: false,
    };
    for (const malformed of [
      { itemId: " " },
      { itemId: undefined },
      { status: "future" },
      { status: undefined },
      { truncated: "false" },
      { truncated: undefined },
      { detail: "x".repeat(4_097) },
      { detail: "Checking\u202E files" },
      { detail: "Checking\u001B files" },
      { detail: "\u0000" },
    ])
      expect(readClaudePublicSummary({ ...valid, ...malformed })).toBeUndefined();
  });

  it("inspects only Bash command data without resurrecting omitted/raw results", () => {
    const base = {
      itemType: "command_execution",
      status: "failed",
      data: {
        toolName: "Bash",
        commandInspectionVersion: 1,
        inspectionProvider: "claudeAgent",
        input: { description: "Run focused tests", command: "yarn test" },
        output: "<script>alert('inert')</script>\nFailure",
        outputTruncated: true,
        result: { content: "private raw output" },
        signature: "private signature",
      },
    };
    expect(readClaudeCommandInspection(base)).toEqual({
      description: "Run focused tests",
      descriptionTruncated: false,
      command: "yarn test",
      commandTruncated: false,
      output: "<script>alert('inert')</script>\nFailure",
      outputTruncated: true,
      status: "failed",
    });
    expect(readClaudeCommandInspection({ ...base, itemType: "mcp_tool_call" })).toBeUndefined();
    for (const commandInspectionVersion of [0, 2, "1", true])
      expect(
        readClaudeCommandInspection({ ...base, data: { ...base.data, commandInspectionVersion } }),
      ).toBeUndefined();
    const { commandInspectionVersion: _marker, ...legacyData } = base.data;
    expect(readClaudeCommandInspection({ ...base, data: legacyData })).toBeUndefined();
    for (const inspectionProvider of [undefined, "codex", "grok"])
      expect(
        readClaudeCommandInspection({ ...base, data: { ...base.data, inspectionProvider } }),
      ).toBeUndefined();
    expect(
      readClaudeCommandInspection({ ...base, data: { ...base.data, toolName: "Read" } }),
    ).toBeUndefined();
    expect(
      readClaudeCommandInspection({
        ...base,
        data: {
          toolName: "Bash",
          commandInspectionVersion: 1,
          inspectionProvider: "claudeAgent",
          result: { content: "omitted" },
          rawOutput: { stdout: "not the agreed output projection" },
        },
      })?.output,
    ).toBeUndefined();
  });

  it("keeps missing and empty output distinct and honors explicit truncation", () => {
    expect(readCommandOutput(undefined)?.output).toBeUndefined();
    expect(readCommandOutput("")?.output).toBe("");
    expect(readCommandOutput("genuine ... text")?.outputTruncated).toBe(false);
    expect(readCommandOutput("x".repeat(2_049))?.output).toHaveLength(2_048);
    expect(readCommandOutput("x".repeat(2_049))?.outputTruncated).toBe(true);
    expect(
      readCommandFields({ input: { description: "x".repeat(2_049) } })?.descriptionTruncated,
    ).toBe(true);
  });

  it("accepts only canonical observed receipt timestamps, never guessed execution duration", () => {
    expect(
      readCommandFields({
        startedAt: "2026-10-09T00:00:00.000Z",
        completedAt: "2026-10-09T00:00:02.000Z",
        durationMs: 2_000,
      }),
    ).toMatchObject({
      startedAt: "2026-10-09T00:00:00.000Z",
      completedAt: "2026-10-09T00:00:02.000Z",
    });
    expect(
      readCommandFields({
        startedAt: "not a timestamp",
        completedAt: "2026-02-31T00:00:00.000Z",
        durationMs: 0,
      }),
    ).not.toHaveProperty("startedAt");
    expect(readCommandFields({ completedAt: "2026-02-31T00:00:00.000Z" })).not.toHaveProperty(
      "completedAt",
    );
    expect(readCommandFields({ durationMs: 5 })).not.toHaveProperty("durationMs");
  });

  it("removes terminal/bidi controls and recognized credentials without claiming a complete secret scanner", () => {
    const inspection = readClaudeCommandInspection({
      itemType: "command_execution",
      data: {
        toolName: "Bash",
        commandInspectionVersion: 1,
        inspectionProvider: "claudeAgent",
        input: {
          command: "printf sk-123456789012345678901234",
          description: "Authorization: Bearer secretcredential123456789",
        },
        output: "\u202E npm_12345678901234567890\u001B\nretained line",
      },
    });
    expect(inspection?.command).toBe("printf [redacted]");
    expect(inspection?.description).toBe("Authorization: Bearer [redacted]");
    expect(inspection?.output).toBe(" [redacted]\nretained line");
    const expandedRedaction = readCommandFields({
      output: `${"x".repeat(2_024)} Authorization: Bearer a`,
    });
    expect(expandedRedaction?.output?.length).toBeLessThanOrEqual(2_048);
    expect(expandedRedaction?.outputTruncated).toBe(true);
  });

  it("merges sparse terminal snapshots without losing output or retaining a running status", () => {
    expect(
      mergeClaudeCommandInspections(
        {
          command: "yarn test",
          commandTruncated: true,
          description: "Long description",
          descriptionTruncated: true,
          output: "received",
          outputTruncated: true,
          startedAt: "2026-10-09T00:00:00.000Z",
          status: "inProgress",
        },
        {
          commandTruncated: false,
          outputTruncated: false,
          completedAt: "2026-10-09T00:00:02.000Z",
        },
      ),
    ).toEqual({
      command: "yarn test",
      commandTruncated: true,
      description: "Long description",
      descriptionTruncated: true,
      output: "received",
      outputTruncated: true,
      startedAt: "2026-10-09T00:00:00.000Z",
      completedAt: "2026-10-09T00:00:02.000Z",
    });
  });
});
