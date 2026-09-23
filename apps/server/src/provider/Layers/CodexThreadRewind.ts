import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";

import { ProviderAdapterRewindOutcomeUnknownError } from "../Errors.ts";

// Rewind needs turn identities, not message/tool bodies. Bound both each
// metadata-only page and the total walk so corrupt cursors cannot monopolize a
// provider session. This permits 16,384 turns without hydrating their content.
export const CODEX_REWIND_PAGE_SIZE = 64;
export const CODEX_REWIND_MAX_PAGES = 256;
export const CODEX_REWIND_PREFLIGHT_TIMEOUT = "30 seconds";

export interface CodexThreadRewindClient {
  readonly request: CodexClient.CodexAppServerClientShape["request"];
  readonly raw: Pick<CodexClient.CodexAppServerClientShape["raw"], "request">;
}

const decodeLegacyRollbackResponse = Schema.decodeUnknownEffect(CodexSchema.V2ThreadReadResponse);
const goalCanContinue = (
  status: CodexSchema.V2ThreadGoalGetResponse__ThreadGoalStatus | undefined,
) => status === "active" || status === "usageLimited";

/**
 * Codex 0.156 removed `thread/rollback`. Its supported replacement reverts a
 * paginated thread before an exact native turn and returns metadata only:
 * https://github.com/openai/codex/blob/fe74a774532af67b5a4a3dec03ce9469e17f89af/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
 *
 * Select that operation from the provider's observed history mode, without
 * probing by mutation or retrying an uncertain mutation. Legacy providers keep
 * their original rollback operation; a newer provider that cannot rewind a
 * legacy history fails visibly rather than reconstructing a new conversation.
 */
