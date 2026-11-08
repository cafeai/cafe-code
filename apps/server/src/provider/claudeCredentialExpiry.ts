import {
  ServerProviderCredentialExpiry as CredentialExpirySchema,
  type ServerProvider,
  type ServerProviderCredentialExpiry,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

/** Public callback payloads contain no native conversation, account or path. */
export interface ClaudeCredentialExpiryObservation {
  readonly resultIndex: number;
  readonly expiresAt: string | undefined;
  readonly observedAt: string;
}

/** One opaque Cafe lease belongs to one independently bound native query. */
export interface ClaudeCredentialExpiryLease {
  readonly observe: (observation: ClaudeCredentialExpiryObservation) => Effect.Effect<void>;
  readonly retire: Effect.Effect<void>;
}

// This is advisory metadata, not a complete active-session inventory. Keep at
// most64 live observations; missing/omitted information never means no expiry.
export const MAX_CLAUDE_CREDENTIAL_EXPIRY_OWNERS = 64;

/**
 * The SDK promises ISO8601, not arbitrary Date.parse input. Validate calendar
 * and offset components before normalizing to one finite UTC wire format.
 * Reject inherited/accessor slots at the SDK boundary before calling this
 * pure parser; a malformed string never becomes a public native observation.
 */
export function parseClaudeCredentialExpiry(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 20 || value.length > 40) return undefined;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!parts) return undefined;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return undefined;
  if (parts[8] !== "Z") {
    const offset = parts[8]!;
    if (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59) return undefined;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return undefined;
  const canonical = DateTime.formatIso(DateTime.makeUnsafe(milliseconds));
  return canonical.length === 24 ? canonical : undefined;
}

/** Current-runtime evidence must never be persisted or revived from a cache. */
export function withoutClaudeCredentialExpiry(provider: ServerProvider): ServerProvider {
  if (!Object.hasOwn(provider.auth, "credentialExpiry")) return provider;
  const { credentialExpiry: _retired, ...auth } = provider.auth;
  return { ...provider, auth };
}

const decodeAdvisory = Schema.decodeUnknownOption(CredentialExpirySchema);

/**
 * Decorate this exact Claude driver's snapshot with a volatile level. Advisory
 * invalidations contain no values; every consumer reads the current live-owner
 * level rather than replaying a delayed result. Native probe operations retain
 * their original implementations, parameters, cancellation and scheduling.
 */
