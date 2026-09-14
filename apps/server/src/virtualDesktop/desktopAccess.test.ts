import { expect, it, vi } from "vitest";
import { ThreadId } from "@cafecode/contracts";
import { DesktopManager } from "./DesktopManager.ts";
import { DesktopAuthority, desktopTokenDigest, type DesktopBinding } from "./authority.ts";
import type { DesktopStore } from "./store.ts";
const native = vi.hoisted(() => vi.fn());
vi.mock("./nativeClient.ts", async (original) => ({
  ...(await original<typeof import("./nativeClient.ts")>()),
  nativeRequest: native,
}));
function fixture() {
  native.mockReset();
  const policy = {
    virtualDesktopsEnabled: true,
    desktopControlMcpEnabled: true,
    desktopObservationRetention: 50,
  };
  const observations = { save: vi.fn(), setRetention: vi.fn() };
  const selections = new Map<ThreadId, string | null>();
  const store = {
    attach: vi.fn(async (threadId: ThreadId, id: string | null) => {
      selections.set(threadId, id);
    }),
    selected: vi.fn(async (threadId: ThreadId) => selections.get(threadId) ?? null),
  };
  const manager = new DesktopManager({
    store: store as unknown as DesktopStore,
    observations,
    stateDir: "unused",
    mcpPort: 1234,
    policy,
  });
  const internal = manager as unknown as {
    initialized: Promise<void>;
    desktops: Map<string, unknown>;
    authority: DesktopAuthority;
    supported: boolean;
    start(binding: DesktopBinding): Promise<void>;
    end(binding: DesktopBinding): Promise<void>;
  };
  // Seed an already-adopted runtime so these authorization/race tests never
  // start Sway or require a host display. Native transport is the only mock.
  internal.initialized = Promise.resolve();
  internal.supported = true;
  const runtime = {
    definition: { id: "desktop", incarnation: "one", directory: "unused" },
    snapshot: { state: "ready", humanControl: true, canResize: true },
  };
  internal.desktops.set("desktop", runtime);
  const binding: DesktopBinding = {
    threadId: ThreadId.make("root"),
    desktopId: "desktop",
    incarnation: "one",
    active: false,
    revoked: false,
    controllers: new Set(),
    connectionPath: "unused",
    observedEpoch: 1,
  };
  internal.authority.bindings.set(desktopTokenDigest("token"), binding);
  return { manager, policy, internal, runtime, binding, observations, store };
}
it("rejects busy attachments without revoking the owner, then allows selection after release", async () => {
  const { manager, binding, internal, store } = fixture();
  const other = ThreadId.make("other");
  internal.authority.start(binding);
  await expect(
    manager.manage({ operation: "attach", id: "desktop", threadId: other }),
  ).rejects.toMatchObject({ code: "busy" });
  expect(store.attach).not.toHaveBeenCalled();
  internal.authority.requireTurn(binding);
  // Removing a selection during a turn does not transfer its active control.
  await manager.manage({ operation: "attach", id: null, threadId: binding.threadId });
  internal.authority.requireTurn(binding);
  await expect(
    manager.manage({ operation: "attach", id: "desktop", threadId: other }),
  ).rejects.toMatchObject({ code: "busy" });
  await manager.manage({ operation: "attach", id: "desktop", threadId: binding.threadId });
  expect(await store.selected(binding.threadId)).toBe("desktop");
  await internal.authority.end(binding, async () => {});
  await manager.manage({ operation: "attach", id: "desktop", threadId: other });
  expect(await store.selected(other)).toBe("desktop");
  expect(internal.authority.active.size).toBe(0);
  expect(native).not.toHaveBeenCalled();
});
it("reserves the desktop through native cancellation and retries a lost ACK before new input", async () => {
  const { manager, binding, internal } = fixture();
  const next: DesktopBinding = {
    ...binding,
    threadId: ThreadId.make("next"),
    controllers: new Set(),
  };
  internal.authority.bindings.set(desktopTokenDigest("next-token"), next);
  await internal.start(binding);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  native.mockImplementationOnce(async () => {
    await pending;
    return { ok: true };
  });
  const ending = internal.end(binding);
  const starting = internal.start(next);
  await expect(manager.tool("next-token", "take_control", {})).rejects.toMatchObject({
    code: "not_authorized",
  });
  expect(() => internal.authority.start(binding)).toThrow();
  finish();
  await Promise.all([ending, starting]);
  internal.authority.requireTurn(next);
  expect(native).toHaveBeenCalledTimes(1);
  expect(native.mock.calls[0]?.[2]).toEqual({ method: "cancel" });

  native.mockRejectedValueOnce(new Error("lost native ACK"));
  await internal.end(next);
  expect(() => internal.authority.start(binding)).toThrow();
  await expect(manager.tool("next-token", "take_control", {})).rejects.toMatchObject({
    code: "not_authorized",
  });
  native.mockResolvedValueOnce({ ok: true });
  await internal.start(binding);
  internal.authority.requireTurn(binding);
  const calls = native.mock.calls.length;
  await internal.end(next);
  expect(native).toHaveBeenCalledTimes(calls);
});
it("validates display changes and invalidates old observations even if their acknowledgement is lost", async () => {
  const { manager, binding, internal } = fixture();
  await expect(
    manager.tool("token", "set_display", { width: 1920, height: 1080 }),
  ).rejects.toMatchObject({ code: "not_authorized" });
  internal.authority.start(binding);
  binding.observedEpoch = 1;
  await expect(
    manager.tool("token", "set_display", { width: 50000, height: 1080 }),
  ).rejects.toMatchObject({ code: "invalid_request" });
  expect(native).not.toHaveBeenCalled();
  native.mockResolvedValueOnce({ error: "human_control_active" });
  await expect(
    manager.tool("token", "set_display", { width: 1920, height: 1080 }),
  ).rejects.toMatchObject({ code: "busy" });
  binding.observedEpoch = 2;
  native.mockRejectedValueOnce(new Error("lost acknowledgement"));
  await expect(
    manager.tool("token", "set_display", { width: 1920, height: 1080 }),
  ).rejects.toThrow();
  expect(binding.observedEpoch).toBeUndefined();
  await expect(manager.tool("token", "act", { kind: "click", x: 50, y: 50 })).rejects.toThrow(
    "Observe",
  );
  native.mockResolvedValueOnce({ ok: true, width: 1920, height: 1080, displayConfiguration: true });
  expect(await manager.tool("token", "get_display", {})).toEqual({
    width: 1920,
    height: 1080,
    canResize: true,
  });
  expect(binding.observedEpoch).toBeUndefined();
});
it("only the matching active turn can reclaim control, and requires re-observation", async () => {
  const { manager, binding, internal, runtime } = fixture();
  await expect(manager.tool("owner-token", "take_control", {})).rejects.toMatchObject({
    code: "not_authorized",
  });
  await expect(manager.tool("token", "take_control", {})).rejects.toMatchObject({
    code: "not_authorized",
  });
  internal.authority.start(binding);
  binding.observedEpoch = 4;
  native.mockResolvedValue({ humanControl: false, controlEpoch: 5 });
  expect(await manager.tool("token", "take_control", {})).toEqual({
    humanControl: false,
    observeBeforeActing: true,
  });
  expect(native).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.any(String),
    { method: "take-control" },
    expect.any(AbortSignal),
  );
  expect(runtime.snapshot.humanControl).toBe(false);
  await expect(manager.tool("token", "act", { kind: "click", x: 1, y: 1 })).rejects.toMatchObject({
    code: "operation_failed",
  });
  runtime.definition.incarnation = "replacement";
  await expect(manager.tool("token", "take_control", {})).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(native).toHaveBeenCalledTimes(1);
});
it("never saves card previews as conversation observations and rejects a capture after termination", async () => {
  const { manager, runtime, observations } = fixture();
  native.mockResolvedValueOnce({ image: "png" });
  expect(await manager.preview("desktop")).toEqual({ image: "png" });
  expect(observations.save).not.toHaveBeenCalled();
  native.mockImplementationOnce(async () => {
    runtime.snapshot.state = "stopped";
    return { image: "stale" };
  });
  await expect(manager.preview("desktop")).rejects.toMatchObject({ code: "unavailable" });
});
it("bounds preview encoders and refuses private capture with desktop access off", async () => {
  const { manager, policy } = fixture();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  native.mockImplementation(async () => {
    await pending;
    return { image: "png" };
  });
  const a = manager.preview("desktop"),
    b = manager.preview("desktop");
  await expect(manager.preview("desktop")).rejects.toMatchObject({ code: "busy" });
  finish();
  await Promise.all([a, b]);
  policy.virtualDesktopsEnabled = false;
  await expect(manager.preview("desktop")).rejects.toMatchObject({ code: "feature_disabled" });
  expect(native).toHaveBeenCalledTimes(2);
});
it("reserves one model mutation lane, allows state reads, and releases it after failure", async () => {
  const { manager, internal, binding, runtime } = fixture();
  internal.authority.start(binding);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  native.mockImplementationOnce(async () => {
    await pending;
    throw new Error("lost reply");
  });
  const mutation = manager.tool("token", "take_control", {});
  await expect(manager.tool("token", "observe", {})).rejects.toMatchObject({ code: "busy" });
  native.mockResolvedValueOnce({ width: 1280, height: 800 });
  expect(await manager.tool("token", "get_display", {})).toMatchObject({ width: 1280 });
  finish();
  await expect(mutation).rejects.toThrow();
  native.mockResolvedValueOnce({ humanControl: false });
  await expect(manager.tool("token", "take_control", {})).resolves.toMatchObject({
    humanControl: false,
  });
  expect((runtime.snapshot as unknown as { toolUsage: unknown }).toolUsage).toMatchObject({
    calls: 4,
    failures: 2,
  });
});
