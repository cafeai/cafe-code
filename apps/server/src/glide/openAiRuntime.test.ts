// Native fixture boundary retains exact process, private directory and watcher lifetime.
// @effect-diagnostics nodeBuiltinImport:off
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, type TestContext } from "vitest";
import { OpenAiMcpChild } from "./mcpChild.ts";
import type { OpenAiComputerInstallation } from "./openAiInstallation.ts";
import { boundedOpenAiResult, GlideRuntime, makeGlideExecutionLane } from "./openAiRuntime.ts";

vi.mock("./openAiInstallation.ts", () => ({
  validateOpenAiComputerInstallation: vi.fn(async () => undefined),
}));
const installation: OpenAiComputerInstallation = {
  applicationPath: "/fixture/OpenAI.app",
  runtimeRoot: "/fixture/runtime",
  nodePath: process.execPath,
  replPath: "/fixture/node_repl",
  codexPath: "/fixture/codex",
  servicePath: "/fixture/Computer.app",
  moduleDirectory: "/fixture/modules",
};
const source = fileURLToPath(
  new URL("../../integration/fixtures/openai-repl.fixture.mjs", import.meta.url),
);
async function fixture(
  context: TestContext,
  options: {
    stubborn?: boolean;
    turnError?: boolean;
    authorize?: () => Promise<{ apps: string[]; current(): boolean }>;
  } = {},
) {
  let directory: string | undefined,
    retired = false;
  const runtimes: GlideRuntime[] = [];
  const watchers: ReturnType<typeof watch>[] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  const homes: string[] = [];
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      retired = true;
      for (const watcher of watchers) watcher.close();
      await Promise.all(runtimes.map((runtime) => runtime.close()));
      if (directory) await rm(directory, { recursive: true, force: true });
    })());
  context.signal.addEventListener(
    "abort",
    () => {
      void cleanup();
    },
    { once: true },
  );
  context.onTestFinished(cleanup);
  directory = await realpath(await mkdtemp(join(tmpdir(), "openai-runtime-fixture-")));
  if (retired) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("Fixture retired during setup.");
  }
  const receipt = join(directory, "entered"),
    turnReceipt = join(directory, "ended");
  const received = Promise.withResolvers<void>();
  const watcher = watch(directory, (_event, name) => {
    if (name === "entered")
      void readFile(receipt, "utf8").then(
        (text) => {
          if (text === "native request admitted") received.resolve();
        },
        () => undefined,
      );
  });
  watchers.push(watcher);
  const create = (withLane?: ReturnType<typeof makeGlideExecutionLane>) => {
    const runtime = new GlideRuntime({
      installation,
      authority: {
        authorize:
          options.authorize ??
          (async () => ({ apps: ["fixture.editor"], current: () => !retired })),
      },
      ...(withLane ? { withLane } : {}),
      childFactory: (environment, root) => {
        if (retired) throw new Error("Fixture retired before native admission.");
        environments.push(environment);
        homes.push(root);
        return new OpenAiMcpChild({
          command: process.execPath,
          args: [source],
          cwd: root,
          env: {
            ...environment,
            FIXTURE_RECEIPT: receipt,
            FIXTURE_TURN_RECEIPT: turnReceipt,
            ...(options.turnError ? { FIXTURE_TURN_ERROR: "1" } : {}),
            ...(options.stubborn ? { FIXTURE_STUBBORN: "1" } : {}),
          },
        });
      },
    });
    runtimes.push(runtime);
    return runtime;
  };
  return { create, received: received.promise, receipt, turnReceipt, environments, homes };
}
const text = (result: { content: unknown[] }) =>
  result.content.map((item) => (item as { text?: string }).text ?? "").join("");
