import { describe, expect, it, vi } from "vitest";
import type { LocalVerificationTask } from "./local-verification-cache-contract.ts";
import {
  LocalVerificationCacheError,
  type LocalVerificationCache,
  type LocalVerificationCacheResult,
} from "./local-verification-cache.ts";
import { withLocalVerificationReusePolicy } from "./local-verification-reuse-policy.ts";

function task(scope: LocalVerificationTask["scope"], id = "synthetic-task"): LocalVerificationTask {
  return {
    id,
    cwd: import.meta.dirname,
    args: ["original-command", "--original-option"],
    environment: { SYNTHETIC_INPUT: "unchanged" },
    scope,
  };
}

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const eligible = [
  task({ kind: "node", workspace: "apps/server" }),
  task({
    kind: "typecheck",
    workspace: "packages/effect-codex-app-server",
    compiler: "synthetic-qualified-compiler",
  }),
  task({ kind: "typecheck", workspace: "apps/server", compiler: "synthetic-qualified-compiler" }),
  task(
    { kind: "browser", files: ["original.browser.tsx"], projects: ["desktop", "touch"] },
    "browser:Desktop and touch features",
  ),
  task(
    { kind: "browser", files: ["original.browser.tsx"], projects: ["desktop"] },
    "browser:Mermaid security",
  ),
  task(
    { kind: "browser", files: ["original.browser.tsx"], projects: ["desktop"] },
    "browser:Mermaid families",
  ),
];

describe("local reuse cost policy", () => {
  it.each(eligible)(
    "forwards eligible $scope.kind/$id without changing its owner or result",
    async (candidate) => {
      const signal = new AbortController().signal;
      let originalRuns = 0;
      const execute = vi.fn(async () => {
        originalRuns += 1;
      });
      const result: LocalVerificationCacheResult = {
        status: "fresh",
        message: "Original coordinator result.",
      };
      const observe = vi.fn();
      const run = vi.fn<LocalVerificationCache["run"]>(
        async (received, receivedSignal, receivedExecute, receivedObserver) => {
          expect(received).toBe(candidate);
          expect(receivedSignal).toBe(signal);
          expect(receivedExecute).toBe(execute);
          expect(receivedObserver).toBe(observe);
          await receivedExecute();
          return result;
        },
      );
      expect(
        await withLocalVerificationReusePolicy({ run }).run(candidate, signal, execute, observe),
      ).toBe(result);
      expect(run).toHaveBeenCalledExactlyOnceWith(candidate, signal, execute, observe);
      expect(execute).toHaveBeenCalledOnce();
      expect(originalRuns).toBe(1);
    },
  );

  it("retains an eligible authenticated reuse result without forcing execution", async () => {
    const result: LocalVerificationCacheResult = {
      status: "reused",
      message: "Original prior-success receipt.",
    };
    const run = vi.fn<LocalVerificationCache["run"]>(async () => result);
    const execute = vi.fn(async () => {});
    expect(
      await withLocalVerificationReusePolicy({ run }).run(
        eligible[0]!,
        new AbortController().signal,
        execute,
      ),
    ).toBe(result);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    task({ kind: "node", workspace: "apps/web" }),
    task({ kind: "node", workspace: "packages/shared" }),
    task({ kind: "node", workspace: "future-workspace" }),
    task({ kind: "typecheck", workspace: "apps/web", compiler: "synthetic-qualified-compiler" }),
    task({
      kind: "typecheck",
      workspace: "packages/contracts",
      compiler: "synthetic-qualified-compiler",
    }),
    task({ kind: "typecheck", workspace: "scripts", compiler: "synthetic-qualified-compiler" }),
    task(
      { kind: "browser", files: ["original.browser.tsx"], projects: ["desktop"] },
      "browser:Diagram and table PNG",
    ),
    task(
      { kind: "browser", files: ["original.browser.tsx"], projects: ["desktop"] },
      "browser:Mermaid security extra",
    ),
    task(
      { kind: "browser", files: ["original.browser.tsx"], projects: ["desktop"] },
      "browser:future-group",
    ),
    // A familiar identifier never overrides the scope's different policy.
    task({ kind: "node", workspace: "scripts" }, "browser:Mermaid security"),
  ])(
    "executes bypassed $scope.kind/$id without entering any underlying cache work",
    async (candidate) => {
      const run = vi.fn<LocalVerificationCache["run"]>(async () => {
        throw new Error("The bypass must not enter fingerprint or receipt work.");
      });
      let originalRuns = 0;
      const execute = vi.fn(async () => {
        originalRuns += 1;
      });
      const result = await withLocalVerificationReusePolicy({ run }).run(
        candidate,
        new AbortController().signal,
        execute,
      );
      expect(result.status).toBe("fresh");
      expect(result.message).toContain("bypasses local result reuse");
      expect(originalRuns).toBe(1);
      expect(execute).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("propagates the original bypass failure by identity, even if cancellation also arrives", async () => {
    const controller = new AbortController();
    const failure = new Error("Original synthetic executor failure.");
    const run = vi.fn<LocalVerificationCache["run"]>(async () => ({
      status: "reused",
      message: "Unreachable.",
    }));
    const execute = vi.fn(async () => {
      controller.abort();
      throw failure;
    });
    await expect(
      withLocalVerificationReusePolicy({ run }).run(
        task({ kind: "node", workspace: "scripts" }),
        controller.signal,
        execute,
      ),
    ).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses an already-retired owner before either fresh or cached admission", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn<LocalVerificationCache["run"]>(async () => ({
      status: "reused",
      message: "Unreachable.",
    }));
    const execute = vi.fn(async () => {});
    const policy = withLocalVerificationReusePolicy({ run });
    for (const candidate of [eligible[0]!, task({ kind: "node", workspace: "scripts" })])
      await expect(policy.run(candidate, controller.signal, execute)).rejects.toMatchObject({
        reason: "cancelled",
      });
    expect(run).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("joins an admitted bypass callback before refusing its late successful completion", async (context) => {
    const entered = deferred();
    const held = deferred();
    const controller = new AbortController();
    const run = vi.fn<LocalVerificationCache["run"]>(async () => ({
      status: "reused",
      message: "Unreachable.",
    }));
    let pending: Promise<LocalVerificationCacheResult> | undefined;
    context.onTestFinished(async () => {
      held.release();
      await pending?.catch(() => {});
    });
    let originalClosed = false;
    let settled = false;
    pending = withLocalVerificationReusePolicy({ run }).run(
      task({ kind: "node", workspace: "scripts" }),
      controller.signal,
      async () => {
        entered.release();
        await held.promise;
        originalClosed = true;
      },
    );
    const rejection = expect(pending).rejects.toBeInstanceOf(LocalVerificationCacheError);
    void pending
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    await entered.promise;
    controller.abort();
    expect(originalClosed).toBe(false);
    expect(settled).toBe(false);
    held.release();
    await rejection;
    expect(originalClosed).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("cannot convert an eligible cache completion after cancellation into qualification", async () => {
    const controller = new AbortController();
    const run = vi.fn<LocalVerificationCache["run"]>(async () => {
      controller.abort();
      return { status: "reused", message: "An already-retired cached completion." };
    });
    const execute = vi.fn(async () => {});
    await expect(
      withLocalVerificationReusePolicy({ run }).run(eligible[0]!, controller.signal, execute),
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(run).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
});
