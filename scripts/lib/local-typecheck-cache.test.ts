// These are lexical fixture program identities; no compiler or profile IO runs.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve } from "node:path";
import { describe, expect, it, vi, type TestContext } from "vitest";
import { cachedLocalTypecheckLaunch as nativeCachedLaunch } from "./local-typecheck-cache.ts";
import type { LocalCompilerExit } from "./local-typecheck.ts";
import type { LocalVerificationCache } from "./local-verification-cache.ts";

const program = { name: "fixture", cwd: import.meta.dirname, compiler: process.execPath };
const successful = { code: 0, signal: null, transportError: false } as const;
// Queue/controller behavior is cross-platform. The separate metadata fixture
// qualifies real POSIX file retirement; no Windows ACL proof is borrowed here.
const cachedLocalTypecheckLaunch: typeof nativeCachedLaunch = (root, cache, launch) =>
  nativeCachedLaunch(root, cache, launch, async () => {});

function isolatedTaskEnvironment(context: TestContext) {
  context.onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  for (const name of Object.keys(process.env).filter((name) => name.startsWith("GIT_")))
    vi.stubEnv(name, undefined);
  for (const name of [
    "CI",
    "GITHUB_ACTIONS",
    "NODE_OPTIONS",
    "NODE_PATH",
    "BASH_ENV",
    "ENV",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
  ])
    vi.stubEnv(name, undefined);
  vi.stubEnv("CODEX_TOOL_CALL_ID", "synthetic-inherited-call");
  vi.stubEnv("CAFE_CODE_CACHE_ENV_SENTINEL", "retain-literal");
}

