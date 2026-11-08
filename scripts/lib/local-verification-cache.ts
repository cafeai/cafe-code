import { types } from "node:util";
import type {
  LocalVerificationFingerprint,
  LocalVerificationInputSnapshot,
  LocalVerificationReceiptStore,
  LocalVerificationTask,
} from "./local-verification-cache-contract.ts";

export type LocalVerificationCacheFailure = "cancelled" | "invalid-fingerprint" | "inputs-changed";

/** These observations describe a gate, never its inputs or reuse authority.
 * A per-run callback avoids associating one concurrent owner's refusal with
 * another task. No received error, digest, path or environment is projected. */
export interface LocalVerificationCacheDiagnostic {
  readonly phase: "pre-execute" | "reuse-recheck" | "post-execute" | "post-publication";
  readonly outcome: "admitted" | "unavailable" | "refused";
  readonly key: "not-compared" | "same" | "changed" | "unavailable";
  readonly fence: "not-compared" | "same" | "changed" | "unavailable";
  readonly reason?: LocalVerificationCacheFailure;
}

export type LocalVerificationCacheObserver = (diagnostic: LocalVerificationCacheDiagnostic) => void;

export interface LocalVerificationCacheFailureObservation {
  readonly reason: LocalVerificationCacheFailure;
  readonly diagnostic?: LocalVerificationCacheDiagnostic;
}

const failureObservations = new WeakMap<object, LocalVerificationCacheFailureObservation>();

/** Lookup never inspects a received error, including proxies and forged
 * prototypes. Only this module's constructor/internal failure path can mint
 * the finite observation; callers must not format arbitrary error fields. */
export function readLocalVerificationCacheFailure(
  value: unknown,
): LocalVerificationCacheFailureObservation | undefined {
  if ((typeof value !== "object" || value === null) && typeof value !== "function")
    return undefined;
  return failureObservations.get(value);
}

/** Fixed operational feedback, never received environment, paths or causes. */
export class LocalVerificationCacheError extends Error {
  readonly reason: LocalVerificationCacheFailure;
  readonly diagnostic?: LocalVerificationCacheDiagnostic;
  constructor(reason: LocalVerificationCacheFailure) {
    super(
      reason === "cancelled"
        ? "Local verification task cancelled; no current task qualification was granted."
        : reason === "inputs-changed"
          ? "Local verification task inputs changed; no current task qualification was granted."
          : "Local verification could not bind valid task inputs; no current task qualification was granted.",
    );
    if (reason !== "cancelled" && reason !== "inputs-changed" && reason !== "invalid-fingerprint")
      throw new TypeError("Unsupported local verification cache failure reason.");
    this.name = "LocalVerificationCacheError";
    this.reason = reason;
    failureObservations.set(this, Object.freeze({ reason }));
  }
}

export interface LocalVerificationCacheResult {
  readonly status: "fresh" | "reused";
  readonly message: string;
}

export interface LocalVerificationCache {
  /** The trusted executor must resolve only after the exact task's native
   * close and owned cleanup, and reject any failure/uncertain close. This
   * coordinator does not reinterpret an exit or manufacture that receipt. */
  run(
    task: LocalVerificationTask,
    signal: AbortSignal,
    execute: () => Promise<void>,
    observe?: LocalVerificationCacheObserver,
  ): Promise<LocalVerificationCacheResult>;
}

const digest = /^[a-f0-9]{64}$/;

function readSnapshot(value: unknown): LocalVerificationInputSnapshot | undefined {
  if (value === undefined) return undefined;
  // The current producer is code-owned, but a malformed/proxy/getter result
  // must not fabricate cache authority or execute arbitrary property access.
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
    throw new LocalVerificationCacheError("invalid-fingerprint");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new LocalVerificationCacheError("invalid-fingerprint");
  const properties = Object.getOwnPropertyDescriptors(value);
  const key: unknown = properties.key?.value;
  const fence: unknown = properties.fence?.value;
  if (
    Reflect.ownKeys(value).length !== 2 ||
    Object.keys(properties).sort().join(",") !== "fence,key" ||
    !properties.key ||
    !("value" in properties.key) ||
    !properties.fence ||
    !("value" in properties.fence) ||
    typeof key !== "string" ||
    !digest.test(key) ||
    typeof fence !== "string" ||
    !digest.test(fence)
  )
    throw new LocalVerificationCacheError("invalid-fingerprint");
  return Object.freeze({ key, fence });
}

/** Explicit local session only. Canonical CI/release runners never construct
 * this coordinator. Receipts are produced only by actual successful tasks in
 * this lane, not imported historical logs or partial graph output. */
