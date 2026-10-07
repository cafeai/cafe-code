import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import { NativeControlHost } from "../../../desktop/src/nativeControl/NativeControlHost.ts";
import { makeNativeControlSessionBroker } from "./sessionRuntime.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(platform: NodeJS.Platform = "darwin") {
  const root = await fs.mkdtemp(join(tmpdir(), "cafe-native-broker-"));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const bridgeSource = join(root, "synthetic-bridge.mjs");
  await fs.writeFile(bridgeSource, "// isolated fixture; never executed\n", { mode: 0o600 });
  const request = vi.fn(async (body: Record<string, unknown>) =>
    body.method === "trusted_session_end"
      ? { closed: true }
      : { content: [{ type: "text", text: "isolated native response" }] },
  );
  const host = new NativeControlHost({
    stateDirectory: root,
    runtimeRoot: "unused",
    hostBundleId: "fixture",
    platform: "darwin",
    controller: {
      start: async () => {},
      stop: async () => {},
      session: async () => ({ request, close: () => {} }),
      health: async () => ({ content: [] }),
    },
  });
  await host.listen();
  await host.setEnabled(true);
  cleanups.push(() => host.close());
  const broker = makeNativeControlSessionBroker({ stateDirectory: root, bridgeSource, platform });
  cleanups.push(() => broker.close());
  return { root, bridgeSource, host, broker, request };
}
it.each(["codex", "claudeAgent"] as const)(
  "binds private %s transport and revokes access before removing its files",
  async (provider) => {
    const f = await fixture();
    const binding = await f.broker.bind({
      threadId: ThreadId.make("synthetic-thread"),
      providerInstanceId: ProviderInstanceId.make("synthetic-account"),
      provider,
    });
    expect(binding).toBeDefined();
    const [bridgePath, path] = binding!.launch.args;
    const connection = JSON.parse(await fs.readFile(path!, "utf8")) as {
      token: string;
      url: string;
      audience: string;
    };
    expect(connection.audience).toBe("cafe-native-control");
    expect(new URL(connection.url).pathname).toBe("/mcp/native-control");
    expect(binding!.launch.args.join(" ")).not.toContain(connection.token);
    expect(await fs.readFile(bridgePath!, "utf8")).toBe("// isolated fixture; never executed\n");
    if (process.platform !== "win32") expect((await fs.stat(path!)).mode & 0o077).toBe(0);
    const call = async () => {
      const r = await fetch(connection.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "click", arguments: { x: 10, y: 20 } },
        }),
      });
      const text = await r.text();
      return {
        status: r.status,
        value: (text ? JSON.parse(text) : {}) as { result?: { isError?: boolean } },
      };
    };
    expect((await call()).value.result?.isError).toBe(true);
    await binding!.activate();
    await binding!.beginTurn();
    expect((await call()).value.result?.isError).not.toBe(true);
    await binding!.endTurn();
    expect((await call()).value.result?.isError).toBe(true);
    await binding!.dispose();
    await binding!.dispose();
    expect((await call()).status).toBe(403);
    await expect(fs.stat(dirname(path!))).rejects.toMatchObject({ code: "ENOENT" });
  },
);
it.each(["linux", "win32"] as const)(
  "does not mint a provider binding on %s even if a host descriptor exists",
  async (platform) => {
    const f = await fixture(platform);
    expect(
      await f.broker.bind({
        threadId: ThreadId.make("synthetic-thread"),
        providerInstanceId: ProviderInstanceId.make("account"),
        provider: "codex",
      }),
    ).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
  },
);
it("retires every private binding on close and refuses subsequent acquisition", async () => {
  const f = await fixture();
  const input = {
    threadId: ThreadId.make("synthetic-thread"),
    providerInstanceId: ProviderInstanceId.make("account"),
    provider: "codex" as const,
  };
  const binding = await f.broker.bind(input);
  const path = binding!.launch.args[1]!;
  await f.broker.close();
  await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.broker.bind(input)).toBeUndefined();
});
