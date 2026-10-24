// These fixtures own exact native Node handles; no provider or shell is launched.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
// Native temporary namespaces and close-joined cleanup are the behavior under test.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { describe, expect, it, vi, type TestContext } from "vitest";
import {
  createLocalVerificationCache,
  LocalVerificationCacheError,
  readLocalVerificationCacheFailure,
  type LocalVerificationCacheDiagnostic,
} from "./local-verification-cache.ts";
import type {
  LocalVerificationInputSnapshot,
  LocalVerificationReceiptStore,
  LocalVerificationTask,
} from "./local-verification-cache-contract.ts";

const key = "a".repeat(64);
const changedKey = "b".repeat(64);
const fence = "c".repeat(64);
const changedFence = "d".repeat(64);
const task: LocalVerificationTask = {
  id: "synthetic-native-task",
  cwd: "/synthetic",
  args: ["synthetic"],
  environment: {},
  scope: { kind: "node", workspace: "synthetic" },
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function memoryStore(events: string[] = []) {
  const keys = new Set<string>();
  const store = {
    authenticateEnvironment: () => "e".repeat(64),
    read: vi.fn(async (digest: string) => keys.has(digest)),
    publish: vi.fn(async (digest: string, signal: AbortSignal) => {
      if (signal.aborted) return false;
      keys.add(digest);
      events.push("publish");
      return true;
    }),
  } satisfies LocalVerificationReceiptStore;
  return { store, keys };
}

interface NativeTask {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  readonly failure: Error;
  readonly release: () => void;
}

type NativeCachePhase =
  | "fixture-ready"
  | "first-run-entered"
  | "first-spawned"
  | "first-admitted"
  | "first-ready"
  | "cancel-requested"
  | "first-released"
  | "first-closed"
  | "zero-close-confirmed"
  | "cancellation-refused"
  | "second-run-entered"
  | "second-spawned"
  | "second-ready"
  | "second-released"
  | "second-closed"
  | "fresh-completed"
  | "owners-admitted"
  | "both-ready"
  | "first-qualified"
  | "second-refused"
  | "reuse-entered"
  | "reuse-completed";

/** Observe existing await boundaries only. Counts are admitted native starts,
 * not inferred ready/close success; the original assertions remain authority.
 * Register before acquisition and stop recording synchronously on retirement,
 * so a late owned close cannot append observations to a later fixture. */
function observeNativeCachePhases(context: TestContext, kind: "cancel-zero" | "concurrent-close") {
  const started = performance.now();
  const phases: { phase: NativeCachePhase; count: number; elapsedMs: number }[] = [];
  let retired = false;
  let omitted = 0;
  const retire = () => {
    retired = true;
  };
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(() => {
    retire();
    context.signal.removeEventListener("abort", retire);
  });
  context.onTestFailed(() => {
    try {
      // Only fixed source-owned phases and finite numbers are formatted. No
      // native error, executable, argument, environment or output is inspected.
      const summary = phases
        .map(({ phase, count, elapsedMs }) => `${phase}:${count}:${elapsedMs}`)
        .join(",");
      process.stderr.write(
        `Synthetic native-cache ${kind} phases (phase:count:ms; omitted=${omitted}): ${summary}\n`,
      );
    } catch {
      /* Diagnostics never replace the original test or native error. */
    }
  });
  return (phase: NativeCachePhase, count: number) => {
    try {
      if (retired || context.signal.aborted) return;
      if (phases.length === 16) {
        phases.shift();
        omitted = Math.min(1_000_000, omitted + 1);
      }
      const elapsed = performance.now() - started;
      phases.push({
        phase,
        count: Number.isFinite(count) ? Math.max(0, Math.min(2, Math.floor(count))) : 0,
        elapsedMs: Number.isFinite(elapsed)
          ? Math.max(0, Math.min(60_000, Math.floor(elapsed)))
          : 0,
      });
    } catch {
      /* A missing observation cannot alter execution, readiness or close. */
    }
  };
}

/** IPC holds the exact child before native close, without a sleep or a timer.
 * Every child runs the same pinned executable as this qualified test process.
 * Its empty environment cannot load NODE_OPTIONS hooks or provider settings. */
function nativeTasks(context: TestContext, events: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "cafe-local-cache-"));
  const counter = join(root, "counter");
  const owners = new Set<{ retire: () => void }>();
  const pending = new Set<Promise<unknown>>();
  let retired = false;
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    // The original caller still observes the original result; this handler
    // only prevents cleanup's duplicate ownership join becoming unhandled.
    void promise.catch(() => {});
    return promise;
  };
  const retire = () => {
    retired = true;
    for (const owner of owners) owner.retire();
  };
  context.signal.addEventListener("abort", retire, { once: true });
  // Register before any asynchronous native acquisition. On hard timeout,
  // retire admission, close exact children, join them, then remove only this
  // fixture-created namespace. No process inventory or PID signalling is used.
  context.onTestFinished(async () => {
    retire();
    await Promise.allSettled(pending);
    context.signal.removeEventListener("abort", retire);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    track,
    count: () => readFileSync(counter, "utf8").split("\n").filter(Boolean).length,
    start(signal: AbortSignal, exitCode = 0): NativeTask {
      if (retired || signal.aborted) throw new Error("Synthetic native task owner retired");
      const ready = deferred<void>();
      const failure = new Error("Synthetic native task did not close successfully");
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { appendFileSync } from 'node:fs';
appendFileSync(process.argv[1], 'run\\n');
process.on('SIGTERM', () => process.exit(0));
process.on('message', (message) => {
  if (message === 'finish') process.exit(Number(process.argv[2]));
});
process.send('ready');`,
          counter,
          String(exitCode),
        ],
        { cwd: root, env: {}, shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      let closed = false;
      let nativeError: Error | undefined;
      const owner = {
        retire: () => {
          if (!closed) child.kill("SIGTERM");
        },
      };
      owners.add(owner);
      const cancel = () => owner.retire();
      signal.addEventListener("abort", cancel, { once: true });
      const completion = track(
        new Promise<void>((resolve, reject) => {
          child.on("error", (error) => {
            nativeError = error;
          });
          child.on("message", (message) => {
            if (message === "ready") ready.resolve();
          });
          child.once("close", (code, nativeSignal) => {
            closed = true;
            owners.delete(owner);
            signal.removeEventListener("abort", cancel);
            events.push("close");
            if (nativeError) reject(nativeError);
            else if (code !== 0 || nativeSignal !== null) reject(failure);
            else resolve();
          });
        }),
      );
      const readiness = track(
        Promise.race([
          ready.promise,
          completion.then(() => {
            throw failure;
          }),
        ]),
      );
      // Check a signal that changed immediately after spawn/listener setup.
      if (signal.aborted) cancel();
      return {
        ready: readiness,
        closed: completion,
        failure,
        release: () => {
          if (!closed && child.connected) child.send("finish");
        },
      };
    },
  };
}

describe("local successful-task qualification", () => {
  it("publishes only after an actual held Node closes, reuses exact inputs, and executes changed inputs", async (context) => {
    const events: string[] = [];
    const native = nativeTasks(context, events);
    const { store } = memoryStore(events);
    let currentKey = key;
    const cache = createLocalVerificationCache({
      store,
      fingerprint: async () => ({ key: currentKey, fence }),
    });
    const admitted = deferred<NativeTask>();
    let settled = false;
    const first = native.track(
      cache
        .run(task, context.signal, async () => {
          const child = native.start(context.signal);
          admitted.resolve(child);
          await child.closed;
        })
        .then((result) => {
          settled = true;
          return result;
        }),
    );
    const child = await admitted.promise;
    await child.ready;
    expect(settled).toBe(false);
    expect(store.publish).not.toHaveBeenCalled();
    expect(native.count()).toBe(1);
    child.release();
    expect((await first).status).toBe("fresh");
    expect(events).toEqual(["close", "publish"]);
    const execute = vi.fn(async () => {});
    const reused = await cache.run(task, context.signal, execute);
    expect(reused.status).toBe("reused");
    expect(reused.message).toContain("not freshly executed");
    expect(execute).not.toHaveBeenCalled();
    expect(native.count()).toBe(1);
    currentKey = changedKey;
    const changed = await native.track(
      cache.run(task, context.signal, async () => {
        const next = native.start(context.signal);
        await next.ready;
        next.release();
        await next.closed;
      }),
    );
    expect(changed.status).toBe("fresh");
    expect(native.count()).toBe(2);
    expect(store.publish).toHaveBeenCalledTimes(2);
  });

  it("rejects cancellation even when the exact native child exits zero and cannot seed a hit", async (context) => {
    const mark = observeNativeCachePhases(context, "cancel-zero");
    let nativeStarts = 0;
    const native = nativeTasks(context);
    mark("fixture-ready", nativeStarts);
    const { store, keys } = memoryStore();
    const controller = new AbortController();
    const cache = createLocalVerificationCache({
      store,
      fingerprint: async () => ({ key, fence }),
    });
    const admitted = deferred<NativeTask>();
    mark("first-run-entered", nativeStarts);
    const run = native.track(
      cache.run(task, controller.signal, async () => {
        // The executor owns cancellation/close, not the cache coordinator. Model
        // a native task that acknowledges cancellation with a successful exit;
        // this remains a real zero exit on Windows as well as POSIX.
        const child = native.start(context.signal);
        mark("first-spawned", ++nativeStarts);
        admitted.resolve(child);
        await child.closed;
        mark("first-closed", nativeStarts);
      }),
    );
    const rejection = expect(run).rejects.toMatchObject({ reason: "cancelled" });
    const child = await admitted.promise;
    mark("first-admitted", nativeStarts);
    await child.ready;
    mark("first-ready", nativeStarts);
    controller.abort(new Error("Opaque abort reason must not be projected"));
    mark("cancel-requested", nativeStarts);
    child.release();
    mark("first-released", nativeStarts);
    await child.closed; // A real zero native close still cannot qualify cancellation.
    mark("zero-close-confirmed", nativeStarts);
    await rejection;
    mark("cancellation-refused", nativeStarts);
    expect(keys.size).toBe(0);
    expect(store.publish).not.toHaveBeenCalled();
    mark("second-run-entered", nativeStarts);
    await native.track(
      cache.run(task, context.signal, async () => {
        const next = native.start(context.signal);
        mark("second-spawned", ++nativeStarts);
        await next.ready;
        mark("second-ready", nativeStarts);
        next.release();
        mark("second-released", nativeStarts);
        await next.closed;
        mark("second-closed", nativeStarts);
      }),
    );
    mark("fresh-completed", nativeStarts);
    expect(native.count()).toBe(2);
  });

  it("propagates an actual failed native close without publishing or losing another completed task", async (context) => {
    const native = nativeTasks(context);
    const { store, keys } = memoryStore();
    const cache = createLocalVerificationCache({
      store,
      fingerprint: async (input) => ({ key: input.id === task.id ? key : changedKey, fence }),
    });
    await cache.run(task, context.signal, async () => {});
    const admitted = deferred<NativeTask>();
    const failedTask = { ...task, id: "different-failing-task" };
    const failed = native.track(
      cache.run(failedTask, context.signal, async () => {
        const child = native.start(context.signal, 1);
        admitted.resolve(child);
        await child.ready;
        child.release();
        await child.closed;
      }),
    );
    const failure = (await admitted.promise).failure;
    await expect(failed).rejects.toBe(failure);
    expect(keys).toEqual(new Set([key]));
    const execute = vi.fn(async () => {});
    expect((await cache.run(task, context.signal, execute)).status).toBe("reused");
    expect(execute).not.toHaveBeenCalled();
    expect(store.publish).toHaveBeenCalledTimes(1);
  });

  it("keeps concurrent exact-input executions independently owned until each real native close", async (context) => {
    const mark = observeNativeCachePhases(context, "concurrent-close");
    let nativeStarts = 0;
    const native = nativeTasks(context);
    mark("fixture-ready", nativeStarts);
    const { store, keys } = memoryStore();
    const cache = createLocalVerificationCache({
      store,
      fingerprint: async () => ({ key, fence }),
    });
    const firstAdmission = deferred<NativeTask>();
    const secondAdmission = deferred<NativeTask>();
    mark("first-run-entered", nativeStarts);
    const first = native.track(
      cache.run(task, context.signal, async () => {
        const child = native.start(context.signal);
        mark("first-spawned", ++nativeStarts);
        firstAdmission.resolve(child);
        await child.closed;
        mark("first-closed", nativeStarts);
      }),
    );
    mark("second-run-entered", nativeStarts);
    const second = native.track(
      cache.run(task, context.signal, async () => {
        const child = native.start(context.signal, 1);
        mark("second-spawned", ++nativeStarts);
        secondAdmission.resolve(child);
        await child.closed;
      }),
    );
    const [successfulChild, failedChild] = await Promise.all([
      firstAdmission.promise,
      secondAdmission.promise,
    ]);
    mark("owners-admitted", nativeStarts);
    await Promise.all([successfulChild.ready, failedChild.ready]);
    mark("both-ready", nativeStarts);
    expect(native.count()).toBe(2);
    expect(store.publish).not.toHaveBeenCalled();
    successfulChild.release();
    mark("first-released", nativeStarts);
    expect((await first).status).toBe("fresh");
    mark("first-qualified", nativeStarts);
    const rejected = expect(second).rejects.toBe(failedChild.failure);
    failedChild.release();
    mark("second-released", nativeStarts);
    await rejected;
    mark("second-refused", nativeStarts);
    expect(keys).toEqual(new Set([key]));
    expect(store.publish).toHaveBeenCalledTimes(1);
    const execute = vi.fn(async () => {});
    mark("reuse-entered", nativeStarts);
    expect((await cache.run(task, context.signal, execute)).status).toBe("reused");
    mark("reuse-completed", nativeStarts);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "rejects key, fence or unavailable post-snapshots rather than qualifying stale inputs (hit=%s)",
    async (hit) => {
      for (const [after, keyOutcome, fenceOutcome] of [
        [{ key: changedKey, fence }, "changed", "same"],
        [{ key, fence: changedFence }, "same", "changed"],
        [{ key: changedKey, fence: changedFence }, "changed", "changed"],
        [undefined, "unavailable", "unavailable"],
      ] as const) {
        const { store, keys } = memoryStore();
        if (hit) keys.add(key);
        const observations: LocalVerificationCacheDiagnostic[] = [];
        const fingerprint = vi
          .fn()
          .mockResolvedValueOnce({ key, fence })
          .mockResolvedValueOnce(after);
        const cache = createLocalVerificationCache({ store, fingerprint });
        const execute = vi.fn(async () => {});
        const refused = {
          phase: hit ? "reuse-recheck" : "post-execute",
          outcome: "refused",
          reason: "inputs-changed",
          key: keyOutcome,
          fence: fenceOutcome,
        } as const;
        const pending = cache.run(task, new AbortController().signal, execute, (diagnostic) =>
          observations.push(diagnostic),
        );
        await expect(pending).rejects.toMatchObject({
          reason: "inputs-changed",
          diagnostic: refused,
        });
        await pending.catch((error: unknown) => {
          expect(readLocalVerificationCacheFailure(error)).toEqual({
            reason: "inputs-changed",
            diagnostic: refused,
          });
        });
        expect(observations).toEqual([
          { phase: "pre-execute", outcome: "admitted", key: "not-compared", fence: "not-compared" },
          refused,
        ]);
        expect(observations.every(Object.isFrozen)).toBe(true);
        expect(execute).toHaveBeenCalledTimes(hit ? 0 : 1);
        expect(fingerprint).toHaveBeenCalledTimes(2);
        expect(store.publish).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    "keeps a throwing observer inert for fresh and reused qualification (hit=%s)",
    async (hit) => {
      const { store, keys } = memoryStore();
      if (hit) keys.add(key);
      let receivedReads = 0;
      const opaque = Object.defineProperty({}, "message", {
        get() {
          receivedReads += 1;
          throw new Error("Opaque observer value");
        },
      });
      const observer = vi.fn((_diagnostic: LocalVerificationCacheDiagnostic) => {
        throw opaque;
      });
      const cache = createLocalVerificationCache({
        store,
        fingerprint: async () => ({ key, fence }),
      });
      const execute = vi.fn(async () => {});
      expect((await cache.run(task, new AbortController().signal, execute, observer)).status).toBe(
        hit ? "reused" : "fresh",
      );
      expect(observer).toHaveBeenCalledTimes(hit ? 2 : 3);
      expect(execute).toHaveBeenCalledTimes(hit ? 0 : 1);
      expect(store.publish).toHaveBeenCalledTimes(hit ? 0 : 1);
      expect(receivedReads).toBe(0);

      keys.clear();
      const originalFailure = new Error("Original executor failure");
      await expect(
        cache.run(
          task,
          new AbortController().signal,
          async () => {
            throw originalFailure;
          },
          observer,
        ),
      ).rejects.toBe(originalFailure);
      expect(observer).toHaveBeenCalledTimes(hit ? 3 : 4);
      expect(readLocalVerificationCacheFailure(originalFailure)).toBeUndefined();
      expect(receivedReads).toBe(0);

      const changed = createLocalVerificationCache({
        store,
        fingerprint: vi
          .fn()
          .mockResolvedValueOnce({ key, fence })
          .mockResolvedValueOnce({ key: changedKey, fence }),
      });
      await expect(
        changed.run(task, new AbortController().signal, execute, observer),
      ).rejects.toMatchObject({ reason: "inputs-changed" });
      expect(observer).toHaveBeenCalledTimes(hit ? 5 : 6);
      expect(store.publish).toHaveBeenCalledTimes(hit ? 0 : 1);
      expect(receivedReads).toBe(0);
    },
  );

  it("projects only private nominal failure observations without reading opaque errors or traps", () => {
    let receivedCalls = 0;
    const nominal = new LocalVerificationCacheError("cancelled");
    const admitted = readLocalVerificationCacheFailure(nominal);
    expect(admitted).toEqual({ reason: "cancelled" });
    expect(Object.isFrozen(admitted)).toBe(true);
    // Even properties later replaced on a genuine Error are not diagnostic
    // input. The private observation remains the exact constructor receipt.
    Object.defineProperty(nominal, "reason", {
      get() {
        receivedCalls++;
        throw new Error("Opaque reason");
      },
    });
    Object.defineProperty(nominal, "diagnostic", {
      get() {
        receivedCalls++;
        throw new Error("Opaque diagnostic");
      },
    });
    expect(readLocalVerificationCacheFailure(nominal)).toBe(admitted);
    const forged = Object.create(LocalVerificationCacheError.prototype);
    Object.defineProperty(forged, "reason", {
      get() {
        receivedCalls++;
        throw new Error("Forged reason");
      },
    });
    const proxy = new Proxy(nominal, {
      get() {
        receivedCalls++;
        throw new Error("Opaque property trap");
      },
      getPrototypeOf() {
        receivedCalls++;
        throw new Error("Opaque prototype trap");
      },
      getOwnPropertyDescriptor() {
        receivedCalls++;
        throw new Error("Opaque descriptor trap");
      },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const value of [
      undefined,
      null,
      "cancelled",
      0,
      Symbol("opaque"),
      () => {},
      {},
      new Error("Opaque"),
      forged,
      proxy,
      revoked.proxy,
    ])
      expect(readLocalVerificationCacheFailure(value)).toBeUndefined();
    expect(receivedCalls).toBe(0);
    expect(() => new LocalVerificationCacheError("foreign" as "cancelled")).toThrow(
      "Unsupported local verification cache failure reason.",
    );
  });

  it("refuses unsafe fingerprints without invoking received getters or proxy traps", async () => {
    let receivedCalls = 0;
    const getter = Object.defineProperty({ fence }, "key", {
      get() {
        receivedCalls++;
        return key;
      },
    });
    const proxy = new Proxy(
      { key, fence },
      {
        getOwnPropertyDescriptor() {
          receivedCalls++;
          throw new Error("Received proxy trap");
        },
        getPrototypeOf() {
          receivedCalls++;
          throw new Error("Received proxy trap");
        },
      },
    );
    const revoked = Proxy.revocable({ key, fence }, {});
    revoked.revoke();
    for (const value of [
      getter,
      proxy,
      revoked.proxy,
      [],
      null,
      { key: "A".repeat(64), fence },
      { key, fence: "x" },
      { key, fence, extra: true },
      { key, fence, [Symbol("extra")]: true },
      Object.create({ key, fence }),
    ]) {
      const { store } = memoryStore();
      const cache = createLocalVerificationCache({
        store,
        fingerprint: async () => value as LocalVerificationInputSnapshot,
      });
      const execute = vi.fn(async () => {});
      const observations: LocalVerificationCacheDiagnostic[] = [];
      const refused = {
        phase: "pre-execute",
        outcome: "refused",
        key: "unavailable",
        fence: "unavailable",
        reason: "invalid-fingerprint",
      } as const;
      await expect(
        cache.run(task, new AbortController().signal, execute, (diagnostic) =>
          observations.push(diagnostic),
        ),
      ).rejects.toMatchObject({
        reason: "invalid-fingerprint",
        diagnostic: refused,
      });
      expect(observations).toEqual([refused]);
      expect(execute).not.toHaveBeenCalled();
      expect(store.read).not.toHaveBeenCalled();
      expect(store.publish).not.toHaveBeenCalled();
    }
    expect(receivedCalls).toBe(0);
  });

  it("runs without reuse authority when input capture is unavailable and bypasses both cache operations with fresh", async () => {
    const { store, keys } = memoryStore();
    keys.add(key);
    const fingerprint = vi.fn(async () => undefined);
    const execute = vi.fn(async () => {});
    const unavailable = createLocalVerificationCache({ store, fingerprint });
    const observations: LocalVerificationCacheDiagnostic[] = [];
    expect(
      (
        await unavailable.run(task, new AbortController().signal, execute, (diagnostic) =>
          observations.push(diagnostic),
        )
      ).status,
    ).toBe("fresh");
    expect(observations).toEqual([
      { phase: "pre-execute", outcome: "unavailable", key: "unavailable", fence: "unavailable" },
      { phase: "post-execute", outcome: "unavailable", key: "unavailable", fence: "unavailable" },
    ]);
    expect(fingerprint).toHaveBeenCalledTimes(2);
    const fresh = createLocalVerificationCache({
      store,
      fresh: true,
      fingerprint: async () => ({ key, fence }),
    });
    expect((await fresh.run(task, new AbortController().signal, execute)).message).toContain(
      "--fresh",
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(store.read).not.toHaveBeenCalled();
    expect(store.publish).not.toHaveBeenCalled();
  });

  it("treats unavailable or malformed cache results as misses while preserving an actual task failure", async () => {
    const { store } = memoryStore();
    store.read.mockRejectedValueOnce(new Error("Opaque store failure"));
    store.publish.mockRejectedValueOnce(new Error("Opaque write failure"));
    const cache = createLocalVerificationCache({
      store,
      fingerprint: async () => ({ key, fence }),
    });
    const execute = vi.fn(async () => {});
    const result = await cache.run(task, new AbortController().signal, execute);
    expect(result.status).toBe("fresh");
    expect(result.message).toBe("Freshly executed; no successful-task receipt was stored.");
    store.read.mockResolvedValueOnce("true" as unknown as boolean);
    await cache.run(task, new AbortController().signal, execute);
    expect(execute).toHaveBeenCalledTimes(2);
    const failure = new Error("Original executor failure");
    store.read.mockResolvedValueOnce(false);
    await expect(
      cache.run(task, new AbortController().signal, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(store.publish).toHaveBeenCalledTimes(2);
  });

  for (const { label, after, keyOutcome, fenceOutcome, publication } of [
    {
      label: "key drift after a committed publication",
      after: { key: changedKey, fence },
      keyOutcome: "changed",
      fenceOutcome: "same",
      publication: "stored",
    },
    {
      label: "fence drift after a committed publication",
      after: { key, fence: changedFence },
      keyOutcome: "same",
      fenceOutcome: "changed",
      publication: "stored",
    },
    {
      label: "unavailable inputs after a committed publication",
      after: undefined,
      keyOutcome: "unavailable",
      fenceOutcome: "unavailable",
      publication: "stored",
    },
    {
      label: "key drift while publication returns unavailable",
      after: { key: changedKey, fence },
      keyOutcome: "changed",
      fenceOutcome: "same",
      publication: "unavailable",
    },
    {
      label: "key drift while publication throws",
      after: { key: changedKey, fence },
      keyOutcome: "changed",
      fenceOutcome: "same",
      publication: "failed",
    },
  ] as const) {
    it(`rejects ${label} without revoking earlier successful evidence`, async (context) => {
      const controller = new AbortController();
      const entered = deferred<void>();
      const release = deferred<void>();
      const pending: Promise<unknown>[] = [];
      const { store, keys } = memoryStore();
      let current: LocalVerificationInputSnapshot | undefined = { key, fence };
      const observations: LocalVerificationCacheDiagnostic[] = [];
      const retire = () => controller.abort();
      // Register both gate release and ownership joins before the first await.
      // Timeout retirement cannot leave this publication or a later reuse live.
      context.onTestFinished(async () => {
        retire();
        entered.resolve();
        release.resolve();
        await Promise.allSettled(pending);
        context.signal.removeEventListener("abort", retire);
      });
      context.signal.addEventListener("abort", retire, { once: true });
      if (context.signal.aborted) retire();
      store.publish.mockImplementationOnce(async (digest, signal) => {
        entered.resolve();
        await release.promise;
        if (signal.aborted) return false;
        if (publication === "failed") throw new Error("Opaque held publication failure");
        if (publication === "unavailable") return false;
        keys.add(digest);
        return true;
      });
      const cache = createLocalVerificationCache({ store, fingerprint: async () => current });
      const execute = vi.fn(async () => {});
      const run = cache.run(task, controller.signal, execute, (diagnostic) =>
        observations.push(diagnostic),
      );
      pending.push(run);
      const refused = {
        phase: "post-publication",
        outcome: "refused",
        reason: "inputs-changed",
        key: keyOutcome,
        fence: fenceOutcome,
      } as const;
      const rejection = expect(run).rejects.toMatchObject({
        reason: "inputs-changed",
        diagnostic: refused,
      });
      pending.push(rejection);
      await entered.promise;
      if (controller.signal.aborted) throw new Error("Held publication fixture retired.");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(keys.size).toBe(0);
      // The task and its first post-close recheck already completed before
      // publication was admitted. Change inputs only inside that awaited gap.
      current = after;
      release.resolve();
      await rejection;
      if (controller.signal.aborted) throw new Error("Held publication fixture retired.");
      expect(observations.at(-1)).toEqual(refused);
      expect(store.publish).toHaveBeenCalledExactlyOnceWith(key, controller.signal);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(keys.has(key)).toBe(publication === "stored");
      expect(keys.has(changedKey)).toBe(false);
      if (publication === "stored") {
        // A completed task's original content proof remains valid. A later
        // invocation may reuse it with a stable NEW native fence; neither a
        // rollback nor deletion of that older receipt is required or allowed.
        current = { key, fence: changedFence };
        const reexecute = vi.fn(async () => {});
        const reuse = cache.run(task, controller.signal, reexecute);
        pending.push(reuse);
        expect((await reuse).status).toBe("reused");
        expect(reexecute).not.toHaveBeenCalled();
        expect(keys.has(key)).toBe(true);
      }
    });
  }

  it("does not admit execution after a cancelled lookup or publish after cancellation before commit", async (context) => {
    const controller = new AbortController();
    const nextController = new AbortController();
    const lookup = deferred<boolean>();
    const entered = deferred<void>();
    const commit = deferred<void>();
    const pending: Promise<unknown>[] = [];
    const { store, keys } = memoryStore();
    // Release and join both admitted attempts on hard timeout too. A retired
    // test must not leave a held lookup or publication able to complete later.
    context.onTestFinished(async () => {
      controller.abort();
      nextController.abort();
      lookup.resolve(false);
      commit.resolve();
      await Promise.allSettled(pending);
    });
    store.read.mockImplementationOnce(() => {
      entered.resolve();
      return lookup.promise;
    });
    const cache = createLocalVerificationCache({
      store,
      fingerprint: async () => ({ key, fence }),
    });
    const execute = vi.fn(async () => {});
    const cancelled = cache.run(task, controller.signal, execute);
    pending.push(cancelled);
    const rejection = expect(cancelled).rejects.toMatchObject({ reason: "cancelled" });
    await entered.promise;
    controller.abort();
    lookup.resolve(false);
    await rejection;
    expect(execute).not.toHaveBeenCalled();

    const publishing = deferred<void>();
    store.publish.mockImplementationOnce(async (digest, signal) => {
      publishing.resolve();
      await commit.promise;
      if (signal.aborted) return false;
      keys.add(digest);
      return true;
    });
    const next = cache.run(task, nextController.signal, execute);
    pending.push(next);
    const nextRejection = expect(next).rejects.toMatchObject({ reason: "cancelled" });
    await publishing.promise;
    nextController.abort();
    commit.resolve();
    await nextRejection;
    expect(keys.size).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.publish).toHaveBeenCalledExactlyOnceWith(key, nextController.signal);
  });

  it("retains a qualified receipt after its atomic commit but never reports cancelled completion as green", async () => {
    const controller = new AbortController();
    const { store, keys } = memoryStore();
    store.publish.mockImplementationOnce(async (digest) => {
      keys.add(digest); // The store's completed commit is the linearization point.
      controller.abort();
      return true;
    });
    const cache = createLocalVerificationCache({
      store,
      fingerprint: async () => ({ key, fence }),
    });
    await expect(cache.run(task, controller.signal, async () => {})).rejects.toMatchObject({
      reason: "cancelled",
    });
    expect(keys.has(key)).toBe(true);
    const execute = vi.fn(async () => {});
    expect((await cache.run(task, new AbortController().signal, execute)).status).toBe("reused");
    expect(execute).not.toHaveBeenCalled();
  });
});
