import { scopeThreadRef } from "@cafecode/client-runtime";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EnvironmentState, useStore } from "../store";
import { type Thread } from "../types";

import {
  createLocalDispatchSnapshot,
  deriveRetryableSteerReplayCandidates,
  deriveComposerSendState,
  deriveLockedProvider,
  doesSteerFailureActivityMatchPending,
  doesSteerProcessingActivityMatchPending,
  hasServerAcknowledgedLocalDispatch,
  isSteerProcessingActivityTimely,
  mergePendingSteerSnapshotsForInterruptedTurn,
  readDeliveredSteerMessageId,
  readRecoveredSteerMessageId,
  readSteerProcessingMessageId,
  restoreCanonicalRetryImages,
  resolveFollowUpQueuePhase,
  resolveSendEnvMode,
  shouldResolvePendingSteerDispatch,
  shouldBackpressurePendingSteerDispatch,
  shouldPinTimelineToEndForLocalMessage,
  shouldWriteThreadErrorToCurrentServerThread,
  waitForStartedServerThread,
} from "./ChatView.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");

const fetchBoundedRetryImage: typeof fetch = async () =>
  new Response(new Uint8Array([137, 80, 78, 71]), {
    status: 200,
    headers: { "content-type": "image/png" },
  });

async function fetchUnavailableRetryImage(url: RequestInfo | URL): Promise<Response> {
  const value = String(url);
  if (value.includes("oversized")) {
    return {
      ok: true,
      blob: async () => ({ size: Number.MAX_SAFE_INTEGER }) as Blob,
    } as Response;
  }
  throw new TypeError("preview transport unavailable");
}

describe("deriveComposerSendState", () => {
  it("ignores stale inline context placeholders when deciding sendability", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text and images sendable", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 1,
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("deriveLockedProvider", () => {
  it("keeps started threads unlocked so they can switch provider instances", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-03-29T00:01:00.000Z",
        startedAt: "2026-03-29T00:01:01.000Z",
        completedAt: "2026-03-29T00:01:30.000Z",
      },
    });

    expect(
      deriveLockedProvider({
        thread: {
          ...thread,
          session: {
            status: "ready",
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            createdAt: "2026-03-29T00:02:00.000Z",
            updatedAt: "2026-03-29T00:02:00.000Z",
            orchestrationStatus: "ready",
          },
        },
        selectedProvider: "codex",
        threadProvider: "claudeAgent",
      }),
    ).toBeNull();
  });
});

describe("mergePendingSteerSnapshotsForInterruptedTurn", () => {
  it("matches Codex TUI by merging pending steer text into one next turn", () => {
    const merged = mergePendingSteerSnapshotsForInterruptedTurn([
      { promptText: "first pending steer", images: [] },
      { promptText: "second pending steer", images: [] },
    ]);

    expect(merged?.promptText).toBe("first pending steer\nsecond pending steer");
    expect(merged?.images).toEqual([]);
  });

  it("preserves image-only steers without adding empty newline padding", () => {
    const file = new File(["image"], "image.png", { type: "image/png" });
    const image = {
      type: "image" as const,
      id: "image-1",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: file.size,
      file,
      previewUrl: "memory:image-1",
    };

    const merged = mergePendingSteerSnapshotsForInterruptedTurn([
      { promptText: "", images: [image] },
      { promptText: "describe this", images: [] },
    ]);

    expect(merged?.promptText).toBe("describe this");
    expect(merged?.images).toEqual([image]);
  });
});

