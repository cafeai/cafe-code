import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import { readBridgeConnection } from "../mcp/localBridge.ts";
import { GlideNativeHost } from "./nativeHost.ts";
import {
  glideHostAppFromExecutable,
  makeGlideSessionRuntime,
  type GlideSessionBinding,
} from "./sessionRuntime.ts";
import { GlideExecutionError } from "./runtime.ts";
import { unknownActionReceipt } from "./protocol.ts";

const identity = {
  threadId: ThreadId.make("glide-fixture"),
  providerInstanceId: ProviderInstanceId.make("codex_fixture"),
  provider: "codex" as const,
  runtimeMode: "full-access",
};
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "glide-session-fixture-")));
  const bridgeSource = join(root, "bridge.mjs");
  await writeFile(bridgeSource, "// Fixture only, never executed.\n");
  let policy = { enabled: false, apps: [] as readonly string[], fullAccess: true, desktop: false };
  const status = vi.fn(async () => ({
    accessibility: true,
    screenRecording: false,
    apps: [{ name: "Editor", bundleId: "fixture.editor", path: "/Editor.app", pid: 10 }],
  }));
  const kernels: {
    execute: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const nativeFactory = vi.fn(() => {
    throw new Error("No native child is allowed in this fixture.");
  });
  const host = new GlideNativeHost(nativeFactory);
  const runtime = makeGlideSessionRuntime({
    helperPath: "/synthetic/helper",
    bridgeSource,
    mcpPort: 12345,
    nativeHost: host,
    readPolicy: async () => policy,
    writePolicy: async (_id, next) => {
      policy = { ...policy, ...next, desktop: next.desktop === true };
    },
    status,
    runtimeFactory: () => {
      const kernel = {
        execute: vi.fn(async () => ({ content: [{ type: "text" as const, text: "owned" }] })),
        reset: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      };
      kernels.push(kernel);
      return kernel;
    },
  });
  const token = async (binding: GlideSessionBinding) =>
    (await readBridgeConnection(binding.launch.args[1]!, "cafe-glide")).token;
  return {
    runtime,
    kernels,
    token,
    nativeFactory,
    status,
    policy: (next: Partial<typeof policy>) => {
      policy = { ...policy, ...next };
    },
    cleanup: async () => {
      try {
        await runtime.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
describe("Cafe Glide session authority", () => {
  it("preserves bounded owned cancellation receipts inside the authenticated JSON result", async () => {
    const f = await fixture();
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      const binding = (await f.runtime.bind(identity))!;
      await binding.activate();
      const token = await f.token(binding);
      await f.runtime.operation({ kind: "execute", token, input: { code: "prepare" } });
      const receipt = unknownActionReceipt(
        "type_into",
        "owned:1",
        "Input may have partially completed.",
      );
      f.kernels[0]!.execute.mockRejectedValueOnce(new GlideExecutionError("cancelled", [receipt]));
      const result = await f.runtime.operation({
        kind: "execute",
        token,
        input: { code: "cancelled" },
      });
      expect(JSON.parse(JSON.stringify(result))).toEqual({
        isError: true,
        content: [
          { type: "text", text: `Glide action ${JSON.stringify(receipt)}` },
          { type: "text", text: "cancelled" },
        ],
      });
      f.policy({ enabled: false });
      await expect(
        f.runtime.operation({ kind: "execute", token, input: { code: "revoked" } }),
      ).rejects.toThrow("Glide");
      expect(f.kernels[0]!.execute).toHaveBeenCalledTimes(2);
    } finally {
      await f.cleanup();
    }
  });
  it("reads draft availability without a chat or grant, while every mutation still requires its exact chat", async () => {
    const f = await fixture();
    try {
      await expect(
        f.runtime.operation({ kind: "control", input: { action: "status" } }),
      ).resolves.toMatchObject({
        available: true,
        enabled: false,
        connected: false,
        fullAccess: false,
      });
      expect(f.kernels).toHaveLength(0);
      expect(f.nativeFactory).not.toHaveBeenCalled();
      await expect(
        f.runtime.operation({
          kind: "control",
          input: { action: "set-enabled", enabled: true },
        } as never),
      ).rejects.toThrow();
      await expect(
        f.runtime.operation({ kind: "control", input: { action: "stop" } } as never),
      ).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
  });
  it("enables desktop permission only with current OS permissions and revokes the exact kernel when switched off", async () => {
    const f = await fixture();
    try {
      const binding = (await f.runtime.bind(identity))!;
      await binding.activate();
      const token = await f.token(binding);
      const toggle = (enabled: boolean) =>
        f.runtime.operation({
          kind: "control",
          input: { action: "set-enabled", threadId: identity.threadId, enabled },
        });
      const execute = () =>
        f.runtime.operation({ kind: "execute", token, input: { code: "owned desktop operation" } });
      await expect(toggle(true)).rejects.toThrow("Glide");
      await expect(execute()).rejects.toThrow("Glide");
      f.status.mockResolvedValue({ accessibility: true, screenRecording: true, apps: [] });
      f.policy({ fullAccess: false });
      await expect(toggle(true)).rejects.toThrow("Glide");
      f.policy({ fullAccess: true });
      await expect(toggle(true)).resolves.toMatchObject({ enabled: true, apps: [] });
      await execute();
      expect(f.kernels).toHaveLength(1);
      await expect(toggle(false)).resolves.toMatchObject({ enabled: false });
      expect(f.kernels[0]!.close).toHaveBeenCalledOnce();
      await expect(execute()).rejects.toThrow("Glide");
      await toggle(true);
      await execute();
      expect(f.kernels).toHaveLength(2);
    } finally {
      await f.cleanup();
    }
  });
  it("permits pending discovery, denies execution until exact activation and explicit Full access/app grant", async () => {
    const f = await fixture();
    try {
      const binding = (await f.runtime.bind(identity))!;
      const token = await f.token(binding);
      expect(JSON.stringify(binding.launch)).not.toContain(token);
      await expect(f.runtime.operation({ kind: "catalog", token })).resolves.toEqual({
        connected: true,
      });
      const execute = () =>
        f.runtime.operation({
          kind: "execute",
          token,
          input: { code: "arbitrary trusted local JavaScript" },
        });
      await expect(execute()).rejects.toThrow("Glide");
      await binding.activate();
      await expect(execute()).rejects.toThrow("Glide");
      expect(f.kernels).toHaveLength(0);
      f.policy({ enabled: true, apps: ["fixture.editor"], fullAccess: false });
      await expect(execute()).rejects.toThrow("Glide");
      f.policy({ fullAccess: true });
      await execute();
      await execute();
      expect(f.kernels).toHaveLength(1);
      expect(f.kernels[0]!.execute).toHaveBeenCalledTimes(2);
      expect(f.nativeFactory).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
  it("isolates replacement ownership, rejects a stale staged candidate, and makes disposal idempotent", async () => {
    const f = await fixture();
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      const old = (await f.runtime.bind(identity))!;
      await old.activate();
      const token = await f.token(old);
      await f.runtime.operation({ kind: "execute", token, input: { code: "old" } });
      const next = (await f.runtime.bind(identity))!,
        stale = (await f.runtime.bind(identity))!;
      await next.activate();
      await expect(stale.activate()).rejects.toThrow("Glide");
      await expect(
        f.runtime.operation({ kind: "execute", token, input: { code: "stale" } }),
      ).rejects.toThrow("Glide");
      await old.dispose();
      await old.dispose();
      await f.runtime.operation({
        kind: "execute",
        token: await f.token(next),
        input: { code: "new" },
      });
      expect(f.kernels).toHaveLength(2);
      expect(f.kernels[1]!.reset).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
  it("pauses Stop until a new admitted provider turn, and revokes kernels before app-grant publication", async () => {
    const f = await fixture();
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      const binding = (await f.runtime.bind(identity))!;
      await binding.activate();
      const token = await f.token(binding);
      const execute = () =>
        f.runtime.operation({ kind: "execute", token, input: { code: "cell" } });
      await execute();
      await binding.cancel();
      await expect(execute()).rejects.toThrow("Glide");
      binding.resume();
      await execute();
      await f.runtime.operation({
        kind: "control",
        input: { action: "configure", threadId: identity.threadId, enabled: false, apps: [] },
      });
      expect(f.kernels[0]!.reset).toHaveBeenCalledTimes(2);
      await expect(execute()).rejects.toThrow("Glide");
      const status = await f.runtime.operation({
        kind: "control",
        input: { action: "status", threadId: identity.threadId },
      });
      expect(status).toMatchObject({
        enabled: false,
        accessibility: true,
        screenRecording: false,
        apps: [],
      });
    } finally {
      await f.cleanup();
    }
  });
  it("keeps restricted-session discovery inert while supporting later explicit Full access", async () => {
    const f = await fixture();
    try {
      const binding = (await f.runtime.bind({ ...identity, runtimeMode: "approval-required" }))!;
      await binding.activate();
      const token = await f.token(binding);
      f.policy({ fullAccess: false, enabled: true, apps: ["fixture.editor"] });
      await expect(
        f.runtime.operation({ kind: "execute", token, input: { code: "cell" } }),
      ).rejects.toThrow("Glide");
      expect(f.kernels).toHaveLength(0);
      f.policy({ fullAccess: true });
      await f.runtime.operation({ kind: "execute", token, input: { code: "cell" } });
      expect(f.kernels).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });
  it("bounds retained kernels and frees a slot on explicit permission revocation", async () => {
    const f = await fixture();
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      const sessions: { binding: GlideSessionBinding; token: string }[] = [];
      for (let index = 0; index < 5; index++) {
        const binding = (await f.runtime.bind({
          ...identity,
          threadId: ThreadId.make(`owned-${index}`),
        }))!;
        await binding.activate();
        sessions.push({ binding, token: await f.token(binding) });
      }
      const run = (index: number) =>
        f.runtime.operation({
          kind: "execute",
          token: sessions[index]!.token,
          input: { code: "cell" },
        });
      for (let index = 0; index < 4; index++) await run(index);
      await expect(run(4)).rejects.toThrow("Four Glide kernels");
      expect(f.kernels).toHaveLength(4);
      await f.runtime.operation({
        kind: "control",
        input: { action: "configure", threadId: "owned-0", enabled: false, apps: [] },
      });
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      await run(4);
      expect(f.kernels[0]!.close).toHaveBeenCalledOnce();
      expect(f.kernels).toHaveLength(5);
    } finally {
      await f.cleanup();
    }
  });
});

const responsible = {
  path: "/Users/dev/cafe/apps/desktop/.electron-runtime/debug/Cafe Code (Debug).app",
  name: "Cafe Code (Debug)",
  bundleId: "com.cafeai.cafecode.debug",
};
async function setup(status: () => Promise<unknown>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "glide-host-fixture-")));
  const bridgeSource = join(root, "bridge.mjs");
  await writeFile(bridgeSource, "// Fixture only, never executed.\n");
  const reveal = vi.fn(async (_path: string) => undefined);
  const nativeStatus = vi.fn(status);
  const runtime = makeGlideSessionRuntime({
    helperPath: "/synthetic/helper",
    bridgeSource,
    mcpPort: 12345,
    nativeHost: new GlideNativeHost(() => {
      throw new Error("No native child is allowed in this fixture.");
    }),
    readPolicy: async () => ({ enabled: false, apps: [], fullAccess: true }),
    writePolicy: async () => undefined,
    status: nativeStatus as never,
    hostExecutablePath: "/Applications/Cafe Code.app/Contents/MacOS/Cafe Code",
    reveal,
  });
  return {
    runtime,
    reveal,
    nativeStatus,
    cleanup: async () => {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("Glide permission setup host identity", () => {
  it("derives the outermost bundle of a host executable and refuses bare binaries", () => {
    expect(
      glideHostAppFromExecutable(
        "/Applications/Cafe Code.app/Contents/Frameworks/Cafe Code Helper.app/Contents/MacOS/Cafe Code Helper",
      ),
    ).toEqual({ path: "/Applications/Cafe Code.app", name: "Cafe Code" });
    expect(glideHostAppFromExecutable("/usr/local/bin/node")).toBeUndefined();
    expect(glideHostAppFromExecutable("relative/Cafe.app/Contents/MacOS/Cafe")).toBeUndefined();
  });

  it("reports the native responsible app and macOS version, preferring it over the host executable", async () => {
    const f = await setup(async () => ({
      accessibility: false,
      screenRecording: true,
      osMajorVersion: 27,
      responsibleApp: responsible,
      apps: [],
    }));
    try {
      await expect(
        f.runtime.operation({ kind: "control", input: { action: "status" } }),
      ).resolves.toMatchObject({
        accessibility: false,
        screenRecording: true,
        osMajorVersion: 27,
        hostApp: responsible,
      });
    } finally {
      await f.cleanup();
    }
  });

  it("falls back to the owner executable bundle when the responsible process is unknown", async () => {
    const f = await setup(async () => ({
      accessibility: false,
      screenRecording: false,
      responsibleApp: null,
      apps: [],
    }));
    try {
      const result = (await f.runtime.operation({
        kind: "control",
        input: { action: "status" },
      })) as Record<string, unknown>;
      expect(result.hostApp).toEqual({ path: "/Applications/Cafe Code.app", name: "Cafe Code" });
      expect(result).not.toHaveProperty("osMajorVersion");
    } finally {
      await f.cleanup();
    }
  });

  it("reveals only the freshly observed native host bundle and never accepts a client path", async () => {
    const f = await setup(async () => ({
      accessibility: true,
      screenRecording: true,
      responsibleApp: responsible,
      apps: [],
    }));
    try {
      await f.runtime.operation({ kind: "control", input: { action: "reveal-host-app" } });
      expect(f.reveal).toHaveBeenCalledExactlyOnceWith(responsible.path);
      await expect(
        f.runtime.operation({
          kind: "control",
          input: { action: "reveal-host-app", path: "/tmp/Other.app" },
        } as never),
      ).rejects.toThrow();
      expect(f.reveal).toHaveBeenCalledTimes(1);
      f.nativeStatus.mockRejectedValueOnce(new Error("helper unavailable"));
      await expect(
        f.runtime.operation({ kind: "control", input: { action: "reveal-host-app" } }),
      ).rejects.toThrow();
      expect(f.reveal).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
    }
  });
});
