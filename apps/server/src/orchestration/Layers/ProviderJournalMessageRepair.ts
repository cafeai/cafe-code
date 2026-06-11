import {
  CommandId,
  EventId,
  MessageId,
  ProviderRuntimeEvent,
  type ProviderJournalMessageRepairInput,
  type ProviderJournalMessageRepairResult,
  type ProviderMessageRepairSource,
  type ProviderRuntimeEvent as ProviderRuntimeEventValue,
  type ProviderThreadAssistantMessagesRepairInput,
  type ProviderThreadAssistantMessagesRepairResult,
  RuntimeItemId,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import type { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderJournalMessageRepair,
  type ProviderJournalMessageRepairShape,
} from "../Services/ProviderJournalMessageRepair.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import type { ProviderThreadSnapshot } from "../../provider/Services/ProviderAdapter.ts";
import {
  assistantCompletionTextFromRuntimeEvent,
  prefixSafeAssistantRepairSuffix,
} from "../providerAssistantCompletionText.ts";

const PROVIDER_JOURNAL_REPAIR_CANDIDATE_LIMIT = 50;
const ASSISTANT_MESSAGE_ID_PREFIX = "assistant:";

const decodeProviderRuntimeEventJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderRuntimeEvent),
);

interface ProviderJournalEventRow {
  readonly cursor: number;
  readonly emittedAt: string;
  readonly eventJson: string;
}

interface RepairCandidate {
  readonly cursor: number;
  readonly event: ProviderRuntimeEventValue;
  readonly completionText: string;
}

interface RepairCompletionSource {
  readonly source: ProviderMessageRepairSource;
  readonly provider: ProviderRuntimeEventValue["provider"];
  readonly providerInstanceId?: ProviderRuntimeEventValue["providerInstanceId"];
  readonly itemId?: RuntimeItemId;
  readonly sourceEventId?: EventId;
  readonly completionText: string;
  readonly sourceKey: string;
  readonly auditSummary: string;
}

interface UpstreamRepairCandidate {
  readonly turnId: TurnId;
  readonly itemId?: RuntimeItemId;
  readonly completionText: string;
  readonly sourceKey: string;
}

type UpstreamThreadReadState =
  | {
      readonly type: "not-requested";
    }
  | {
      readonly type: "unavailable";
      readonly reason: string;
    }
  | {
      readonly type: "available";
      readonly snapshot: ProviderThreadSnapshot;
      readonly provider: ProviderRuntimeEventValue["provider"];
      readonly providerInstanceId?: ProviderRuntimeEventValue["providerInstanceId"];
    };

const safeResult = (
  input: ProviderJournalMessageRepairInput,
  result: Omit<ProviderJournalMessageRepairResult, "threadId" | "messageId">,
): ProviderJournalMessageRepairResult => ({
  threadId: input.threadId,
  messageId: input.messageId,
  ...result,
});

const nonNegativeLength = (value: string) => value.length;

function expectedItemIdFromMessageId(messageId: MessageId): string | undefined {
  const value = String(messageId);
  if (!value.startsWith(ASSISTANT_MESSAGE_ID_PREFIX)) {
    return undefined;
  }
  const itemId = value.slice(ASSISTANT_MESSAGE_ID_PREFIX.length);
  return itemId.length > 0 ? itemId : undefined;
}

