import type { DesktopPowerSaveBlockerState } from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as ElectronPowerSaveBlocker from "../electron/ElectronPowerSaveBlocker.ts";

const INITIAL_STATE: DesktopPowerSaveBlockerState = { mode: "off", chatsRunning: false };

export interface DesktopPowerSaveBlockerSnapshot {
  readonly desiredState: DesktopPowerSaveBlockerState;
  readonly blockerId: number | null;
  readonly active: boolean;
}
export interface ClosedLidDisplayOwner {
  /** Revoke the previous observation synchronously, before queued native IO. */
  readonly observe: (closed: boolean | null) => void;
  /** Actual adoption, never just requested policy. */
  readonly maySleep: () => boolean;
  readonly close: () => Promise<void>;
}
export interface DesktopPowerSaveBlockerShape {
  readonly update: (state: DesktopPowerSaveBlockerState) => Effect.Effect<void>;
  readonly snapshot: Effect.Effect<DesktopPowerSaveBlockerSnapshot>;
  readonly bindClosedLid: (current: () => boolean) => Effect.Effect<ClosedLidDisplayOwner>;
}
export class DesktopPowerSaveBlocker extends Context.Service<
  DesktopPowerSaveBlocker,
  DesktopPowerSaveBlockerShape
>()("cafecode/desktop/app/PowerSaveBlocker") {}

function shouldBlockSleep(state: DesktopPowerSaveBlockerState): boolean {
  return state.mode === "always" || (state.mode === "during-chats" && state.chatsRunning);
}