export const makeClaudeCredentialExpiry = Effect.fn("makeClaudeCredentialExpiry")(function* () {
  const entries = new Map<
    object,
    { readonly isCurrent: () => boolean; readonly advisory: ServerProviderCredentialExpiry }
  >();
  let closed = false;
  const changes = yield* Effect.acquireRelease(PubSub.sliding<void>(1), (pubsub) =>
    Effect.sync(() => {
      closed = true;
      entries.clear();
    }).pipe(Effect.andThen(PubSub.shutdown(pubsub))),
  );
  const current = (isCurrent: () => boolean): boolean => {
    if (closed) return false;
    try {
      return isCurrent() === true;
    } catch {
      return false;
    }
  };
  const prune = (): boolean => {
    let changed = false;
    for (const [owner, entry] of entries) {
      if (!current(entry.isCurrent)) {
        entries.delete(owner);
        changed = true;
      }
    }
    return changed;
  };
  const latest = (): ServerProviderCredentialExpiry | undefined => {
    // The current-snapshot getter stays inert: filter retired owners without
    // mutating even this metadata map. Admission prunes stale entries before
    // applying its resource cap; scope teardown clears all retained closures.
    let selected: ServerProviderCredentialExpiry | undefined;
    for (const { advisory, isCurrent } of entries.values()) {
      if (!current(isCurrent)) continue;
      if (
        !selected ||
        advisory.expiresAt < selected.expiresAt ||
        (advisory.expiresAt === selected.expiresAt && advisory.observedAt > selected.observedAt)
      )
        selected = advisory;
    }
    return selected;
  };
  const invalidate = () => PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const onOwner = (isCurrent: () => boolean): Effect.Effect<ClaudeCredentialExpiryLease> =>
    Effect.sync(() => {
      const owner = Object.freeze({});
      let retired = false;
      let lastIndex = -1;
      return {
        observe: (observation: ClaudeCredentialExpiryObservation) =>
          Effect.sync(() => {
            if (
              retired ||
              !current(isCurrent) ||
              !Number.isSafeInteger(observation.resultIndex) ||
              observation.resultIndex < 0 ||
              observation.resultIndex <= lastIndex
            )
              return false;
            // Advance the exact lease's index even if a defensive validation
            // fails, so an older callback cannot restore its previous deadline.
            lastIndex = observation.resultIndex;
            // Absence is a numbered native observation too; do not let an
            // invalid callback timestamp clear a previous valid advisory.
            if (parseClaudeCredentialExpiry(observation.observedAt) !== observation.observedAt)
              return false;
            // Another query can observe while a retired owner is still awaiting
            // native capability cleanup. Pruning that owner changes the public
            // level even when this new observation has no advisory of its own.
            const pruned = prune();
            if (observation.expiresAt === undefined) return entries.delete(owner) || pruned;
            const parsed = decodeAdvisory({
              source: "native-result",
              expiresAt: observation.expiresAt,
              observedAt: observation.observedAt,
            });
            if (Option.isNone(parsed)) return pruned;
            if (!entries.has(owner) && entries.size >= MAX_CLAUDE_CREDENTIAL_EXPIRY_OWNERS)
              return pruned;
            entries.set(owner, { isCurrent, advisory: parsed.value });
            return true;
          }).pipe(Effect.flatMap((changed) => (changed ? invalidate() : Effect.void))),
        retire: Effect.sync(() => {
          retired = true;
          return entries.delete(owner);
        }).pipe(Effect.flatMap((changed) => (changed ? invalidate() : Effect.void))),
      } satisfies ClaudeCredentialExpiryLease;
    });
  const project = (provider: ServerProvider): ServerProvider => {
    const clean = withoutClaudeCredentialExpiry(provider);
    if (clean.driver !== "claudeAgent" || !clean.enabled) return clean;
    const credentialExpiry = latest();
    return credentialExpiry ? { ...clean, auth: { ...clean.auth, credentialExpiry } } : clean;
  };
  const decorate = (provider: ServerProviderShape): ServerProviderShape => {
    const getCurrentSnapshot = provider.getCurrentSnapshot;
    // This private decorator has exactly the managed Claude provider caller,
    // whose inert current getter is required. Falling back to getSnapshot here
    // would turn a metadata notification into a native settings/probe action.
    if (!getCurrentSnapshot) throw new Error("Claude expiry requires an inert current snapshot.");
    return {
      ...provider,
      getSnapshot: provider.getSnapshot.pipe(Effect.map(project)),
      getCurrentSnapshot: getCurrentSnapshot.pipe(Effect.map(project)),
      refresh: provider.refresh.pipe(Effect.map(project)),
      ...(provider.refreshAfterAccountChange
        ? {
            refreshAfterAccountChange: provider.refreshAfterAccountChange.pipe(Effect.map(project)),
          }
        : {}),
      ...(provider.refreshAccountUsage
        ? { refreshAccountUsage: provider.refreshAccountUsage.pipe(Effect.map(project)) }
        : {}),
      ...(provider.refreshModels
        ? { refreshModels: provider.refreshModels.pipe(Effect.map(project)) }
        : {}),
      ...(provider.setAccountUsage
        ? {
            setAccountUsage: (
              limits: Parameters<NonNullable<ServerProviderShape["setAccountUsage"]>>[0],
            ) => provider.setAccountUsage!(limits).pipe(Effect.map(project)),
          }
        : {}),
      streamChanges: Stream.merge(
        provider.streamChanges.pipe(Stream.map(project)),
        Stream.fromPubSub(changes).pipe(
          Stream.mapEffect(() => getCurrentSnapshot.pipe(Effect.map(project))),
        ),
      ),
    };
  };
  return { onOwner, decorate };
});
