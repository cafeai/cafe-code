// Native fixture retains exact loopback socket/response lifetime and bounded streaming controls.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer } from "node:http";
import { Readable } from "node:stream";
// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// Native fixture paths retain host drive, separator and namespace semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { expect, it } from "vitest";
import { ServerConfig, type ServerConfigShape } from "../src/config.ts";
import { glideOwnerOperationSchema } from "../src/glide/sessionRuntime.ts";
import { runPrivateGlideRequest } from "../src/glide/privateDaemon.ts";
import { handleGlideMcpRequest } from "../src/glide/http.ts";
import { GlideNativeHost } from "../src/glide/nativeHost.ts";
import { actionReceiptSchema } from "../src/glide/protocol.ts";
import {
  installGlideSessionRuntime,
  makeGlideSessionRuntime,
  type GlideSessionBinding,
} from "../src/glide/sessionRuntime.ts";

/** Actual copied stdio bridge -> native HTTP interpreter -> owner broker ->
 * real ESM worker -> shared native host. Only the OS peer is synthetic. No
 * provider, credentials, user app or permissions are used by this journey. */
it.each(["local", "daemon", "supervisor", "desktop"] as const)(
  "connects independent bridges through the complete managed Glide pipeline (%s)",
  async (placement) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "glide-pipeline-")));
    const scope = await Effect.runPromise(Scope.make());
    const frontendConfig = {} as ServerConfigShape;
    const handler = await Effect.runPromise(
      NodeHttpServer.makeHandler(
        handleGlideMcpRequest.pipe(Effect.provideService(ServerConfig, frontendConfig)),
        { scope },
      ),
    );
    const server = createServer(handler);
    const clients: Client[] = [];
    let value = "initial";
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<unknown>();
    void held.promise.catch(() => undefined);
    const effects: { method: unknown; sessionId: unknown }[] = [];
    const host = new GlideNativeHost(
      () => ({
        request: async (frame) => {
          if (frame.method === "list_apps")
            return [{ name: "Fixture", bundleId: "fixture.editor", path: "/Fixture.app", pid: 10 }];
          if (frame.method === "get_app_state")
            return {
              app: "/Fixture.app",
              text: value,
              screenshot: null,
              revision: 1,
              pid: 10,
              windowId: 7,
              accessibilityAvailable: true,
              bounds: { x: 0, y: 0, width: 100, height: 100 },
              screenshotWidth: 100,
              screenshotHeight: 100,
              capturedAt: "2026-10-17T00:00:00.000Z",
            };
          if (frame.method === "type_text") {
            if ((frame.input as { text: string }).text === "held") {
              entered.resolve();
              return held.promise;
            }
            value += (frame.input as { text: string }).text;
            effects.push({ method: frame.method, sessionId: frame.sessionId });
            return {
              actionId: `${String(frame.sessionId)}:${effects.length}`,
              method: "type_text",
              status: "unverified",
              dispatch: "dispatched",
              osAcceptance: "unacknowledged",
              stage: "text-input",
              progress: {
                axAttempted: 0,
                axAccepted: 0,
                eventsPosted: [...(frame.input as { text: string }).text].length * 2,
                textScalarsPosted: [...(frame.input as { text: string }).text].length,
              },
              verification: { kind: "none", matched: null },
            };
          }
          return null;
        },
        close: async () => {
          held.reject(new Error("Exact native peer retired."));
        },
      }),
      async () => [{ name: "Fixture", bundleId: "fixture.editor", path: "/Fixture.app", pid: 10 }],
    );
    await new Promise<void>((yes) => server.listen(0, "127.0.0.1", yes));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address.");
    const policies = new Map<
      string,
      { enabled: boolean; apps: readonly string[]; fullAccess: boolean; desktop?: boolean }
    >();
    const runtime = makeGlideSessionRuntime({
      helperPath: "/synthetic/native-peer",
      nativeHost: host,
      mcpPort: address.port,
      bridgeSource: fileURLToPath(new URL("../dist/glide-mcp-bridge.mjs", import.meta.url)),
      readPolicy: async (threadId) =>
        policies.get(threadId) ?? { enabled: false, apps: [], fullAccess: true },
      initializePolicy: async (threadId) => {
        if (!policies.has(threadId))
          policies.set(threadId, { enabled: true, desktop: true, apps: [], fullAccess: true });
      },
      writePolicy: async (threadId, policy) => {
        policies.set(threadId, { ...policy, fullAccess: true });
      },
      status: async () => ({ accessibility: true, screenRecording: true, apps: [] }),
    });
    const uninstall = installGlideSessionRuntime(runtime);
    const ownerToken = "cd".repeat(32);
    const privateTasks = new Set<Promise<void>>();
    const ownerServer = createServer((incoming, outgoing) => {
      if (
        incoming.headers.authorization !== `Bearer ${ownerToken}` ||
        incoming.url !== "/glide/session/operation"
      ) {
        outgoing.writeHead(401);
        outgoing.end();
        return;
      }
      const task = runPrivateGlideRequest(incoming, outgoing, (body, signal) =>
        runtime.operation(glideOwnerOperationSchema.parse(body), signal),
      );
      privateTasks.add(task);
      void task.finally(() => privateTasks.delete(task));
    });
    await new Promise<void>((yes) => ownerServer.listen(0, "127.0.0.1", yes));
    const ownerAddress = ownerServer.address();
    if (!ownerAddress || typeof ownerAddress === "string")
      throw new Error("Missing owner fixture address.");
    if (placement === "daemon" || placement === "supervisor")
      Object.assign(frontendConfig, {
        [placement === "daemon" ? "providerDaemon" : "providerSupervisor"]: {
          httpBaseUrl: `http://127.0.0.1:${ownerAddress.port}`,
          token: ownerToken,
        },
      });
    const attach = async (thread: string) => {
      const binding = (await runtime.bind({
        threadId: ThreadId.make(thread),
        providerInstanceId: ProviderInstanceId.make("codex_fixture"),
        provider: "codex",
        runtimeMode: "full-access",
      }))!;
      const transport = new StdioClientTransport({
        command: binding.launch.command,
        args: [...binding.launch.args],
        env: { ...binding.launch.env },
        stderr: "pipe",
      });
      const client = new Client({ name: "glide-pipeline-fixture", version: "1" });
      clients.push(client);
      await client.connect(transport);
      if (transport.stderr instanceof Readable) transport.stderr.resume();
      return { binding, client };
    };
    const run = (client: Client, code: string) =>
      client.callTool({ name: "js", arguments: { code } });
    try {
      const a = await attach("chat-a"),
        b = await attach("chat-b");
      expect((await a.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "js",
        "js_reset",
      ]);
      expect((await run(a.client, "nodeRepl.write('should refuse')")).isError).toBe(true);
      await a.binding.activate();
      await b.binding.activate();
      expect((await run(a.client, "nodeRepl.write('still disabled')")).isError).toBe(true);
      for (const thread of ["chat-a", "chat-b"])
        await runtime.operation(
          placement === "desktop"
            ? { kind: "initialize-thread", threadId: thread }
            : {
                kind: "control",
                input: {
                  action: "configure",
                  threadId: thread,
                  enabled: true,
                  apps: ["fixture.editor"],
                },
              },
        );
      const first = await run(
        a.client,
        'import {glide as driver} from "@cafecode/glide"; var counter=1; var editor=await driver.getApp("Fixture",{windowId:7}); await editor.typeText(" managed"); nodeRepl.write(await editor.getAXState({emit:false}));',
      );
      expect(first.isError).not.toBe(true);
      expect(JSON.stringify(first.content)).toContain("initial managed");
      expect(effects).toEqual([
        { method: "type_text", sessionId: expect.stringMatching(/^[a-f0-9-]{36}$/) },
      ]);
      expect(
        JSON.stringify((await run(b.client, "nodeRepl.write(typeof counter)")).content),
      ).toContain("undefined");
      await b.client.callTool({ name: "js_reset", arguments: {} });
      expect(
        JSON.stringify((await run(a.client, "counter++; nodeRepl.write(counter)")).content),
      ).toContain("2");
      const pending = run(a.client, 'await editor.typeText("held");');
      await entered.promise;
      await a.binding.cancel();
      const cancelled = await pending;
      expect(cancelled.isError).toBe(true);
      const outputs = JSON.parse(JSON.stringify(cancelled.content)) as {
        type: string;
        text?: string;
      }[];
      const receipts = outputs.flatMap((item) =>
        item.type === "text" && item.text?.startsWith("Glide action ")
          ? [actionReceiptSchema.parse(JSON.parse(item.text.slice("Glide action ".length)))]
          : [],
      );
      expect(receipts).toMatchObject([
        {
          method: "type_text",
          status: "uncertain",
          dispatch: "unknown",
          progress: { eventsPosted: null },
        },
      ]);
      expect((await run(a.client, "nodeRepl.write('stopped')")).isError).toBe(true);
      a.binding.resume();
      expect(
        JSON.stringify((await run(a.client, "nodeRepl.write(typeof counter)")).content),
      ).toContain("undefined");
      await runtime.operation({
        kind: "control",
        input: { action: "configure", threadId: "chat-a", enabled: false, apps: [] },
      });
      expect((await run(a.client, "nodeRepl.write('revoked')")).isError).toBe(true);
      expect(effects).toHaveLength(1);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      uninstall();
      await runtime.close();
      ownerServer.closeAllConnections();
      await new Promise<void>((yes) => ownerServer.close(() => yes()));
      await Promise.all(privateTasks);
      server.closeAllConnections();
      await new Promise<void>((yes) => server.close(() => yes()));
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await rm(root, { recursive: true, force: true });
    }
  },
);
