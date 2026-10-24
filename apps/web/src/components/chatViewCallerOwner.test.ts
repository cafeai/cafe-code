import { afterEach, describe, expect, it, vi, type TestContext } from "vitest";
import {
  createChatViewCallerOwner,
  type ChatViewCallerMountOptions,
} from "./chatViewCallerOwner.test.fixture";

const mountOptions: Omit<ChatViewCallerMountOptions, "lifecycle"> = {
  viewport: {
    name: "inert-owner",
    width: 1,
    height: 1,
    textTolerancePx: 0,
    attachmentTolerancePx: 0,
  },
  snapshot: {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: "2026-10-24T00:00:00.000Z",
  },
};

/** Public hooks are exercised without aborting Vitest's enclosing test. Every
 * inert gate has a completion fallback, so a failed unit assertion cannot leave
 * its synthetic owner pending. These fallback joins are not positive evidence:
 * each case explicitly asserts its own observed completion/error below.
 */
function hooks(actual: TestContext, preaborted = false) {
  const controller = new AbortController();
  if (preaborted) controller.abort();
  const finished: Parameters<TestContext["onTestFinished"]>[0][] = [];
  const failed: Parameters<TestContext["onTestFailed"]>[0][] = [];
  const releases: (() => void)[] = [];
  actual.onTestFinished(async () => {
    for (const release of releases) release();
    controller.abort();
    await Promise.allSettled(finished.map((callback) => callback(actual)));
  });
  return {
    controller,
    context: {
      signal: controller.signal,
      onTestFinished: (callback) => {
        finished.push(callback);
      },
      onTestFailed: (callback) => {
        failed.push(callback);
      },
    } satisfies Pick<TestContext, "signal" | "onTestFinished" | "onTestFailed">,
    gate<T>(fallback: T) {
      let resolve!: (value: T) => void;
      let reject!: (failure: unknown) => void;
      const promise = new Promise<T>((complete, refuse) => {
        resolve = complete;
        reject = refuse;
      });
      releases.push(() => resolve(fallback));
      return { promise, resolve, reject };
    },
    async finish() {
      for (const callback of finished) await callback(actual);
    },
    async reportFailure() {
      for (const callback of failed) await callback(actual);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("exact ChatView caller ownership", () => {
  it("refuses an unknown label before hook registration, acquisition or diagnostic emission", (context) => {
    const h = hooks(context);
    const finish = vi.spyOn(h.context, "onTestFinished");
    const failed = vi.spyOn(h.context, "onTestFailed");
    const listen = vi.spyOn(h.controller.signal, "addEventListener");
    const sink = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mount = vi.fn(async (_options: ChatViewCallerMountOptions) => undefined);
    expect(() =>
      Reflect.apply(createChatViewCallerOwner, undefined, [
        h.context,
        mount,
        { label: "unrecognized-fixture-label" },
      ]),
    ).toThrow("Unsupported synthetic caller label");
    expect(finish).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
  });

  it("refuses a foreign lifecycle before acquisition without consuming its one exact mount", async (context) => {
    const h = hooks(context);
    const ownDispose = vi.fn(async () => undefined);
    const foreignRetire = vi.fn(async () => undefined);
    const foreignCapture = vi.fn((_cleanup: () => Promise<void>) => undefined);
    const foreignAssert = vi.fn(() => undefined);
    const foreignPhase = vi.fn((_phase: string) => undefined);
    const mount = vi.fn(async (options: ChatViewCallerMountOptions) => {
      options.lifecycle?.ownCleanup(ownDispose);
      return { mounted: true };
    });
    const owner = createChatViewCallerOwner(h.context, mount, { label: "desk-preview" });
    expect(() =>
      Reflect.apply(owner.mount, owner, [
        {
          ...mountOptions,
          lifecycle: {
            assertActive: foreignAssert,
            retire: foreignRetire,
            ownCleanup: foreignCapture,
            observePhase: foreignPhase,
          },
        },
      ]),
    ).toThrow("lifecycle cannot be replaced");
    expect(mount).not.toHaveBeenCalled();
    expect(await owner.mount(mountOptions)).toEqual({ mounted: true });
    await owner.cleanup();
    expect(mount).toHaveBeenCalledOnce();
    expect(ownDispose).toHaveBeenCalledOnce();
    expect(foreignRetire).not.toHaveBeenCalled();
    expect(foreignCapture).not.toHaveBeenCalled();
    expect(foreignAssert).not.toHaveBeenCalled();
    expect(foreignPhase).not.toHaveBeenCalled();
  });

  it("refuses a preaborted body, mount and action without acquiring them", async (context) => {
    const h = hooks(context, true);
    const mount = vi.fn(async (_options: ChatViewCallerMountOptions) => ({ mounted: true }));
    const body = vi.fn(async () => undefined);
    const action = vi.fn(async () => undefined);
    const owner = createChatViewCallerOwner(h.context, mount, { label: "desk-preview" });
    await expect(owner.run(body)).rejects.toThrow("retired");
    expect(() => owner.mount(mountOptions)).toThrow("retired");
    await expect(owner.own("request", action)).rejects.toThrow("retired");
    await h.finish();
    expect(body).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it("joins the original admitted action before disposal and refuses a retired continuation", async (context) => {
    const h = hooks(context);
    const actionGate = h.gate(7);
    const admitted = h.gate(undefined);
    const releasing = h.gate(undefined);
    const order: string[] = [];
    const dispose = vi.fn(async () => {
      order.push("unmount");
    });
    const restore = vi.fn(() => {
      order.push("restore");
    });
    const owner = createChatViewCallerOwner(
      h.context,
      async (options) => {
        options.lifecycle?.ownCleanup(dispose);
        return { mounted: true };
      },
      {
        label: "pending-steer",
        beforeDrain: () => {
          order.push("release");
          releasing.resolve(undefined);
        },
        afterUnmount: restore,
      },
    );
    await owner.mount(mountOptions);
    const action = owner.own("request", () => {
      admitted.resolve(undefined);
      return actionGate.promise;
    });
    const observed = action.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    await admitted.promise;
    h.controller.abort();
    const completion = owner.cleanup();
    await releasing.promise;
    expect(dispose).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    const late = vi.fn(async () => undefined);
    await expect(owner.own("request", late)).rejects.toThrow("retired");
    expect(late).not.toHaveBeenCalled();
    actionGate.resolve(7);
    expect(await observed).toEqual(
      expect.objectContaining({ message: expect.stringContaining("retired") }),
    );
    await completion;
    await h.finish();
    expect(order).toEqual(["release", "unmount", "restore"]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
  });

  it("retains a late mount and unmounts its exact result once after abort", async (context) => {
    const h = hooks(context);
    const rendered = h.gate({ native: "owned" });
    const entered = h.gate(undefined);
    const dispose = vi.fn(async () => undefined);
    let exactResult: { native: string } | undefined;
    const owner = createChatViewCallerOwner(
      h.context,
      async (options) => {
        options.lifecycle?.ownCleanup(async () => {
          exactResult = await rendered.promise;
          await dispose();
        });
        entered.resolve(undefined);
        return rendered.promise;
      },
      { label: "editor-promotion" },
    );
    const mounting = owner.mount(mountOptions);
    const observed = mounting.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    await entered.promise;
    h.controller.abort();
    const completion = owner.cleanup();
    expect(dispose).not.toHaveBeenCalled();
    const nativeResult = { native: "exact-late-result" };
    rendered.resolve(nativeResult);
    expect(await observed).toEqual(
      expect.objectContaining({ message: expect.stringContaining("retired") }),
    );
    await completion;
    expect(exactResult).toBe(nativeResult);
    expect(dispose).toHaveBeenCalledOnce();
    expect(owner.cleanup()).toBe(completion);
  });

  it("releases only its held ACK before joining a mount that depends on it", async (context) => {
    const h = hooks(context);
    const acknowledgement = h.gate(undefined);
    const entered = h.gate(undefined);
    const order: string[] = [];
    const release = vi.fn(() => {
      order.push("release");
      acknowledgement.resolve(undefined);
    });
    const dispose = vi.fn(async () => {
      order.push("unmount");
    });
    const owner = createChatViewCallerOwner(
      h.context,
      async (options) => {
        options.lifecycle?.ownCleanup(dispose);
        entered.resolve(undefined);
        await acknowledgement.promise;
        order.push("mounted");
        return { mounted: true };
      },
      { label: "subagent-obsolete-ack", beforeDrain: release },
    );
    const mounting = owner.mount(mountOptions);
    const observed = mounting.then(
      () => undefined,
      (failure: unknown) => failure,
    );
    await entered.promise;
    const completion = owner.cleanup();
    expect(owner.cleanup()).toBe(completion);
    await completion;
    expect(await observed).toEqual(
      expect.objectContaining({ message: expect.stringContaining("retired") }),
    );
    expect(order).toEqual(["release", "mounted", "unmount"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("publishes cleanup before reentrant release and never replays disposal", async (context) => {
    const h = hooks(context);
    let reentrant: Promise<void> | undefined;
    const dispose = vi.fn(async () => undefined);
    const release: () => void = vi.fn(() => {
      reentrant = owner.cleanup();
    });
    const owner = createChatViewCallerOwner(
      h.context,
      async (options) => {
        options.lifecycle?.ownCleanup(dispose);
        options.lifecycle?.ownCleanup(dispose);
        return undefined;
      },
      { label: "subagent-already-canonical", beforeDrain: release },
    );
    await owner.mount(mountOptions);
    const completion = owner.cleanup();
    await completion;
    expect(reentrant).toBe(completion);
    await h.finish();
    expect(release).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("refuses a second mount and a replacement raw cleanup without losing the first", async (context) => {
    const h = hooks(context);
    const dispose = vi.fn(async () => undefined);
    const replacement = vi.fn(async () => undefined);
    const mount = vi.fn(async (options: ChatViewCallerMountOptions) => {
      options.lifecycle?.ownCleanup(dispose);
      options.lifecycle?.ownCleanup(replacement);
      return undefined;
    });
    const owner = createChatViewCallerOwner(h.context, mount, { label: "desk-preview" });
    await expect(owner.mount(mountOptions)).rejects.toThrow("cannot be replaced");
    expect(() => owner.mount(mountOptions)).toThrow("already owns");
    await owner.cleanup();
    expect(mount).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
  });

  it("preserves original operation rejection and synchronous throw identities", async (context) => {
    const h = hooks(context);
    const owner = createChatViewCallerOwner(h.context, async () => undefined, {
      label: "worktree-overrides",
    });
    const rejected = Object.freeze({ opaque: "rejected fixture operation" });
    const thrown = Object.freeze({ opaque: "synchronous fixture operation" });
    await expect(owner.own("request", () => Promise.reject(rejected))).rejects.toBe(rejected);
    await expect(
      owner.own("request", () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    await owner.cleanup();
  });

  it("keeps an original late action rejection opaque after retirement", async (context) => {
    const h = hooks(context);
    const native = h.gate<unknown>(undefined);
    const failure = Object.freeze({ opaque: "late native action" });
    const owner = createChatViewCallerOwner(h.context, async () => undefined, {
      label: "pending-steer",
    });
    const action = owner.own("request", () => native.promise);
    const observed = action.then(
      () => undefined,
      (received: unknown) => received,
    );
    h.controller.abort();
    const completion = owner.cleanup();
    native.reject(failure);
    expect(await observed).toBe(failure);
    await completion;
  });

  it("does not restore an override before the exact native disposer settles", async (context) => {
    const h = hooks(context);
    const unmount = h.gate(undefined);
    const entered = h.gate(undefined);
    const restore = vi.fn(() => undefined);
    const owner = createChatViewCallerOwner(
      h.context,
      async (options) => {
        options.lifecycle?.ownCleanup(async () => {
          entered.resolve(undefined);
          await unmount.promise;
        });
        return undefined;
      },
      { label: "image-only-send", afterUnmount: restore },
    );
    await owner.mount(mountOptions);
    const completion = owner.cleanup();
    await entered.promise;
    expect(restore).not.toHaveBeenCalled();
    unmount.resolve(undefined);
    await completion;
    expect(restore).toHaveBeenCalledOnce();
  });

  it("continues cleanup stages and preserves all opaque failures without replacing the body failure", async (context) => {
    const h = hooks(context);
    const bodyFailure = Object.freeze({ opaque: "body" });
    const releaseFailure = Object.freeze({ opaque: "release" });
    const unmountFailure = Object.freeze({ opaque: "unmount" });
    const restoreFailure = Object.freeze({ opaque: "restore" });
    const order: string[] = [];
    const owner = createChatViewCallerOwner(
      h.context,
      async (options) => {
        options.lifecycle?.ownCleanup(async () => {
          order.push("unmount");
          throw unmountFailure;
        });
        return undefined;
      },
      {
        label: "reconnect-exhaustion",
        beforeDrain: () => {
          order.push("release");
          throw releaseFailure;
        },
        afterUnmount: () => {
          order.push("restore");
          throw restoreFailure;
        },
      },
    );
    await expect(
      owner.run(async () => {
        await owner.mount(mountOptions);
        throw bodyFailure;
      }),
    ).rejects.toBe(bodyFailure);
    const cleanupFailure = await owner.cleanup().then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(cleanupFailure).toBeInstanceOf(AggregateError);
    expect(cleanupFailure).toEqual(
      expect.objectContaining({
        message: "Synthetic chat caller cleanup failed.",
        errors: [releaseFailure, unmountFailure, restoreFailure],
      }),
    );
    if (
      !cleanupFailure ||
      typeof cleanupFailure !== "object" ||
      !("errors" in cleanupFailure) ||
      !Array.isArray(cleanupFailure.errors)
    )
      throw new Error("Opaque cleanup failures missing.");
    expect(cleanupFailure.errors[0]).toBe(releaseFailure);
    expect(cleanupFailure.errors[1]).toBe(unmountFailure);
    expect(cleanupFailure.errors[2]).toBe(restoreFailure);
    await expect(h.finish()).rejects.toBe(cleanupFailure);
    expect(order).toEqual(["release", "unmount", "restore"]);
  });

  it("fails a successful body with its single exact cleanup rejection", async (context) => {
    const h = hooks(context);
    const failure = Object.freeze({ opaque: "cleanup" });
    const owner = createChatViewCallerOwner(
      h.context,
      async (options) => {
        options.lifecycle?.ownCleanup(async () => {
          throw failure;
        });
        return undefined;
      },
      { label: "restored-compaction" },
    );
    await expect(
      owner.run(async () => {
        await owner.mount(mountOptions);
        return 7;
      }),
    ).rejects.toBe(failure);
    await expect(owner.cleanup()).rejects.toBe(failure);
  });

  it.for(["thenable", "value"] as const)(
    "refuses an unexpected synchronous-release return (%s) without inspecting it or skipping cleanup",
    async (kind, context) => {
      const h = hooks(context);
      let thenReads = 0;
      const thenable = {
        get then() {
          thenReads += 1;
          throw new Error("Synthetic then property must remain unread.");
        },
      };
      const dispose = vi.fn(async () => undefined);
      const restore = vi.fn(() => undefined);
      const owner = createChatViewCallerOwner(
        h.context,
        async (options) => {
          options.lifecycle?.ownCleanup(dispose);
          return undefined;
        },
        {
          label: "subagent-obsolete-ack",
          beforeDrain: () => (kind === "thenable" ? thenable : 7),
          afterUnmount: restore,
        },
      );
      await owner.mount(mountOptions);
      await expect(owner.cleanup()).rejects.toThrow("must finish synchronously");
      expect(thenReads).toBe(0);
      expect(dispose).toHaveBeenCalledOnce();
      expect(restore).toHaveBeenCalledOnce();
    },
  );

  it("refuses direct cleanup self-joins instead of retaining them as pending work", async (context) => {
    const h = hooks(context);
    const owner = createChatViewCallerOwner(h.context, async () => undefined, {
      label: "pending-steer",
    });
    await expect(owner.own("request", () => owner.cleanup())).rejects.toThrow(
      "join its own cleanup",
    );
    await owner.cleanup();
  });

  it("refuses a raw mount returning caller cleanup before retaining a circular mount join", async (context) => {
    const h = hooks(context);
    const mount = (_options: ChatViewCallerMountOptions): Promise<void> => owner.cleanup();
    const owner = createChatViewCallerOwner(h.context, mount, { label: "editor-promotion" });
    await expect(owner.mount(mountOptions)).rejects.toThrow("mount cannot join its caller cleanup");
    await owner.cleanup();
  });

  it("refuses a self-joining raw disposer and restoration while still finishing both stages", async (context) => {
    const h = hooks(context);
    const restored: () => Promise<void> = vi.fn(() => owner.cleanup());
    const owner = createChatViewCallerOwner(
      h.context,
      async (options) => {
        options.lifecycle?.ownCleanup(() => owner.cleanup());
        return undefined;
      },
      { label: "image-only-send", afterUnmount: restored },
    );
    await owner.mount(mountOptions);
    const failure = await owner.cleanup().then(
      () => undefined,
      (received: unknown) => received,
    );
    expect(failure).toEqual(
      expect.objectContaining({
        message: "Synthetic chat caller cleanup failed.",
        errors: [
          expect.objectContaining({ message: "A mount cannot return its caller cleanup." }),
          expect.objectContaining({ message: "A restoration cannot return its own cleanup." }),
        ],
      }),
    );
    expect(restored).toHaveBeenCalledOnce();
  });

  it("records only bounded finite fixed phases and ignores late passive callbacks", async (context) => {
    const h = hooks(context);
    const sink = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const owner = createChatViewCallerOwner(h.context, async () => undefined, {
      label: "desk-preview",
    });
    await owner.run(async () => {
      for (let index = 0; index < 40; index += 1) owner.mark("input");
    });
    await h.reportFailure();
    const first: unknown = sink.mock.calls[0]?.[1];
    expect(first).toEqual(expect.objectContaining({ label: "desk-preview" }));
    if (!first || typeof first !== "object" || !("phases" in first) || !Array.isArray(first.phases))
      throw new Error("Fixed owner diagnostic records missing.");
    expect(first.phases).toHaveLength(16);
    for (const entry of first.phases) {
      const row: unknown = entry;
      if (!row || typeof row !== "object" || !("elapsedMs" in row) || !("count" in row))
        throw new Error("Invalid fixed owner diagnostic record.");
      if (typeof row.elapsedMs !== "number" || typeof row.count !== "number")
        throw new Error("Non-numeric fixed owner diagnostic record.");
      expect(Number.isFinite(row.elapsedMs)).toBe(true);
      expect(Number.isFinite(row.count)).toBe(true);
    }
    owner.mark("image");
    await h.reportFailure();
    expect(sink.mock.calls[1]?.[1]).toEqual(first);
    const operation = vi.fn(async () => undefined);
    await expect(
      Reflect.apply(owner.own, owner, ["private-fixture-payload", operation]),
    ).rejects.toThrow("Unsupported synthetic caller phase");
    expect(operation).not.toHaveBeenCalled();
  });
});
