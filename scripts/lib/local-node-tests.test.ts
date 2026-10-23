// These tests own only disposable manifest inputs, never real application data.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import { discoverLocalNodeTestPrograms, runLocalNodeTestPrograms } from "./local-node-tests.ts";
import type { TestPlanExecution } from "./run-test-plan.ts";
import type { TestStep } from "./test-run-plan.ts";
import {
  LocalVerificationCacheError,
  type LocalVerificationCache,
} from "./local-verification-cache.ts";
import { localVerificationGitEnvironment } from "./local-verification-environment.ts";

const encode = Schema.encodeSync(Schema.UnknownFromJsonString);

const gate = () => {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

describe("local cached Node workspace ownership", () => {
  it.skipIf(process.platform === "win32")(
    "fingerprints and executes the exact frozen prepared Git environment without changing the parent",
    async (context) => {
      // Only this isolated test worker's environment is prepared. No real Git
      // process/profile is entered by this controller wiring assertion.
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
      vi.stubEnv("GIT_PAGER", "cat");
      vi.stubEnv("CODEX_TOOL_CALL_ID", "synthetic-inherited-call");
      vi.stubEnv("CAFE_CODE_CACHE_ENV_SENTINEL", "retain-literal");
      let fingerprintEnvironment: Readonly<Record<string, string | undefined>> | undefined;
      const cache: LocalVerificationCache = {
        async run(task, _signal, execute) {
          fingerprintEnvironment = task.environment;
          expect(Object.isFrozen(task.environment)).toBe(true);
          expect(Object.hasOwn(task.environment, "CODEX_TOOL_CALL_ID")).toBe(false);
          expect(task.environment.CAFE_CODE_CACHE_ENV_SENTINEL === "retain-literal").toBe(true);
          for (const [name, value] of Object.entries(
            localVerificationGitEnvironment(import.meta.dirname),
          ))
            expect(task.environment[name] === value).toBe(true);
          await execute();
          return { status: "fresh", message: "Synthetic exact environment qualified." };
        },
      };
      let executed = 0;
      await runLocalNodeTestPrograms(
        import.meta.dirname,
        [{ name: "fixture-server", location: "apps/server" }],
        1,
        context.signal,
        cache,
        async (_steps, execution) => {
          executed += 1;
          // Comparing a boolean avoids printing captured environment values if
          // the ownership assertion fails.
          expect(execution?.environment === fingerprintEnvironment).toBe(true);
        },
      );
      expect(executed).toBe(1);
      expect(process.env.GIT_CONFIG_GLOBAL === undefined).toBe(true);
      expect(process.env.GIT_TEMPLATE_DIR === undefined).toBe(true);
      expect(process.env.GIT_PAGER === "cat").toBe(true);
      expect(process.env.CODEX_TOOL_CALL_ID === "synthetic-inherited-call").toBe(true);
      expect(process.env.CAFE_CODE_CACHE_ENV_SENTINEL === "retain-literal").toBe(true);
    },
  );
  it("keeps fresh server and ineligible workspace execution environments literal", async (context) => {
    context.onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    vi.stubEnv("CODEX_TOOL_CALL_ID", "synthetic-inherited-call");
    vi.stubEnv("CAFE_CODE_CACHE_ENV_SENTINEL", "retain-literal");
    for (const scenario of [
      { reuse: false, workspace: "apps/server" },
      { reuse: true, workspace: "scripts" },
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
      await runLocalNodeTestPrograms(
        import.meta.dirname,
        [{ name: "fixture", location: scenario.workspace }],
        1,
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
          if (scenario.reuse) expect(execution?.environment === fingerprintEnvironment).toBe(true);
        },
      );
      expect(cacheCalls).toBe(scenario.reuse ? 1 : 0);
      expect(executions).toBe(1);
    }
    expect(process.env.CODEX_TOOL_CALL_ID === "synthetic-inherited-call").toBe(true);
  });
  it("continues remaining owners when the failure diagnostic sink throws", async (context) => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("Opaque synthetic diagnostic sink failure.");
    });
    context.onTestFinished(() => write.mockRestore());
    const executed: string[] = [];
    await expect(
      runLocalNodeTestPrograms(
        import.meta.dirname,
        [
          { name: "first", location: "first" },
          { name: "second", location: "second" },
        ],
        1,
        context.signal,
        undefined,
        async (steps) => {
          executed.push(steps[0]!.name);
          if (executed.length === 1) throw undefined;
        },
      ),
    ).rejects.toThrow("1/2");
    expect(executed).toEqual(["Node tests first", "Node tests second"]);
    expect(write).toHaveBeenCalledOnce();
  });
  it("distinguishes exact execution fulfillment from cache admission and never inspects opaque failures", async (context) => {
    const output: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      output.push(String(value));
      return true;
    });
    context.onTestFinished(() => write.mockRestore());
    const opaque = new Proxy(
      {},
      {
        get() {
          throw new Error("PRIVATE_ERROR");
        },
        getPrototypeOf() {
          throw new Error("PRIVATE_PROTOTYPE");
        },
      },
    );
    for (const phase of ["admission", "execution", "post-execution"] as const) {
      let executed = 0;
      const cache: LocalVerificationCache = {
        async run(_task, _signal, execute) {
          if (phase === "admission") throw new LocalVerificationCacheError("invalid-fingerprint");
          await execute();
          throw new LocalVerificationCacheError("inputs-changed");
        },
      };
      await expect(
        runLocalNodeTestPrograms(
          import.meta.dirname,
          [{ name: "fixture", location: "fixture" }],
          1,
          context.signal,
          cache,
          async () => {
            executed += 1;
            if (phase === "execution") throw opaque;
          },
        ),
      ).rejects.toThrow("0/1");
      expect(executed).toBe(phase === "admission" ? 0 : 1);
    }
    expect(output).toEqual([
      "Node tests fixture: admission failed; cache=invalid-fingerprint.\n",
      "Node tests fixture: execution failed; reason=unclassified.\n",
      "Node tests fixture: post-execution failed; cache=inputs-changed.\n",
    ]);
  });
  it("refuses Turbo traversal syntax before admitting any native task", async () => {
    let executed = 0;
    for (const name of ["first...", "...first", "first...second"]) {
      await expect(
        runLocalNodeTestPrograms(
          import.meta.dirname,
          [{ name, location: "first" }],
          1,
          new AbortController().signal,
          undefined,
          async () => {
            executed += 1;
          },
        ),
      ).rejects.toThrow("Unsupported local Node test selector");
    }
    expect(executed).toBe(0);
  });
  it("discovers actual script owners and refuses changed root/dependent/cached/sidecar graphs", async (context) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cafe-node-discovery-")));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "packages/fixture"), { recursive: true });
    await mkdir(join(root, "packages/inert"), { recursive: true });
    const put = (path: string, value: unknown) => writeFile(join(root, path), encode(value));
    await put("package.json", { name: "fixture-root", scripts: { test: "turbo run test" } });
    await put("packages/fixture/package.json", {
      name: "fixture",
      scripts: { test: "vitest run --config ../../vitest.config.ts" },
    });
    await put("packages/inert/package.json", { name: "inert" });
    const metadata = async () =>
      [
        { name: "fixture-root", location: "." },
        { name: "fixture", location: "packages/fixture" },
        { name: "inert", location: "packages/inert" },
      ]
        .map((row) => encode(row))
        .join("\n");
    await put("turbo.json", { tasks: { test: { cache: false } } });
    expect(await discoverLocalNodeTestPrograms(root, context.signal, metadata)).toEqual([
      { name: "fixture", location: "packages/fixture" },
    ]);
    for (const test of [
      { cache: true },
      { cache: false, dependsOn: ["^test"] },
      { cache: false, with: ["fixture#dev"] },
    ]) {
      await put("turbo.json", { tasks: { test } });
      await expect(discoverLocalNodeTestPrograms(root, context.signal, metadata)).rejects.toThrow(
        "Unsupported ordered",
      );
    }
    await put("turbo.json", { tasks: { test: { cache: false } } });
    await put("package.json", { name: "fixture-root", scripts: { test: "something-else" } });
    await expect(discoverLocalNodeTestPrograms(root, context.signal, metadata)).rejects.toThrow(
      "root test entry",
    );
    await put("package.json", { name: "fixture-root", scripts: { test: "turbo run test" } });
    await put("packages/fixture/turbo.json", { extends: ["//"] });
    await expect(discoverLocalNodeTestPrograms(root, context.signal, metadata)).rejects.toThrow(
      "Workspace-specific",
    );
  });
  it("bounds independent owners and never admits another before an original close", async () => {
    const first = gate();
    const second = gate();
    const both = gate();
    const third = gate();
    const observed: TestStep[][] = [];
    let active = 0;
    let maximum = 0;
    const execute = async (steps: readonly TestStep[], options?: TestPlanExecution) => {
      expect(options?.cwd).toBe(import.meta.dirname);
      expect(options?.environment).toBeDefined();
      observed.push([...steps]);
      active += 1;
      maximum = Math.max(maximum, active);
      if (observed.length === 2) both.release();
      try {
        if (steps[0]!.args.includes("--filter=first")) await first.promise;
        else if (steps[0]!.args.includes("--filter=second")) await second.promise;
        else {
          third.release();
        }
      } finally {
        active -= 1;
      }
    };
    const controller = new AbortController();
    const pending = runLocalNodeTestPrograms(
      import.meta.dirname,
      [
        { name: "first", location: "first" },
        { name: "second", location: "second" },
        { name: "third", location: "third" },
      ],
      2,
      controller.signal,
      undefined,
      execute,
    );
    try {
      await both.promise;
      expect(observed).toHaveLength(2);
      first.release();
      await third.promise;
      expect(observed).toHaveLength(3);
      expect(maximum).toBe(2);
      for (const [step] of observed) {
        expect(step!.args).toContain("--concurrency=1");
        expect(step!.args).toContain("--maxWorkers=2");
        expect(step!.args).toContain("--force");
        expect(step!.args.filter((arg) => arg.startsWith("--filter="))).toHaveLength(1);
      }
    } finally {
      first.release();
      second.release();
      await pending;
    }
  });

  it("does not execute a reused workspace and retains every required task", async () => {
    const taskIds: string[] = [];
    const executed: string[] = [];
    const cache: LocalVerificationCache = {
      async run(task, _signal, execute) {
        taskIds.push(task.id);
        if (task.id.endsWith(":second"))
          return { status: "reused", message: "REUSED synthetic exact input." };
        await execute();
        return { status: "fresh", message: "FRESH synthetic close." };
      },
    };
    await runLocalNodeTestPrograms(
      import.meta.dirname,
      [
        { name: "first", location: "first" },
        { name: "second", location: "second" },
      ],
      2,
      new AbortController().signal,
      cache,
      async (steps) => {
        executed.push(steps[0]!.name);
      },
    );
    expect(taskIds).toEqual(["node:first", "node:second"]);
    expect(executed).toEqual(["Node tests first"]);
  });

  it("collects remaining diagnostic failures but cancellation fences queued owners", async () => {
    const executed: string[] = [];
    await expect(
      runLocalNodeTestPrograms(
        import.meta.dirname,
        [
          { name: "first", location: "first" },
          { name: "second", location: "second" },
        ],
        1,
        new AbortController().signal,
        undefined,
        async (steps) => {
          executed.push(steps[0]!.name);
          if (executed.length === 1) throw new Error("Original fixture failure.");
        },
      ),
    ).rejects.toThrow("1/2");
    expect(executed).toEqual(["Node tests first", "Node tests second"]);
    const controller = new AbortController();
    const cancelled: string[] = [];
    await expect(
      runLocalNodeTestPrograms(
        import.meta.dirname,
        [
          { name: "first", location: "first" },
          { name: "second", location: "second" },
        ],
        1,
        controller.signal,
        undefined,
        async (steps) => {
          cancelled.push(steps[0]!.name);
          controller.abort();
        },
      ),
    ).rejects.toThrow("incomplete");
    expect(cancelled).toEqual(["Node tests first"]);
  });
});
