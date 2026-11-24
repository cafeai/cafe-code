// Native transport fixture keeps exact child/socket lifetimes and public test retirement.
// @effect-diagnostics nodeBuiltinImport:off
import { createServer } from "node:http";
import { watch } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ProviderInstanceId, ThreadId, TurnId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { expect, it, vi } from "vitest";
import { ServerConfig, type ServerConfigShape } from "../src/config.ts";
import {
  glideOwnerOperationSchema,
  installGlideSessionRuntime,
  makeGlideSessionRuntime,
} from "../src/glide/sessionRuntime.ts";
import { runPrivateGlideRequest } from "../src/glide/privateDaemon.ts";
import { handleGlideMcpRequest } from "../src/glide/http.ts";
import { GlideRuntime, makeGlideExecutionLane } from "../src/glide/openAiRuntime.ts";
import { OpenAiMcpChild } from "../src/glide/mcpChild.ts";
import type { OpenAiComputerInstallation } from "../src/glide/openAiInstallation.ts";
import { glideChildEnvironment } from "../src/glide/child.ts";

vi.mock("../src/glide/openAiInstallation.ts", () => ({
  validateOpenAiComputerInstallation: vi.fn(async () => undefined),
}));
const installation: OpenAiComputerInstallation = {
  applicationPath: "/fixture/OpenAI.app",
  runtimeRoot: "/fixture/runtime",
  nodePath: process.execPath,
  replPath: "/fixture/repl",
  codexPath: "/fixture/codex",
  servicePath: "/fixture/Computer.app",
  moduleDirectory: "/fixture/modules",
};
const peerSource = fileURLToPath(new URL("./fixtures/openai-repl.fixture.mjs", import.meta.url));

/** Real copied bridge -> real HTTP/owner broker -> real OpenAI adapter -> inert
 * native MCP peer. No OpenAI installation, credentials, provider or OS input. */