const make = Effect.fn("desktop.powerSaveBlocker.make")(function* () {
  const powerSaveBlocker = yield* ElectronPowerSaveBlocker.ElectronPowerSaveBlocker;
  const desiredStateRef = yield* Ref.make(INITIAL_STATE);
  const mutex = yield* Semaphore.make(1);
  const runNative = Effect.runPromiseWith(yield* Effect.context<never>());
  type Held = {
    readonly id: number;
    readonly type: ElectronPowerSaveBlocker.ElectronPowerSaveBlockerType;
  };
  type Owner = {
    retired: boolean;
    closed: boolean | null;
    adopted: boolean;
    closing: Promise<void> | null;
    readonly current: () => boolean;
  };
  // Start a replacement before stopping the previous blocker, preserving CPU
  // protection. Refused releases retain the exact ID, with at most two held.
  let held: Held[] = [];
  let owner: Owner | null = null;
  let disposed = false;
  let driving: Promise<void> | null = null;
  let again = false;
  // Identity changes on every admitted observation/intent, including a quick
  // closed -> open -> closed cycle with the same final boolean value.
  let revision = {};
  const revoke = () => {
    revision = {};
    if (owner) owner.adopted = false;
  };

  const release = Effect.fn("desktop.powerSaveBlocker.release")(function* (
    blocker: Held,
    current: () => boolean = () => true,
  ) {
    if (yield* powerSaveBlocker.isStarted(blocker.id)) {
      // A completed probe cannot admit a stop for superseded policy. Already
      // admitted native operations still finish and retain their exact IDs.
      if (!current()) return;
      yield* powerSaveBlocker.stop(blocker.id);
    }
    if (yield* powerSaveBlocker.isStarted(blocker.id))
      return yield* Effect.die(new Error("Power blocker release was not adopted"));
    held = held.filter((value) => value !== blocker);
  });
  const apply = Effect.gen(function* () {
    const applyingRevision = revision;
    const applyingOwner = owner;
    const current = () => !disposed && revision === applyingRevision && owner === applyingOwner;
    if (owner) owner.adopted = false;
    const state = yield* Ref.get(desiredStateRef);
    if (!current()) return;
    // Retain the weaker blocker through this owner's native cleanup. Fresh
    // intent is still required for adoption or any new screen-sleep request.
    const closed = owner !== null && !owner.retired && owner.closed === true;
    const type =
      disposed || !shouldBlockSleep(state)
        ? null
        : closed
          ? "prevent-app-suspension"
          : "prevent-display-sleep";
    for (const blocker of held) {
      if (!(yield* powerSaveBlocker.isStarted(blocker.id)))
        held = held.filter((value) => value !== blocker);
      if (!current()) return;
    }
    if (type !== null && !held.some((blocker) => blocker.type === type)) {
      if (held.length >= 2)
        return yield* Effect.die(new Error("Power blocker ownership limit reached"));
      const id = yield* powerSaveBlocker.start(type);
      if (!Number.isSafeInteger(id) || id < 0 || held.some((blocker) => blocker.id === id))
        return yield* Effect.die(new Error("Power blocker identity was not admitted"));
      held.push({ id, type });
      if (!(yield* powerSaveBlocker.isStarted(id)))
        return yield* Effect.die(new Error("Power blocker start was not adopted"));
      if (!current()) return;
    }
    for (const blocker of held)
      if (blocker.type !== type) {
        yield* release(blocker, current);
        if (!current()) return;
      }
    if (current() && owner && !owner.retired && owner.current() && owner.closed === true && closed)
      owner.adopted = held.every((blocker) => blocker.type !== "prevent-display-sleep");
  }).pipe(Effect.uninterruptible);

  // Native callbacks synchronously replace intent. Coalesce to one held
  // operation plus the latest policy; finalization joins this exact driver.
  const pump = () => {
    again = true;
    if (driving || disposed) return;
    driving = (async () => {
      while (again) {
        if (disposed) return;
        again = false;
        // A failed older transition must not erase newer intent admitted
        // while its native operation was pending. There is no same-intent
        // retry loop: only another observation/update can set `again`.
        await runNative(mutex.withPermit(apply)).catch(() => {
          // apply revoked adoption before IO. A newer transaction may have
          // completed after its mutex release; never mutate that result here.
        });
      }
    })().finally(() => {
      driving = null;
      if (again && !disposed) pump();
    });
  };
  const join = async () => {
    for (;;) {
      const active = driving;
      if (!active) return;
      await active;
    }
  };
  const bindClosedLid = (current: () => boolean) =>
    Effect.sync((): ClosedLidDisplayOwner => {
      if (disposed || owner !== null) throw new Error("Closed-lid display policy already owned");
      const admitted: Owner = {
        retired: false,
        closed: null,
        adopted: false,
        closing: null,
        current,
      };
      owner = admitted;
      revoke();
      pump();
      return {
        observe: (closed) => {
          if (disposed || owner !== admitted || admitted.retired) return;
          admitted.closed = closed;
          revoke();
          pump();
        },
        maySleep: () =>
          !disposed &&
          owner === admitted &&
          !admitted.retired &&
          admitted.current() &&
          admitted.closed === true &&
          admitted.adopted,
        close: () => {
          if (admitted.closing) return admitted.closing;
          admitted.retired = true;
          admitted.adopted = false;
          if (owner === admitted) {
            revoke();
            pump();
          }
          admitted.closing = join().then(() => {
            if (owner === admitted) owner = null;
          });
          return admitted.closing;
        },
      };
    });
  const update = (state: DesktopPowerSaveBlockerState) =>
    Effect.gen(function* () {
      if (disposed) return;
      // Publish intent before waiting for an older native operation. Queued
      // updates then reconcile the latest state, rather than replaying old
      // chat-start/finish or preference changes after a lid transition.
      revoke();
      yield* Ref.set(desiredStateRef, { mode: state.mode, chatsRunning: state.chatsRunning });
      yield* mutex.withPermit(apply);
    }).pipe(
      // Once published, intent owns its queued reconciliation even if the IPC
      // waiter is cancelled. Service cleanup still fences and joins the mutex.
      Effect.uninterruptible,
      Effect.asVoid,
      Effect.withSpan("desktop.powerSaveBlocker.update", {
        attributes: { mode: state.mode, chatsRunning: state.chatsRunning },
      }),
    );
  const snapshot = Effect.gen(function* () {
    yield* Effect.promise(join);
    return yield* mutex.withPermit(
      Effect.gen(function* () {
        const desiredState = yield* Ref.get(desiredStateRef);
        const strongest =
          held.find((blocker) => blocker.type === "prevent-display-sleep") ?? held[0];
        const blockerId = strongest?.id ?? null;
        const active = blockerId !== null && (yield* powerSaveBlocker.isStarted(blockerId));
        return { desiredState, blockerId, active };
      }),
    );
  });
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      disposed = true;
      revoke();
      if (owner) {
        owner.retired = true;
        owner.adopted = false;
        owner = null;
      }
      yield* Effect.promise(join);
      yield* mutex.withPermit(
        Effect.forEach([...held], (blocker) =>
          release(blocker).pipe(Effect.catchCause(() => Effect.void)),
        ),
      );
    }),
  );
  return DesktopPowerSaveBlocker.of({ update, snapshot, bindClosedLid });
});

export const layer = Layer.effect(DesktopPowerSaveBlocker, make());
