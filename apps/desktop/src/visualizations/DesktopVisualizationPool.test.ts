import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type * as Electron from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestVisualizationHost } from "@cafecode/shared/visualizationHostClient";
import {
  VISUALIZATION_HOST_ACTIVE_MS,
  VISUALIZATION_HOST_MAX_INPUT_BYTES,
  VISUALIZATION_HOST_TICKET_MS,
  type VisualizationHostDocument,
} from "@cafecode/contracts/visualizationHost";
import { DesktopVisualizationHost } from "./DesktopVisualizationHost.ts";
import type {
  VisualizationSurface,
  VisualizationSurfaceOptions,
} from "./ElectronVisualizationSurface.ts";

vi.mock("electron", () => ({}));
const hosts: DesktopVisualizationHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  vi.useRealTimers();
});
const source: VisualizationHostDocument = {
  kind: "generated",
  html: "<p>private pool source</p>",
  assets: [],
  width: 400,
  height: 200,
  appearance: "light",
};
const bounds = { x: 0, y: 0, width: 400, height: 200 };
function ownerWindow() {
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => true,
    mainFrame: { frameToken: randomUUID(), url: "cafecode://app/chat" },
    send: vi.fn(),
    focus: vi.fn(),
  });
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => true,
    webContents: contents,
  }) as unknown as Electron.BrowserWindow;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const native: {
    surface: VisualizationSurface;
    input: VisualizationSurfaceOptions;
    initialize: ReturnType<typeof vi.fn>;
    capture: ReturnType<typeof vi.fn>;
    retire: ReturnType<typeof vi.fn>;
    suspend: ReturnType<typeof vi.fn>;
  }[] = [];
  const host = new DesktopVisualizationHost({
    stateDirectory: "unused-pool-fixture",
    preloadPath: "unused-pool-preload",
    createSurface: (input) => {
      let current = true;
      const initialize = vi.fn(async () => {}),
        capture = vi.fn(async () => ({ png: new Uint8Array([1]), width: 400, height: 200 }));
      const retire = vi.fn(async () => {
          current = false;
          return true;
        }),
        suspend = vi.fn(() => true);
      const surface: VisualizationSurface = {
        generation: randomUUID(),
        initialize,
        installSource: async () => {},
        capture,
        retire,
        suspend,
        isCurrent: () => current,
        update: () => current,
        send: () => current,
      };
      native.push({ surface, input, initialize, capture, retire, suspend });
      return surface;
    },
  });
  hosts.push(host);
  const connection = await host.listen(false);
  const window = ownerWindow();
  const owner = {
    environmentId: "pool-environment",
    threadId: "pool-thread",
    operationId: randomUUID(),
  };
  const prepare = (document = source, operationId = owner.operationId) => {
    const ticket = randomUUID().replaceAll("-", "").repeat(2);
    const input = { ticket, owner: { ...owner, operationId }, document };
    return { ticket, input, result: host.prepare(input) };
  };
  const open = (ticket: string, extra = {}) =>
    host.open(window, { ticket, bounds, appearance: "light", ...extra });
  return { host, connection, window, owner, native, prepare, open };
}

