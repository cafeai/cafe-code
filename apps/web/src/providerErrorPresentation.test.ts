import { describe, expect, it } from "vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import { sha256 } from "@noble/hashes/sha2.js";
import { isProviderErrorRepresentedInWorkLog } from "./providerErrorPresentation";

const at = "2026-10-12T00:00:00.000Z";
const turnId = TurnId.make("failed-root");
const instance = ProviderInstanceId.make("codex-work");
const runtime = "10000000-0000-4000-8000-000000000001";
const thread: Parameters<typeof isProviderErrorRepresentedInWorkLog>[0]["thread"] = {
  id: ThreadId.make("own-thread"),
  error: "Synthetic provider failure",
  modelSelection: { instanceId: instance, model: "gpt-6.1-sol" },
  session: {
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: instance,
    status: "ready",
    orchestrationStatus: "ready",
    createdAt: at,
    updatedAt: at,
    lastError: "Synthetic provider failure",
    subagentRuntimeId: runtime,
  },
  latestTurn: {
    turnId,
    state: "error",
    requestedAt: at,
    startedAt: at,
    completedAt: at,
    assistantMessageId: null,
  },
};
const digest = (value: string) =>
  Array.from(sha256(new TextEncoder().encode(value)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
const row = (patch: Record<string, unknown> = {}): OrchestrationThreadActivity => ({
  id: EventId.make("durable-error"),
  kind: "runtime.error",
  tone: "error",
  summary: "Provider error",
  createdAt: at,
  turnId,
  payload: {
    providerDiagnostic: { version: 1, status: "error", subject: { kind: "root" } },
    providerErrorHash: digest(thread.error!),
    providerErrorOwnerHash: digest(JSON.stringify([thread.id, turnId, instance, runtime])),
    ...patch,
  },
});
const represented = (activities: OrchestrationThreadActivity[], owner = thread) =>
  isProviderErrorRepresentedInWorkLog({ thread: owner, activities });

describe("durable provider error presentation replacement", () => {
  it("requires exact current failed root and durable content-free owner/message witnesses without mutating truth", () => {
    const before = structuredClone(thread);
    expect(represented([row()])).toBe(true);
    expect(thread).toEqual(before);
    expect(represented([])).toBe(false);
    for (const patch of [
      { providerDiagnostic: undefined },
      { providerErrorHash: undefined },
      { providerErrorOwnerHash: undefined },
      { providerErrorHash: digest("Other failure") },
      { providerErrorOwnerHash: digest("Other owner") },
      { providerDiagnostic: { version: 1, status: "error", subject: { kind: "unknown" } } },
    ])
      expect(represented([row(patch)])).toBe(false);
    expect(represented([{ ...row(), turnId: TurnId.make("other-turn") }])).toBe(false);
    expect(represented([row()], { ...thread, id: ThreadId.make("foreign-thread") })).toBe(false);
    expect(represented([row()], { ...thread, session: null })).toBe(false);
    expect(represented([row()], { ...thread, error: "Direct send failed" })).toBe(false);
    expect(
      represented([row()], {
        ...thread,
        session: { ...thread.session!, subagentRuntimeId: "replacement" },
      }),
    ).toBe(false);
    expect(
      represented([row()], {
        ...thread,
        modelSelection: {
          ...thread.modelSelection,
          instanceId: ProviderInstanceId.make("replacement"),
        },
      }),
    ).toBe(false);
    expect(
      represented([row()], {
        ...thread,
        latestTurn: { ...thread.latestTurn!, state: "completed" },
      }),
    ).toBe(false);
    expect(
      represented([row()], {
        ...thread,
        session: { ...thread.session!, updatedAt: "2026-10-12T00:00:01.000Z" },
      }),
    ).toBe(false);
  });
  it("never lets an older occurrence hide a later unrecorded/mismatching root error, while children do not impersonate root", () => {
    expect(represented([row(), row({ providerErrorHash: digest("new error") })])).toBe(false);
    expect(represented([row(), row({ providerDiagnostic: undefined })])).toBe(false);
    expect(
      represented([
        row(),
        row({
          providerDiagnostic: {
            version: 1,
            status: "error",
            subject: { kind: "subagent", id: "child", label: "Worker" },
          },
        }),
      ]),
    ).toBe(true);
  });
  it("preserves actionable auth and approval feedback even when its diagnostic is recorded", () => {
    for (const error of [
      "Authentication expired",
      "Approval required",
      "Permission denied",
      "Sign in again",
    ]) {
      const owner = { ...thread, error, session: { ...thread.session!, lastError: error } };
      expect(represented([row({ providerErrorHash: digest(error) })], owner)).toBe(false);
    }
  });
  it("does not invoke private marker accessors", () => {
    let reads = 0;
    const payload = Object.defineProperty({}, "providerDiagnostic", {
      get() {
        reads++;
        throw new Error("private getter");
      },
    });
    expect(represented([{ ...row(), payload }])).toBe(false);
    expect(reads).toBe(0);
  });
});
