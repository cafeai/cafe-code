// Native fixture retains actual host file/socket identity and exact owned cleanup.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// Native fixture retains actual host file/socket identity and exact owned cleanup.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ProviderInstanceId, ThreadId, TurnId } from "@cafecode/contracts";
import { readBridgeConnection } from "../mcp/localBridge.ts";
import { GlideNativeHost } from "./nativeHost.ts";
import {
  glideHostAppFromExecutable,
  makeGlideSessionRuntime,
  type GlideSessionBinding,
} from "./sessionRuntime.ts";
import { GlideExecutionError } from "./runtime.ts";
import { unknownActionReceipt } from "./protocol.ts";
import type { GlideTrayEvent } from "./tray.ts";
import type { GlideTraySnapshot } from "./activity.ts";

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
  let stopRevision = 0;
  let trayEvent: ((event: GlideTrayEvent) => void) | undefined;
  let trayFailure: (() => void) | undefined;
  const tray = {
    publish: vi.fn(async (_snapshot: GlideTraySnapshot) => undefined),
    close: vi.fn(async () => undefined),
  };
  const writePolicy = vi.fn(
    async (
      _id: string,
      next: { enabled: boolean; apps: readonly string[]; desktop?: boolean },
      revision?: string,
    ) => {
      if (revision !== undefined && revision !== String(stopRevision))
        throw new Error("Stale grant");
      policy = { ...policy, ...next, desktop: next.desktop === true };
    },
  );
  const stopAllPolicies = vi.fn(async () => {
    stopRevision++;
    policy = { ...policy, enabled: false, desktop: false };
  });
  const runtime = makeGlideSessionRuntime({
    helperPath: "/synthetic/helper",
    trayFactory: (_path, event, failure) => {
      trayEvent = event;
      trayFailure = failure;
      return tray;
    },
    bridgeSource,
    mcpPort: 12345,
    nativeHost: host,
    readPolicy: async () => policy,
    writePolicy,
    readStopRevision: async () => String(stopRevision),
    stopAllPolicies,
    initializePolicy: async (_id, revision) => {
      if (revision !== String(stopRevision)) throw new Error("Stale draft");
      policy = { ...policy, enabled: true, desktop: true };
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
    start: async (
      binding: GlideSessionBinding,
      threadId = identity.threadId,
      turnId = "fixture-turn",
    ) => {
      binding.observeTurn?.({ type: "turn.started", threadId, turnId: TurnId.make(turnId) });
      await runtime.operation({ kind: "control", input: { action: "status", threadId } });
    },
    stopAllPolicies,
    status,
    tray,
    writePolicy,
    trayEvent: (event: GlideTrayEvent) => trayEvent?.(event),
    trayFailure: () => trayFailure?.(),
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
  it("keeps disabled provider sessions and their cleanup independent of a failed status host", async () => {
    const f = await fixture();
    try {
      f.tray.publish.mockImplementationOnce(async () => {
        f.trayFailure();
        throw new Error("Synthetic status-host failure");
      });
      const binding = (await f.runtime.bind(identity))!;
      const token = await f.token(binding);
      await expect(binding.activate()).resolves.toBeUndefined();
      await expect(f.runtime.operation({ kind: "catalog", token })).resolves.toEqual({
        connected: true,
      });
      binding.resume();
      await f.start(binding);
      await expect(
        f.runtime.operation({ kind: "execute", token, input: { code: "not granted" } }),
      ).rejects.toThrow("Glide");
      await expect(binding.cancel()).resolves.toBeUndefined();
      await expect(binding.dispose()).resolves.toBeUndefined();
      await expect(f.runtime.operation({ kind: "catalog", token })).rejects.toThrow("Glide");
      // The failed child remains unavailable. A later ordinary session must
      // still start without recovering or silently re-enabling desktop access.
      const replacement = (await f.runtime.bind(identity))!;
      await expect(replacement.activate()).resolves.toBeUndefined();
      await expect(
        f.runtime.operation({
          kind: "execute",
          token: await f.token(replacement),
          input: { code: "still not granted" },
        }),
      ).rejects.toThrow("Glide");
      await expect(replacement.dispose()).resolves.toBeUndefined();
      expect(f.kernels).toHaveLength(0);
      expect(f.nativeFactory).not.toHaveBeenCalled();
      expect(f.writePolicy).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
  it("still requires status acknowledgement when activating an enabled desktop grant", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let activating: Promise<void> | undefined;
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      f.tray.publish.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        f.trayFailure();
        throw new Error("Synthetic native ACK failure");
      });
      const binding = (await f.runtime.bind(identity))!;
      let activated = false;
      activating = binding.activate().then(() => {
        activated = true;
      });
      const refused = expect(activating).rejects.toThrow("Synthetic native ACK failure");
      await entered.promise;
      expect(activated).toBe(false);
      release.resolve();
      await refused;
      binding.resume();
      await f.start(binding);
      await expect(
        f.runtime.operation({
          kind: "execute",
          token: await f.token(binding),
          input: { code: "failed status grant" },
        }),
      ).rejects.toThrow("Glide");
      expect(f.kernels).toHaveLength(0);
      expect(f.nativeFactory).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await activating?.catch(() => undefined);
      await f.cleanup();
    }
  });
  it("keeps the status visible until an admitted cell drains after its exact turn finishes", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let running: Promise<unknown> | undefined;
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      const binding = (await f.runtime.bind(identity))!;
      await binding.activate();
      await f.start(binding);
      const token = await f.token(binding);
      await f.runtime.operation({ kind: "execute", token, input: { code: "prepare" } });
      f.kernels[0]!.execute.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { content: [] };
      });
      running = f.runtime.operation({
        kind: "execute",
        token,
        input: { code: "held admitted cell" },
      });
      await entered.promise;
      binding.observeTurn?.({
        type: "turn.completed",
        threadId: identity.threadId,
        turnId: TurnId.make("fixture-turn"),
      });
      await f.runtime.operation({ kind: "control", input: { action: "status" } });
      expect(f.tray.publish.mock.calls.at(-1)?.[0].rows[0]?.state).toBe("stopping");
      await expect(
        f.runtime.operation({ kind: "execute", token, input: { code: "late cell" } }),
      ).rejects.toThrow();
      release.resolve();
      await running;
      await f.runtime.operation({ kind: "control", input: { action: "status" } });
      expect(f.tray.publish.mock.calls.at(-1)?.[0].rows).toEqual([]);
    } finally {
      release.resolve();
      await running;
      await f.cleanup();
    }
  });
  it("shows only running turns, retires idle previews and refuses idle execution without disabling the saved grant", async () => {
    const f = await fixture();
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      const binding = (await f.runtime.bind(identity))!;
      await binding.activate();
      const token = await f.token(binding);
      expect(f.tray.publish.mock.calls.at(-1)?.[0].rows).toEqual([]);
      const execute = () =>
        f.runtime.operation({ kind: "execute", token, input: { code: "cell" } });
      await expect(execute()).rejects.toThrow();
      await f.start(binding, identity.threadId, "first");
      expect(f.tray.publish.mock.calls.at(-1)?.[0].rows).toHaveLength(1);
      await execute();
      await f.start(binding, identity.threadId, "second");
      binding.observeTurn?.({
        type: "turn.completed",
        threadId: identity.threadId,
        turnId: TurnId.make("first"),
      });
      expect(f.tray.publish.mock.calls.at(-1)?.[0].rows).toHaveLength(1);
      binding.observeTurn?.({
        type: "turn.completed",
        threadId: identity.threadId,
        turnId: TurnId.make("second"),
      });
      const status = await f.runtime.operation({
        kind: "control",
        input: { action: "status", threadId: identity.threadId },
      });
      expect(status).toMatchObject({ enabled: true, connected: true });
      expect(f.tray.publish.mock.calls.at(-1)?.[0].rows).toEqual([]);
      await expect(execute()).rejects.toThrow();
      expect(f.kernels[0]!.execute).toHaveBeenCalledOnce();
      expect(f.writePolicy).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
  it("keeps another running chat visible and ignores a retired owner's lifecycle", async () => {
    const f = await fixture();
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      const old = (await f.runtime.bind(identity))!;
      await old.activate();
      await f.start(old);
      const otherId = ThreadId.make("other-running-chat");
      const other = (await f.runtime.bind({ ...identity, threadId: otherId }))!;
      await other.activate();
      await f.start(other, otherId);
      expect(f.tray.publish.mock.calls.at(-1)?.[0].rows).toHaveLength(2);
      const next = (await f.runtime.bind(identity))!;
      await next.activate();
      await f.start(next, identity.threadId, "replacement-turn");
      old.observeTurn?.({ type: "session.exited", threadId: identity.threadId });
      next.observeTurn?.({
        type: "turn.completed",
        threadId: otherId,
        turnId: TurnId.make("replacement-turn"),
      });
      other.observeTurn?.({ type: "session.exited", threadId: otherId });
      await f.runtime.operation({ kind: "control", input: { action: "status" } });
      expect(f.tray.publish.mock.calls.at(-1)?.[0].rows).toHaveLength(1);
      await expect(
        f.runtime.operation({
          kind: "execute",
          token: await f.token(next),
          input: { code: "current" },
        }),
      ).resolves.toBeDefined();
    } finally {
      await f.cleanup();
    }
  });
  it("reopens only from explicit composer enable and keeps idle enabled chats hidden until their next running turn", async () => {
    const f = await fixture();
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      f.status.mockResolvedValue({ accessibility: true, screenRecording: true, apps: [] });
      const binding = (await f.runtime.bind(identity))!;
      await binding.activate();
      await f.start(binding);
      await f.runtime.operation({ kind: "control", input: { action: "stop-all" } });
      expect(f.tray.publish.mock.calls.at(-1)?.[0]).toMatchObject({ state: "stopped", rows: [] });
      const enable = () =>
        f.runtime.operation({
          kind: "control",
          input: { action: "set-enabled", enabled: true, threadId: identity.threadId },
        });
      await expect(enable()).resolves.toMatchObject({ enabled: true, paused: false });
      expect(f.tray.publish.mock.calls.at(-1)?.[0]).toMatchObject({ state: "ready", reveal: 1 });
      expect(f.tray.publish.mock.calls.at(-1)?.[0].rows).toHaveLength(1);
      await expect(
        f.runtime.operation({
          kind: "execute",
          token: await f.token(binding),
          input: { code: "explicitly resumed" },
        }),
      ).resolves.toBeDefined();
      binding.observeTurn?.({
        type: "turn.completed",
        threadId: identity.threadId,
        turnId: TurnId.make("fixture-turn"),
      });
      await enable();
      expect(f.tray.publish.mock.calls.at(-1)?.[0]).toMatchObject({ reveal: 2, rows: [] });
      await f.start(binding, identity.threadId, "next-turn");
      expect(f.tray.publish.mock.calls.at(-1)?.[0]).toMatchObject({ reveal: 2 });
      expect(f.tray.publish.mock.calls.at(-1)?.[0].rows).toHaveLength(1);
      await f.runtime.operation({ kind: "control", input: { action: "status" } });
      expect(f.tray.publish.mock.calls.at(-1)?.[0].reveal).toBe(2);
    } finally {
      await f.cleanup();
    }
  });
  it("requires a successful durable global stop before any chat can enable again after a storage failure", async () => {
    const f = await fixture();
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      const binding = (await f.runtime.bind(identity))!;
      await binding.activate();
      await f.start(binding);
      f.stopAllPolicies.mockRejectedValueOnce(new Error("Synthetic transaction failure"));
      await expect(
        f.runtime.operation({ kind: "control", input: { action: "stop-all" } }),
      ).rejects.toThrow();
      await expect(
        f.runtime.operation({
          kind: "initialize-thread",
          threadId: "stale-storage-draft",
          stopRevision: "0",
        }),
      ).rejects.toThrow();
      f.status.mockResolvedValue({ accessibility: true, screenRecording: true, apps: [] });
      await expect(
        f.runtime.operation({
          kind: "control",
          input: { action: "set-enabled", threadId: identity.threadId, enabled: true },
        }),
      ).rejects.toThrow();
      expect(f.writePolicy).not.toHaveBeenCalled();
      await f.runtime.operation({ kind: "control", input: { action: "stop-all" } });
      await expect(
        f.runtime.operation({
          kind: "control",
          input: { action: "set-enabled", threadId: identity.threadId, enabled: true },
        }),
      ).resolves.toMatchObject({ enabled: true });
    } finally {
      await f.cleanup();
    }
  });
  it("retains stopping evidence until exact disposal closes and preserves a replacement owner's row", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      const old = (await f.runtime.bind(identity))!;
      await old.activate();
      await f.start(old);
      await f.runtime.operation({
        kind: "execute",
        token: await f.token(old),
        input: { code: "prepare" },
      });
      f.kernels[0]!.close.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
      const closing = old.dispose();
      await entered.promise;
      expect(f.tray.publish.mock.calls.at(-1)?.[0].rows[0]?.state).toBe("stopping");
      const replacement = (await f.runtime.bind(identity))!;
      await replacement.activate();
      await f.start(replacement);
      expect(f.tray.publish.mock.calls.at(-1)?.[0].rows.map((row) => row.state)).toEqual([
        "stopping",
        "ready",
      ]);
      release.resolve();
      await closing;
      expect(f.tray.publish.mock.calls.at(-1)?.[0].rows.map((row) => row.state)).toEqual(["ready"]);
      await expect(
        f.runtime.operation({
          kind: "execute",
          token: await f.token(replacement),
          input: { code: "new owner" },
        }),
      ).resolves.toBeDefined();
    } finally {
      release.resolve();
      await f.cleanup();
    }
  });
  it("keeps incomplete retirement unavailable through repeated Stop all and explicit enable", async () => {
    const f = await fixture();
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      const binding = (await f.runtime.bind(identity))!;
      await binding.activate();
      await f.start(binding);
      await f.runtime.operation({
        kind: "execute",
        token: await f.token(binding),
        input: { code: "prepare" },
      });
      f.kernels[0]!.close.mockRejectedValueOnce(new Error("Synthetic owned close failure"));
      await expect(
        f.runtime.operation({ kind: "control", input: { action: "stop-all" } }),
      ).rejects.toThrow();
      await expect(
        f.runtime.operation({ kind: "control", input: { action: "stop-all" } }),
      ).rejects.toThrow();
      f.status.mockResolvedValue({ accessibility: true, screenRecording: true, apps: [] });
      await expect(
        f.runtime.operation({
          kind: "control",
          input: { action: "set-enabled", threadId: identity.threadId, enabled: true },
        }),
      ).rejects.toThrow();
      expect(f.tray.publish.mock.calls.at(-1)?.[0].state).toBe("unavailable");
      expect(f.writePolicy).not.toHaveBeenCalled();
    } finally {
      await expect(f.cleanup()).rejects.toThrow();
    }
  });
  it("fences queued admission before joining native retirement and keeps grants off across resume and new bindings", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      const binding = (await f.runtime.bind(identity))!;
      await binding.activate();
      await f.start(binding);
      const token = await f.token(binding);
      await f.runtime.operation({ kind: "execute", token, input: { code: "prepare" } });
      f.kernels[0]!.close.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
      });
      const stopped = f.runtime.operation({ kind: "control", input: { action: "stop-all" } });
      await entered.promise;
      binding.resume();
      await expect(
        f.runtime.operation({ kind: "execute", token, input: { code: "blocked" } }),
      ).rejects.toThrow();
      expect(f.tray.publish.mock.calls.some(([snapshot]) => snapshot.state === "stopping")).toBe(
        true,
      );
      release.resolve();
      await stopped;
      expect(f.tray.publish.mock.calls.at(-1)?.[0]).toMatchObject({ state: "stopped", rows: [] });
      await expect(
        f.runtime.operation({
          kind: "initialize-thread",
          threadId: "stale-draft",
          stopRevision: "0",
        }),
      ).rejects.toThrow();
      const replacement = (await f.runtime.bind({
        ...identity,
        threadId: ThreadId.make("replacement"),
      }))!;
      await replacement.activate();
      await f.start(replacement, ThreadId.make("replacement"));
      replacement.resume();
      await expect(
        f.runtime.operation({
          kind: "execute",
          token: await f.token(replacement),
          input: { code: "still blocked" },
        }),
      ).rejects.toThrow();
      f.status.mockResolvedValue({ accessibility: true, screenRecording: true, apps: [] });
      await f.runtime.operation({
        kind: "control",
        input: { action: "set-enabled", threadId: identity.threadId, enabled: true },
      });
      binding.resume();
      await expect(
        f.runtime.operation({ kind: "execute", token, input: { code: "explicit grant" } }),
      ).resolves.toBeDefined();
    } finally {
      release.resolve();
      await f.cleanup();
    }
  });
  it("rejects an enable held across Stop all before its durable publication", async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    try {
      f.status.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { accessibility: true, screenRecording: true, apps: [] };
      });
      const enabling = f.runtime.operation({
        kind: "control",
        input: { action: "set-enabled", threadId: identity.threadId, enabled: true },
      });
      const refused = expect(enabling).rejects.toThrow();
      await entered.promise;
      await f.runtime.operation({ kind: "control", input: { action: "stop-all" } });
      release.resolve();
      await refused;
      expect(f.writePolicy).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await f.cleanup();
    }
  });
  it("revokes access on status-host failure and exposes only server-minted current-owner navigation", async () => {
    const f = await fixture();
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      const binding = (await f.runtime.bind(identity))!;
      await binding.activate();
      await f.start(binding);
      const token = await f.token(binding);
      await f.runtime.operation({ kind: "execute", token, input: { code: "prepare" } });
      const row = f.tray.publish.mock.calls.at(-1)![0].rows[0]!;
      f.trayEvent({ type: "open-chat", owner: row.owner });
      expect(
        await f.runtime.operation({ kind: "control", input: { action: "activity" } }),
      ).toMatchObject({ navigation: { threadId: identity.threadId } });
      f.trayFailure();
      await f.runtime.operation({ kind: "control", input: { action: "stop-all" } });
      binding.resume();
      await expect(
        f.runtime.operation({ kind: "execute", token, input: { code: "hidden capture" } }),
      ).rejects.toThrow();
      expect(f.kernels[0]!.close).toHaveBeenCalledOnce();
    } finally {
      await f.cleanup();
    }
  });
  it("preserves bounded owned cancellation receipts inside the authenticated JSON result", async () => {
    const f = await fixture();
    try {
      f.policy({ enabled: true, apps: ["fixture.editor"] });
      const binding = (await f.runtime.bind(identity))!;
      await binding.activate();
      await f.start(binding);
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
      await f.start(binding);
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
      await f.start(binding);
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
      await f.start(old);
      const token = await f.token(old);
      await f.runtime.operation({ kind: "execute", token, input: { code: "old" } });
      const next = (await f.runtime.bind(identity))!,
        stale = (await f.runtime.bind(identity))!;
      await next.activate();
      await f.start(next);
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
      await f.start(binding);
      const token = await f.token(binding);
      const execute = () =>
        f.runtime.operation({ kind: "execute", token, input: { code: "cell" } });
      await execute();
      await binding.cancel();
      await expect(execute()).rejects.toThrow("Glide");
      binding.resume();
      await f.start(binding, identity.threadId, "next-turn");
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
      await f.start(binding);
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
        await f.start(binding, ThreadId.make(`owned-${index}`));
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
    trayFactory: () => ({ publish: async () => undefined, close: async () => undefined }),
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
