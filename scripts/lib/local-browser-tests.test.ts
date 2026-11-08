import { describe, expect, it, vi, type TestContext } from "vitest";
import { runLocalBrowserTestPlan } from "./local-browser-tests.ts";
import type { CompleteLocalBrowserSelection } from "./browser-test-selection.ts";
import type { LocalVerificationCache } from "./local-verification-cache.ts";

const selection: CompleteLocalBrowserSelection = {
  desktopFiles: ["src/components/fixture.browser.tsx"],
  touchFiles: ["src/components/touch.browser.tsx"],
  fluidFiles: [],
  reducedMotionFiles: [],
  mermaidSecurityFiles: [],
  mermaidFamilyFiles: [],
  imageExportFiles: [],
  inlineFiles: [],
};
const steps = [
  { name: "prepare", args: ["exec", "node", "owned-fixture-preparation.ts"] },
  {
    name: "desktop",
    args: [
      "workspace",
      "@cafecode/web",
      "test:browser",
      ...selection.desktopFiles,
      "--project=desktop",
      "--maxWorkers=2",
    ],
  },
  {
    name: "bridge",
    args: ["workspace", "@cafeai/cafe-code", "exec", "vitest"],
    env: { CAFE_FIXTURE: "private-artifact" },
  },
  {
    name: "default-project",
    args: [
      "workspace",
      "@cafecode/web",
      "test:browser",
      ...selection.desktopFiles,
      "--maxWorkers=2",
    ],
  },
];
const eligibleStep = { ...steps[1]!, name: "Desktop and touch features" };

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