describe("shouldResolvePendingSteerDispatch", () => {
  it("keeps a Codex steer pending when only the previous turn became terminal", () => {
    expect(
      shouldResolvePendingSteerDispatch({
        provider: "codex",
        terminalTurnAfterSteer: true,
        steerProcessingStarted: false,
        steerFailureRecorded: false,
        steerRecoveryRecorded: false,
        assistantResponseAfterSteer: false,
      }),
    ).toBe(false);
  });

  it("resolves once Codex emits the steer processing marker", () => {
    expect(
      shouldResolvePendingSteerDispatch({
        provider: "codex",
        terminalTurnAfterSteer: true,
        steerProcessingStarted: true,
        steerFailureRecorded: false,
        steerRecoveryRecorded: false,
        assistantResponseAfterSteer: false,
      }),
    ).toBe(true);
  });

  it("resolves once the backend records Codex's no-active-turn recovery", () => {
    expect(
      shouldResolvePendingSteerDispatch({
        provider: "codex",
        terminalTurnAfterSteer: true,
        steerProcessingStarted: false,
        steerFailureRecorded: false,
        steerRecoveryRecorded: true,
        assistantResponseAfterSteer: false,
      }),
    ).toBe(true);
  });

  it("preserves the existing terminal-resolution rule for non-Codex providers", () => {
    expect(
      shouldResolvePendingSteerDispatch({
        provider: "claude",
        terminalTurnAfterSteer: true,
        steerProcessingStarted: false,
        steerFailureRecorded: false,
        steerRecoveryRecorded: false,
        assistantResponseAfterSteer: false,
      }),
    ).toBe(true);
  });
});

describe("doesSteerProcessingActivityMatchPending", () => {
  it("settles only the exactly correlated steer when multiple messages share a turn", () => {
    expect(
      doesSteerProcessingActivityMatchPending({
        pendingMessageId: "steer-message-a",
        processingMessageId: "steer-message-a",
        legacyTurnMatches: false,
      }),
    ).toBe(true);
    expect(
      doesSteerProcessingActivityMatchPending({
        pendingMessageId: "steer-message-b",
        processingMessageId: "steer-message-a",
        legacyTurnMatches: true,
      }),
    ).toBe(false);
  });

  it("uses turn correlation only for legacy processing activities without a message id", () => {
    expect(
      doesSteerProcessingActivityMatchPending({
        pendingMessageId: "legacy-steer",
        processingMessageId: null,
        legacyTurnMatches: true,
      }),
    ).toBe(true);
    expect(
      doesSteerProcessingActivityMatchPending({
        pendingMessageId: "legacy-steer",
        processingMessageId: null,
        legacyTurnMatches: false,
      }),
    ).toBe(false);
  });
});