describe("cached compiler admission", () => {
  it("fingerprints and launches one exact frozen eligible task environment", async (context) => {
    isolatedTaskEnvironment(context);
    const root = import.meta.dirname;
    const eligible = {
      ...program,
      cwd: resolve(root, "packages/effect-codex-app-server"),
    };
    let fingerprintEnvironment: Readonly<NodeJS.ProcessEnv> | undefined;
    let cacheCalls = 0;
    let launches = 0;
    const cache: LocalVerificationCache = {
      async run(task, _signal, execute) {
        cacheCalls += 1;
        fingerprintEnvironment = task.environment;
        expect(Object.isFrozen(task.environment)).toBe(true);
        expect(Object.hasOwn(task.environment, "CODEX_TOOL_CALL_ID")).toBe(
          process.platform === "win32",
        );
        expect(task.environment.CAFE_CODE_CACHE_ENV_SENTINEL === "retain-literal").toBe(true);
        expect(task.environment.NODE_OPTIONS).toBe("--max-old-space-size=4096");
        await execute();
        return { status: "fresh", message: "Synthetic exact environment qualified." };
      },
    };
    const held = cachedLocalTypecheckLaunch(root, cache, (_program, environment) => {
      launches += 1;
      // A hash-only omission would fail this exact-object execution seam.
      expect(environment === fingerprintEnvironment).toBe(true);
      return { closed: Promise.resolve(successful), terminate: () => {} };
    })(eligible);
    expect(await held.closed).toEqual(successful);
    expect(cacheCalls).toBe(1);
    expect(launches).toBe(1);
    expect(process.env.CODEX_TOOL_CALL_ID === "synthetic-inherited-call").toBe(true);
    expect(process.env.CAFE_CODE_CACHE_ENV_SENTINEL === "retain-literal").toBe(true);
  });

  it("retains the inherited call marker for fresh and ineligible compiler programs", async (context) => {
    isolatedTaskEnvironment(context);
    for (const scenario of [
      { reuse: false, workspace: "packages/effect-codex-app-server" },
      { reuse: true, workspace: "apps/desktop" },
    ]) {
      let fingerprintEnvironment: Readonly<NodeJS.ProcessEnv> | undefined;
      let cacheCalls = 0;
      let launches = 0;
      const cache: LocalVerificationCache = {
        async run(task, _signal, execute) {
          cacheCalls += 1;
          fingerprintEnvironment = task.environment;
          await execute();
          return { status: "fresh", message: "Synthetic fresh close." };
        },
      };
      const held = cachedLocalTypecheckLaunch(
        import.meta.dirname,
        scenario.reuse ? cache : undefined,
        (_program, environment) => {
          launches += 1;
          expect(Object.isFrozen(environment)).toBe(true);
          expect(environment?.CODEX_TOOL_CALL_ID === "synthetic-inherited-call").toBe(true);
          expect(environment?.CAFE_CODE_CACHE_ENV_SENTINEL === "retain-literal").toBe(true);
          if (scenario.reuse) expect(environment === fingerprintEnvironment).toBe(true);
          return { closed: Promise.resolve(successful), terminate: () => {} };
        },
      )({ ...program, cwd: resolve(import.meta.dirname, scenario.workspace) });
      expect(await held.closed).toEqual(successful);
      expect(launches).toBe(1);
      expect(cacheCalls).toBe(scenario.reuse ? 1 : 0);
    }
    expect(process.env.CODEX_TOOL_CALL_ID === "synthetic-inherited-call").toBe(true);
  });

  it("retires recognized metadata before a fresh local launch even without a receipt session", async () => {
    const order: string[] = [];
    const held = nativeCachedLaunch(
      import.meta.dirname,
      undefined,
      () => {
        order.push("launch");
        return { closed: Promise.resolve(successful), terminate: () => {} };
      },
      async () => {
        order.push("retire");
      },
    )(program);
    expect(await held.closed).toEqual(successful);
    expect(order).toEqual(["retire", "launch"]);
  });
  it("does not launch a native compiler for an admitted prior success", async () => {
    let launches = 0;
    const cache: LocalVerificationCache = {
      async run(task) {
        expect(task.args.at(-1)).toBe("--noEmit");
        expect(task.environment.NODE_OPTIONS).toBe("--max-old-space-size=4096");
        return { status: "reused", message: "REUSED exact fixture inputs." };
      },
    };
    const held = cachedLocalTypecheckLaunch(import.meta.dirname, cache, () => {
      launches += 1;
      throw new Error("Must not launch.");
    })(program);
    expect(await held.closed).toEqual(successful);
    expect(launches).toBe(0);
  });

  it("joins an admitted compiler close and propagates the queue's exact retirement", async () => {
    let resolve = (_exit: LocalCompilerExit) => {};
    const nativeClose = new Promise<LocalCompilerExit>((done) => {
      resolve = done;
    });
    let terminated = 0;
    let admitted = () => {};
    const launched = new Promise<void>((done) => {
      admitted = done;
    });
    const cache: LocalVerificationCache = {
      async run(_task, signal, execute) {
        await execute();
        if (signal.aborted) throw new Error("Cancelled even with zero close.");
        return { status: "fresh", message: "FRESH exact close." };
      },
    };
    const held = cachedLocalTypecheckLaunch(import.meta.dirname, cache, () => {
      admitted();
      return {
        closed: nativeClose,
        terminate: () => {
          terminated += 1;
        },
      };
    })(program);
    let settled = false;
    void held.closed.then(() => {
      settled = true;
    });
    try {
      await launched;
      held.terminate();
      expect(terminated).toBe(1);
      expect(settled).toBe(false);
    } finally {
      resolve(successful);
    }
    expect((await held.closed).code).toBe(1);
  });

  it("preserves native diagnostic failure and refuses a zero result whose inputs drifted", async () => {
    const failed = { code: 2, signal: null, transportError: false } as const;
    const run: LocalVerificationCache["run"] = async (_task, _signal, execute) => {
      await execute();
      throw new Error("Source changed before receipt publication.");
    };
    for (const actual of [successful, failed]) {
      const held = cachedLocalTypecheckLaunch(import.meta.dirname, { run }, () => ({
        closed: Promise.resolve(actual),
        terminate: () => {},
      }))(program);
      expect(await held.closed).toEqual(
        actual.code === 2 ? failed : { code: 1, signal: null, transportError: false },
      );
    }
  });

  it("keeps uncertain spawn/close failures distinct from ordinary compiler diagnostics", async () => {
    const cache: LocalVerificationCache = {
      async run(_task, _signal, execute) {
        await execute();
        return { status: "fresh", message: "Fresh." };
      },
    };
    const failedSpawn = cachedLocalTypecheckLaunch(import.meta.dirname, cache, () => {
      throw new Error("Synthetic spawn defect.");
    })(program);
    expect((await failedSpawn.closed).transportError).toBe(true);
    const failedClose = cachedLocalTypecheckLaunch(import.meta.dirname, cache, () => ({
      closed: Promise.reject(new Error("Synthetic uncertain close.")),
      terminate: () => {},
    }))(program);
    expect((await failedClose.closed).transportError).toBe(true);
  });

  it("joins exact native close when cancellation during launch cannot request retirement", async () => {
    let release = (_exit: LocalCompilerExit) => {};
    const close = new Promise<LocalCompilerExit>((resolve) => {
      release = resolve;
    });
    let observeRetirement = () => {};
    const retirement = new Promise<void>((resolve) => {
      observeRetirement = resolve;
    });
    let retire = () => {};
    const cache: LocalVerificationCache = {
      async run(_task, _signal, execute) {
        await execute();
        return { status: "fresh", message: "Fresh." };
      },
    };
    const held = cachedLocalTypecheckLaunch(import.meta.dirname, cache, () => {
      retire();
      return {
        closed: close,
        terminate: () => {
          observeRetirement();
          throw new Error("Synthetic retirement transport defect.");
        },
      };
    })(program);
    retire = held.terminate;
    let settled = false;
    void held.closed.then(() => {
      settled = true;
    });
    try {
      await retirement;
      expect(settled).toBe(false);
    } finally {
      release(successful);
    }
    expect(await held.closed).toEqual({ code: 1, signal: null, transportError: true });
  });
});
