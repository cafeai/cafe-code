import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  AUTO_NUDGE_BUILT_IN_PROMPTS,
  AUTO_NUDGE_BUILT_IN_PROMPTS_JAPANESE,
  DEFAULT_THREAD_AUTO_NUDGE_CONFIG,
  LEGACY_AUTO_NUDGE_BUILT_IN_PROMPTS,
  MAX_AUTO_NUDGE_MAX_ROUNDS,
  migrateStoredAutoNudgeBuiltInPrompt,
  normalizeAutoNudgeBuiltInPrompt,
  ThreadAutoNudgeConfig,
  ThreadAutoNudgePrompt,
} from "./autoNudge.ts";

const decodeConfig = Schema.decodeUnknownSync(ThreadAutoNudgeConfig);
const decodePrompt = Schema.decodeUnknownSync(ThreadAutoNudgePrompt);

describe("Auto Nudge contracts", () => {
  it("keeps the feature off by default", () => {
    expect(DEFAULT_THREAD_AUTO_NUDGE_CONFIG).toMatchObject({
      mode: "off",
      prompt: "",
      backgroundContinuation: false,
      authorityRevision: 0,
      roundsDispatched: 0,
    });
  });

  it("pins the current plan-driven built-in prompts", () => {
    expect(AUTO_NUDGE_BUILT_IN_PROMPTS["steady-progress"]).toBe(
      "Continue from the current thread context; do not restart discovery or reread settled material. Re-anchor to unresolved operator requests and the project's applicable handoff, plan, canon, and current PR/backlog state. Reuse a compact progress packet when present; refresh external state only after a relevant change or when stale. Select the highest-priority unblocked operator ask, keep at most two coherent lanes, implement the next verifiable slice, and update canon only when evidence or operator intent requires it. Linear owns actionable status and dependencies; Notion owns durable decisions and research; link rather than duplicate. Stop and report when the plan is complete, progress is blocked, or new authority is required.",
    );
    expect(AUTO_NUDGE_BUILT_IN_PROMPTS["hardcore-fanout"]).toBe(
      "Continue from the current thread context; do not restart discovery. Re-anchor to unresolved operator requests and the project's applicable handoff, plan, canon, and current PR/backlog state. Reconcile external state once per bounded run, then refresh only after a relevant change or when stale. Drive the highest-priority unblocked asks through bounded, non-overlapping parallel lanes with one owner per lane; never fan out duplicate investigation or implementation. Give each lane a compact context packet, converge through repository gates and required independent audits, and update canon only when evidence or operator intent requires it. Linear owns actionable status and dependencies; Notion owns durable decisions and research; link rather than duplicate. Stop fan-out when lanes contend, context cost exceeds its value, work is complete or blocked, or new authority is required.",
    );
  });

  it("upgrades recognized defaults without changing custom thread text", () => {
    expect(
      normalizeAutoNudgeBuiltInPrompt(
        "steady-progress",
        LEGACY_AUTO_NUDGE_BUILT_IN_PROMPTS["steady-progress"][0] ?? "",
      ),
    ).toBe(AUTO_NUDGE_BUILT_IN_PROMPTS["steady-progress"]);
    expect(migrateStoredAutoNudgeBuiltInPrompt("off", "Fan out and keep going")).toBe(
      AUTO_NUDGE_BUILT_IN_PROMPTS["hardcore-fanout"],
    );
    expect(normalizeAutoNudgeBuiltInPrompt("steady-progress", "My exact thread prompt")).toBe(
      "My exact thread prompt",
    );
    expect(normalizeAutoNudgeBuiltInPrompt("steady-progress", "", "ja")).toBe(
      AUTO_NUDGE_BUILT_IN_PROMPTS_JAPANESE["steady-progress"],
    );
  });

  it("accepts multiline thread text and rejects empty thread text", () => {
    expect(decodePrompt("Continue this thread.\nCheck the current plan.")).toContain("\n");
    expect(() => decodePrompt("   \n  ")).toThrow();
  });

  it("bounds rounds and defines no elapsed-time authority", () => {
    const decoded = decodeConfig({
      ...DEFAULT_THREAD_AUTO_NUDGE_CONFIG,
      mode: "steady-progress",
      prompt: "Continue this exact thread.",
      armedAt: "2026-08-11T12:00:00.000Z",
      maxRounds: MAX_AUTO_NUDGE_MAX_ROUNDS,
      lastDispatchedMessageId: "message-auto-nudge",
    });
    expect(decoded.maxRounds).toBe(MAX_AUTO_NUDGE_MAX_ROUNDS);
    expect("maxMinutes" in decoded).toBe(false);
    expect("intervalMs" in decoded).toBe(false);
    expect("deadlineAt" in decoded).toBe(false);
    expect(decoded.lastDispatchedMessageId).toBe("message-auto-nudge");
    expect(() => decodeConfig({ ...decoded, maxRounds: MAX_AUTO_NUDGE_MAX_ROUNDS + 1 })).toThrow();
  });
});
