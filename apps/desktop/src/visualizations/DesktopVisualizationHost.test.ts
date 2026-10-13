import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Electron from "electron";
import { requestVisualizationHost } from "@cafecode/shared/visualizationHostClient";
import {
  VISUALIZATION_HOST_ACTIVE_MS,
  VISUALIZATION_HOST_PREVIEW_MS,
  VISUALIZATION_HOST_SUSPEND_MS,
  type VisualizationHostDocument,
  type VisualizationHostOwner,
} from "@cafecode/contracts/visualizationHost";
import { DesktopVisualizationHost } from "./DesktopVisualizationHost.ts";
import type {
  VisualizationSurface,
  VisualizationSurfaceOptions,
} from "./ElectronVisualizationSurface.ts";

vi.mock("electron", () => ({}));
const document: VisualizationHostDocument = {
  kind: "generated",
  html: "<p>private source sentinel</p>",
  assets: [],
  width: 400,
  height: 200,
  appearance: "dark",
};
const owner: VisualizationHostOwner = {
  environmentId: "fixture-environment",
  threadId: "fixture-thread",
  operationId: randomUUID(),
};
const consentId = randomUUID();
const bounds = { x: 10, y: 30, width: 400, height: 200 };
const hosts: DesktopVisualizationHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  vi.useRealTimers();
});

function windowFixture() {
  const window = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      mainFrame: { frameToken: "trusted-document", url: "cafecode://app/chat" },
      send: vi.fn(),
    },
  };
  return window as unknown as Electron.BrowserWindow;
}
async function fixture(options?: {
  retire?: boolean;
  initialize?: () => Promise<void>;
  installSource?: () => Promise<void>;
  now?: () => number;
  kind?: "generated" | "mcp-app";
}) {
  const surfaces: (VisualizationSurface & { calls: ReturnType<typeof vi.fn> })[] = [];
  const callbacks: VisualizationSurfaceOptions[] = [];
  const host = new DesktopVisualizationHost({
    stateDirectory: "unused-without-publication",
    preloadPath: "unused-injected-preload",
    ...(options?.now ? { now: options.now } : {}),
    createSurface: (input) => {
      callbacks.push(input);
      let current = true;
      const calls = vi.fn();
      const surface: VisualizationSurface & { calls: ReturnType<typeof vi.fn> } = {
        generation: randomUUID(),
        calls,
        initialize: options?.initialize ?? (async () => {}),
        installSource: async () => {
          calls("source");
          await options?.installSource?.();
        },
        isCurrent: () => current,
        capture: async () => ({ png: new Uint8Array([1, 2, 3]), width: 400, height: 200 }),
        update: () => {
          calls("update");
          return current;
        },
        suspend: () => true,
        send: () => current,
        retire: async () => {
          calls("retire");
          current = false;
          return options?.retire ?? true;
        },
      };
      surfaces.push(surface);
      return surface;
    },
  });
  hosts.push(host);
  const connection = await host.listen(false);
  const window = windowFixture();
  const ticket = "a".repeat(64);
  const input = { ticket, owner, document: { ...document, kind: options?.kind ?? "generated" } };
  expect(host.prepare(input).status).toBe("ready");
  return {
    host,
    connection,
    window,
    ticket,
    input,
    surfaces,
    callbacks,
    open: () => host.open(window, { ticket, bounds, appearance: "dark" }),
  };
}

