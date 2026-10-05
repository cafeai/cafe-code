import { afterEach, expect, it, vi } from "vitest";
import { DesktopManager } from "./DesktopManager.ts";
import type { DesktopStore } from "./store.ts";
let manager: DesktopManager;
afterEach(async () => {
  const internal = manager as unknown as { desktops: Map<string, unknown> };
  internal?.desktops.clear();
  await manager?.close();
  vi.useRealTimers();
});
function fixture() {
  manager = new DesktopManager({
    store: {} as DesktopStore,
    observations: { save: vi.fn(), setRetention: vi.fn(async () => undefined) },
    stateDir: "fixture",
    mcpPort: 12345,
    policy: {
      virtualDesktopsEnabled: true,
      desktopControlMcpEnabled: true,
      desktopObservationRetention: 50,
    },
  });
  const internal = manager as unknown as {
    initialized: Promise<void>;
    desktops: Map<string, unknown>;
    request: (r: unknown, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  internal.initialized = Promise.resolve();
  const runtime = { definition: { incarnation: "incarnation-one" }, snapshot: { state: "ready" } };
  internal.desktops.set("desktop", runtime);
  const state = { controlEpoch: 0, humanControl: false, width: 1280, height: 800 };
  const request = vi.fn(async (_r: unknown, input: Record<string, unknown>) => {
    if (input.method === "human-take-control") {
      if (input.controlEpoch !== state.controlEpoch) throw new Error("stale");
      state.controlEpoch++;
      state.humanControl = true;
    }
    if (input.method === "human-return-control") {
      if (input.controlEpoch !== state.controlEpoch) throw new Error("stale");
      state.controlEpoch++;
      state.humanControl = false;
    }
    return { ...state };
  });
  internal.request = request;
  return { runtime, state, request };
}
it("requires the same owner, lease and incarnation for input and invalidates old takeover leases", async () => {
  const { runtime, request } = fixture();
  const first = await manager.remoteViewer("owner-a", "desktop", "take-control");
  await expect(
    manager.remoteViewer("owner-b", "desktop", "act", first.lease, {
      kind: "key",
      keys: ["Return"],
    }),
  ).rejects.toMatchObject({ code: "not_authorized" });
  await manager.remoteViewer("owner-a", "desktop", "act", first.lease, {
    kind: "key",
    keys: ["Return"],
  });
  expect(request).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ method: "human-act", controlEpoch: 1 }),
  );
  const second = await manager.remoteViewer("owner-b", "desktop", "take-control");
  await expect(
    manager.remoteViewer("owner-a", "desktop", "return-control", first.lease),
  ).rejects.toMatchObject({ code: "not_authorized" });
  runtime.definition.incarnation = "replacement";
  await expect(
    manager.remoteViewer("owner-b", "desktop", "act", second.lease, { kind: "click", x: 1, y: 1 }),
  ).rejects.toMatchObject({ code: "not_authorized" });
});
it("rejects input after native/agent takeover and never replays a rejected action", async () => {
  const { state, request } = fixture();
  const claimed = await manager.remoteViewer("owner", "desktop", "take-control");
  state.controlEpoch++;
  state.humanControl = false;
  await expect(
    manager.remoteViewer("owner", "desktop", "act", claimed.lease, {
      kind: "text",
      text: "private text",
    }),
  ).rejects.toMatchObject({ code: "not_authorized" });
  expect(request.mock.calls.filter(([, input]) => input.method === "human-act")).toHaveLength(0);
});
it("expires abandoned control and requires the viewer feature to remain enabled", async () => {
  vi.useFakeTimers();
  const { request } = fixture();
  const claimed = await manager.remoteViewer("owner", "desktop", "take-control");
  await vi.advanceTimersByTimeAsync(40_000);
  expect(request).toHaveBeenLastCalledWith(expect.anything(), {
    method: "human-return-control",
    controlEpoch: 1,
  });
  await expect(
    manager.remoteViewer("owner", "desktop", "heartbeat", claimed.lease),
  ).rejects.toMatchObject({ code: "not_authorized" });
  await manager.setPolicy({
    virtualDesktopsEnabled: false,
    desktopControlMcpEnabled: false,
    desktopObservationRetention: 50,
  });
  await expect(manager.remoteViewer("owner", "desktop", "take-control")).rejects.toMatchObject({
    code: "feature_disabled",
  });
});
