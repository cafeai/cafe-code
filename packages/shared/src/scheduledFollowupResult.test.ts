import { describe, expect, it } from "vitest";

import {
  parseScheduledFollowupResult,
  stripScheduledFollowupResultForDisplay,
} from "./scheduledFollowupResult.ts";

const runId = "12345678-1234-4123-8123-123456789abc";
const report = { runId, result: "no-change", summary: "No new failures.", finish: false };
const footer = (value: unknown) => `<!-- cafe-scheduled-followup: ${JSON.stringify(value)} -->`;

describe("scheduled follow-up canonical result footer", () => {
  it("decodes an exact final marker and preserves only the bounded result fields", () => {
    expect(
      parseScheduledFollowupResult(`Checked the build.\n\n${footer(report)}\n`, runId),
    ).toEqual(report);
    expect(
      parseScheduledFollowupResult(footer({ ...report, result: "changed", finish: true }), runId),
    ).toEqual({ ...report, result: "changed", finish: true });
  });

  it("never accepts a marker for a different run or guesses no-change from ordinary output", () => {
    expect(
      parseScheduledFollowupResult(footer(report), "12345678-1234-4123-8123-123456789abd"),
    ).toBeNull();
    expect(parseScheduledFollowupResult("No changes. Everything is fine.", runId)).toBeNull();
  });

  it.each([
    `Quoted inline: ${footer(report)}`,
    `${footer(report)}\nMore answer follows.`,
    `\`\`\`html\n${footer(report)}\n\`\`\``,
    `<!-- cafe-scheduled-followup: {broken json} -->`,
    `<!-- cafe-scheduled-followup: ${JSON.stringify(report)}-->`,
    `<!-- cafe-scheduled-followup:\n${JSON.stringify(report)} -->`,
  ])("rejects nonfinal, malformed or nonexact marker %s", (text) => {
    expect(parseScheduledFollowupResult(text, runId)).toBeNull();
  });

  it.each([
    { ...report, finish: "true" },
    { ...report, result: "success" },
    { ...report, scheduleId: "not-authority" },
    { ...report, summary: "x".repeat(1_001) },
    { ...report, summary: " \n " },
    { ...report, summary: "misleading\u202esummary" },
    { ...report, runId: "not-a-uuid" },
  ])("rejects unknown, oversized or invalid report fields %j", (value) => {
    expect(parseScheduledFollowupResult(footer(value), runId)).toBeNull();
  });

  it("reads only the bounded tail of large answers and rejects an oversized footer", () => {
    expect(
      parseScheduledFollowupResult(`${"Answer. ".repeat(10_000)}\n${footer(report)}`, runId),
    ).toEqual(report);
    expect(
      parseScheduledFollowupResult(footer({ ...report, summary: " ".repeat(9_000) }), runId),
    ).toBeNull();
  });

  it("strips metadata for display only while preserving every original answer byte", () => {
    const answer = "  Original answer with spaces.\r\n\r\n";
    const source = `${answer}${footer(report)}\n`;
    expect(stripScheduledFollowupResultForDisplay(source)).toBe(answer);
    expect(source).toBe(`${answer}${footer(report)}\n`);
    const malformed = `${answer}${footer({ ...report, extra: true })}`;
    expect(stripScheduledFollowupResultForDisplay(malformed)).toBe(malformed);
  });
});