describe("main-owned visualization leases", () => {
  it("passes full CSS viewport and separate visible clip only to the exact admitted surface", async () => {
    const f = await fixture();
    const clipBounds = { x: 10, y: 60, width: 300, height: 100 };
    const opened = await f.host.open(f.window, {
      ticket: f.ticket,
      bounds,
      clipBounds,
      appearance: "dark",
    });
    expect(opened.state).toBe("active");
    expect(f.callbacks[0]).toMatchObject({ bounds, clipBounds });
    const update = vi.spyOn(f.surfaces[0]!, "update");
    const changedClip = { ...clipBounds, height: 80 };
    await f.host.update(f.window, {
      leaseId: opened.leaseId,
      bounds,
      clipBounds: changedClip,
      visible: true,
      appearance: "dark",
    });
    expect(update).toHaveBeenCalledExactlyOnceWith(
      bounds,
      "dark",
      undefined,
      undefined,
      changedClip,
      false,
    );
  });
  it("separates active open admission from an exact acknowledged visibility update", async () => {
    const f = await fixture();
    const state = await f.open();
    expect(state.state).toBe("active");
    expect(f.surfaces[0]!.calls).not.toHaveBeenCalledWith("update");
    const input = { leaseId: state.leaseId, bounds, visible: true, appearance: "light" as const };
    expect((await f.host.update(windowFixture(), input)).state).toBe("blocked");
    expect((await f.host.update(f.window, { ...input, leaseId: randomUUID() })).state).toBe(
      "blocked",
    );
    expect(f.surfaces[0]!.calls).not.toHaveBeenCalledWith("update");
    expect((await f.host.update(f.window, input)).state).toBe("active");
    expect(f.surfaces[0]!.calls).toHaveBeenCalledWith("update");
  });
  it("refuses a delayed visibility commit after the pending owner was revoked", async () => {
    const f = await fixture();
    const state = await f.open();
    f.callbacks[0]!.onRevoked();
    expect(
      (
        await f.host.update(f.window, {
          leaseId: state.leaseId,
          bounds,
          visible: true,
          appearance: "light",
        })
      ).state,
    ).toBe("blocked");
    expect(f.surfaces[0]!.calls).not.toHaveBeenCalledWith("update");
    expect(f.host.inspect(f.ticket, state.leaseId)).toBeNull();
  });
  it("consumes a private ticket once and binds the exact current native document", async () => {
    const f = await fixture();
    const state = await f.open();
    expect(state.state).toBe("active");
    expect(f.host.inspect(f.ticket, state.leaseId)?.documentGeneration).toBe(
      f.surfaces[0]!.generation,
    );
    expect((await f.open()).state).toBe("blocked");
    expect(f.host.inspect("b".repeat(64), state.leaseId)).toBeNull();
    expect(await f.host.capture(windowFixture(), state.leaseId)).toBeNull();
    expect((await f.host.retire(windowFixture(), state.leaseId)).state).toBe("blocked");
    expect((await f.host.retire(f.window, state.leaseId)).state).toBe("retired");
    expect(f.host.inspect(f.ticket, state.leaseId)).toBeNull();
    expect(f.host.prepare(f.input)).toMatchObject({ status: "blocked", reason: "busy" });
  });
  it("changes only bounds/presentation when expanding the same admitted host", async () => {
    const f = await fixture();
    const state = await f.open();
    const generation = f.host.inspect(f.ticket, state.leaseId)!.documentGeneration;
    await f.host.update(f.window, {
      leaseId: state.leaseId,
      bounds: { x: 0, y: 0, width: 1200, height: 800 },
      visible: true,
      appearance: "light",
    });
    expect(f.surfaces).toHaveLength(1);
    expect(f.host.inspect(f.ticket, state.leaseId)!.documentGeneration).toBe(generation);
    expect(f.surfaces[0]!.calls).toHaveBeenCalledWith("update");
  });
  it("preserves the finite absolute external App lease", async () => {
    vi.useFakeTimers();
    const f = await fixture({ kind: "mcp-app" });
    const state = await f.open();
    await vi.advanceTimersByTimeAsync(VISUALIZATION_HOST_ACTIVE_MS - 10);
    await f.host.update(f.window, {
      leaseId: state.leaseId,
      bounds,
      visible: true,
      appearance: "light",
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(f.host.inspect(f.ticket, state.leaseId)).toBeNull();
    expect(f.surfaces[0]!.calls).toHaveBeenCalledWith("retire");
  });
  it("keeps generated source identity beyond five minutes and retires only its offscreen owner", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const state = await f.open();
    const generation = f.host.inspect(f.ticket, state.leaseId)!.documentGeneration;
    expect(state.expiresAtMs).toBeNull();
    expect(f.host.capabilities()).toMatchObject({ generatedLifecycle: "visible" });
    await f.host.update(f.window, {
      leaseId: state.leaseId,
      bounds,
      visible: true,
      appearance: "dark",
    });
    await vi.advanceTimersByTimeAsync(VISUALIZATION_HOST_ACTIVE_MS * 2);
    expect(
      (
        await f.host.update(f.window, {
          leaseId: state.leaseId,
          bounds,
          clipBounds: { ...bounds, height: 40 },
          visible: true,
          appearance: "dark",
        })
      ).state,
    ).toBe("active");
    expect(f.host.inspect(f.ticket, state.leaseId)).toMatchObject({
      documentGeneration: generation,
      expiresAtMs: null,
    });
    expect(await f.host.capture(f.window, state.leaseId)).not.toBeNull();
    expect(f.surfaces).toHaveLength(1);
    expect(f.surfaces[0]!.calls).not.toHaveBeenCalledWith("retire");
    expect(
      (
        await f.host.update(f.window, {
          leaseId: state.leaseId,
          bounds,
          visible: false,
          appearance: "dark",
        })
      ).state,
    ).toBe("retired");
    expect(f.host.inspect(f.ticket, state.leaseId)).toBeNull();
  });
  it("retires an uncommitted generated document at the original absolute startup budget", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const state = await f.open();
    await vi.advanceTimersByTimeAsync(VISUALIZATION_HOST_PREVIEW_MS - 1);
    expect(f.host.inspect(f.ticket, state.leaseId)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.host.inspect(f.ticket, state.leaseId)).toBeNull();
    expect(f.surfaces[0]!.calls).toHaveBeenCalledWith("retire");
    expect(
      (
        await f.host.update(f.window, {
          leaseId: state.leaseId,
          bounds,
          visible: true,
          appearance: "dark",
        })
      ).state,
    ).toBe("blocked");
  });
  it("rejects late first presentation without waiting for the cleanup timer to run", async () => {
    let now = 0;
    const f = await fixture({ now: () => now });
    const state = await f.open();
    now = VISUALIZATION_HOST_PREVIEW_MS;
    expect(
      (
        await f.host.update(f.window, {
          leaseId: state.leaseId,
          bounds,
          visible: true,
          appearance: "dark",
        })
      ).state,
    ).toBe("retired");
    expect(f.surfaces[0]!.calls).not.toHaveBeenCalledWith("update");
    expect(f.surfaces[0]!.calls).toHaveBeenCalledWith("retire");
    expect(f.host.inspect(f.ticket, state.leaseId)).toBeNull();
  });
  it("reobserves pending generated source membership, owner and absolute budget before parsing", async () => {
    let now = 0,
      entered!: () => void,
      release!: () => void;
    const installing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      now: () => now,
      installSource: async () => {
        entered();
        await held;
      },
    });
    const opening = f.open();
    await installing;
    const admit = f.callbacks[0]!.admitGeneratedSource!;
    expect(admit()).toBe(true);
    const frame = f.window.webContents.mainFrame as unknown as { frameToken: string; url: string };
    frame.frameToken = "replacement";
    expect(admit()).toBe(false);
    frame.frameToken = "trusted-document";
    frame.url = "cafecode://app/replacement";
    expect(admit()).toBe(false);
    frame.url = "cafecode://app/chat";
    expect(admit()).toBe(true);
    // Advance the injected monotonic observation without running timer cleanup.
    // Loaded fonts still cannot authorize parsing at this exact spent deadline.
    now = VISUALIZATION_HOST_PREVIEW_MS;
    expect(admit()).toBe(false);
    release();
    expect(await opening).toMatchObject({ state: "blocked", reason: "timeout" });
    expect(admit()).toBe(false);
    expect(f.surfaces[0]!.calls).toHaveBeenCalledWith("retire");
  });
  it("never retains pending generated font authority after revocation or quarantine", async () => {
    let entered!: () => void, release!: () => void;
    const installing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({
      retire: false,
      installSource: async () => {
        entered();
        await held;
      },
    });
    const opening = f.open();
    await installing;
    const admit = f.callbacks[0]!.admitGeneratedSource!;
    expect(admit()).toBe(true);
    f.callbacks[0]!.onRevoked();
    expect(admit()).toBe(false);
    release();
    await opening;
    expect(admit()).toBe(false);
    expect(f.host.capabilities()).toMatchObject({ available: false, reason: "quarantined" });
    const app = await fixture({ kind: "mcp-app" });
    await app.open();
    expect(app.callbacks[0]!.admitGeneratedSource).toBeUndefined();
  });
  it.each(["initialize", "installSource"] as const)(
    "rejects a %s acknowledgement after the absolute startup origin",
    async (phase) => {
      let now = 0;
      const f = await fixture({
        now: () => now,
        [phase]: async () => {
          now = VISUALIZATION_HOST_PREVIEW_MS + 1;
        },
      });
      expect(await f.open()).toMatchObject({
        state: "blocked",
        reason: "timeout",
        expiresAtMs: null,
      });
      expect(f.surfaces[0]!.calls).toHaveBeenCalledWith("retire");
      expect(f.surfaces[0]!.calls).toHaveBeenCalledTimes(phase === "initialize" ? 1 : 2);
    },
  );
  it("does not return late pixels after a finite App or uncommitted startup deadline", async () => {
    for (const kind of ["generated", "mcp-app"] as const) {
      let now = 0;
      const f = await fixture({ now: () => now, kind });
      const state = await f.open();
      const capture = vi.fn(async () => {
        now = kind === "generated" ? VISUALIZATION_HOST_PREVIEW_MS : VISUALIZATION_HOST_ACTIVE_MS;
        return { png: new Uint8Array([1, 2, 3]), width: 400, height: 200 };
      });
      f.surfaces[0]!.capture = capture;
      expect(await f.host.capture(f.window, state.leaseId)).toBeNull();
      expect(capture).toHaveBeenCalledOnce();
      expect(await f.host.capture(f.window, state.leaseId)).toBeNull();
      expect(capture).toHaveBeenCalledOnce();
    }
  });
  it("hides only exact generated presentation and denies capture/focus without renewing authority", async () => {
    const f = await fixture();
    const state = await f.open();
    f.surfaces[0]!.hidePresentation = vi.fn(() => true);
    f.surfaces[0]!.focus = vi.fn(() => true);
    const generation = f.host.inspect(f.ticket, state.leaseId)!.documentGeneration;
    const input = {
      leaseId: state.leaseId,
      bounds,
      visible: true,
      appearance: "dark" as const,
      presentationHidden: true,
    };
    expect((await f.host.update(windowFixture(), input)).state).toBe("blocked");
    expect((await f.host.update(f.window, input)).state).toBe("active");
    expect(f.host.inspect(f.ticket, state.leaseId)).toMatchObject({
      state: "suspended",
      expiresAtMs: null,
      documentGeneration: generation,
    });
    expect(await f.host.capture(f.window, state.leaseId)).toBeNull();
    expect(f.host.focus(f.window, state.leaseId)).toBe(false);
    expect((await f.host.update(f.window, { ...input, presentationHidden: false })).state).toBe(
      "active",
    );
    expect(f.host.inspect(f.ticket, state.leaseId)).toMatchObject({
      state: "active",
      documentGeneration: generation,
    });
    const app = await fixture({ kind: "mcp-app" });
    const appState = await app.open();
    app.surfaces[0]!.hidePresentation = vi.fn(() => true);
    expect((await app.host.update(app.window, { ...input, leaseId: appState.leaseId })).state).toBe(
      "retired",
    );
    expect(app.surfaces[0]!.hidePresentation).not.toHaveBeenCalled();
  });
  it("refuses actions from a same-URL replacement document", async () => {
    const f = await fixture();
    const state = await f.open();
    const frame = f.window.webContents.mainFrame as unknown as { frameToken: string };
    frame.frameToken = "replacement";
    expect(await f.host.capture(f.window, state.leaseId)).toBeNull();
    expect(f.host.send(f.window, state.leaseId, '{"method":"ping"}')).toBe(false);
    expect(
      (
        await f.host.update(f.window, {
          leaseId: state.leaseId,
          bounds,
          visible: true,
          appearance: "light",
        })
      ).state,
    ).toBe("blocked");
  });
  it("holds a quarantined lane after inconclusive native retirement", async () => {
    const f = await fixture({ retire: false });
    const state = await f.open();
    expect((await f.host.retire(f.window, state.leaseId)).state).toBe("quarantined");
    expect(f.host.capabilities()).toMatchObject({ available: false, reason: "quarantined" });
    expect(await f.host.preview(owner, document)).toMatchObject({ status: "blocked" });
    expect(f.surfaces).toHaveLength(1);
  });
  it("revokes response authority before uncertain cleanup finishes", async () => {
    const f = await fixture({ retire: false });
    const state = await f.open();
    f.callbacks[0]!.onRevoked();
    expect(f.host.inspect(f.ticket, state.leaseId)).toBeNull();
    expect(f.host.send(f.window, state.leaseId, '{"method":"ping"}')).toBe(false);
  });
  it("permits a bounded Apps consent suspension but never hidden new requests", async () => {
    vi.useFakeTimers();
    const f = await fixture({ kind: "mcp-app" });
    const state = await f.open();
    expect(f.host.suspend(f.window, state.leaseId, true, consentId)).toBe(true);
    expect(f.host.inspect(f.ticket, state.leaseId)).toMatchObject({ state: "suspended" });
    expect(f.host.send(f.window, state.leaseId, '{"method":"tools/call"}')).toBe(false);
    expect(await f.host.capture(f.window, state.leaseId)).toBeNull();
    f.callbacks[0]!.onMessage('{"method":"tools/call"}');
    expect(f.window.webContents.send).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ state: "message" }),
    );
    expect(f.host.suspend(f.window, state.leaseId, false, consentId)).toBe(true);
    expect(f.host.suspend(f.window, state.leaseId, true, consentId)).toBe(false);
    expect(f.host.send(f.window, state.leaseId, '{"method":"ping"}')).toBe(true);
  });
  it("retires an unanswered suspension after its nonrenewable deadline", async () => {
    vi.useFakeTimers();
    const f = await fixture({ kind: "mcp-app" });
    const state = await f.open();
    f.host.suspend(f.window, state.leaseId, true, consentId);
    await vi.advanceTimersByTimeAsync(VISUALIZATION_HOST_SUSPEND_MS);
    expect(f.host.inspect(f.ticket, state.leaseId)).toBeNull();
  });
  it("permits fresh sequential consents while refusing replayed or mismatched consent identities", async () => {
    vi.useFakeTimers();
    const f = await fixture({ kind: "mcp-app" });
    const state = await f.open();
    const next = randomUUID();
    expect(f.host.suspend(f.window, state.leaseId, true, consentId)).toBe(true);
    expect(f.host.suspend(f.window, state.leaseId, false, next)).toBe(false);
    expect(f.host.suspend(f.window, state.leaseId, true, next)).toBe(false);
    expect(f.host.suspend(f.window, state.leaseId, false, consentId)).toBe(true);
    expect(f.host.suspend(f.window, state.leaseId, true, next)).toBe(true);
    expect(f.host.suspend(f.window, state.leaseId, false, consentId)).toBe(false);
    expect(f.host.suspend(f.window, state.leaseId, false, next)).toBe(true);
    expect(f.host.suspend(f.window, state.leaseId, true, next)).toBe(false);
    expect(f.host.inspect(f.ticket, state.leaseId)?.expiresAtMs).toBe(state.expiresAtMs);
  });
  it("cannot renew a pending consent with another identity or extend the absolute document lease", async () => {
    vi.useFakeTimers();
    const f = await fixture({ kind: "mcp-app" });
    const state = await f.open();
    expect(f.host.suspend(f.window, state.leaseId, true, consentId)).toBe(true);
    await vi.advanceTimersByTimeAsync(VISUALIZATION_HOST_SUSPEND_MS - 1);
    expect(f.host.suspend(f.window, state.leaseId, true, randomUUID())).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.host.inspect(f.ticket, state.leaseId)).toBeNull();
    const g = await fixture({ kind: "mcp-app" });
    const other = await g.open();
    await vi.advanceTimersByTimeAsync(VISUALIZATION_HOST_ACTIVE_MS - 1);
    expect(g.host.suspend(g.window, other.leaseId, true, randomUUID())).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(g.host.inspect(g.ticket, other.leaseId)).toBeNull();
  });
  it("returns exact quarantine truth on failed admission and survives lost event delivery", async () => {
    const f = await fixture({
      retire: false,
      initialize: async () => {
        throw new Error("private native failure");
      },
    });
    const send = f.window.webContents.send as ReturnType<typeof vi.fn>;
    send.mockImplementation(() => {
      throw new Error("lost native document");
    });
    const state = await f.open();
    expect(state).toMatchObject({ state: "quarantined", reason: "retirement-uncertain" });
    expect(f.host.capabilities().reason).toBe("quarantined");
    expect((await f.open()).state).toBe("blocked");
  });
  it("does not grant generated documents Apps relay or consent suspension", async () => {
    const f = await fixture();
    const state = await f.open();
    expect(f.host.suspend(f.window, state.leaseId, true, consentId)).toBe(false);
    expect(f.host.send(f.window, state.leaseId, '{"method":"ping"}')).toBe(false);
  });
  it("refuses duplicate/replacement private preparation and expires stale tickets", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    expect(f.host.prepare(f.input)).toMatchObject({ status: "blocked", reason: "busy" });
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await f.open()).state).toBe("blocked");
    expect(f.surfaces).toHaveLength(0);
  });
  it("returns preview bytes only after observed retirement and refuses uncertain capture success", async () => {
    const f = await fixture({ retire: false });
    expect(await f.host.preview(owner, document)).toEqual({
      status: "blocked",
      reason: "retirement-uncertain",
    });
    expect(f.host.capabilities().reason).toBe("quarantined");
  });
  it("privately initializes and replays exact App poster data without a renderer or action broker", async () => {
    const sent: {
      method?: string;
      id?: number;
      result?: unknown;
      params?: unknown;
      error?: unknown;
    }[] = [];
    let retired = false;
    const host = new DesktopVisualizationHost({
      stateDirectory: "unused-without-publication",
      preloadPath: "unused-injected-preload",
      createSurface: (input) => ({
        generation: randomUUID(),
        initialize: async () => {},
        isCurrent: () => !retired,
        installSource: async () =>
          input.onMessage(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "ui/initialize",
              params: {
                protocolVersion: "2026-01-26",
                appInfo: { name: "fixture", version: "1" },
                appCapabilities: {},
              },
            }),
          ),
        send: (json) => {
          const value = JSON.parse(json) as (typeof sent)[number];
          sent.push(value);
          if (value.id === 1 && value.result) {
            input.onMessage('{"jsonrpc":"2.0","method":"ui/notifications/initialized"}');
            input.onMessage(
              '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"never","arguments":{}}}',
            );
          }
          return !retired;
        },
        capture: async () => {
          expect(sent.filter((value) => value.method).map((value) => value.method)).toEqual([
            "ui/notifications/tool-input",
            "ui/notifications/tool-result",
          ]);
          expect(
            sent.find((value) => value.method === "ui/notifications/tool-input")?.params,
          ).toEqual({ arguments: { exact: "private input" } });
          expect(sent.find((value) => value.id === 2)?.error).toMatchObject({
            message: "Operation unavailable",
          });
          expect(host.diagnostics().retainedInputBytes).toBeGreaterThan(
            Buffer.byteLength(document.html),
          );
          return { png: new Uint8Array([1, 2, 3]), width: 400, height: 200 };
        },
        update: () => true,
        suspend: () => true,
        retire: async () => {
          retired = true;
          return true;
        },
      }),
    });
    hosts.push(host);
    await host.listen(false);
    const replay = {
      originalInputJson: '{"exact":"private input"}',
      originalResultJson: '{"content":[{"type":"text","text":"private result"}]}',
    };
    expect(await host.preview(owner, document, replay)).toEqual({
      status: "blocked",
      reason: "invalid",
    });
    expect(await host.preview(owner, { ...document, kind: "mcp-app" })).toEqual({
      status: "blocked",
      reason: "invalid",
    });
    expect(await host.preview(owner, { ...document, kind: "mcp-app" }, replay)).toMatchObject({
      status: "ready",
    });
    expect(retired).toBe(true);
    expect(host.diagnostics().retainedInputBytes).toBe(0);
  });
  it("binds operation revocation exactly and preserves another owner's ticket", async () => {
    const f = await fixture();
    await f.host.revoke({ ...owner, operationId: randomUUID() });
    const state = await f.open();
    expect(state.state).toBe("active");
    await f.host.revoke(owner);
    expect(f.host.inspect(f.ticket, state.leaseId)).toBeNull();
  });
  it("authenticates broker generation and rejects source/selector extras without echoing private bytes", async () => {
    const f = await fixture();
    const denied = await fetch(f.connection.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${"b".repeat(64)}` },
      body: JSON.stringify({ source: document.html }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("private source sentinel");
    expect(
      await requestVisualizationHost(f.connection, "prepareViewer", {
        ...f.input,
        path: "/private/secret",
      }),
    ).toEqual({ status: "blocked", reason: "invalid" });
    await expect(
      requestVisualizationHost({ ...f.connection, generation: randomUUID() }, "inspectViewer", {
        ticket: f.ticket,
        leaseId: randomUUID(),
      }),
    ).rejects.toThrow("Visualization host request was refused.");
    const nonAscii = await fetch(f.connection.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${"é".repeat(64)}` },
      body: "{}",
    });
    expect(nonAscii.status).toBe(403);
    const nested = await fetch(f.connection.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${f.connection.token}` },
      body: "[".repeat(17) + "0" + "]".repeat(17),
    });
    expect(nested.status).toBe(400);
    expect(
      await requestVisualizationHost(f.connection, "inspectViewer", {
        ticket: f.ticket,
        leaseId: randomUUID(),
      }),
    ).toBeNull();
  });
  it("publishes bounded counts without retaining private diagnostics", async () => {
    const f = await fixture();
    const before = f.host.diagnostics();
    expect(before).toMatchObject({
      activeCount: 0,
      pendingViewerCount: 1,
      retainedInputBytes: Buffer.byteLength(JSON.stringify(f.input), "utf8"),
    });
    const state = await f.open();
    expect(f.host.diagnostics().activeCount).toBe(1);
    await f.host.retire(f.window, state.leaseId);
    const after = f.host.diagnostics();
    expect(after).toMatchObject({
      activeCount: 0,
      pendingViewerCount: 0,
      retainedInputBytes: 0,
      retirementCount: 1,
    });
    expect(JSON.stringify(after)).not.toContain("private");
    expect(JSON.stringify(after)).not.toContain(f.ticket);
  });
});