export const rewindCodexThreadWithClient = Effect.fn(
  "CodexSessionRuntime.rewindCodexThreadWithClient",
)(function* (input: {
  readonly client: CodexThreadRewindClient;
  readonly providerThreadId: string;
  readonly numTurns: number;
}) {
  if (!Number.isSafeInteger(input.numTurns) || input.numTurns < 1) {
    return yield* CodexErrors.CodexAppServerRequestError.invalidParams(
      "Codex rewind requires a positive safe integer turn count",
    );
  }

  const preflight = yield* Effect.gen(function* () {
    const metadata = yield* input.client.request("thread/read", {
      threadId: input.providerThreadId,
      includeTurns: false,
    });
    if (metadata.thread.id !== input.providerThreadId) {
      return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
        "Codex rewind thread identity did not match",
      );
    }
    if (metadata.thread.status.type !== "idle") {
      return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
        "Stop the active Codex turn before rewinding",
      );
    }

    if (metadata.thread.historyMode !== "paginated") {
      return { historyMode: "legacy" } as const;
    }

    const boundary = yield* Effect.gen(function* () {
      const goal = yield* input.client.request("thread/goal/get", {
        threadId: input.providerThreadId,
      });
      if (goalCanContinue(goal.goal?.status)) {
        return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
          "Pause the active Codex goal before rewinding",
        );
      }
      const seenCursors = new Set<string>();
      const seenTurns = new Set<string>();
      let cursor: string | undefined;
      let remaining = input.numTurns;
      let latestTurnId: string | undefined;

      for (let page = 0; page < CODEX_REWIND_MAX_PAGES; page += 1) {
        const limit = Math.min(CODEX_REWIND_PAGE_SIZE, remaining);
        const response = yield* input.client.request("thread/turns/list", {
          threadId: input.providerThreadId,
          sortDirection: "desc",
          itemsView: "notLoaded",
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        if (response.data.length > limit) {
          return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
            "Codex rewind history exceeded its requested page size",
          );
        }
        latestTurnId ??= response.data[0]?.id;
        for (const turn of response.data) {
          // Duplicated or blank turn ids could select an earlier destructive
          // boundary than the requested count. Reject the whole preflight.
          if (turn.id.length === 0 || seenTurns.has(turn.id)) {
            return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
              "Codex rewind history contained an invalid turn identity",
            );
          }
          seenTurns.add(turn.id);
          if (turn.status === "inProgress") {
            return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
              "Stop the active Codex turn before rewinding",
            );
          }
          remaining -= 1;
        }
        const target = response.data.at(-1);
        if (remaining === 0 && target && latestTurnId) {
          // Capture one retained turn before mutation. After a failed native
          // ACK, matching this exact tail distinguishes the intended prefix
          // from an unchanged history or some unrelated concurrent truncation.
          let retainedTurnId: string | null = null;
          if (response.nextCursor) {
            const retained = yield* input.client.request("thread/turns/list", {
              threadId: input.providerThreadId,
              sortDirection: "desc",
              itemsView: "notLoaded",
              limit: 1,
              cursor: response.nextCursor,
            });
            const retainedTurn = retained.data[0];
            if (
              retained.data.length !== 1 ||
              !retainedTurn?.id ||
              seenTurns.has(retainedTurn.id) ||
              retainedTurn.status === "inProgress"
            ) {
              return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
                "Codex rewind retained history boundary was invalid",
              );
            }
            retainedTurnId = retainedTurn.id;
          }
          return {
            beforeTurnId: target.id,
            latestTurnId,
            retainedTurnId,
            originalTail: [...seenTurns, ...(retainedTurnId ? [retainedTurnId] : [])],
          };
        }
        const nextCursor = response.nextCursor;
        if (response.data.length === 0 || !nextCursor) {
          return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
            "Codex rewind requested more turns than the available history",
          );
        }
        if (seenCursors.has(nextCursor)) {
          return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
            "Codex rewind history repeated a pagination cursor",
          );
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
        "Codex rewind exceeds the bounded history lookup limit",
      );
    });

    // Native revert can shut down active work, unlike old rollback. Recheck the
    // provider's idle state and goal admission after pagination, immediately
    // before the one mutation. Cafe's surrounding thread lock serializes local
    // input; refusing active goals closes their autonomous continuation path.
    const current = yield* input.client.request("thread/read", {
      threadId: input.providerThreadId,
      includeTurns: false,
    });
    const currentGoal = yield* input.client.request("thread/goal/get", {
      threadId: input.providerThreadId,
    });
    if (
      current.thread.id !== input.providerThreadId ||
      current.thread.historyMode !== "paginated" ||
      current.thread.status.type !== "idle" ||
      goalCanContinue(currentGoal.goal?.status)
    ) {
      return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
        "Codex rewind state changed during history lookup",
      );
    }
    const newest = yield* input.client.request("thread/turns/list", {
      threadId: input.providerThreadId,
      sortDirection: "desc",
      itemsView: "notLoaded",
      limit: 1,
    });
    if (
      newest.data.length !== 1 ||
      newest.data[0]?.id !== boundary.latestTurnId ||
      newest.data[0]?.status === "inProgress"
    ) {
      return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
        "Codex rewind history changed during lookup",
      );
    }
    return { historyMode: "paginated", ...boundary } as const;
  }).pipe(
    // One deadline covers every read, including the initial metadata and final
    // admission recheck. The RPC client itself has no request timeout, and a
    // stuck preflight otherwise holds Cafe's lifecycle lock indefinitely after
    // CheckpointReactor has already restored the target filesystem checkpoint.
    // Mutations remain outside this deadline: cancelling an ambiguous mutation
    // must never authorize a retry or a different destructive operation.
    Effect.timeoutOrElse({
      duration: CODEX_REWIND_PREFLIGHT_TIMEOUT,
      orElse: () =>
        Effect.fail(
          CodexErrors.CodexAppServerRequestError.invalidRequest(
            "Codex rewind history lookup timed out",
          ),
        ),
    }),
  );

  if (preflight.historyMode === "legacy") {
    // The old response has the same thread envelope as thread/read. Keep this
    // narrow compatibility decoder outside the generated current method map;
    // never re-add a deleted method to the current upstream schema by hand.
    const response = yield* input.client.raw.request("thread/rollback", {
      threadId: input.providerThreadId,
      numTurns: input.numTurns,
    });
    return yield* decodeLegacyRollbackResponse(response).pipe(
      Effect.mapError(
        () =>
          new CodexErrors.CodexAppServerProtocolParseError({
            detail: "Invalid legacy Codex rewind response",
          }),
      ),
    );
  }
  // The native mutation is issued exactly once. Its empty turns array is the
  // documented metadata-only result, not evidence that all history was deleted.
  // Upstream commits its store replacement BEFORE reloading the runtime, which
  // can fail before the ACK (thread_processor.rs:thread_revert_response). Thus
  // even a JSON-RPC error can follow a successful durable mutation. Reconcile
  // only after failure; never turn a successful ACK into a fallible extra read.
  return yield* input.client
    .request("thread/revert", {
      threadId: input.providerThreadId,
      beforeTurnId: preflight.beforeTurnId,
    })
    .pipe(
      Effect.catch((failure) =>
        Effect.gen(function* () {
          const reconciliation = yield* Effect.gen(function* () {
            const metadata = yield* input.client.request("thread/read", {
              threadId: input.providerThreadId,
              includeTurns: false,
            });
            const goal = yield* input.client.request("thread/goal/get", {
              threadId: input.providerThreadId,
            });
            if (
              metadata.thread.id !== input.providerThreadId ||
              metadata.thread.historyMode !== "paginated" ||
              metadata.thread.status.type !== "idle" ||
              goalCanContinue(goal.goal?.status)
            ) {
              return { outcome: "unknown" } as const;
            }
            const newest = yield* input.client.request("thread/turns/list", {
              threadId: input.providerThreadId,
              sortDirection: "desc",
              itemsView: "notLoaded",
              limit: 1,
            });
            const latest = newest.data[0];
            if (
              (preflight.retainedTurnId === null &&
                newest.data.length === 0 &&
                !newest.nextCursor) ||
              (preflight.retainedTurnId !== null &&
                newest.data.length === 1 &&
                latest?.id === preflight.retainedTurnId &&
                latest.status !== "inProgress")
            ) {
              return { outcome: "committed", response: metadata } as const;
            }

            // A transport/parse failure does not establish that the request has
            // settled: its mutation might still commit after an unchanged read.
            // Only a completed JSON-RPC error plus an exact unchanged tail may
            // authorize the existing filesystem compensation path.
            if (
              failure._tag !== "CodexAppServerRequestError" ||
              newest.data.length !== 1 ||
              latest?.id !== preflight.latestTurnId ||
              latest.status === "inProgress"
            ) {
              return { outcome: "unknown" } as const;
            }
            let matched = 1;
            let cursor = newest.nextCursor;
            const seenCursors = new Set<string>();
            while (matched < preflight.originalTail.length) {
              if (!cursor || seenCursors.has(cursor)) return { outcome: "unknown" } as const;
              seenCursors.add(cursor);
              const limit = Math.min(
                CODEX_REWIND_PAGE_SIZE,
                preflight.originalTail.length - matched,
              );
              const page = yield* input.client.request("thread/turns/list", {
                threadId: input.providerThreadId,
                sortDirection: "desc",
                itemsView: "notLoaded",
                limit,
                cursor,
              });
              if (page.data.length === 0 || page.data.length > limit) {
                return { outcome: "unknown" } as const;
              }
              for (const turn of page.data) {
                if (turn.id !== preflight.originalTail[matched] || turn.status === "inProgress") {
                  return { outcome: "unknown" } as const;
                }
                matched += 1;
              }
              cursor = page.nextCursor;
            }
            if (preflight.retainedTurnId === null && cursor) {
              return { outcome: "unknown" } as const;
            }
            return { outcome: "unchanged" } as const;
          }).pipe(
            Effect.timeoutOrElse({
              duration: CODEX_REWIND_PREFLIGHT_TIMEOUT,
              orElse: () => Effect.succeed({ outcome: "unknown" } as const),
            }),
            Effect.catch(() => Effect.succeed({ outcome: "unknown" } as const)),
          );
          if (reconciliation.outcome === "committed") return reconciliation.response;
          if (reconciliation.outcome === "unchanged") {
            return yield* CodexErrors.CodexAppServerRequestError.invalidRequest(
              "Codex rewind was not applied; the original conversation history was verified unchanged",
            );
          }
          return yield* new ProviderAdapterRewindOutcomeUnknownError({});
        }),
      ),
    );
});