export function createLocalVerificationCache(options: {
  readonly store: LocalVerificationReceiptStore;
  readonly fingerprint: LocalVerificationFingerprint;
  readonly fresh?: boolean;
}): LocalVerificationCache {
  const { store, fingerprint } = options;
  const fresh = options.fresh === true;
  return {
    async run(task, signal, execute, observe) {
      let phase: LocalVerificationCacheDiagnostic["phase"] = "pre-execute";
      const failure = (
        reason: LocalVerificationCacheFailure,
        diagnostic: LocalVerificationCacheDiagnostic,
      ) => {
        const error = new LocalVerificationCacheError(reason);
        // Only internally constructed finite fields can reach this property.
        // Do not copy properties from a caught fingerprint/executor error.
        Object.defineProperty(error, "diagnostic", {
          value: Object.freeze(diagnostic),
          enumerable: true,
          writable: false,
          configurable: false,
        });
        failureObservations.set(error, Object.freeze({ reason, diagnostic }));
        return error;
      };
      const report = (diagnostic: LocalVerificationCacheDiagnostic) => {
        try {
          observe?.(Object.freeze(diagnostic));
        } catch {
          // An observer exception cannot alter qualification.
        }
      };
      const assertActive = () => {
        // Abort reasons are opaque: never coerce, inspect or log them.
        if (signal.aborted)
          throw failure("cancelled", {
            phase,
            outcome: "refused",
            key: "unavailable",
            fence: "unavailable",
            reason: "cancelled",
          });
      };
      const snapshot = async (before?: LocalVerificationInputSnapshot) => {
        assertActive();
        let value: unknown;
        try {
          value = await fingerprint(task, signal);
        } catch {
          assertActive();
          const diagnostic: LocalVerificationCacheDiagnostic = {
            phase,
            outcome: "refused",
            key: "unavailable",
            fence: "unavailable",
            reason: "invalid-fingerprint",
          };
          report(diagnostic);
          throw failure("invalid-fingerprint", diagnostic);
        }
        assertActive();
        let after: LocalVerificationInputSnapshot | undefined;
        try {
          after = readSnapshot(value);
        } catch {
          const diagnostic: LocalVerificationCacheDiagnostic = {
            phase,
            outcome: "refused",
            key: "unavailable",
            fence: "unavailable",
            reason: "invalid-fingerprint",
          };
          report(diagnostic);
          throw failure("invalid-fingerprint", diagnostic);
        }
        const changed =
          before !== undefined &&
          (after === undefined || before.key !== after.key || before.fence !== after.fence);
        const diagnostic: LocalVerificationCacheDiagnostic = {
          phase,
          outcome: changed ? "refused" : after ? "admitted" : "unavailable",
          key: !after
            ? "unavailable"
            : !before
              ? "not-compared"
              : before.key === after.key
                ? "same"
                : "changed",
          fence: !after
            ? "unavailable"
            : !before
              ? "not-compared"
              : before.fence === after.fence
                ? "same"
                : "changed",
          ...(changed ? { reason: "inputs-changed" as const } : {}),
        };
        // Exactly one fixed observation per actual snapshot, at most three per
        // run. The existing equality gate remains authoritative, not callback
        // completion or any diagnostic field supplied by another component.
        report(diagnostic);
        if (changed) throw failure("inputs-changed", diagnostic);
        assertActive();
        return after;
      };
      const before = await snapshot();
      if (before && !fresh) {
        let hit = false;
        try {
          hit = (await store.read(before.key)) === true;
        } catch {
          // Cache unavailability is a miss, never evidence of task success.
        }
        assertActive();
        if (hit) {
          phase = "reuse-recheck";
          await snapshot(before);
          assertActive();
          return {
            status: "reused",
            message: "Reused a prior successful task for these exact inputs; not freshly executed.",
          };
        }
      }

      assertActive();
      // Original task failures propagate unchanged. In particular, an unknown
      // native close cannot reach the success-publication path below.
      await execute();
      phase = "post-execute";
      assertActive();
      await snapshot(before);
      assertActive();
      if (fresh)
        return {
          status: "fresh",
          message: "Freshly executed; --fresh bypassed cache reads and writes.",
        };
      if (!before)
        return {
          status: "fresh",
          message: "Freshly executed; no reusable input identity was admitted.",
        };

      let stored = false;
      try {
        // The producer rechecks this same signal before its atomic commit.
        // Cancellation after a completed commit cannot revoke an earlier
        // qualified task, but must still prevent the caller reporting green.
        stored = (await store.publish(before.key, signal)) === true;
      } catch {
        // A failed cache write cannot turn an actually passed task into a
        // failure, nor imply that a reusable receipt was successfully stored.
      }
      // Receipt IO is asynchronous even after native close and its first input
      // check. A source change while that write is queued must not qualify the
      // caller's current inputs. Recheck even when optional storage failed:
      // cache availability cannot bypass the source-drift fence. An earlier
      // atomic receipt remains valid for its original key; never delete it or
      // relabel it as evidence for the changed inputs.
      phase = "post-publication";
      await snapshot(before);
      assertActive();
      return {
        status: "fresh",
        message: stored
          ? "Freshly executed; a reusable successful-task receipt was stored."
          : "Freshly executed; no successful-task receipt was stored.",
      };
    },
  };
}
