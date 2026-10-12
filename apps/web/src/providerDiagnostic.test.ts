import {
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderDiagnosticSnapshot,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import {
  deriveProviderDiagnosticWorkLogRecord,
  providerDiagnosticCopyDetails,
  providerDiagnosticSubjectLabel,
  providerDiagnosticWorkLogLabel,
  readMatchingProviderDiagnosticResponse,
  readProviderDiagnosticSummary,
} from "./providerDiagnostic";

const identity = {
  threadId: ThreadId.make("diagnostic-chat"),
  turnId: TurnId.make("diagnostic-turn"),
  activityId: EventId.make("diagnostic-occurrence"),
};
const snapshot: ProviderDiagnosticSnapshot = {
  version: 1,
  observedAt: "2026-10-12T05:32:08.000Z",
  source: "codex.error",
  method: "error",
  native: {
    eventId: "native-occurrence",
    threadId: "private-native-thread",
    turnId: "private-native-turn",
    requestId: "native-request-correlation",
  },
  message: "Connection interrupted",
  json: '{\n  "willRetry": true,\n  "token": "[Redacted]"\n}',
  redacted: true,
  truncated: false,
  omittedFields: false,
};

function activity(
  payload: Record<string, unknown>,
  kind = "runtime.warning",
): OrchestrationThreadActivity {
  return {
    id: identity.activityId,
    turnId: identity.turnId,
    createdAt: snapshot.observedAt,
    kind,
    summary: "private error prose",
    tone: "info",
    payload,
  };
}

describe("provider diagnostic received-data presentation", () => {
  it("retains only validated public root/child identity and observed counts", () => {
    const record = deriveProviderDiagnosticWorkLogRecord(
      activity({
        providerDiagnostic: {
          version: 1,
          status: "retry",
          subject: { kind: "subagent", id: "child-one", label: "Layout reviewer" },
          observedRetryCount: 12,
        },
        message: "private error",
        detail: { token: "private_token" },
      }),
    );
    expect(record?.recorded).toBe(true);
    expect(providerDiagnosticSubjectLabel(record!.summary)).toBe("Layout reviewer");
    expect(providerDiagnosticWorkLogLabel(record!.summary)).toBe("Provider retry · 12");
    expect(JSON.stringify(record)).not.toContain("private");
    expect(
      providerDiagnosticSubjectLabel({ version: 1, status: "error", subject: { kind: "root" } }),
    ).toBe("Root");
    expect(
      providerDiagnosticWorkLogLabel({ version: 1, status: "error", subject: { kind: "unknown" } }),
    ).toBe("Provider error");
  });

  it("shows honest unknown legacy identities without inventing original diagnostics or prose counts", () => {
    const retry = deriveProviderDiagnosticWorkLogRecord(
      activity({
        retrying: true,
        message: "Reconnecting 1/5",
        nativeRetry: { observedCount: 1024, timing: "unknown", countLimited: true },
      }),
    );
    expect(retry).toEqual({
      recorded: false,
      summary: {
        version: 1,
        status: "retry",
        subject: { kind: "unknown" },
        observedRetryCount: 1024,
        countLimited: true,
      },
    });
    expect(providerDiagnosticSubjectLabel(retry!.summary)).toBe("Agent not recorded");
    expect(providerDiagnosticWorkLogLabel(retry!.summary)).toBe("Provider retry · 1024+");
    expect(
      deriveProviderDiagnosticWorkLogRecord(activity({ message: "Reconnecting 3/5" })),
    ).toBeNull();
    expect(
      deriveProviderDiagnosticWorkLogRecord(
        activity({ message: "private error" }, "runtime.error"),
      ),
    ).toMatchObject({
      recorded: false,
      summary: { status: "error", subject: { kind: "unknown" } },
    });
    expect(
      deriveProviderDiagnosticWorkLogRecord(
        activity(
          { providerDiagnostic: { version: 1, status: "error", subject: { kind: "root" } } },
          "task.completed",
        ),
      ),
    ).toBeNull();
  });

  it("refuses forged, future and credential-shaped summary metadata without invoking accessors", () => {
    for (const summary of [
      { version: 2, status: "error", subject: { kind: "root" } },
      { version: 1, status: "retry", subject: { kind: "root", id: "child" } },
      { version: 1, status: "retry", subject: { kind: "subagent" } },
      {
        version: 1,
        status: "retry",
        subject: { kind: "subagent", id: "child", label: "Bearer private_fixture_value" },
      },
      { version: 1, status: "retry", subject: { kind: "root" }, observedRetryCount: 0 },
      {
        version: 1,
        status: "retry",
        subject: { kind: "root" },
        countLimited: true,
      },
      { version: 1, status: "error", subject: { kind: "root" }, json: "private" },
    ])
      expect(readProviderDiagnosticSummary(summary)).toBeUndefined();
    let reads = 0;
    const accessor = Object.defineProperty({}, "providerDiagnostic", {
      enumerable: true,
      get() {
        reads += 1;
        return { version: 1, status: "error", subject: { kind: "root" } };
      },
    });
    expect(deriveProviderDiagnosticWorkLogRecord(activity(accessor))).toBeNull();
    expect(reads).toBe(0);
  });

  it("keeps reported lower-bound retry counts below the per-target ceiling honest", () => {
    const summary = readProviderDiagnosticSummary({
      version: 1,
      status: "retry",
      subject: { kind: "root" },
      observedRetryCount: 1008,
      countLimited: true,
    });
    expect(summary).toBeDefined();
    expect(providerDiagnosticWorkLogLabel(summary!)).toBe("Provider retry · 1008+");
  });

  it("admits only exact echoed occurrence identity and bounded inert private snapshots", () => {
    expect(
      readMatchingProviderDiagnosticResponse({ ...identity, diagnostic: snapshot }, identity),
    ).toEqual({ diagnostic: snapshot });
    expect(
      readMatchingProviderDiagnosticResponse({ ...identity, diagnostic: null }, identity),
    ).toEqual({ diagnostic: null });
    for (const [field, value] of [
      ["threadId", "foreign-chat"],
      ["turnId", null],
      ["activityId", "foreign-event"],
    ]) {
      expect(
        readMatchingProviderDiagnosticResponse(
          { ...identity, [field!]: value, diagnostic: snapshot },
          identity,
        ),
      ).toBeNull();
    }
    for (const diagnostic of [
      { ...snapshot, json: "x".repeat(32769) },
      { ...snapshot, json: "界".repeat(10923) },
      { ...snapshot, message: "x".repeat(4097) },
      { ...snapshot, native: { token: "never display" } },
      { ...snapshot, native: { threadId: "x".repeat(513) } },
      { ...snapshot, observedAt: "not an instant" },
      { ...snapshot, version: 2 },
      { ...snapshot, secrets: "not an admitted field" },
    ])
      expect(
        readMatchingProviderDiagnosticResponse({ ...identity, diagnostic }, identity),
      ).toBeNull();
    let reads = 0;
    const hostile = Object.defineProperty({ ...identity }, "diagnostic", {
      enumerable: true,
      get() {
        reads += 1;
        return snapshot;
      },
    });
    expect(readMatchingProviderDiagnosticResponse(hostile, identity)).toBeNull();
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("private exception");
        },
      },
    );
    expect(readMatchingProviderDiagnosticResponse(proxy, identity)).toBeNull();
    expect(reads).toBe(0);
  });

  it("explicit diagnostic copy preserves the saved redacted JSON and provenance markers", () => {
    const details = providerDiagnosticCopyDetails({
      ...snapshot,
      truncated: true,
      omittedFields: true,
    });
    expect(details).toContain(snapshot.json);
    expect(details).toContain("private-native-thread");
    expect(details).toContain("Secrets redacted: true");
    expect(details).toContain("Truncated: true");
    expect(details).toContain("Fields omitted: true");
    expect(details).not.toContain("Copy JSON");
  });
});