describe("exact native visualization pool ownership", () => {
  it("routes bounded monotonic natural layout only from a current exact generated owner", async () => {
    const f = await fixture(),
      generated = f.prepare(),
      state = await f.open(generated.ticket);
    const send = f.window.webContents.send as ReturnType<typeof vi.fn>;
    send.mockClear();
    f.native[0]!.input.onLayout!({ height: 420, constrained: false, sequence: 1 });
    expect(send).toHaveBeenCalledWith("desktop:visualization-event", {
      leaseId: state.leaseId,
      openingTicket: generated.ticket,
      state: "layout",
      layout: { height: 420, constrained: false, sequence: 1 },
    });
    send.mockClear();
    for (const layout of [
      { height: 420, constrained: false, sequence: 1 },
      { height: 2001, constrained: false, sequence: 2 },
      { height: NaN, constrained: false, sequence: 2 },
    ])
      f.native[0]!.input.onLayout!(layout);
    expect(send).not.toHaveBeenCalled();
    const app = await f.open(f.prepare({ ...source, kind: "mcp-app" }).ticket);
    f.native[1]!.input.onLayout!({ height: 420, constrained: false, sequence: 1 });
    expect(send.mock.calls.filter((call) => call[1].state === "layout")).toHaveLength(0);
    await f.host.retire(f.window, app.leaseId);
    Reflect.set(f.window.webContents.mainFrame, "frameToken", randomUUID());
    f.native[0]!.input.onLayout!({ height: 421, constrained: false, sequence: 2 });
    expect(send.mock.calls.filter((call) => call[1].state === "layout")).toHaveLength(0);
  });
  it("refuses native visibility updates after absolute expiry or an opaque native exception", async () => {
    const f = await fixture(),
      state = await f.open(f.prepare({ ...source, kind: "mcp-app" }).ticket);
    const update = vi.spyOn(f.native[0]!.surface, "update");
    vi.spyOn(f.host as unknown as { now(): number }, "now").mockReturnValue(
      performance.now() + VISUALIZATION_HOST_ACTIVE_MS + 1,
    );
    expect(
      (
        await f.host.update(f.window, {
          leaseId: state.leaseId,
          bounds,
          visible: true,
          appearance: "light",
        })
      ).state,
    ).toBe("retired");
    expect(update).not.toHaveBeenCalled();
    const other = await fixture(),
      active = await other.open(other.prepare().ticket);
    vi.spyOn(other.native[0]!.surface, "update").mockImplementation(() => {
      throw new Error("private native cause");
    });
    expect(
      (
        await other.host.update(other.window, {
          leaseId: active.leaseId,
          bounds,
          visible: true,
          appearance: "light",
        })
      ).state,
    ).toBe("retired");
    expect(other.host.diagnostics().lastRetirementReason).toBe("unavailable");
    expect(JSON.stringify(other.host.diagnostics())).not.toContain("private native cause");
  });
  it("restores only an unexpired exact trusted focus target", async () => {
    const f = await fixture();
    await f.open(f.prepare({ ...source, kind: "mcp-app" }).ticket);
    await f.open(f.prepare().ticket);
    const focus = vi.fn(() => true);
    f.native[0]!.surface.focus = focus;
    f.native[0]!.input.onTrustedFocus!();
    f.native[1]!.input.onFocusDenied!();
    expect(focus).toHaveBeenCalledOnce();
    vi.spyOn(f.host as unknown as { now(): number }, "now").mockReturnValue(
      performance.now() + VISUALIZATION_HOST_ACTIVE_MS + 1,
    );
    f.native[1]!.input.onFocusDenied!();
    expect(focus).toHaveBeenCalledOnce();
    expect(f.window.webContents.focus).toHaveBeenCalledOnce();
  });
  it("reserves four viewers before awaits and admits a separate fifth preview", async () => {
    const f = await fixture();
    const tickets = Array.from({ length: 4 }, () => f.prepare());
    const opens = tickets.map((value) => f.open(value.ticket));
    expect(f.host.capacity()).toMatchObject({ viewerCount: 4, freeViewers: 0 });
    const fifth = f.prepare();
    expect((await f.open(fifth.ticket)).reason).toBe("busy");
    const states = await Promise.all(opens);
    expect(states.every((state) => state.state === "active")).toBe(true);
    expect(f.native).toHaveLength(4);
    expect(await f.host.preview({ ...f.owner, operationId: randomUUID() }, source)).toMatchObject({
      status: "ready",
    });
    expect(f.native).toHaveLength(5);
    expect(f.host.capacity().viewerCount).toBe(4);
    expect(new Set(states.map((state) => state.leaseId)).size).toBe(4);
  });
  it("includes at most one manual App in the same four viewer slots", async () => {
    const f = await fixture();
    const app = f.prepare({ ...source, kind: "mcp-app" });
    expect((await f.open(app.ticket)).state).toBe("active");
    const another = f.prepare({ ...source, kind: "mcp-app" });
    expect((await f.open(another.ticket)).reason).toBe("busy");
    for (let index = 0; index < 3; index += 1)
      expect((await f.open(f.prepare().ticket)).state).toBe("active");
    expect(f.host.capacity()).toMatchObject({ viewerCount: 4, mcpAppAvailable: false });
  });
  it("discards only an unused exact ticket through the authenticated broker", async () => {
    const f = await fixture();
    const first = f.prepare(),
      sibling = f.prepare();
    expect(
      await requestVisualizationHost(f.connection, "discardPrepared", { ticket: first.ticket }),
    ).toEqual({ discarded: true });
    expect((await f.open(first.ticket)).reason).toBe("expired");
    const state = await f.open(sibling.ticket);
    expect(state.state).toBe("active");
    expect(
      await requestVisualizationHost(f.connection, "discardPrepared", { ticket: sibling.ticket }),
    ).toEqual({ discarded: false });
    expect(f.host.inspect(sibling.ticket, state.leaseId)).not.toBeNull();
    expect(
      await requestVisualizationHost(f.connection, "discardPrepared", {
        ticket: sibling.ticket,
        owner: f.owner,
      }),
    ).toMatchObject({ status: "blocked", reason: "invalid" });
  });
  it("cannot use a sibling, foreign window or replaced frame as a lease fallback", async () => {
    const f = await fixture();
    const first = f.prepare(),
      second = f.prepare();
    const a = await f.open(first.ticket),
      b = await f.open(second.ticket);
    expect(f.host.inspect(first.ticket, b.leaseId)).toBeNull();
    expect((await f.host.retire(ownerWindow(), a.leaseId)).state).toBe("blocked");
    await f.host.retire(f.window, a.leaseId);
    expect(f.host.inspect(second.ticket, b.leaseId)).not.toBeNull();
    expect(f.native[1]!.retire).not.toHaveBeenCalled();
    const frame = f.window.webContents.mainFrame as unknown as { frameToken: string };
    frame.frameToken = randomUUID();
    expect(
      (
        await f.host.update(f.window, {
          leaseId: b.leaseId,
          bounds,
          visible: true,
          appearance: "light",
        })
      ).state,
    ).toBe("blocked");
  });
  it("quarantines all new source after one uncertain retirement while healthy siblings can retire", async () => {
    const f = await fixture();
    const a = await f.open(f.prepare().ticket),
      b = await f.open(f.prepare().ticket);
    f.native[0]!.retire.mockResolvedValue(false);
    expect((await f.host.retire(f.window, a.leaseId)).state).toBe("quarantined");
    expect(f.host.capabilities()).toMatchObject({ available: false, reason: "quarantined" });
    expect(f.prepare().result.status).toBe("blocked");
    expect(await f.host.preview(f.owner, source)).toMatchObject({ status: "blocked" });
    expect((await f.host.retire(f.window, b.leaseId)).state).toBe("retired");
    expect(f.host.diagnostics()).toMatchObject({ viewerCount: 1, activeCount: 1 });
  });
  it("counts actual escaped encoded envelopes across live and prepared records", async () => {
    const f = await fixture();
    const large = {
      ...source,
      html: "\\".repeat(512 * 1024),
      assets: [{ id: "bounded", mime: "image/png" as const, base64: "A".repeat(8 * 1024 * 1024) }],
    };
    for (let index = 0; index < 4; index += 1)
      expect((await f.open(f.prepare(large).ticket)).state).toBe("active");
    const prepared = Array.from({ length: 3 }, () => f.prepare(large));
    expect(prepared.every((value) => value.result.status === "ready")).toBe(true);
    expect(f.prepare(large).result).toMatchObject({ status: "blocked", reason: "busy" });
    expect(f.host.diagnostics().retainedInputBytes).toBeLessThanOrEqual(
      VISUALIZATION_HOST_MAX_INPUT_BYTES,
    );
    expect(f.host.diagnostics().retainedInputBytes).toBeGreaterThan(63 * 1024 * 1024);
    expect(await f.host.preview(f.owner, large)).toMatchObject({
      status: "blocked",
      reason: "busy",
    });
    expect(f.host.discardPrepared(prepared[0]!.ticket).discarded).toBe(true);
    expect(f.prepare(large).result.status).toBe("ready");
  });
  it("serializes heavy native capture without multiplying raster copies", async () => {
    const f = await fixture();
    const a = await f.open(f.prepare().ticket),
      b = await f.open(f.prepare().ticket);
    const gate = deferred<{ png: Uint8Array; width: number; height: number }>();
    f.native[0]!.capture.mockImplementation(() => gate.promise);
    const first = f.host.capture(f.window, a.leaseId),
      second = f.host.capture(f.window, b.leaseId);
    await Promise.resolve();
    expect(f.native[0]!.capture).toHaveBeenCalledOnce();
    expect(f.native[1]!.capture).not.toHaveBeenCalled();
    gate.resolve({ png: new Uint8Array([1]), width: 400, height: 200 });
    expect(await first).not.toBeNull();
    expect(await second).not.toBeNull();
    expect(f.native[1]!.capture).toHaveBeenCalledOnce();
  });
  it("returns only one-use visibility-owned continuation for exact yielded source/window", async () => {
    const f = await fixture();
    const first = f.prepare(),
      state = await f.open(first.ticket);
    const yielded = await f.host.yield(f.window, state.leaseId);
    expect(yielded).toMatchObject({ state: "retired", expiresAtMs: state.expiresAtMs });
    expect(yielded.continuation).toMatch(/^[a-f0-9]{64}$/);
    expect(f.host.diagnostics()).toMatchObject({ retainedInputBytes: 0, continuationCount: 1 });
    const wrong = f.prepare({ ...source, html: "<p>other source</p>" });
    expect((await f.open(wrong.ticket, { continuation: yielded.continuation })).reason).toBe(
      "owner-revoked",
    );
    f.host.discardPrepared(wrong.ticket);
    const resumed = await f.open(f.prepare().ticket, { continuation: yielded.continuation });
    expect(resumed).toMatchObject({ state: "active", expiresAtMs: state.expiresAtMs });
    expect(resumed.leaseId).not.toBe(state.leaseId);
    expect((await f.open(f.prepare().ticket, { continuation: yielded.continuation })).reason).toBe(
      "owner-revoked",
    );
    expect(f.host.diagnostics().continuationCount).toBe(0);
  });
  it("reserves continuation metadata before concurrent retirement awaits", async () => {
    const f = await fixture();
    for (let index = 0; index < 3; index += 1) {
      const state = await f.open(f.prepare().ticket);
      expect((await f.host.yield(f.window, state.leaseId)).continuation).toBeDefined();
    }
    const a = await f.open(f.prepare().ticket),
      b = await f.open(f.prepare().ticket);
    const gate = deferred<boolean>();
    f.native[3]!.retire.mockImplementation(() => gate.promise);
    const first = f.host.yield(f.window, a.leaseId);
    const refused = await f.host.yield(f.window, b.leaseId);
    expect(refused.state).toBe("blocked");
    expect(refused.continuation).toBeUndefined();
    gate.resolve(true);
    expect((await first).continuation).toBeDefined();
    expect(f.host.diagnostics().continuationCount).toBe(4);
  });
  it("expires unused continuation tokens without adding a generated lifetime maximum", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const state = await f.open(f.prepare().ticket);
    const yielded = await f.host.yield(f.window, state.leaseId);
    await vi.advanceTimersByTimeAsync(VISUALIZATION_HOST_TICKET_MS);
    expect((await f.open(f.prepare().ticket, { continuation: yielded.continuation })).reason).toBe(
      "owner-revoked",
    );
    expect(f.host.diagnostics().continuationCount).toBe(0);
    const current = await f.open(f.prepare().ticket);
    const fresh = await f.host.yield(f.window, current.leaseId);
    const resumed = await f.open(f.prepare().ticket, { continuation: fresh.continuation });
    expect(resumed.expiresAtMs).toBe(state.expiresAtMs);
    expect(resumed.expiresAtMs).toBeNull();
    await f.host.update(f.window, {
      leaseId: resumed.leaseId,
      bounds,
      visible: true,
      appearance: "light",
    });
    await vi.advanceTimersByTimeAsync(VISUALIZATION_HOST_ACTIVE_MS * 2);
    expect(f.host.capacity().viewerCount).toBe(1);
  });
  it("hides the same document during finite geometry transition and refuses renewal", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const prepared = f.prepare({ ...source, kind: "mcp-app" }),
      state = await f.open(prepared.ticket);
    const generation = f.host.inspect(prepared.ticket, state.leaseId)!.documentGeneration;
    expect(f.host.beginTransition(f.window, state.leaseId)).toBe(true);
    expect(f.host.beginTransition(f.window, state.leaseId)).toBe(false);
    expect(f.host.inspect(prepared.ticket, state.leaseId)?.state).toBe("suspended");
    expect(f.host.send(f.window, state.leaseId, "{}")).toBe(false);
    expect(
      (
        await f.host.update(f.window, {
          leaseId: state.leaseId,
          bounds,
          visible: true,
          appearance: "light",
          displayMode: "fullscreen",
          focus: true,
        })
      ).state,
    ).toBe("active");
    expect(f.host.inspect(prepared.ticket, state.leaseId)).toMatchObject({
      state: "active",
      documentGeneration: generation,
    });
    expect(f.native[0]!.suspend.mock.calls).toEqual([[true], [false]]);
    expect(f.host.beginTransition(f.window, state.leaseId)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.host.inspect(prepared.ticket, state.leaseId)).toBeNull();
  });
  it("observes finite capacity only for the exact trusted window/frame", async () => {
    const f = await fixture();
    expect(f.host.observeCapacity(f.window, true, randomUUID(), 1)).toBe(true);
    const value = f.prepare();
    expect(f.window.webContents.send).toHaveBeenCalledWith(
      "desktop:visualization-capacity-changed",
      expect.objectContaining({ preparedCount: 1, freePreparations: 3 }),
    );
    const frame = f.window.webContents.mainFrame as unknown as { frameToken: string };
    frame.frameToken = randomUUID();
    vi.mocked(f.window.webContents.send).mockClear();
    f.host.discardPrepared(value.ticket);
    expect(f.window.webContents.send).not.toHaveBeenCalled();
  });
  it("refuses late capacity observation teardown/revival across registration generations", async () => {
    const f = await fixture(),
      first = randomUUID(),
      next = randomUUID();
    expect(f.host.observeCapacity(f.window, true, first, 1)).toBe(true);
    expect(f.host.observeCapacity(f.window, false, first, 1)).toBe(true);
    expect(f.host.observeCapacity(f.window, true, first, 1)).toBe(false);
    expect(f.host.observeCapacity(f.window, true, next, 3)).toBe(true);
    expect(f.host.observeCapacity(f.window, false, first, 1)).toBe(false);
    f.prepare();
    expect(f.window.webContents.send).toHaveBeenCalledWith(
      "desktop:visualization-capacity-changed",
      expect.any(Object),
    );
  });
  it("never mints a continuation after revoke or shutdown races its exact yield", async () => {
    for (const close of [false, true]) {
      const f = await fixture(),
        state = await f.open(f.prepare().ticket),
        gate = deferred<boolean>();
      f.native[0]!.retire.mockImplementation(() => gate.promise);
      const yielded = f.host.yield(f.window, state.leaseId);
      const revocation = close ? f.host.close() : f.host.revoke(f.owner);
      gate.resolve(true);
      await revocation;
      expect((await yielded).continuation).toBeUndefined();
      expect(f.host.diagnostics().continuationCount).toBe(0);
    }
  });
});
