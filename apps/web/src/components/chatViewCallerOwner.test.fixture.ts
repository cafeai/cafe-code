import type { TestContext } from "vitest";
import type { mountChatView } from "./ChatViewBrowser.shared";

// This module has no React, browser-provider or shared-fixture runtime import.
// Its supplied mount remains the existing exact native/React ownership backend.
export type ChatViewCallerMountOptions = Parameters<typeof mountChatView>[0];
const labels = [
  "subagent-obsolete-ack",
  "subagent-already-canonical",
  "subagent-newer-ack",
  "editor-promotion",
  "restored-compaction",
  "worktree-overrides",
  "image-only-send",
  "pending-steer",
  "reconnect-exhaustion",
  "desk-preview",
  "desk-late-fork",
  "composer-rail-docking",
  "navigation-atrium",
] as const;
export type ChatViewCallerLabel = (typeof labels)[number];
const phases = [
  "mount",
  "config",
  "layout",
  "draft",
  "rail",
  "controls",
  "editor",
  "input",
  "save",
  "reset",
  "request",
  "ack",
  "canonical",
  "overlay",
  "close",
  "closed",
  "reopen",
  "value",
  "prompt",
  "send-target",
  "send",
  "receipt",
  "snapshot",
  "work-log",
  "image",
  "upload",
  "picker",
  "attachments",
  "steer",
  "processing",
  "reconnect",
  "exhaustion",
  "first-row",
  "second-row",
  "preview",
  "tab",
  "route",
  "draft-cleared",
] as const;
export type ChatViewCallerPhase = (typeof phases)[number];
type MountPhase = "viewport" | "styles" | "render" | "websocket" | "bootstrap" | "layout";
type RecordedPhase =
  | ChatViewCallerPhase
  | `mount:${MountPhase}`
  | "cleanup"
  | "before-drain"
  | "unmount"
  | "after-unmount"
  | "retired";
type PhaseRecord = {
  readonly phase: RecordedPhase;
  readonly state: "entered" | "settled" | "observed";
  readonly count: number;
  readonly elapsedMs: number;
};
const admittedLabels: ReadonlySet<unknown> = new Set(labels);
const admittedPhases: ReadonlySet<unknown> = new Set(phases);
const admittedMountPhases: ReadonlySet<unknown> = new Set([
  "viewport",
  "styles",
  "render",
  "websocket",
  "bootstrap",
  "layout",
]);

export interface ChatViewCallerOwnerOptions {
  readonly label: ChatViewCallerLabel;
  /** Synchronous, exact test-owned ACK release; never an admission receipt. */
  readonly beforeDrain?: () => void;
  /** Restore only acquired overrides, after exact mount disposal settles. */
  readonly afterUnmount?: () => void | Promise<void>;
}

/**
 * Own one fixture caller, not another mount implementation or timeout policy.
 * Construction must precede the first acquisition. The shared mount's existing
 * retirement lease calls this SAME cleanup before its DOM/RPC/global resets.
 */
