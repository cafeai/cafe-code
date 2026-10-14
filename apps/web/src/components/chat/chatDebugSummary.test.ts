import { describe, expect, it } from "vitest";
import {
  MessageId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
  EnvironmentId,
  TurnId,
  DEFAULT_UNIFIED_SETTINGS,
  type CodexCompactionObservation,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import {
  countBy,
  summarizeDebugMessage,
  summarizeDebugActivity,
  summarizeDebugSession,
  readDebugRecord,
  summarizeDebugCodexCompactionEvidence,
  summarizeDebugCodexSavedPolicy,
  summarizeDebugThreadPerformance,
} from "./chatDebugSummary";
import type { Thread } from "../../types";

const compactionAccount = ProviderInstanceId.make("codex-owned-compaction-account");
const compactionRuntime = SubagentRuntimeId.make("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa");
const compactionSession = {
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: compactionAccount,
  subagentRuntimeId: compactionRuntime,
  status: "running" as const,
  orchestrationStatus: "running" as const,
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:01.000Z",
  codexContextWindowOverride: 800_000,
  codexAutoCompactTokenLimit: 800_000,
};
const compactionObservation: CodexCompactionObservation = {
  version: 1,
  phase: "started",
  sourceOwner: { type: "root" },
  observedAt: "2026-10-15T00:00:02.000Z",
  order: 4,
  nativeTurnId: "PRIVATE_NATIVE_TURN",
  nativeItemId: "PRIVATE_NATIVE_ITEM",
  startObservedAt: "2026-10-15T00:00:02.000Z",
  rootOpeningRequests: { contextWindow: 800_000, autoCompactTokenLimit: 800_000 },
  lastReportedUsageBeforeStart: {
    observedAt: "2026-10-15T00:00:01.000Z",
    order: 3,
    nativeTurnId: "PRIVATE_NATIVE_TURN",
    usedTokens: 419_900,
    inputTokens: 370_000,
    cachedInputTokens: 310_000,
    outputTokens: 49_900,
    reasoningOutputTokens: 40_000,
    totalProcessedTokens: 1_300_000,
    reportedUsableContextWindow: 760_000,
  },
  usageEvidence: "received-before-start",
  evictedSourceCount: 0,
  evictedItemCount: 0,
  triggerReason: "unreported",
  accountingScope: "unreported",
  resolvedThreshold: null,
};
function compactionActivity(
  observation: CodexCompactionObservation = compactionObservation,
  extras: Record<string, unknown> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`compaction-fixture-${observation.order}`),
    createdAt: observation.observedAt,
    kind: observation.phase === "started" ? "tool.started" : "tool.completed",
    tone: "tool",
    summary: "PRIVATE_PROVIDER_DETAIL",
    turnId: TurnId.make("canonical-parent-turn"),
    payload: {
      itemType: "context_compaction",
      itemId: observation.nativeItemId,
      taskOwner: observation.sourceOwner,
      nativeWorkRuntimeId: compactionRuntime,
      nativeWorkProviderInstanceId: compactionAccount,
      codexCompactionObservation: observation,
      ...extras,
    },
  };
}
function compactionThread(activities: OrchestrationThreadActivity[] = []): Thread {
  return {
    id: ThreadId.make("compaction-debug-thread"),
    environmentId: EnvironmentId.make("compaction-environment"),
    codexThreadId: null,
    projectId: null,
    title: "Fixture",
    modelSelection: { instanceId: compactionAccount, model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: compactionSession,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: compactionSession.createdAt,
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities,
    codexContextWindowOverride: 800_000,
  };
}

describe("chat diagnostic projections", () => {
  it("retains exact current-owner pre-start usage across completion without relabeling later usage or reasoning", () => {
    const completed = {
      ...compactionObservation,
      phase: "completed" as const,
      observedAt: "2026-10-15T00:00:04.000Z",
      order: 6,
    };
    const later: OrchestrationThreadActivity = {
      id: EventId.make("post-compaction-usage"),
      kind: "context-window.updated",
      tone: "info",
      summary: "Context window updated",
      turnId: TurnId.make("canonical-parent-turn"),
      createdAt: "2026-10-15T00:00:03.000Z",
      payload: {
        usedTokens: 12_000,
        lastUsedTokens: 12_000,
        inputTokens: 10_000,
        autoCompactTokenLimit: 450_000,
      },
    };
    const thread = compactionThread([compactionActivity(), later, compactionActivity(completed)]);
    const evidence = summarizeDebugCodexCompactionEvidence({
      session: thread.session,
      activities: thread.activities,
    });
    expect(evidence.currentOwnerKnown).toBe(true);
    expect(evidence.latest).toHaveLength(1);
    expect(evidence.latest[0]).toMatchObject({
      phase: "completed",
      source: "root",
      order: 6,
      rootOpeningRequests: { contextWindow: 800_000, autoCompactTokenLimit: 800_000 },
      lastReportedUsageBeforeStart: {
        usedTokens: 419_900,
        outputTokens: 49_900,
        reasoningOutputTokens: 40_000,
        totalProcessedTokens: 1_300_000,
      },
      triggerReason: "unreported",
      accountingScope: "unreported",
      resolvedThreshold: null,
    });
    const full = summarizeDebugThreadPerformance(thread, Date.parse(completed.observedAt));
    expect(full.compaction?.policy).toMatchObject({
      thresholdResolution: "native-unreported",
      nominalRequestAtNativeOpening: 800_000,
      nominalRequestEvidenceKnown: true,
      explicitCafeOverride: 450_000,
      usageAnnotationIsResolvedThreshold: false,
      resolvedThresholdReportedByProvider: false,
    });
    expect(full.compaction?.latestContextWindow.usedTokens).toBe(12_000);
    expect(JSON.stringify(full)).not.toContain("PRIVATE_");
  });

  it("distinguishes a child source without borrowing root opening policy or its canonical parent turn", () => {
    const child = {
      ...compactionObservation,
      sourceOwner: { type: "child" as const, id: "PRIVATE_CHILD" },
      nativeTurnId: "PRIVATE_CHILD_NATIVE_TURN",
      nativeItemId: "PRIVATE_CHILD_NATIVE_ITEM",
      lastReportedUsageBeforeStart: {
        ...compactionObservation.lastReportedUsageBeforeStart!,
        nativeTurnId: "PRIVATE_CHILD_NATIVE_TURN",
        usedTokens: 99_000,
        inputTokens: 90_000,
        cachedInputTokens: 80_000,
        outputTokens: 9_000,
        reasoningOutputTokens: 7_000,
        totalProcessedTokens: 200_000,
      },
    };
    const result = summarizeDebugCodexCompactionEvidence({
      session: compactionSession,
      activities: [compactionActivity(child)],
    });
    expect(result.latest).toHaveLength(1);
    expect(result.latest[0]?.source).toBe("child");
    expect(result.latest[0]?.rootOpeningRequests).toEqual({
      contextWindow: 800_000,
      autoCompactTokenLimit: 800_000,
    });
    expect(result.latest[0]?.lastReportedUsageBeforeStart?.usedTokens).toBe(99_000);
    expect(result.latest[0]).not.toHaveProperty("childOpeningRequests");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  it("refuses foreign, stale, mismatched, malformed and accessor observation evidence without inventing legacy ownership", () => {
    let getterReads = 0;
    const accessor = Object.defineProperty({ ...compactionObservation }, "order", {
      get: () => {
        getterReads += 1;
        return 4;
      },
    });
    const variants = [
      { nativeWorkProviderInstanceId: "other-account" },
      { nativeWorkRuntimeId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" },
      { nativeWorkRuntimeId: undefined },
      { nativeWorkProviderInstanceId: undefined },
      { itemId: "another-item" },
      { taskOwner: undefined },
      { taskOwner: { type: "child", id: "foreign-child" } },
      { codexCompactionObservation: { ...compactionObservation, version: 2 } },
      { codexCompactionObservation: { ...compactionObservation, phase: "completed" } },
      { codexCompactionObservation: accessor },
      { codexCompactionObservation: undefined },
    ];
    for (const extra of variants) {
      const result = summarizeDebugCodexCompactionEvidence({
        session: compactionSession,
        activities: [compactionActivity(compactionObservation, extra)],
      });
      expect(result.latest).toEqual([]);
      expect(result.omittedUnqualifiedCount).toBe(1);
    }
    for (const session of [
      null,
      { ...compactionSession, provider: "claudeAgent" },
      { ...compactionSession, providerInstanceId: "other-account" },
      { ...compactionSession, subagentRuntimeId: undefined },
      { ...compactionSession, orchestrationStatus: "stopped" },
      { ...compactionSession, status: "unrecognized" },
      { ...compactionSession, orchestrationStatus: undefined },
      { ...compactionSession, status: undefined },
      { ...compactionSession, subagentRuntimeId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb" },
    ]) {
      expect(
        summarizeDebugCodexCompactionEvidence({ session, activities: [compactionActivity()] })
          .latest,
      ).toEqual([]);
    }
    expect(getterReads).toBe(0);
    const trapped = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("PRIVATE_TRAP");
        },
      },
    );
    expect(
      summarizeDebugCodexCompactionEvidence({
        session: trapped,
        activities: [compactionActivity()],
      }).latest,
    ).toEqual([]);
    expect(
      summarizeDebugCodexCompactionEvidence({
        session: compactionSession,
        activities: [
          compactionActivity(compactionObservation, { codexCompactionObservation: trapped }),
        ],
      }).latest,
    ).toEqual([]);
    const revoked = Proxy.revocable(compactionSession, {});
    revoked.revoke();
    expect(
      summarizeDebugCodexCompactionEvidence({
        session: revoked.proxy,
        activities: [compactionActivity()],
      }).latest,
    ).toEqual([]);
    const revokedPayload = Proxy.revocable({}, {});
    revokedPayload.revoke();
    expect(
      summarizeDebugCodexCompactionEvidence({
        session: compactionSession,
        activities: [{ ...compactionActivity(), payload: revokedPayload.proxy }],
      }).latest,
    ).toEqual([]);
  });

  it("bounds received evidence to eight latest items and keeps missing pre-start samples explicitly unknown", () => {
    const activities = Array.from({ length: 10 }, (_, index) =>
      compactionActivity({
        ...compactionObservation,
        order: index + 10,
        nativeItemId: `PRIVATE_ITEM_${index}`,
      }),
    );
    const result = summarizeDebugCodexCompactionEvidence({
      session: compactionSession,
      activities,
    });
    expect(result.latest).toHaveLength(8);
    expect(result.latest.map((entry) => entry.order)).toEqual([19, 18, 17, 16, 15, 14, 13, 12]);
    const unavailable = summarizeDebugCodexCompactionEvidence({
      session: compactionSession,
      activities: [
        compactionActivity({
          ...compactionObservation,
          lastReportedUsageBeforeStart: null,
          usageEvidence: "not-observed",
        }),
      ],
    });
    expect(unavailable.latest[0]).toMatchObject({
      usageEvidence: "not-observed",
      lastReportedUsageBeforeStart: null,
    });
  });

  it("compares saved exact-account compaction precedence with known/null/missing opening evidence, never a draft or sibling", () => {
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [compactionAccount]: {
          driver: ProviderDriverKind.make("codex"),
          defaultCodexContextWindowOverride: 900_000,
          config: { autoCompactTokenLimit: 450_000, privateCredential: "PRIVATE_CREDENTIAL" },
        },
      },
    };
    const thread = compactionThread();
    expect(summarizeDebugCodexSavedPolicy(thread, settings)).toMatchObject({
      source: "chat-override",
      desiredRootContextWindowRequest: 800_000,
      desiredRootAutoCompactRequest: 450_000,
      explicitAccountAutoCompactRequest: 450_000,
      pending: true,
      pendingCompaction: true,
      comparisonKnown: true,
      isUnsentDraft: false,
      isResolvedNativeThreshold: false,
    });
    expect(
      summarizeDebugCodexSavedPolicy({ ...thread, codexContextWindowOverride: null }, settings),
    ).toMatchObject({
      source: "account-default",
      desiredRootContextWindowRequest: 900_000,
    });
    expect(
      summarizeDebugCodexSavedPolicy(
        { ...thread, session: { ...compactionSession, codexAutoCompactTokenLimit: undefined } },
        settings,
      ),
    ).toMatchObject({
      comparisonKnown: false,
      pendingCompaction: true,
    });
    expect(
      summarizeDebugCodexSavedPolicy(
        { ...thread, session: { ...compactionSession, codexAutoCompactTokenLimit: null } },
        settings,
      )?.comparisonKnown,
    ).toBe(true);
    expect(
      summarizeDebugCodexSavedPolicy(
        {
          ...thread,
          session: {
            ...compactionSession,
            providerInstanceId: ProviderInstanceId.make("foreign-account"),
          },
        },
        settings,
      ),
    ).toMatchObject({
      selectedAccountMatchesRuntime: false,
      comparisonKnown: false,
      pending: null,
    });
    expect(JSON.stringify(summarizeDebugCodexSavedPolicy(thread, settings))).not.toContain(
      "PRIVATE_",
    );
    let getterReads = 0;
    const accessorConfig = Object.defineProperty({}, "autoCompactTokenLimit", {
      get() {
        getterReads += 1;
        return 420_000;
      },
    });
    const accessorSettings = {
      ...settings,
      providerInstances: {
        [compactionAccount]: {
          ...settings.providerInstances[compactionAccount]!,
          config: accessorConfig,
        },
      },
    };
    expect(
      summarizeDebugCodexSavedPolicy(thread, accessorSettings)?.desiredRootAutoCompactRequest,
    ).toBe(800_000);
    const inheritedSettings = {
      ...settings,
      providerInstances: Object.create(settings.providerInstances),
    };
    expect(summarizeDebugCodexSavedPolicy(thread, inheritedSettings)).toBeNull();
    expect(getterReads).toBe(0);
    expect(
      summarizeDebugThreadPerformance(
        {
          ...thread,
          session: { ...compactionSession, provider: ProviderDriverKind.make("claudeAgent") },
        },
        0,
      ).compaction,
    ).toBeNull();
  });

  it("reports nominal Codex request proof without inventing an effective threshold or legacy proof", () => {
    const session = {
      provider: ProviderDriverKind.make("codex"),
      status: "ready" as const,
      orchestrationStatus: "ready" as const,
      createdAt: "2026-10-14T00:00:00.000Z",
      updatedAt: "2026-10-14T00:00:00.000Z",
      codexContextWindowOverride: 800_000,
      codexAutoCompactTokenLimit: 800_000,
    };
    expect(summarizeDebugSession(session)).toMatchObject({
      codexContextWindowOverride: 800_000,
      hasCodexContextWindowRequestEvidence: true,
      codexAutoCompactTokenLimit: 800_000,
      hasCodexAutoCompactRequestEvidence: true,
    });
    expect(summarizeDebugSession({ ...session, codexAutoCompactTokenLimit: null })).toMatchObject({
      codexAutoCompactTokenLimit: null,
      hasCodexAutoCompactRequestEvidence: true,
    });
    for (const unknown of [undefined, NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        summarizeDebugSession({ ...session, codexAutoCompactTokenLimit: unknown }),
      ).toMatchObject({
        codexAutoCompactTokenLimit: null,
        hasCodexAutoCompactRequestEvidence: false,
      });
    }
    expect(
      summarizeDebugSession({ ...session, provider: ProviderDriverKind.make("claudeAgent") }),
    ).toMatchObject({
      codexContextWindowOverride: null,
      hasCodexContextWindowRequestEvidence: false,
      codexAutoCompactTokenLimit: null,
      hasCodexAutoCompactRequestEvidence: false,
    });
    expect(JSON.stringify(summarizeDebugSession(session))).not.toContain("720000");
  });
  it("reports runtime evidence without exposing its correlation key or worker content", () => {
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("subagent-event"),
      kind: "task.progress",
      tone: "info",
      summary: "PRIVATE_LABEL",
      turnId: null,
      createdAt: "2026-10-04T00:00:00.000Z",
      payload: {
        taskId: "PRIVATE_TASK",
        subagent: {
          threadId: "PRIVATE_CHILD",
          runtimeId: "PRIVATE_RUNTIME",
          historyId: "PRIVATE_HISTORY",
          status: "active",
          label: "PRIVATE_LABEL",
          objective: "PRIVATE_OBJECTIVE",
        },
      },
    };
    const summary = summarizeDebugActivity(activity);
    expect(JSON.parse(summary.payloadPreview)).toEqual({
      status: "active",
      hasRuntimeEvidence: true,
      hasHistoryBinding: true,
    });
    expect(JSON.stringify(summary)).not.toContain("PRIVATE_");
    const session = {
      provider: ProviderDriverKind.make("codex"),
      status: "running" as const,
      orchestrationStatus: "running" as const,
      createdAt: activity.createdAt,
      updatedAt: activity.createdAt,
      subagentRuntimeId: "PRIVATE_RUNTIME",
    };
    expect(summarizeDebugSession(session)?.hasSubagentRuntimeEvidence).toBe(true);
    expect(JSON.stringify(summarizeDebugSession(session))).not.toContain("PRIVATE_RUNTIME");
    expect(
      summarizeDebugSession({ ...session, subagentRuntimeId: undefined })
        ?.hasSubagentRuntimeEvidence,
    ).toBe(false);
    expect(
      summarizeDebugSession({ ...session, subagentRuntimeId: null })?.hasSubagentRuntimeEvidence,
    ).toBe(false);
    expect(summarizeDebugSession(null)).toBeNull();
  });

  it("keeps bounded message previews with secrets redacted before truncation", () => {
    const secret = `sk-${"a".repeat(32)}`;
    const text = `${secret} ${"long text ".repeat(100)}`;
    const summary = summarizeDebugMessage({
      id: MessageId.make("message"),
      role: "user",
      text,
      createdAt: "2026-09-06T00:00:00.000Z",
      streaming: false,
    });
    expect(summary.textLength).toBe(text.length);
    expect(summary.textPreview.length).toBeLessThanOrEqual(120);
    expect(summary.textPreview).toContain("sk-[redacted]");
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it("survives cyclic diagnostic payloads without expanding them", () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("event"),
      kind: "runtime.warning",
      tone: "info",
      summary: "Operational warning",
      turnId: null,
      createdAt: "2026-09-06T00:00:00.000Z",
      payload,
    };
    expect(summarizeDebugActivity(activity).payloadPreview).toBe("[unserializable]");
    expect(readDebugRecord([])).toBeNull();
    expect(readDebugRecord(null)).toBeNull();
  });

  it("counts untrusted prototype-like labels as ordinary keys", () => {
    const result = countBy(["__proto__", "constructor", "__proto__"], (label) => label);
    expect(result["__proto__"]).toBe(2);
    expect(result["constructor"]).toBe(1);
    expect(Object.getPrototypeOf(result)).toBeNull();
  });

  it("reports only bounded counts for inline questions, not titles or suggestions", () => {
    const activity: OrchestrationThreadActivity = {
      id: EventId.make("question-event"),
      kind: "provider.async-questions",
      tone: "info",
      summary: "PRIVATE_QUESTION",
      turnId: null,
      createdAt: "2026-09-10T00:00:00.000Z",
      payload: {
        PRIVATE_KEY: "PRIVATE_VALUE",
        itemId: "PRIVATE_ITEM",
        questions: Array.from({ length: 20 }, () => ({
          title: "PRIVATE_QUESTION",
          options: Array.from({ length: 40 }, () => "PRIVATE_SUGGESTION"),
        })),
      },
    };
    const summary = summarizeDebugActivity(activity);
    expect(JSON.parse(summary.payloadPreview)).toEqual({ questionCount: 16, optionCount: 512 });
    expect(summary.payloadKeys).toEqual(["optionCount", "questionCount"]);
    expect(JSON.stringify(summary)).not.toContain("PRIVATE_");
    expect(summarizeDebugActivity({ ...activity, payload: null }).payloadPreview).toBe(
      '{"questionCount":0,"optionCount":0}',
    );
  });
});