function dedupeCandidatesByEventId(
  candidates: ReadonlyArray<RepairCandidate>,
): ReadonlyArray<RepairCandidate> {
  const byEventId = new Map<string, RepairCandidate>();
  for (const candidate of candidates) {
    const key = String(candidate.event.eventId);
    const existing = byEventId.get(key);
    if (existing === undefined || candidate.cursor > existing.cursor) {
      byEventId.set(key, candidate);
    }
  }
  return [...byEventId.values()].toSorted((left, right) => right.cursor - left.cursor);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function upstreamAgentMessageCandidates(input: {
  readonly snapshot: ProviderThreadSnapshot;
  readonly turnId: TurnId;
}): ReadonlyArray<UpstreamRepairCandidate> {
  const turn = input.snapshot.turns.find((candidateTurn) => candidateTurn.id === input.turnId);
  if (turn === undefined) {
    return [];
  }

  const candidates: UpstreamRepairCandidate[] = [];
  for (const item of turn.items) {
    if (!isRecord(item) || item.type !== "agentMessage" || typeof item.text !== "string") {
      continue;
    }
    if (item.text.trim().length === 0) {
      continue;
    }
    const rawItemId = typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
    candidates.push({
      turnId: input.turnId,
      ...(rawItemId !== undefined ? { itemId: RuntimeItemId.make(rawItemId) } : {}),
      completionText: item.text,
      sourceKey:
        rawItemId !== undefined ? `agentMessage:${rawItemId}` : `agentMessage:${candidates.length}`,
    });
  }
  return candidates;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectionThreadMessages = yield* ProjectionThreadMessageRepository;
  const projectionTurns = yield* ProjectionTurnRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;

  const queryCompletionCandidates = (input: {
    readonly threadId: string;
    readonly turnId: string;
  }) =>
    Effect.gen(function* () {
      const rows = (yield* sql`
        SELECT
          cursor,
          emitted_at AS "emittedAt",
          event_json AS "eventJson"
        FROM provider_daemon_events
        WHERE json_extract(event_json, '$.threadId') = ${input.threadId}
          AND json_extract(event_json, '$.turnId') = ${input.turnId}
          AND json_extract(event_json, '$.type') = 'item.completed'
          AND json_extract(event_json, '$.payload.itemType') = 'assistant_message'
        ORDER BY cursor DESC
        LIMIT ${PROVIDER_JOURNAL_REPAIR_CANDIDATE_LIMIT}
      `) as unknown as ReadonlyArray<ProviderJournalEventRow>;

      const candidates: RepairCandidate[] = [];
      let malformedRows = 0;
      for (const row of rows) {
        const decoded = yield* Effect.exit(
          Effect.sync(() => decodeProviderRuntimeEventJson(row.eventJson)),
        );
        if (Exit.isFailure(decoded)) {
          malformedRows += 1;
          continue;
        }

        const event = decoded.value;
        const completionText = assistantCompletionTextFromRuntimeEvent(event);
        if (completionText !== undefined && completionText.trim().length > 0) {
          candidates.push({
            cursor: row.cursor,
            event,
            completionText,
          });
        }
      }

      if (malformedRows > 0) {
        yield* Effect.logWarning("provider journal repair skipped malformed completion rows", {
          threadId: input.threadId,
          turnId: input.turnId,
          malformedRows,
        });
      }

      return dedupeCandidatesByEventId(candidates);
    });

  const dispatchRepairAuditActivity = (input: {
    readonly repairInput: ProviderJournalMessageRepairInput;
    readonly source: RepairCompletionSource;
    readonly oldLength: number;
    readonly newLength: number;
    readonly appendedLength: number;
    readonly turnId: TurnId;
    readonly createdAt: string;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(
          [
            "server:assistant-repair-activity",
            input.repairInput.threadId,
            input.repairInput.messageId,
            input.source.source,
            input.source.sourceKey,
            input.oldLength,
            input.newLength,
          ].join(":"),
        ),
        threadId: input.repairInput.threadId,
        activity: {
          id: EventId.make(crypto.randomUUID()),
          tone: "info",
          kind: "assistant.repair.applied",
          summary: input.source.auditSummary,
          payload: {
            messageId: input.repairInput.messageId,
            turnId: input.turnId,
            source: input.source.source,
            provider: input.source.provider,
            providerInstanceId: input.source.providerInstanceId ?? null,
            itemId: input.source.itemId ?? null,
            sourceEventId: input.source.sourceEventId ?? null,
            oldLength: input.oldLength,
            newLength: input.newLength,
            appendedLength: input.appendedLength,
          },
          turnId: input.turnId,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.asVoid);

  const applyPrefixSafeRepair = (input: {
    readonly repairInput: ProviderJournalMessageRepairInput;
    readonly message: ProjectionThreadMessage;
    readonly source: RepairCompletionSource;
    readonly candidateCount: number;
  }) =>
    Effect.gen(function* () {
      const initialRepair = prefixSafeAssistantRepairSuffix({
        projectedText: input.message.text,
        completionText: input.source.completionText,
      });
      if (initialRepair.type === "unchanged") {
        return safeResult(input.repairInput, {
          status: "unchanged",
          reason: "message-already-matches-provider-completion",
          oldLength: nonNegativeLength(input.message.text),
          newLength: nonNegativeLength(input.message.text),
          appendedLength: 0,
          candidateCount: input.candidateCount,
          provider: input.source.provider,
          ...(input.source.providerInstanceId !== undefined
            ? { providerInstanceId: input.source.providerInstanceId }
            : {}),
          ...(input.source.itemId !== undefined ? { itemId: input.source.itemId } : {}),
          ...(input.source.sourceEventId !== undefined
            ? { sourceEventId: input.source.sourceEventId }
            : {}),
          source: input.source.source,
        });
      }
      if (initialRepair.type !== "append") {
        return safeResult(input.repairInput, {
          status: "diverged",
          reason:
            initialRepair.type === "empty-completion"
              ? "empty-provider-completion"
              : "projected-text-not-provider-prefix",
          oldLength: nonNegativeLength(input.message.text),
          candidateCount: input.candidateCount,
          source: input.source.source,
        });
      }

      const latestMessageOption = yield* projectionThreadMessages.getByThreadAndMessageId({
        threadId: input.repairInput.threadId,
        messageId: input.repairInput.messageId,
      });
      if (Option.isNone(latestMessageOption)) {
        return safeResult(input.repairInput, {
          status: "not-eligible",
          reason: "message-not-found-before-apply",
          oldLength: nonNegativeLength(input.message.text),
          source: input.source.source,
        });
      }

      const latestMessage = latestMessageOption.value;
      const latestRepair = prefixSafeAssistantRepairSuffix({
        projectedText: latestMessage.text,
        completionText: input.source.completionText,
      });
      if (latestRepair.type === "unchanged") {
        return safeResult(input.repairInput, {
          status: "unchanged",
          reason: "message-already-repaired",
          oldLength: nonNegativeLength(latestMessage.text),
          newLength: nonNegativeLength(latestMessage.text),
          appendedLength: 0,
          candidateCount: input.candidateCount,
          provider: input.source.provider,
          ...(input.source.providerInstanceId !== undefined
            ? { providerInstanceId: input.source.providerInstanceId }
            : {}),
          ...(input.source.itemId !== undefined ? { itemId: input.source.itemId } : {}),
          ...(input.source.sourceEventId !== undefined
            ? { sourceEventId: input.source.sourceEventId }
            : {}),
          source: input.source.source,
        });
      }
      if (latestRepair.type !== "append") {
        return safeResult(input.repairInput, {
          status: "diverged",
          reason:
            latestRepair.type === "empty-completion"
              ? "empty-provider-completion"
              : "latest-projected-text-not-provider-prefix",
          oldLength: nonNegativeLength(latestMessage.text),
          candidateCount: input.candidateCount,
          source: input.source.source,
        });
      }

      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const oldLength = nonNegativeLength(latestMessage.text);
      const appendedLength = nonNegativeLength(latestRepair.suffix);
      const newLength = oldLength + appendedLength;
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.repair-suffix",
        commandId: CommandId.make(
          [
            "server:assistant-repair",
            input.source.source,
            input.repairInput.threadId,
            input.repairInput.messageId,
            input.source.sourceKey,
            oldLength,
            newLength,
          ].join(":"),
        ),
        threadId: input.repairInput.threadId,
        messageId: input.repairInput.messageId,
        turnId: latestMessage.turnId ?? input.message.turnId!,
        suffix: latestRepair.suffix,
        provider: input.source.provider,
        ...(input.source.providerInstanceId !== undefined
          ? { providerInstanceId: input.source.providerInstanceId }
          : {}),
        ...(input.source.itemId !== undefined ? { itemId: input.source.itemId } : {}),
        source: input.source.source,
        ...(input.source.sourceEventId !== undefined
          ? { sourceEventId: input.source.sourceEventId }
          : {}),
        oldLength,
        newLength,
        appendedLength,
        createdAt,
      });

      yield* dispatchRepairAuditActivity({
        repairInput: input.repairInput,
        source: input.source,
        oldLength,
        newLength,
        appendedLength,
        turnId: latestMessage.turnId ?? input.message.turnId!,
        createdAt,
      });

      return safeResult(input.repairInput, {
        status: "repaired",
        reason: "suffix-appended",
        oldLength,
        newLength,
        appendedLength,
        candidateCount: input.candidateCount,
        provider: input.source.provider,
        ...(input.source.providerInstanceId !== undefined
          ? { providerInstanceId: input.source.providerInstanceId }
          : {}),
        ...(input.source.itemId !== undefined ? { itemId: input.source.itemId } : {}),
        ...(input.source.sourceEventId !== undefined
          ? { sourceEventId: input.source.sourceEventId }
          : {}),
        source: input.source.source,
      });
    });

  const repairOnce = (input: ProviderJournalMessageRepairInput) =>
    Effect.gen(function* () {
      const messageOption = yield* projectionThreadMessages.getByThreadAndMessageId({
        threadId: input.threadId,
        messageId: input.messageId,
      });
      if (Option.isNone(messageOption)) {
        return safeResult(input, {
          status: "not-eligible",
          reason: "message-not-found",
        });
      }

      const message = messageOption.value;
      if (message.role !== "assistant") {
        return safeResult(input, {
          status: "not-eligible",
          reason: "non-assistant-message",
          oldLength: nonNegativeLength(message.text),
        });
      }
      if (message.isStreaming) {
        return safeResult(input, {
          status: "not-eligible",
          reason: "message-still-streaming",
          oldLength: nonNegativeLength(message.text),
        });
      }
      if (message.turnId === null) {
        return safeResult(input, {
          status: "not-eligible",
          reason: "message-without-turn",
          oldLength: nonNegativeLength(message.text),
        });
      }

      const turnOption = yield* projectionTurns.getByTurnId({
        threadId: input.threadId,
        turnId: message.turnId,
      });
      if (Option.isNone(turnOption)) {
        return safeResult(input, {
          status: "not-eligible",
          reason: "turn-not-found",
          oldLength: nonNegativeLength(message.text),
        });
      }

      const turn = turnOption.value;
      if (turn.state === "pending" || turn.state === "running") {
        return safeResult(input, {
          status: "not-eligible",
          reason: "turn-not-terminal",
          oldLength: nonNegativeLength(message.text),
        });
      }

      const candidates = yield* queryCompletionCandidates({
        threadId: input.threadId,
        turnId: message.turnId,
      });
      if (candidates.length === 0) {
        return safeResult(input, {
          status: "source-not-found",
          reason: "no-retained-assistant-completion",
          oldLength: nonNegativeLength(message.text),
          candidateCount: 0,
        });
      }

      const expectedItemId = expectedItemIdFromMessageId(input.messageId);
      const prefixSafeCandidates = candidates
        .map((candidate) => ({
          candidate,
          repair: prefixSafeAssistantRepairSuffix({
            projectedText: message.text,
            completionText: candidate.completionText,
          }),
        }))
        .filter((entry) => entry.repair.type === "append" || entry.repair.type === "unchanged");

      if (prefixSafeCandidates.length === 0) {
        return safeResult(input, {
          status: "diverged",
          reason: "projected-text-not-provider-prefix",
          oldLength: nonNegativeLength(message.text),
          candidateCount: candidates.length,
        });
      }

      const exactMatches =
        expectedItemId !== undefined
          ? prefixSafeCandidates.filter(
              (entry) => String(entry.candidate.event.itemId) === expectedItemId,
            )
          : [];
      const rankedCandidates = exactMatches.length > 0 ? exactMatches : prefixSafeCandidates;
      if (rankedCandidates.length !== 1) {
        return safeResult(input, {
          status: "ambiguous-source",
          reason:
            exactMatches.length > 1
              ? "multiple-exact-provider-items"
              : "multiple-prefix-safe-provider-items",
          oldLength: nonNegativeLength(message.text),
          candidateCount: rankedCandidates.length,
        });
      }

      const selected = rankedCandidates[0]!;
      return yield* applyPrefixSafeRepair({
        repairInput: input,
        message,
        source: {
          source: "provider-journal",
          provider: selected.candidate.event.provider,
          ...(selected.candidate.event.providerInstanceId !== undefined
            ? { providerInstanceId: selected.candidate.event.providerInstanceId }
            : {}),
          ...(selected.candidate.event.itemId !== undefined
            ? { itemId: selected.candidate.event.itemId as RuntimeItemId }
            : {}),
          sourceEventId: selected.candidate.event.eventId,
          completionText: selected.candidate.completionText,
          sourceKey: String(selected.candidate.event.eventId),
          auditSummary: "Assistant message repaired from provider journal",
        },
        candidateCount: candidates.length,
      });
    });

  const readUpstreamThreadState = (threadId: ThreadId): Effect.Effect<UpstreamThreadReadState> =>
    Effect.gen(function* () {
      if (providerService.readThread === undefined) {
        return {
          type: "unavailable",
          reason: "upstream-thread-read-unsupported",
        } satisfies UpstreamThreadReadState;
      }

      const snapshotExit = yield* Effect.exit(providerService.readThread({ threadId }));
      if (Exit.isFailure(snapshotExit)) {
        yield* Effect.logWarning("provider thread repair upstream read failed", {
          threadId,
          causeType: Cause.hasInterruptsOnly(snapshotExit.cause) ? "interrupted" : "failure",
        });
        return {
          type: "unavailable",
          reason: "upstream-thread-read-failed",
        } satisfies UpstreamThreadReadState;
      }

      return {
        type: "available",
        snapshot: snapshotExit.value.snapshot,
        provider: snapshotExit.value.provider,
        providerInstanceId: snapshotExit.value.providerInstanceId,
      } satisfies UpstreamThreadReadState;
    });

  const repairFromUpstreamState = (input: {
    readonly repairInput: ProviderJournalMessageRepairInput;
    readonly message: ProjectionThreadMessage;
    readonly upstreamState: UpstreamThreadReadState;
  }) =>
    Effect.gen(function* () {
      if (input.upstreamState.type === "not-requested") {
        return safeResult(input.repairInput, {
          status: "upstream-unavailable",
          reason: "upstream-read-not-requested",
          oldLength: nonNegativeLength(input.message.text),
          source: "upstream-provider",
        });
      }
      if (input.upstreamState.type === "unavailable") {
        return safeResult(input.repairInput, {
          status: "upstream-unavailable",
          reason: input.upstreamState.reason,
          oldLength: nonNegativeLength(input.message.text),
          source: "upstream-provider",
        });
      }
      if (input.message.turnId === null) {
        return safeResult(input.repairInput, {
          status: "not-eligible",
          reason: "message-without-turn",
          oldLength: nonNegativeLength(input.message.text),
          source: "upstream-provider",
        });
      }

      const candidates = upstreamAgentMessageCandidates({
        snapshot: input.upstreamState.snapshot,
        turnId: input.message.turnId,
      });
      if (candidates.length === 0) {
        return safeResult(input.repairInput, {
          status: "source-not-found",
          reason: "no-upstream-assistant-completion",
          oldLength: nonNegativeLength(input.message.text),
          candidateCount: 0,
          source: "upstream-provider",
        });
      }

      const expectedItemId = expectedItemIdFromMessageId(input.repairInput.messageId);
      const prefixSafeCandidates = candidates
        .map((candidate) => ({
          candidate,
          repair: prefixSafeAssistantRepairSuffix({
            projectedText: input.message.text,
            completionText: candidate.completionText,
          }),
        }))
        .filter((entry) => entry.repair.type === "append" || entry.repair.type === "unchanged");

      if (prefixSafeCandidates.length === 0) {
        return safeResult(input.repairInput, {
          status: "diverged",
          reason: "projected-text-not-upstream-prefix",
          oldLength: nonNegativeLength(input.message.text),
          candidateCount: candidates.length,
          source: "upstream-provider",
        });
      }

      const exactMatches =
        expectedItemId !== undefined
          ? prefixSafeCandidates.filter(
              (entry) =>
                entry.candidate.itemId !== undefined &&
                String(entry.candidate.itemId) === expectedItemId,
            )
          : [];
      const rankedCandidates = exactMatches.length > 0 ? exactMatches : prefixSafeCandidates;
      if (rankedCandidates.length !== 1) {
        return safeResult(input.repairInput, {
          status: "ambiguous-source",
          reason:
            exactMatches.length > 1
              ? "multiple-exact-upstream-items"
              : "multiple-prefix-safe-upstream-items",
          oldLength: nonNegativeLength(input.message.text),
          candidateCount: rankedCandidates.length,
          source: "upstream-provider",
        });
      }

      const selected = rankedCandidates[0]!.candidate;
      return yield* applyPrefixSafeRepair({
        repairInput: input.repairInput,
        message: input.message,
        source: {
          source: "upstream-provider",
          provider: input.upstreamState.provider,
          ...(input.upstreamState.providerInstanceId !== undefined
            ? { providerInstanceId: input.upstreamState.providerInstanceId }
            : {}),
          ...(selected.itemId !== undefined ? { itemId: selected.itemId } : {}),
          completionText: selected.completionText,
          sourceKey: selected.sourceKey,
          auditSummary: "Assistant message repaired from upstream provider history",
        },
        candidateCount: candidates.length,
      });
    });

  const aggregateThreadRepairResults = (input: {
    readonly threadId: ThreadId;
    readonly sourcePolicy: ProviderThreadAssistantMessagesRepairResult["sourcePolicy"];
    readonly totalMessages: number;
    readonly localAttempts: number;
    readonly upstreamAttempts: number;
    readonly results: ReadonlyArray<ProviderJournalMessageRepairResult>;
  }): ProviderThreadAssistantMessagesRepairResult => {
    const count = (status: ProviderJournalMessageRepairResult["status"]) =>
      input.results.filter((result) => result.status === status).length;
    return {
      threadId: input.threadId,
      sourcePolicy: input.sourcePolicy,
      counts: {
        totalMessages: input.totalMessages,
        eligibleMessages: input.results.filter((result) => result.status !== "not-eligible").length,
        localAttempts: input.localAttempts,
        upstreamAttempts: input.upstreamAttempts,
        repaired: count("repaired"),
        unchanged: count("unchanged"),
        notEligible: count("not-eligible"),
        sourceNotFound: count("source-not-found"),
        ambiguousSource: count("ambiguous-source"),
        diverged: count("diverged"),
        upstreamUnavailable: count("upstream-unavailable"),
        failed: count("failed"),
      },
      results: [...input.results],
    };
  };

  const repairThreadAssistantMessages: ProviderJournalMessageRepairShape["repairThreadAssistantMessages"] =
    (input: ProviderThreadAssistantMessagesRepairInput) =>
      Effect.gen(function* () {
        const sourcePolicy = input.sourcePolicy ?? "local-then-upstream";
        const messages = (yield* projectionThreadMessages.listByThreadId({
          threadId: input.threadId,
        })).filter((message) => message.role === "assistant");
        const results: ProviderJournalMessageRepairResult[] = [];
        let localAttempts = 0;
        let upstreamAttempts = 0;
        let upstreamState: UpstreamThreadReadState = { type: "not-requested" };

        const getUpstreamState = Effect.gen(function* () {
          if (upstreamState.type === "not-requested") {
            upstreamState = yield* readUpstreamThreadState(input.threadId);
          }
          return upstreamState;
        });

        for (const message of messages) {
          const repairInput: ProviderJournalMessageRepairInput = {
            threadId: input.threadId,
            messageId: message.messageId,
          };

          if (sourcePolicy !== "upstream-only") {
            localAttempts += 1;
            const localResult = yield* repairOnce(repairInput);
            if (sourcePolicy === "local-only" || localResult.status !== "source-not-found") {
              results.push(localResult);
              continue;
            }
          }

          upstreamAttempts += 1;
          const currentMessageOption = yield* projectionThreadMessages.getByThreadAndMessageId({
            threadId: input.threadId,
            messageId: message.messageId,
          });
          if (Option.isNone(currentMessageOption)) {
            results.push(
              safeResult(repairInput, {
                status: "not-eligible",
                reason: "message-not-found-before-upstream-repair",
                oldLength: nonNegativeLength(message.text),
                source: "upstream-provider",
              }),
            );
            continue;
          }

          const state = yield* getUpstreamState;
          results.push(
            yield* repairFromUpstreamState({
              repairInput,
              message: currentMessageOption.value,
              upstreamState: state,
            }),
          );
        }

        return aggregateThreadRepairResults({
          threadId: input.threadId,
          sourcePolicy,
          totalMessages: messages.length,
          localAttempts,
          upstreamAttempts,
          results,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider thread assistant repair failed", {
            threadId: input.threadId,
            causeType: Cause.hasInterruptsOnly(cause) ? "interrupted" : "failure",
          }).pipe(
            Effect.as(
              aggregateThreadRepairResults({
                threadId: input.threadId,
                sourcePolicy: input.sourcePolicy ?? "local-then-upstream",
                totalMessages: 0,
                localAttempts: 0,
                upstreamAttempts: 0,
                results: [
                  safeResult(
                    {
                      threadId: input.threadId,
                      messageId: MessageId.make("thread-repair"),
                    },
                    {
                      status: "failed",
                      reason: "thread-repair-failed",
                    },
                  ),
                ],
              }),
            ),
          ),
        ),
      );

  const repairAssistantMessage: ProviderJournalMessageRepairShape["repairAssistantMessage"] = (
    input,
  ) =>
    repairOnce(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider journal assistant repair failed", {
          threadId: input.threadId,
          messageId: input.messageId,
          causeType: Cause.hasInterruptsOnly(cause) ? "interrupted" : "failure",
        }).pipe(
          Effect.as(
            safeResult(input, {
              status: "failed",
              reason: "repair-failed",
            }),
          ),
        ),
      ),
    );

  return {
    repairAssistantMessage,
    repairThreadAssistantMessages,
  } satisfies ProviderJournalMessageRepairShape;
});

export const ProviderJournalMessageRepairLive = Layer.effect(
  ProviderJournalMessageRepair,
  make,
).pipe(
  Layer.provide(ProjectionThreadMessageRepositoryLive),
  Layer.provide(ProjectionTurnRepositoryLive),
);