export function createChatViewCallerOwner<Mounted>(
  context: Pick<TestContext, "signal" | "onTestFinished" | "onTestFailed">,
  mount: (options: ChatViewCallerMountOptions) => Promise<Mounted>,
  options: ChatViewCallerOwnerOptions,
) {
  if (!admittedLabels.has(options.label)) throw new Error("Unsupported synthetic caller label.");
  const label = options.label;
  const beforeDrain = options.beforeDrain;
  const afterUnmount = options.afterUnmount;
  const signal = context.signal;
  const startedAt = performance.now();
  const observations: PhaseRecord[] = [];
  const pending = new Set<Promise<unknown>>();
  let retired = false;
  let recording = true;
  let operationCount = 0;
  let mountAdmitted = false;
  let mounting: Promise<Mounted> | undefined;
  let mountCleanup: (() => Promise<void>) | undefined;
  let completion: Promise<void> | undefined;

  const record = (phase: RecordedPhase, state: PhaseRecord["state"]) => {
    try {
      if (!recording) return;
      if (observations.length === 16) observations.shift();
      const elapsed = performance.now() - startedAt;
      observations.push({
        phase,
        state,
        count: Math.min(1_000_000, operationCount),
        elapsedMs: Number.isFinite(elapsed)
          ? Math.min(60_000, Math.max(0, Math.round(elapsed)))
          : 0,
      });
    } catch {
      // Passive observations cannot change an operation's result or error.
    }
  };
  const validatePhase = (phase: ChatViewCallerPhase) => {
    if (!admittedPhases.has(phase)) throw new Error("Unsupported synthetic caller phase.");
  };
  const assertActive = () => {
    if (retired || signal.aborted) throw new Error("The exact chat caller fixture was retired.");
  };
  const mark = (phase: ChatViewCallerPhase) => {
    validatePhase(phase);
    // Late passive callbacks cannot retain a new observation after retirement.
    if (!retired && !signal.aborted) record(phase, "observed");
  };
  const own = async <T>(phase: ChatViewCallerPhase, start: () => PromiseLike<T>): Promise<T> => {
    validatePhase(phase);
    assertActive();
    operationCount = Math.min(1_000_000, operationCount + 1);
    record(phase, "entered");
    const original = Promise.resolve(start());
    const candidate: unknown = original;
    if (completion && candidate === completion)
      throw new Error("A caller operation cannot join its own cleanup.");
    // Join the original promise, never the body/cleanup or this wrapper's tail.
    pending.add(original);
    try {
      const value = await original;
      assertActive();
      record(phase, "settled");
      return value;
    } finally {
      pending.delete(original);
    }
  };
  const drain = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };
  const cleanup = (): Promise<void> => {
    if (completion) return completion;
    retired = true;
    signal.removeEventListener("abort", onAbort);
    record("retired", "observed");
    // The first callback runs in a later microtask, after publishing this exact
    // join. Reentrant retirement cannot replay ACK release or disposal.
    completion = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      record("cleanup", "entered");
      record("before-drain", "entered");
      try {
        const released: unknown = beforeDrain?.();
        if (released === completion)
          throw new Error("A caller release cannot return its own cleanup.");
        // A void TypeScript callback can still return an async/received value.
        // Do not await or inspect a then property; only a completed synchronous
        // release is admitted, while later cleanup stages must still execute.
        if (released !== undefined) throw new Error("A caller release must finish synchronously.");
      } catch (failure) {
        failures.push(failure);
      }
      record("before-drain", "settled");
      // Rejections are still owned by their original body awaits. Settlement
      // here is retirement, never fake success or a new provider receipt.
      if (mounting) await Promise.allSettled([mounting]);
      await drain();
      record("unmount", "entered");
      try {
        const disposing = mountCleanup?.();
        if (disposing === completion) throw new Error("A mount cannot return its caller cleanup.");
        await disposing;
      } catch (failure) {
        failures.push(failure);
      }
      record("unmount", "settled");
      record("after-unmount", "entered");
      try {
        const restoring = afterUnmount?.();
        if (restoring === completion)
          throw new Error("A restoration cannot return its own cleanup.");
        await restoring;
      } catch (failure) {
        failures.push(failure);
      }
      record("after-unmount", "settled");
      record("cleanup", "settled");
      recording = false;
      // Never coerce received failures or log their contents. Preserve every
      // exact identity, including multiple independent cleanup failures.
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, "Synthetic chat caller cleanup failed.");
    });
    return completion;
  };
  const onAbort = () => {
    // The registered finish/shared hooks still join and report this completion.
    void cleanup().catch(() => undefined);
  };
  context.onTestFinished(cleanup);
  context.onTestFailed(() => {
    try {
      console.error("Synthetic ChatView caller phases", { label, phases: [...observations] });
    } catch {
      // The bounded browser console channel is diagnostic, not test authority.
    }
  });
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  return {
    assertActive,
    own,
    cleanup,
    mark,
    mount(originalOptions: Omit<ChatViewCallerMountOptions, "lifecycle">): Promise<Mounted> {
      assertActive();
      if (mountAdmitted) throw new Error("The chat caller already owns its exact mount.");
      if ("lifecycle" in originalOptions)
        throw new Error("The caller mount lifecycle cannot be replaced.");
      mountAdmitted = true;
      return own("mount", () => {
        const acquired = mount({
          ...originalOptions,
          lifecycle: {
            assertActive,
            retire: cleanup,
            ownCleanup(next) {
              if (mountCleanup && next !== mountCleanup)
                throw new Error("The exact mount cleanup cannot be replaced.");
              if (next === cleanup)
                throw new Error("The mount cleanup cannot be its caller retirement.");
              mountCleanup = next;
            },
            observePhase(phase) {
              assertActive();
              if (!admittedMountPhases.has(phase))
                throw new Error("Unsupported synthetic mount phase.");
              record(`mount:${phase}`, "observed");
            },
          },
        });
        const candidate: unknown = acquired;
        if (completion && candidate === completion)
          throw new Error("A mount cannot join its caller cleanup.");
        mounting = acquired;
        return mounting;
      });
    },
    async run<T>(body: () => PromiseLike<T>): Promise<T> {
      let bodyFailed = false;
      try {
        assertActive();
        return await body();
      } catch (failure) {
        bodyFailed = true;
        throw failure;
      } finally {
        try {
          await cleanup();
        } catch (failure) {
          // A failing body keeps its original opaque error. The public/shared
          // completion still rejects with every cleanup failure above.
          if (!bodyFailed) throw failure;
        }
      }
    },
  };
}
