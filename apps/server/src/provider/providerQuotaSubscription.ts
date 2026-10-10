import type {
  ProviderSession,
  ProviderSessionQuotaInput,
  ProviderSessionQuotaResult,
  ThreadId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export const UNAVAILABLE_SESSION_QUOTA: ProviderSessionQuotaResult = { report: null };

/** Denial is an inert subscription, not successful stream completion. The
 * websocket client's live-subscription loop reconnects after completion, so a
 * finite unavailable stream would become automatic request churn. Hold only
 * this null level until cancellation, with no inventory/events/provider work. */
export const unavailableProviderQuotaStream = (): Stream.Stream<ProviderSessionQuotaResult> =>
  Stream.concat(Stream.make(UNAVAILABLE_SESSION_QUOTA), Stream.never);

/** These are private projection/configuration commitments, not evidence of a
 * stable authenticated Claude principal. The renderer supplies no native path. */
export interface ProviderQuotaAuthority {
  readonly configuration: string;
  readonly snapshotSequence: number;
  readonly sessions: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly runtimeId: string;
    readonly cwd: string;
  }>;
}

function sameAuthority(left: ProviderQuotaAuthority, right: ProviderQuotaAuthority): boolean {
  return (
    left.configuration === right.configuration &&
    // The global projection may advance because an unrelated chat streams.
    // Compare only exact admitted tuples/configuration here. The subscriber's
    // relevant invalidation generation additionally fences tuple/config ABA.
    left.sessions.length === right.sessions.length &&
    left.sessions.every((session, index) => {
      const other = right.sessions[index];
      return (
        other !== undefined &&
        session.threadId === other.threadId &&
        session.runtimeId === other.runtimeId &&
        session.cwd === other.cwd
      );
    })
  );
}

/** Read only the existing owner's volatile inventory. Revalidate the saved
 * shell/configuration around this possibly remote read; no native quota
 * control, local fallback, transcript scan, or provider startup belongs here.
 * Settings may select the newest observation, but only from the same admitted
 * instance's current shell-bound sessions. Sidebar requests remain exact. */
export const readBoundProviderQuota = (
  input: ProviderSessionQuotaInput,
  resolveAuthority: Effect.Effect<ProviderQuotaAuthority | undefined>,
  readSessions: Effect.Effect<ReadonlyArray<ProviderSession>>,
): Effect.Effect<ProviderSessionQuotaResult> =>
  Effect.gen(function* () {
    const before = yield* resolveAuthority;
    if (!before || before.sessions.length === 0) return UNAVAILABLE_SESSION_QUOTA;
    // Duplicate saved bindings (even to different chats) cannot establish a
    // singular query owner. Treat corrupt/ambiguous authority as unavailable.
    if (
      new Set(before.sessions.map((session) => session.threadId)).size !== before.sessions.length ||
      new Set(before.sessions.map((session) => session.runtimeId)).size !== before.sessions.length
    )
      return UNAVAILABLE_SESSION_QUOTA;
    const sessions = yield* readSessions;
    const after = yield* resolveAuthority;
    if (!after || !sameAuthority(before, after)) return UNAVAILABLE_SESSION_QUOTA;

    let newest: ProviderSession["quotaReport"];
    for (const admitted of after.sessions) {
      if (
        input.session &&
        (admitted.threadId !== input.session.threadId ||
          admitted.runtimeId !== input.session.runtimeId)
      )
        continue;
      // An ambiguous duplicate is not authorization to pick either owner.
      const matching = sessions.filter(
        (session) =>
          session.threadId === admitted.threadId &&
          session.providerInstanceId === input.instanceId &&
          session.provider === "claudeAgent" &&
          session.subagentRuntimeId === admitted.runtimeId &&
          session.commandCatalogConfigurationKey === after.configuration &&
          session.cwd === admitted.cwd &&
          session.status !== "closed" &&
          session.status !== "error",
      );
      if (matching.length > 1) return UNAVAILABLE_SESSION_QUOTA;
      const report = matching[0]?.quotaReport;
      if (report && (!newest || report.observedAt > newest.observedAt)) newest = report;
    }
    return newest ? { report: newest } : UNAVAILABLE_SESSION_QUOTA;
  });

/** One content-free volatile slot coalesces bursts into a trailing read. Start
 * every invalidation source before the initial inventory, then synchronously
 * fence publication against observed invalidations (including configuration
 * ABA changes). A cancelled subscriber never cancels or changes a provider.
 * Timeout/failure is deliberately unavailable and never retimestamps a report. */
export function subscribeProviderQuota(
  read: Effect.Effect<ProviderSessionQuotaResult>,
  invalidations: ReadonlyArray<Stream.Stream<unknown>>,
): Stream.Stream<ProviderSessionQuotaResult> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.sliding<void>(1);
      yield* Effect.addFinalizer(() => Queue.shutdown(queue));
      let generation = 0;
      for (const source of invalidations) {
        yield* Stream.runForEach(source, () =>
          Effect.sync(() => {
            generation++;
          }).pipe(Effect.andThen(Queue.offer(queue, undefined))),
        ).pipe(Effect.forkScoped({ startImmediately: true }));
      }
      yield* Queue.offer(queue, undefined);
      return Stream.fromQueue(queue).pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            const started = generation;
            const result = yield* read.pipe(
              Effect.timeout(5_000),
              Effect.catchCause(() => Effect.succeed(UNAVAILABLE_SESSION_QUOTA)),
            );
            // No await between the final generation comparison and return.
            return started === generation ? result : UNAVAILABLE_SESSION_QUOTA;
          }),
        ),
        Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
      );
    }),
  );
}