it.for(
  (["local", "daemon", "supervisor", "desktop"] as const).flatMap((placement) =>
    ["glide-mcp-bridge.mjs", "glide-mcp.mjs"].map((entry) => ({ placement, entry })),
  ),
)(
  "$entry gates the OpenAI runtime across the complete $placement pipeline",
  async ({ placement, entry }, context) => {
    let retired = false,
      root: string | undefined,
      scope: Scope.Closeable | undefined;
    let server: ReturnType<typeof createServer> | undefined,
      ownerServer: ReturnType<typeof createServer> | undefined;
    let runtime: ReturnType<typeof makeGlideSessionRuntime> | undefined,
      uninstall: (() => void) | undefined;
    let watcher: ReturnType<typeof watch> | undefined;
    const clients: { client: Client; transport: OpenAiMcpChild }[] = [];
    const privateTasks = new Set<Promise<void>>();
    let cleanupPromise: Promise<void> | undefined;
    const closeServer = async (value: typeof server) => {
      if (!value) return;
      value.closeAllConnections();
      await new Promise<void>((resolve) => value.close(() => resolve()));
    };
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        retired = true;
        watcher?.close();
        uninstall?.();
        await runtime?.close();
        await Promise.all(
          clients.map(async ({ client, transport }) => {
            await transport.close();
            await client.close();
          }),
        );
        await closeServer(ownerServer);
        await Promise.allSettled(privateTasks);
        await closeServer(server);
        if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
        if (root) await rm(root, { recursive: true, force: true });
      })());
    context.signal.addEventListener(
      "abort",
      () => {
        void cleanup();
      },
      { once: true },
    );
    context.onTestFinished(cleanup);
    root = await realpath(await mkdtemp(join(tmpdir(), "openai-computer-pipeline-")));
    if (retired) {
      await rm(root, { recursive: true, force: true });
      throw new Error("Fixture retired.");
    }
    scope = await Effect.runPromise(Scope.make());
    const config = {} as ServerConfigShape;
    const handler = await Effect.runPromise(
      NodeHttpServer.makeHandler(
        handleGlideMcpRequest.pipe(Effect.provideService(ServerConfig, config)),
        { scope },
      ),
    );
    if (retired) throw new Error("Fixture retired before native HTTP admission.");
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address.");
    const receipt = join(root, "entered"),
      entered = Promise.withResolvers<void>();
    watcher = watch(root, (_event, name) => {
      if (name === "entered")
        void readFile(receipt, "utf8").then(
          (text) => {
            if (text === "native request admitted") entered.resolve();
          },
          () => undefined,
        );
    });
    const policies = new Map<
      string,
      { enabled: boolean; apps: readonly string[]; fullAccess: boolean; desktop?: boolean }
    >();
    const spawned: OpenAiMcpChild[] = [],
      lane = makeGlideExecutionLane();
    runtime = makeGlideSessionRuntime({
      helperPath: "/fixture/status-only",
      mcpPort: address.port,
      bridgeSource: fileURLToPath(new URL(`../dist/${entry}`, import.meta.url)),
      trayFactory: () => ({ publish: async () => undefined, close: async () => undefined }),
      readPolicy: async (id) => policies.get(id) ?? { enabled: false, apps: [], fullAccess: true },
      writePolicy: async (id, policy) => {
        policies.set(id, { ...policy, fullAccess: true });
      },
      initializePolicy: async (id) => {
        if (!policies.has(id))
          policies.set(id, { enabled: true, apps: [], desktop: true, fullAccess: true });
      },
      status: async () => ({
        permissionsManagedBy: "openai",
        accessibility: false,
        screenRecording: false,
        apps: [],
      }),
      runtimeFactory: (authority) =>
        new GlideRuntime({
          installation,
          authority,
          withLane: lane,
          childFactory: (env, directory) => {
            if (retired) throw new Error("Fixture retired before native MCP admission.");
            const child = new OpenAiMcpChild({
              command: process.execPath,
              args: [peerSource],
              env: { ...env, FIXTURE_RECEIPT: receipt },
              cwd: directory,
            });
            spawned.push(child);
            return child;
          },
        }),
    });
    uninstall = installGlideSessionRuntime(runtime);
    const token = "cd".repeat(32);
    ownerServer = createServer((incoming, outgoing) => {
      if (
        incoming.headers.authorization !== `Bearer ${token}` ||
        incoming.url !== "/glide/session/operation"
      ) {
        outgoing.writeHead(401);
        outgoing.end();
        return;
      }
      const task = runPrivateGlideRequest(incoming, outgoing, (body, signal) =>
        runtime!.operation(glideOwnerOperationSchema.parse(body), signal),
      );
      privateTasks.add(task);
      void task.finally(() => privateTasks.delete(task));
    });
    await new Promise<void>((resolve) => ownerServer!.listen(0, "127.0.0.1", resolve));
    const ownerAddress = ownerServer.address();
    if (!ownerAddress || typeof ownerAddress === "string")
      throw new Error("Missing owner address.");
    if (placement === "daemon" || placement === "supervisor")
      Object.assign(config, {
        [placement === "daemon" ? "providerDaemon" : "providerSupervisor"]: {
          httpBaseUrl: `http://127.0.0.1:${ownerAddress.port}`,
          token,
        },
      });
    const attach = async (id: string) => {
      const binding = (await runtime!.bind({
        threadId: ThreadId.make(id),
        providerInstanceId: ProviderInstanceId.make("codex_fixture"),
        provider: "codex",
        runtimeMode: "full-access",
      }))!;
      const transport = new OpenAiMcpChild({
        command: binding.launch.command,
        args: binding.launch.args,
        env: { ...glideChildEnvironment(process.env), ...binding.launch.env },
        cwd: root!,
      });
      const client = new Client({ name: "computer-pipeline-fixture", version: "1" });
      clients.push({ client, transport });
      await client.connect(transport);
      return { client, binding };
    };
    const run = (client: Client, code: string) =>
      client.callTool({ name: "js", arguments: { code } });
    try {
      const a = await attach("chat-a"),
        b = await attach("chat-b");
      expect((await a.client.listTools()).tools.map((t) => t.name)).toEqual(["js", "js_reset"]);
      expect((await run(a.client, "before activation")).isError).toBe(true);
      for (const [id, pair] of [
        ["chat-a", a],
        ["chat-b", b],
      ] as const) {
        await pair.binding.activate();
        pair.binding.observeTurn?.({
          type: "turn.started",
          threadId: ThreadId.make(id),
          turnId: TurnId.make(`${id}-turn`),
        });
        expect((await run(pair.client, "before permission")).isError).toBe(true);
        await runtime.operation(
          placement === "desktop"
            ? { kind: "initialize-thread", threadId: id }
            : {
                kind: "control",
                input: {
                  action: "configure",
                  threadId: id,
                  enabled: true,
                  apps: ["fixture.editor"],
                },
              },
        );
      }
      expect(spawned).toHaveLength(0);
      const first = await run(a.client, "literal first cell");
      expect(first.isError).not.toBe(true);
      expect(JSON.stringify(first.content)).toContain("literal first cell");
      expect((await run(b.client, "approval")).content).toEqual([
        { type: "text", text: '{"action":"accept"}' },
      ]);
      expect((await run(a.client, "foreign-app")).content).toEqual([
        {
          type: "text",
          text: JSON.stringify({ action: placement === "desktop" ? "accept" : "decline" }),
        },
      ]);
      expect(spawned).toHaveLength(2);
      await b.client.callTool({ name: "js_reset", arguments: {} });
      expect((await run(a.client, "other reset does not replace me")).isError).not.toBe(true);
      expect(spawned).toHaveLength(2);
      const pending = run(a.client, "hold");
      await entered.promise;
      await a.binding.cancel();
      expect((await pending).isError).toBe(true);
      expect((await run(a.client, "paused")).isError).toBe(true);
      a.binding.resume();
      a.binding.observeTurn?.({
        type: "turn.started",
        threadId: ThreadId.make("chat-a"),
        turnId: TurnId.make("chat-a-next"),
      });
      expect((await run(a.client, "fresh generation")).isError).not.toBe(true);
      const beforeRevocation = spawned.length;
      await runtime.operation({
        kind: "control",
        input: { action: "configure", threadId: "chat-a", enabled: false, apps: [] },
      });
      expect((await run(a.client, "revoked")).isError).toBe(true);
      expect(spawned).toHaveLength(beforeRevocation);
      expect((await run(b.client, "other chat remains enabled")).isError).not.toBe(true);
    } finally {
      await cleanup();
    }
  },
);