describe("doesSteerFailureActivityMatchPending", () => {
  const messageId = MessageId.make("same-id-steer-retry");
  const failure = {
    id: EventId.make("steer-failure-generation-one"),
    tone: "error" as const,
    kind: "provider.turn.steer.failed",
    summary: "Provider steer failed",
    payload: { messageId, intentSequence: 41 },
    turnId: TurnId.make("turn-1"),
    sequence: 42,
    createdAt: "2026-03-29T00:01:01.000Z",
  };

  it("does not let an older same-id failure settle a newer retry generation", () => {
    expect(
      doesSteerFailureActivityMatchPending({
        activity: failure,
        pendingMessageId: messageId,
        pendingIntentSequence: 77,
        dispatchedAt: "2026-03-29T00:02:00.000Z",
      }),
    ).toBe(false);
    expect(
      doesSteerFailureActivityMatchPending({
        activity: {
          ...failure,
          payload: { messageId, intentSequence: 77 },
          createdAt: "2026-03-29T00:02:00.000Z",
        },
        pendingMessageId: messageId,
        pendingIntentSequence: 77,
        dispatchedAt: "2026-03-29T00:02:00.000Z",
      }),
    ).toBe(true);
  });

  it("uses time as the fail-closed generation fence before the dispatch receipt arrives", () => {
    expect(
      doesSteerFailureActivityMatchPending({
        activity: failure,
        pendingMessageId: messageId,
        pendingIntentSequence: null,
        dispatchedAt: "2026-03-29T00:02:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("readRecoveredSteerMessageId", () => {
  it("reads the exact message from a Codex recovery receipt", () => {
    expect(
      readRecoveredSteerMessageId({
        activityKind: "provider.turn.steer.recovered",
        payload: {
          provider: "codex",
          messageId: "steer-message-recovered",
          acceptedTurnId: "turn-stale",
          recoveredTurnId: "turn-recovered",
        },
      }),
    ).toBe("steer-message-recovered");
  });

  it("rejects provider lookalikes and generic activities", () => {
    expect(
      readRecoveredSteerMessageId({
        activityKind: "provider.turn.steer.recovered",
        payload: { provider: "claudeAgent", messageId: "forged-provider" },
      }),
    ).toBeNull();
    expect(
      readRecoveredSteerMessageId({
        activityKind: "provider.turn.steer.recovered",
        payload: {
          provider: "codex",
          messageId: "incomplete-receipt",
          acceptedTurnId: "turn-stale",
        },
      }),
    ).toBeNull();
    expect(
      readRecoveredSteerMessageId({
        activityKind: "task.progress",
        payload: { provider: "codex", messageId: "wrong-kind" },
      }),
    ).toBeNull();
  });
});

describe("readDeliveredSteerMessageId", () => {
  it("accepts only the exact Codex next-turn delivery receipt", () => {
    expect(
      readDeliveredSteerMessageId({
        activityKind: "provider.turn.steer.delivered",
        payload: {
          provider: "codex",
          messageId: "steer-message-delivered",
          deliveredTurnId: "turn-delivered",
          delivery: "next-turn",
        },
      }),
    ).toBe("steer-message-delivered");

    expect(
      readDeliveredSteerMessageId({
        activityKind: "provider.turn.steer.delivered",
        payload: {
          provider: "claudeAgent",
          messageId: "wrong-provider",
          deliveredTurnId: "turn-delivered",
          delivery: "next-turn",
        },
      }),
    ).toBeNull();
    expect(
      readDeliveredSteerMessageId({
        activityKind: "provider.turn.steer.delivered",
        payload: {
          provider: "codex",
          messageId: "wrong-delivery",
          deliveredTurnId: "turn-delivered",
          delivery: "active-turn",
        },
      }),
    ).toBeNull();
    expect(
      readDeliveredSteerMessageId({
        activityKind: "provider.turn.steer.delivered",
        payload: {
          provider: "codex",
          messageId: "missing-turn",
          delivery: "next-turn",
        },
      }),
    ).toBeNull();
  });

  it("never treats a pre-I/O runtime warning as proof of delivery", () => {
    expect(
      readDeliveredSteerMessageId({
        activityKind: "runtime.warning",
        payload: {
          provider: "codex",
          messageId: "warning-only",
          delivery: "next-turn",
        },
      }),
    ).toBeNull();
  });
});

describe("deriveRetryableSteerReplayCandidates", () => {
  const sourceMessageId = MessageId.make("durable-retry-message");
  const failedTurnId = TurnId.make("turn-review");
  const canonicalMessage = {
    id: sourceMessageId,
    role: "user" as const,
    text: "Please retry this exact prompt",
    attachments: [
      {
        type: "image" as const,
        id: "durable-image",
        name: "diagram.png",
        mimeType: "image/png",
        sizeBytes: 128,
        previewUrl: "/attachments/durable-image",
      },
    ],
    turnId: failedTurnId,
    createdAt: "2026-03-29T00:01:00.000Z",
    streaming: false,
  };
  const retryableFailure = {
    id: EventId.make("retryable-steer-failure"),
    tone: "error" as const,
    kind: "provider.turn.steer.failed",
    summary: "Codex could not steer this active turn",
    payload: {
      provider: "codex",
      messageId: sourceMessageId,
      retryableFollowUp: true,
      codexNonSteerableTurnKind: "review",
    },
    turnId: failedTurnId,
    sequence: 1,
    createdAt: "2026-03-29T00:01:01.000Z",
  };

  it("reconstructs one exact same-thread retry with canonical content after reload", () => {
    const thread = {
      ...makeThread(),
      messages: [canonicalMessage],
      // Repeated delivery of the same durable failure must not manufacture
      // duplicate shelf rows after reconnect or snapshot replay.
      activities: [
        retryableFailure,
        {
          ...retryableFailure,
          id: EventId.make("retryable-steer-failure-replayed"),
          sequence: 2,
          createdAt: "2026-03-29T00:01:02.000Z",
        },
      ],
    };

    const candidates = deriveRetryableSteerReplayCandidates({ thread });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.failure).toEqual({
      messageId: sourceMessageId,
      intentSequence: null,
      turnKind: "review",
    });
    expect(candidates[0]?.message.text).toBe(canonicalMessage.text);
    expect(candidates[0]?.message.attachments).toEqual(canonicalMessage.attachments);
    expect(candidates[0]?.failedAt).toBe("2026-03-29T00:01:02.000Z");

    expect(
      deriveRetryableSteerReplayCandidates({
        thread,
        existingSourceMessageIds: new Set([sourceMessageId]),
      }),
    ).toEqual([]);
  });

  it("ignores warning lookalikes and suppresses failures with a later trusted receipt", () => {
    const warning = {
      id: EventId.make("pre-io-runtime-warning"),
      tone: "info" as const,
      kind: "runtime.warning",
      summary: "Provider request will be retried",
      payload: {
        provider: "codex",
        messageId: sourceMessageId,
        retryableFollowUp: true,
        delivery: "next-turn",
      },
      turnId: failedTurnId,
      sequence: 2,
      createdAt: "2026-03-29T00:01:02.000Z",
    };
    const delivered = {
      id: EventId.make("durable-steer-delivery"),
      tone: "info" as const,
      kind: "provider.turn.steer.delivered",
      summary: "Codex accepted the retry as its next turn",
      payload: {
        provider: "codex",
        messageId: sourceMessageId,
        deliveredTurnId: "turn-retry",
        delivery: "next-turn",
      },
      turnId: TurnId.make("turn-retry"),
      sequence: 3,
      createdAt: "2026-03-29T00:01:03.000Z",
    };

    expect(
      deriveRetryableSteerReplayCandidates({
        thread: {
          ...makeThread(),
          messages: [canonicalMessage],
          activities: [warning],
        },
      }),
    ).toEqual([]);
    expect(
      deriveRetryableSteerReplayCandidates({
        thread: {
          ...makeThread(),
          messages: [canonicalMessage],
          activities: [retryableFailure, warning, delivered],
        },
      }),
    ).toEqual([]);
  });

  it("does not reconstruct an older failure after a same-id retry updated the message", () => {
    expect(
      deriveRetryableSteerReplayCandidates({
        thread: {
          ...makeThread(),
          messages: [
            {
              ...canonicalMessage,
              completedAt: "2026-03-29T00:02:00.000Z",
            },
          ],
          activities: [retryableFailure],
        },
      }),
    ).toEqual([]);

    const currentFailure = {
      ...retryableFailure,
      id: EventId.make("retryable-steer-failure-generation-two"),
      payload: { ...retryableFailure.payload, intentSequence: 77 },
      sequence: 78,
      createdAt: "2026-03-29T00:02:00.000Z",
    };
    expect(
      deriveRetryableSteerReplayCandidates({
        thread: {
          ...makeThread(),
          messages: [
            {
              ...canonicalMessage,
              completedAt: "2026-03-29T00:02:00.000Z",
            },
          ],
          activities: [retryableFailure, currentFailure],
        },
      })[0]?.failure,
    ).toEqual({ messageId: sourceMessageId, intentSequence: 77, turnKind: "review" });
  });
});

describe("shouldBackpressurePendingSteerDispatch", () => {
  it("preserves all 64 admitted entries and queues every excess steer without eviction", () => {
    const pending: string[] = [];
    const backpressured: string[] = [];
    for (let index = 0; index < 130; index += 1) {
      const messageId = `steer-${index}`;
      if (shouldBackpressurePendingSteerDispatch(pending.length)) {
        backpressured.push(messageId);
      } else {
        pending.push(messageId);
      }
    }

    expect(pending).toEqual(Array.from({ length: 64 }, (_, index) => `steer-${index}`));
    expect(backpressured).toEqual(Array.from({ length: 66 }, (_, index) => `steer-${index + 64}`));
    expect(new Set([...pending, ...backpressured]).size).toBe(130);
  });
});

describe("restoreCanonicalRetryImages", () => {
  it("restores canonical document handles without downloading or silently counting them as missing images", async () => {
    const attachment = {
      type: "file" as const,
      id: "copy",
      name: "source.html",
      mimeType: "text/html",
      sizeBytes: 12,
    };
    const fetcher = vi.fn(fetchBoundedRetryImage);
    expect(await restoreCanonicalRetryImages([attachment], fetcher)).toEqual({
      images: [],
      files: [attachment],
      unavailableCount: 0,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      deriveComposerSendState({ prompt: "", imageCount: 0, fileCount: 1 }).hasSendableContent,
    ).toBe(true);
    expect(
      mergePendingSteerSnapshotsForInterruptedTurn([
        { promptText: "", images: [], files: [attachment] },
      ])?.files,
    ).toEqual([attachment]);
  });
  it("restores a bounded canonical image into a resendable File", async () => {
    const restored = await restoreCanonicalRetryImages(
      [
        {
          type: "image",
          id: "attachment-restored",
          name: "restored.png",
          mimeType: "image/png",
          sizeBytes: 4,
          previewUrl: "/attachments/attachment-restored",
        },
      ],
      fetchBoundedRetryImage,
    );

    expect(restored.unavailableCount).toBe(0);
    expect(restored.images).toHaveLength(1);
    expect(restored.images[0]).toMatchObject({
      id: "attachment-restored",
      name: "restored.png",
      mimeType: "image/png",
      sizeBytes: 4,
      previewUrl: "/attachments/attachment-restored",
    });
    expect(restored.images[0]?.file).toBeInstanceOf(File);
    expect(new Uint8Array(await restored.images[0]!.file.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
  });

  it("fails unavailable, rejected, and oversized attachments closed", async () => {
    const fetcher = vi.fn(fetchUnavailableRetryImage);

    const restored = await restoreCanonicalRetryImages(
      [
        {
          type: "image",
          id: "attachment-no-preview",
          name: "no-preview.png",
          mimeType: "image/png",
          sizeBytes: 4,
        },
        {
          type: "image",
          id: "attachment-unreachable",
          name: "unreachable.png",
          mimeType: "image/png",
          sizeBytes: 4,
          previewUrl: "/attachments/unreachable",
        },
        {
          type: "image",
          id: "attachment-oversized",
          name: "oversized.png",
          mimeType: "image/png",
          sizeBytes: 4,
          previewUrl: "/attachments/oversized",
        },
      ],
      fetcher,
    );

    expect(restored).toEqual({ images: [], files: [], unavailableCount: 3 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("isSteerProcessingActivityTimely", () => {
  it("accepts exact message correlation despite client/server clock skew", () => {
    expect(
      isSteerProcessingActivityTimely({
        processingMessageId: "exact-message",
        activityCreatedAt: "2026-01-01T00:00:00.000Z",
        dispatchedAt: "2026-01-01T00:05:00.000Z",
      }),
    ).toBe(true);
  });

  it("retains the timestamp guard for legacy uncorrelated activities", () => {
    expect(
      isSteerProcessingActivityTimely({
        processingMessageId: null,
        activityCreatedAt: "2026-01-01T00:00:00.000Z",
        dispatchedAt: "2026-01-01T00:05:00.000Z",
      }),
    ).toBe(false);
  });
});

describe("readSteerProcessingMessageId", () => {
  it("prefers an explicit message id and supports nested runtime metadata", () => {
    expect(
      readSteerProcessingMessageId({
        messageId: "explicit-message",
        usage: { messageId: "nested-message" },
      }),
    ).toBe("explicit-message");
    expect(readSteerProcessingMessageId({ usage: { messageId: "nested-message" } })).toBe(
      "nested-message",
    );
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
  });

  it("forces local mode for non-git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
    expect(resolveSendEnvMode({ requestedEnvMode: "local", isGitRepo: false })).toBe("local");
  });
});

describe("shouldPinTimelineToEndForLocalMessage", () => {
  it("always pins local user submissions to the conversation tail", () => {
    expect(shouldPinTimelineToEndForLocalMessage()).toBe(true);
  });
});

describe("resolveFollowUpQueuePhase", () => {
  it("treats a completed active turn as ready even when the session status is still running", () => {
    const turnId = TurnId.make("turn-completed");

    expect(
      resolveFollowUpQueuePhase({
        phase: "running",
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: "2026-03-29T00:01:30.000Z",
          assistantMessageId: null,
        },
        activeTurnId: turnId,
      }),
    ).toBe("ready");
  });

  it("trusts visible turn completion even when the provider active turn id is stale", () => {
    expect(
      resolveFollowUpQueuePhase({
        phase: "running",
        latestTurn: {
          turnId: TurnId.make("turn-completed"),
          state: "completed",
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: "2026-03-29T00:01:30.000Z",
          assistantMessageId: null,
        },
        activeTurnId: TurnId.make("stale-provider-turn"),
      }),
    ).toBe("ready");
  });

  it("keeps a post-completion running session with no active turn non-dispatchable", () => {
    const completedAt = "2026-03-29T00:01:30.000Z";

    expect(
      resolveFollowUpQueuePhase({
        phase: "running",
        latestTurn: {
          turnId: TurnId.make("turn-completed"),
          state: "completed",
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt,
          assistantMessageId: null,
        },
        activeTurnId: null,
        sessionUpdatedAt: "2026-03-29T00:01:31.000Z",
      }),
    ).toBe("running");
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("routes errors to the active server thread when route and target match", () => {
    const threadId = ThreadId.make("thread-1");
    const routeThreadRef = scopeThreadRef(localEnvironmentId, threadId);

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: {
          environmentId: localEnvironmentId,
          id: threadId,
        },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
  });

  it("does not route draft-thread errors into server-backed state", () => {
    const threadId = ThreadId.make("thread-1");

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        serverThread: undefined,
        routeThreadRef: scopeThreadRef(localEnvironmentId, threadId),
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

const makeThread = (input?: {
  id?: ThreadId;
  latestTurn?: {
    turnId: TurnId;
    state: "running" | "completed";
    requestedAt: string;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
}): Thread => ({
  id: input?.id ?? ThreadId.make("thread-1"),
  environmentId: localEnvironmentId,
  codexThreadId: null,
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  session: null,
  messages: [],
  proposedPlans: [],
  error: null,
  createdAt: "2026-03-29T00:00:00.000Z",
  archivedAt: null,
  updatedAt: "2026-03-29T00:00:00.000Z",
  latestTurn: input?.latestTurn
    ? {
        ...input.latestTurn,
        assistantMessageId: null,
      }
    : null,
  branch: null,
  worktreePath: null,
  turnDiffSummaries: [],
  activities: [],
});

function setStoreThreads(threads: ReadonlyArray<ReturnType<typeof makeThread>>) {
  const projectId = ProjectId.make("project-1");
  const environmentState: EnvironmentState = {
    projectIds: [projectId],
    projectById: {
      [projectId]: {
        id: projectId,
        environmentId: localEnvironmentId,
        name: "Project",
        cwd: "/tmp/project",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        createdAt: "2026-03-29T00:00:00.000Z",
        updatedAt: "2026-03-29T00:00:00.000Z",
        scripts: [],
      },
    },
    threadIds: threads.map((thread) => thread.id),
    threadIdsByProjectId: {
      [projectId]: threads.map((thread) => thread.id),
    },
    threadShellById: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        {
          id: thread.id,
          environmentId: thread.environmentId,
          codexThreadId: thread.codexThreadId,
          projectId: thread.projectId,
          title: thread.title,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          error: thread.error,
          createdAt: thread.createdAt,
          archivedAt: thread.archivedAt,
          updatedAt: thread.updatedAt,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
        },
      ]),
    ),
    threadSessionById: Object.fromEntries(threads.map((thread) => [thread.id, thread.session])),
    threadTurnStateById: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        {
          latestTurn: thread.latestTurn,
          ...(thread.pendingSourceProposedPlan
            ? { pendingSourceProposedPlan: thread.pendingSourceProposedPlan }
            : {}),
        },
      ]),
    ),
    messageIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.messages.map((message) => message.id)]),
    ),
    messageByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.messages.map((message) => [message.id, message])),
      ]),
    ),
    activityIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.activities.map((activity) => activity.id)]),
    ),
    activityByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.activities.map((activity) => [activity.id, activity])),
      ]),
    ),
    proposedPlanIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [thread.id, thread.proposedPlans.map((plan) => plan.id)]),
    ),
    proposedPlanByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.proposedPlans.map((plan) => [plan.id, plan])),
      ]),
    ),
    turnDiffIdsByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        thread.turnDiffSummaries.map((summary) => summary.turnId),
      ]),
    ),
    turnDiffSummaryByThreadId: Object.fromEntries(
      threads.map((thread) => [
        thread.id,
        Object.fromEntries(thread.turnDiffSummaries.map((summary) => [summary.turnId, summary])),
      ]),
    ),
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
  useStore.setState({
    activeEnvironmentId: localEnvironmentId,
    environmentStateById: {
      [localEnvironmentId]: environmentState,
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setStoreThreads([]);
});

describe("waitForStartedServerThread", () => {
  it("resolves immediately when the thread is already started", async () => {
    const threadId = ThreadId.make("thread-started");
    setStoreThreads([
      makeThread({
        id: threadId,
        latestTurn: {
          turnId: TurnId.make("turn-started"),
          state: "running",
          requestedAt: "2026-03-29T00:00:01.000Z",
          startedAt: "2026-03-29T00:00:01.000Z",
          completedAt: null,
        },
      }),
    ]);

    await expect(
      waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId)),
    ).resolves.toBe(true);
  });

  it("waits for the thread to start via subscription updates", async () => {
    const threadId = ThreadId.make("thread-wait");
    setStoreThreads([makeThread({ id: threadId })]);

    const promise = waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500);

    setStoreThreads([
      makeThread({
        id: threadId,
        latestTurn: {
          turnId: TurnId.make("turn-started"),
          state: "running",
          requestedAt: "2026-03-29T00:00:01.000Z",
          startedAt: "2026-03-29T00:00:01.000Z",
          completedAt: null,
        },
      }),
    ]);

    await expect(promise).resolves.toBe(true);
  });

  it("handles the thread starting between the initial read and subscription setup", async () => {
    const threadId = ThreadId.make("thread-race");
    setStoreThreads([makeThread({ id: threadId })]);

    const originalSubscribe = useStore.subscribe.bind(useStore);
    let raced = false;
    vi.spyOn(useStore, "subscribe").mockImplementation((listener) => {
      if (!raced) {
        raced = true;
        setStoreThreads([
          makeThread({
            id: threadId,
            latestTurn: {
              turnId: TurnId.make("turn-race"),
              state: "running",
              requestedAt: "2026-03-29T00:00:01.000Z",
              startedAt: "2026-03-29T00:00:01.000Z",
              completedAt: null,
            },
          }),
        ]);
      }
      return originalSubscribe(listener);
    });

    await expect(
      waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500),
    ).resolves.toBe(true);
  });

  it("returns false after the timeout when the thread never starts", async () => {
    vi.useFakeTimers();

    const threadId = ThreadId.make("thread-timeout");
    setStoreThreads([makeThread({ id: threadId })]);
    const promise = waitForStartedServerThread(scopeThreadRef(localEnvironmentId, threadId), 500);

    await vi.advanceTimersByTimeAsync(500);

    await expect(promise).resolves.toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  const projectId = ProjectId.make("project-1");
  const previousLatestTurn = {
    turnId: TurnId.make("turn-1"),
    state: "completed" as const,
    requestedAt: "2026-03-29T00:00:00.000Z",
    startedAt: "2026-03-29T00:00:01.000Z",
    completedAt: "2026-03-29T00:00:10.000Z",
    assistantMessageId: null,
  };

  const previousSession = {
    provider: ProviderDriverKind.make("codex"),
    status: "ready" as const,
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:10.000Z",
    orchestrationStatus: "idle" as const,
  };

  it("does not clear local dispatch before server state changes", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: previousSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("clears local dispatch when a new turn is already settled", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: {
          ...previousLatestTurn,
          turnId: TurnId.make("turn-2"),
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: "2026-03-29T00:01:30.000Z",
        },
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:01:30.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("clears local dispatch when the latest turn settled after dispatch even if fields already match", () => {
    const completedLatestTurn = {
      ...previousLatestTurn,
      turnId: TurnId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };
    const completedSession = {
      ...previousSession,
      updatedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch: {
          startedAt: "2026-03-29T00:01:10.000Z",
          preparingWorktree: false,
          latestTurnTurnId: completedLatestTurn.turnId,
          latestTurnRequestedAt: completedLatestTurn.requestedAt,
          latestTurnStartedAt: completedLatestTurn.startedAt,
          latestTurnCompletedAt: completedLatestTurn.completedAt,
          sessionOrchestrationStatus: completedSession.orchestrationStatus,
          sessionUpdatedAt: completedSession.updatedAt,
        },
        phase: "ready",
        latestTurn: completedLatestTurn,
        session: completedSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("does not clear local dispatch while the session is running a newer turn than latestTurn", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-2"),
          updatedAt: "2026-03-29T00:01:00.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("does not clear local dispatch while the session is running but latestTurn has not advanced yet", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: undefined,
          updatedAt: "2026-03-29T00:01:00.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("clears local dispatch once the running latestTurn matches the active session turn", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: {
          ...previousLatestTurn,
          turnId: TurnId.make("turn-2"),
          state: "running",
          requestedAt: "2026-03-29T00:01:00.000Z",
          startedAt: "2026-03-29T00:01:01.000Z",
          completedAt: null,
        },
        session: {
          ...previousSession,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("turn-2"),
          updatedAt: "2026-03-29T00:01:01.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("clears local dispatch when the session changes without an observed running phase", () => {
    const localDispatch = createLocalDispatchSnapshot({
      id: ThreadId.make("thread-1"),
      environmentId: localEnvironmentId,
      codexThreadId: null,
      projectId,
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      session: previousSession,
      messages: [],
      proposedPlans: [],
      error: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      archivedAt: null,
      updatedAt: "2026-03-29T00:00:10.000Z",
      latestTurn: previousLatestTurn,
      branch: null,
      worktreePath: null,
      turnDiffSummaries: [],
      activities: [],
    });

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: previousLatestTurn,
        session: {
          ...previousSession,
          updatedAt: "2026-03-29T00:00:11.000Z",
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });
});