describe("local whole-browser-group reuse", () => {
  it("fingerprints and executes the same frozen eligible native-group environment", async (context) => {
    isolatedTaskEnvironment(context);
    let fingerprintEnvironment: Readonly<Record<string, string | undefined>> | undefined;
    let cacheCalls = 0;
    let executions = 0;
    const cache: LocalVerificationCache = {
      async run(task, _signal, execute) {
        cacheCalls += 1;
        fingerprintEnvironment = task.environment;
        expect(task.id).toBe("browser:Desktop and touch features");
        expect(Object.isFrozen(task.environment)).toBe(true);
        expect(Object.hasOwn(task.environment, "CODEX_TOOL_CALL_ID")).toBe(
          process.platform === "win32",
        );
        expect(task.environment.CAFE_CODE_CACHE_ENV_SENTINEL === "retain-literal").toBe(true);
        await execute();
        return { status: "fresh", message: "Synthetic exact environment qualified." };
      },
    };
    await runLocalBrowserTestPlan(
      import.meta.dirname,
      [eligibleStep],
      selection,
      context.signal,
      cache,
      async ([step], execution) => {
        executions += 1;
        expect(step).toBe(eligibleStep);
        // Native execution must receive the object whose complete environment
        // was fingerprinted, not a hash-only normalized projection.
        expect(execution?.environment === fingerprintEnvironment).toBe(true);
      },
    );
    expect(cacheCalls).toBe(1);
    expect(executions).toBe(1);
    expect(process.env.CODEX_TOOL_CALL_ID === "synthetic-inherited-call").toBe(true);
  });

  it("keeps an explicit native step call-marker override literal at both seams", async (context) => {
    isolatedTaskEnvironment(context);
    const step = {
      ...eligibleStep,
      env: { CODEX_TOOL_CALL_ID: "synthetic-explicit-step", CAFE_FIXTURE: "private-artifact" },
    };
    let fingerprintEnvironment: Readonly<Record<string, string | undefined>> | undefined;
    let cacheCalls = 0;
    let executions = 0;
    const cache: LocalVerificationCache = {
      async run(task, _signal, execute) {
        cacheCalls += 1;
        fingerprintEnvironment = task.environment;
        expect(task.environment.CODEX_TOOL_CALL_ID === "synthetic-explicit-step").toBe(true);
        expect(task.environment.CAFE_FIXTURE === "private-artifact").toBe(true);
        expect(task.environment.CAFE_CODE_CACHE_ENV_SENTINEL === "retain-literal").toBe(true);
        expect(Object.isFrozen(task.environment)).toBe(true);
        await execute();
        return { status: "fresh", message: "Synthetic explicit environment qualified." };
      },
    };
    await runLocalBrowserTestPlan(
      import.meta.dirname,
      [step],
      selection,
      context.signal,
      cache,
      async ([actual], execution) => {
        executions += 1;
        expect(actual).toBe(step);
        expect(execution?.environment === fingerprintEnvironment).toBe(true);
        // runTestPlan merges step.env again at launch. Its explicit value must
        // already match the fingerprint rather than being silently stripped.
        expect(actual?.env?.CODEX_TOOL_CALL_ID === "synthetic-explicit-step").toBe(true);
        expect(execution?.environment?.CODEX_TOOL_CALL_ID === "synthetic-explicit-step").toBe(true);
      },
    );
    expect(cacheCalls).toBe(1);
    expect(executions).toBe(1);
    expect(process.env.CODEX_TOOL_CALL_ID === "synthetic-inherited-call").toBe(true);
  });

  it("preserves inherited markers for fresh artifact steps, disabled reuse and unknown groups", async (context) => {
    isolatedTaskEnvironment(context);
    for (const scenario of [
      { step: steps[0]!, reuse: true, cacheCalls: 0 },
      { step: eligibleStep, reuse: false, cacheCalls: 0 },
      { step: { ...eligibleStep, name: "unknown-native-group" }, reuse: true, cacheCalls: 1 },
    ]) {
      let fingerprintEnvironment: Readonly<Record<string, string | undefined>> | undefined;
      let cacheCalls = 0;
      let executions = 0;
      const cache: LocalVerificationCache = {
        async run(task, _signal, execute) {
          cacheCalls += 1;
          fingerprintEnvironment = task.environment;
          await execute();
          return { status: "fresh", message: "Synthetic fresh close." };
        },
      };
      await runLocalBrowserTestPlan(
        import.meta.dirname,
        [scenario.step],
        selection,
        context.signal,
        scenario.reuse ? cache : undefined,
        async (_steps, execution) => {
          executions += 1;
          expect(Object.isFrozen(execution?.environment)).toBe(true);
          expect(execution?.environment?.CODEX_TOOL_CALL_ID === "synthetic-inherited-call").toBe(
            true,
          );
          expect(execution?.environment?.CAFE_CODE_CACHE_ENV_SENTINEL === "retain-literal").toBe(
            true,
          );
          if (scenario.cacheCalls !== 0)
            expect(execution?.environment === fingerprintEnvironment).toBe(true);
        },
      );
      expect(cacheCalls).toBe(scenario.cacheCalls);
      expect(executions).toBe(1);
    }
    expect(process.env.CODEX_TOOL_CALL_ID === "synthetic-inherited-call").toBe(true);
  });

  it("retains fresh artifact IO and exact native group order without restoring browser state", async () => {
    const qualified: string[] = [];
    const executed: string[] = [];
    const order: string[] = [];
    const cache: LocalVerificationCache = {
      async run(task) {
        qualified.push(task.id);
        order.push(task.id);
        expect(task.scope.kind).toBe("browser");
        if (task.scope.kind === "browser") {
          expect(task.scope.files).toEqual(selection.desktopFiles);
          expect(task.scope.projects).toEqual(["desktop"]);
        }
        expect(task.args).toContain("--maxWorkers=2");
        return { status: "reused", message: "REUSED synthetic complete native group." };
      },
    };
    await runLocalBrowserTestPlan(
      import.meta.dirname,
      steps,
      selection,
      new AbortController().signal,
      cache,
      async ([step], options) => {
        executed.push(step!.name);
        order.push(step!.name);
        expect(options?.cwd).toBe(import.meta.dirname);
        if (step!.name === "bridge")
          expect(options?.environment?.CAFE_FIXTURE).toBe("private-artifact");
      },
    );
    expect(executed).toEqual(["prepare", "bridge"]);
    expect(qualified).toEqual(["browser:desktop", "browser:default-project"]);
    expect(order).toEqual(["prepare", "browser:desktop", "bridge", "browser:default-project"]);
  });

  it("stops on the original failure or cancellation without admitting another native group", async () => {
    const failure = new Error("Original preparation failure.");
    await expect(
      runLocalBrowserTestPlan(
        import.meta.dirname,
        steps,
        selection,
        new AbortController().signal,
        undefined,
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    const controller = new AbortController();
    let calls = 0;
    await expect(
      runLocalBrowserTestPlan(
        import.meta.dirname,
        steps,
        selection,
        controller.signal,
        undefined,
        async () => {
          calls += 1;
          controller.abort();
        },
      ),
    ).rejects.toThrow("cancelled");
    expect(calls).toBe(1);
  });
});
