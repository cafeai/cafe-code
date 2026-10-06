import * as Schema from "effect/Schema";
import {
  OrchestrationThreadTurnSubagentDetailBody,
  OrchestrationThreadTurnSubagentDetail,
  ProviderDaemonSubagentDetail,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import { canonicalizeProviderSubagentActivities } from "./subagentDetail.ts";

describe("bounded public subagent activity", () => {
  it("enforces identical detail constraints on daemon and public responses", () => {
    const decoders = [
      Schema.decodeUnknownSync(OrchestrationThreadTurnSubagentDetail),
      Schema.decodeUnknownSync(ProviderDaemonSubagentDetail),
    ];
    const response = {
      provider: "codex",
      providerInstanceId: "codex",
      messages: [],
      gaps: [],
      truncated: false,
      activities: [{ key: "a0", kind: "file_read", detail: "😀".repeat(128) }],
    };
    for (const decode of decoders) {
      expect(decode(response).activities?.[0]?.detail).toBe("😀".repeat(128));
      for (const detail of [
        "x".repeat(513),
        "😀".repeat(129),
        "bad\nline",
        "bad\u202eline",
        "bad\ud800line",
        " trailing ",
      ])
        expect(() =>
          decode({ ...response, activities: [{ key: "a0", kind: "file_read", detail }] }),
        ).toThrow();
      for (const kind of ["tool", "agent_message"])
        expect(() =>
          decode({ ...response, activities: [{ key: "a0", kind, detail: "private metadata" }] }),
        ).toThrow();
      expect(
        decode({ ...response, activities: [{ key: "a0", kind: "command" }] }).activities?.[0],
      ).not.toHaveProperty("detail");
    }
  });
  it("reconstructs categories and canonical times without private fields", () => {
    const detail = canonicalizeProviderSubagentActivities([
      { kind: "tool", timestamp: "2026-10-07T00:00:00.000Z", private: "PRIVATE" },
      { kind: "command", detail: "git status --short", timestamp: "2026-99-99T00:00:00.000Z" },
    ] as Parameters<typeof canonicalizeProviderSubagentActivities>[0]);
    expect(detail.activities).toEqual([
      { key: "a0", kind: "tool", timestamp: "2026-10-07T00:00:00.000Z" },
      { key: "a1", kind: "command", detail: "git status --short" },
    ]);
    expect(JSON.stringify(detail)).not.toContain("PRIVATE");
  });

  it("retains the newest bounded tail and does not claim an exact omitted total", () => {
    const detail = canonicalizeProviderSubagentActivities(
      Array.from({ length: 130 }, () => ({ kind: "tool" as const })),
    );
    expect(detail.activities).toHaveLength(128);
    expect(detail.activities?.[0]?.key).toBe("a2");
    expect(detail.activities?.at(-1)?.key).toBe(`a${(129).toString(36)}`);
    expect(detail.activityHistoryIncomplete).toBe(true);
    expect(detail).not.toHaveProperty("omittedCount");
  });

  it("preserves reader digest identities without leaking native identifiers", () => {
    const identityDigest = "abcd".repeat(16);
    const first = canonicalizeProviderSubagentActivities([{ kind: "tool", identityDigest }]);
    const shifted = canonicalizeProviderSubagentActivities([
      { kind: "command" },
      { kind: "tool", identityDigest },
    ]);
    expect(first.activities?.[0]?.key).toBe(shifted.activities?.[1]?.key);
    expect(first.activities?.[0]?.key).toBe(`a${identityDigest.slice(0, 24)}`);
    expect(first.activities?.[0]).not.toHaveProperty("identityDigest");
    expect(
      canonicalizeProviderSubagentActivities([
        { kind: "tool", identityDigest: "native-private-id" },
      ]).activities?.[0]?.key,
    ).toBe("a0");
  });

  it("keeps activity incompleteness independent of public prose gaps", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationThreadTurnSubagentDetailBody);
    const detail = {
      messages: [],
      gaps: [],
      truncated: false,
      ...canonicalizeProviderSubagentActivities([], true),
    };
    expect(decode(detail)).toEqual(detail);
    expect(decode({ messages: [], gaps: [], truncated: false })).not.toHaveProperty("activities");
  });

  it.each(
    [
      [
        { key: "a0", kind: "tool" },
        { key: "a0", kind: "command" },
      ],
      [{ key: "native/private-id", kind: "tool" }],
      [{ key: "a0", kind: "raw_command" }],
      [{ key: "a0", kind: "tool", timestamp: "PRIVATE" }],
      [{ key: "a0", kind: "tool", detail: "private tool data" }],
      [{ key: "a0", kind: "agent_message", detail: "private recipient" }],
      ...[
        "",
        " leading",
        "trailing ",
        "x\ny",
        "x\ty",
        "x\u202ey",
        "x\ud800y",
        "x".repeat(513),
        "😀".repeat(129),
      ].map((detail) => [{ key: "a0", kind: "command", detail }]),
      Array.from({ length: 129 }, (_, i) => ({ key: `a${i.toString(36)}`, kind: "tool" })),
    ].map((activities) => ({ activities })),
  )("rejects malformed or unbounded activity DTOs %#", ({ activities }) => {
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationThreadTurnSubagentDetailBody)({
        messages: [],
        gaps: [],
        truncated: false,
        activities,
      }),
    ).toThrow();
  });
});