describe("OpenAI computer-use runtime adapter", () => {
  it("forwards the original cell, mints native context and uses a private credential-free home", async (context) => {
    const f = await fixture(context),
      runtime = f.create();
    const code = "const sample = `keep $() and newlines\\n literal`;";
    const result = JSON.parse(text(await runtime.execute({ code })));
    expect(result.code).toBe(code);
    expect(result.metadata["x-codex-turn-metadata"]).toMatchObject({
      thread_id: expect.any(String),
      turn_id: expect.any(String),
      call_id: expect.any(String),
    });
    expect(f.environments[0]!.NODE_OPTIONS).toBe(
      "--max-old-space-size=256 --max-semi-space-size=8",
    );
    expect(f.environments[0]!.NODE_REPL_DISABLE_ANALYTICS).toBe("1");
    expect(JSON.parse(f.environments[0]!.NODE_REPL_WORKER_WRAPPER!)).toEqual([
      installation.nodePath,
      "--max-old-space-size=256",
      "--max-semi-space-size=8",
      "--input-type=module",
      "--eval",
      expect.any(String),
      installation.codexPath,
      result.home,
    ]);
    expect(f.environments[0]!.OPENAI_API_KEY).toBeUndefined();
    expect(f.environments[0]!.NODE_REPL_TRUSTED_SERVICES).toBe('{"sky":"@oai/sky/service"}');
    expect(await readFile(join(result.home, "config.toml"), "utf8")).toBe(
      "[features]\nplugins = false\n",
    );
    await runtime.close();
    await expect(stat(result.home)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("approves only the exact granted native app without adding persistence", async (context) => {
    const f = await fixture(context),
      runtime = f.create();
    expect(JSON.parse(text(await runtime.execute({ code: "approval" })))).toEqual({
      action: "accept",
    });
    expect(JSON.parse(text(await runtime.execute({ code: "foreign-app" })))).toEqual({
      action: "decline",
    });
    expect(JSON.parse(text(await runtime.execute({ code: "user-question" })))).toEqual({
      action: "decline",
    });
    expect(JSON.parse(text(await runtime.execute({ code: "stale-call" })))).toEqual({
      action: "decline",
    });
  });
  it("fences a native app approval whose authority is revoked during its policy read", async (context) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let calls = 0,
      current = true;
    context.onTestFinished(() => release.resolve());
    const f = await fixture(context, {
      authorize: async () => {
        if (++calls === 2) {
          entered.resolve();
          await release.promise;
        }
        return { apps: ["fixture.editor"], current: () => current };
      },
    });
    const runtime = f.create(),
      pending = runtime.execute({ code: "approval" });
    await entered.promise;
    current = false;
    release.resolve();
    await expect(pending).rejects.toThrow("interrupted");
  });
  it("retains native partial-error output without inventing action receipts", async (context) => {
    const f = await fixture(context),
      result = await f.create().execute({ code: "partial-error" });
    expect(result).toEqual({
      isError: true,
      content: [{ type: "text", text: "native partial output" }],
    });
  });
  it("cancels admitted native work and joins close before removing its private home", async (context) => {
    const f = await fixture(context),
      runtime = f.create(),
      controller = new AbortController();
    const pending = runtime.execute({ code: "hold" }, controller.signal);
    const refused = expect(pending).rejects.toThrow("stopped");
    await f.received;
    controller.abort();
    await refused;
    await runtime.close();
    await expect(stat(f.homes[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(f.turnReceipt, "utf8"))).toMatchObject({
      hook_event_name: "Stop",
      session_id: expect.any(String),
      turn_id: expect.any(String),
    });
  });
  it("joins an exact stubborn child after EOF and TERM instead of returning on requested policy", async (context) => {
    const f = await fixture(context, { stubborn: true }),
      runtime = f.create();
    await runtime.execute({ code: "ready" });
    await runtime.close();
    expect(await readFile(f.receipt + ".eof", "utf8")).toBe("eof");
    expect(await readFile(f.receipt + ".term", "utf8")).toBe("term");
    await expect(stat(f.homes[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retires a crashed native child and never replays its request", async (context) => {
    const f = await fixture(context),
      runtime = f.create();
    await expect(runtime.execute({ code: "crash" })).rejects.toThrow("interrupted");
    expect(f.environments).toHaveLength(1);
    await runtime.close();
    await expect(stat(f.homes[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("consumes a failed turn hook once and joins the old child before reset admits a fresh owner", async (context) => {
    const f = await fixture(context, { turnError: true }),
      runtime = f.create();
    const result = JSON.parse(text(await runtime.execute({ code: "first" })));
    const turn = result.metadata["x-codex-turn-metadata"].turn_id;
    await expect(runtime.endTurn(turn)).rejects.toThrow("cleanup was not confirmed");
    await expect(runtime.execute({ code: "must not reuse this owner" })).rejects.toThrow(
      "cleanup was not confirmed",
    );
    await runtime.reset();
    expect((await readFile(f.turnReceipt, "utf8")).trim().split("\n")).toHaveLength(1);
    await expect(stat(f.homes[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(text(await runtime.execute({ code: "fresh owner" }))).code).toBe(
      "fresh owner",
    );
    expect(f.homes).toHaveLength(2);
  });
  it("cancels a queued chat without interrupting or waiting for another chat's held native work", async (context) => {
    const f = await fixture(context),
      lane = makeGlideExecutionLane(),
      first = f.create(lane),
      second = f.create(lane);
    const held = first.execute({ code: "hold" });
    const firstRefused = expect(held).rejects.toThrow();
    await f.received;
    const controller = new AbortController();
    const queued = second.execute({ code: "must not run" }, controller.signal);
    const secondRefused = expect(queued).rejects.toThrow();
    controller.abort();
    await secondRefused;
    await second.close();
    expect(f.environments).toHaveLength(1);
    await first.close();
    await firstRefused;
  });
});
describe("OpenAI result admission", () => {
  it("keeps native text errors literal and refuses unsupported resource/link output", () => {
    expect(
      boundedOpenAiResult({ content: [{ type: "text", text: "native error" }], isError: true }),
    ).toEqual({ content: [{ type: "text", text: "native error" }], isError: true });
    expect(() =>
      boundedOpenAiResult({ content: [{ type: "resource_link", uri: "file:///private/unknown" }] }),
    ).toThrow();
  });
  it("checks decoded image geometry and total output before returning screenshots", () => {
    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.write("IHDR", 12);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    expect(
      boundedOpenAiResult({
        content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
      }).content,
    ).toHaveLength(1);
    png.writeUInt32BE(16385, 16);
    expect(() =>
      boundedOpenAiResult({
        content: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
      }),
    ).toThrow("limit");
    expect(() =>
      boundedOpenAiResult({
        content: Array.from({ length: 129 }, () => ({ type: "text", text: "" })),
      }),
    ).toThrow("limit");
  });
});
