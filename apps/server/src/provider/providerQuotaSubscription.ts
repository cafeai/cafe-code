import type {
  ProviderSession,
  ProviderSessionQuotaInput,
  ProviderSessionQuotaResult,
  ThreadId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { ProviderAccountQuotaReading, ProviderInstance } from "./ProviderDriver.ts";

export const UNAVAILABLE_SESSION_QUOTA: ProviderSessionQuotaResult = { report: null };

/** Reused public ids cannot authorize a result from a retired account instance. */
export const readBoundInstanceQuota = (
  resolveInstance: Effect.Effect<
    Pick<ProviderInstance, "enabled" | "driverKind" | "readAccountQuota"> | undefined
  >,
): Effect.Effect<ProviderAccountQuotaReading> =>
  Effect.gen(function* () {
    const instance = yield* resolveInstance;
    if (!instance?.enabled || instance.driverKind !== "claudeAgent" || !instance.readAccountQuota)
      return UNAVAILABLE_SESSION_QUOTA;
    const reading = yield* instance.readAccountQuota;
    return (yield* resolveInstance) === instance ? reading : UNAVAILABLE_SESSION_QUOTA;
  });

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

export function sameProviderQuotaAuthority(
  left: ProviderQuotaAuthority,
  right: ProviderQuotaAuthority,
): boolean {
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

/** Revalidate saved shell/configuration around the selected instance's bounded
 * native allowance read. If there is no usable native reading, use only the
 * same admitted instance's current passive reports. Exact-chat requests retain
 * their binding, and Settings can read native allowances before any chat exists. */
export const readBoundProviderQuota = (
  input: ProviderSessionQuotaInput,
  resolveAuthority: Effect.Effect<ProviderQuotaAuthority | undefined>,
  readSessions: Effect.Effect<ReadonlyArray<ProviderSession>>,
  readAccountQuota?: Effect.Effect<ProviderAccountQuotaReading>,
): Effect.Effect<ProviderAccountQuotaReading> =>
  Effect.gen(function* () {
    const before = yield* resolveAuthority;
    if (!before || (before.sessions.length === 0 && (input.session || !readAccountQuota)))
      return UNAVAILABLE_SESSION_QUOTA;
    // Duplicate saved bindings (even to different chats) cannot establish a
    // singular query owner. Treat corrupt/ambiguous authority as unavailable.
    if (
      new Set(before.sessions.map((session) => session.threadId)).size !== before.sessions.length ||
      new Set(before.sessions.map((session) => session.runtimeId)).size !== before.sessions.length
    )
      return UNAVAILABLE_SESSION_QUOTA;
    if (readAccountQuota) {
      const reading = yield* readAccountQuota;
      const after = yield* resolveAuthority;
      if (!after || !sameProviderQuotaAuthority(before, after)) return UNAVAILABLE_SESSION_QUOTA;
      if (reading.report) return reading;
    }
    const sessions = yield* readSessions;
    const after = yield* resolveAuthority;
    if (!after || !sameProviderQuotaAuthority(before, after)) return UNAVAILABLE_SESSION_QUOTA;

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
  read: Effect.Effect<ProviderAccountQuotaReading>,
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
      return Stream.fromEffectRepeat(
        Queue.take(queue).pipe(
          // The shared cache expires one minute after native lookup completion.
          // Wait from the completed read, so a slow first lookup cannot make a
          // fixed subscription tick miss its expiry and double the interval.
          Effect.timeoutOption("60 seconds"),
          Effect.andThen(
            Effect.gen(function* () {
              const started = generation;
              const result = yield* read.pipe(
                // Cold account selection and the control-only read have separate
                // finite allowances. Include their joined native cleanup plus
                // both authority observations, without widening either child.
                Effect.timeout(15_000),
                Effect.catchCause(() =>
                  Effect.succeed<ProviderAccountQuotaReading>(UNAVAILABLE_SESSION_QUOTA),
                ),
              );
              // No await between the final generation checks and publication.
              // The reader's private guard must never enter the public stream.
              const { isCurrent, ...reading } = result;
              return started === generation && (!isCurrent || isCurrent())
                ? reading
                : UNAVAILABLE_SESSION_QUOTA;
            }),
          ),
        ),
      ).pipe(Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)));
    }),
  );
}
