import { randomUUID } from "node:crypto";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { VisualizationSurfaceDiagnostics } from "./visualizationDiagnostics.ts";

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
let retireBrokerRequests: (() => Promise<void>) | undefined;
let brokerFinalization: Promise<void> | undefined;
const encodeBrokerPhases = Schema.encodeSync(Schema.UnknownFromJsonString);
const nativeSnapshot = (
  phase: VisualizationSurfaceDiagnostics["phase"],
): VisualizationSurfaceDiagnostics => ({
  phase,
  rejection: "none",
  exclusiveProcess: true,
  frameCount: 1,
  rendererCount: 1,
  gone: false,
  destroyed: false,
  watchdogArmed: false,
  heartbeatMissed: false,
  assetBytes: 0,
  requestCount: 1,
  servedBytes: 68,
  captureOutcome: "not-attempted",
  captureWidth: 0,
  captureHeight: 0,
  geometryOutcome: "full",
  viewportWidth: 400,
  viewportHeight: 200,
  clipWidth: 400,
  clipHeight: 200,
  ownerZoom: 1,
  nativeVisibility: "hidden",
  visibilityHintSent: "not-sent",
  visibilityCommitted: false,
  layoutHeight: 0,
  layoutConstrained: false,
  layoutSequence: 0,
  layoutPublications: 0,
  layoutRefusals: 0,
  layoutRefusal: "none",
});
beforeEach(() => {
  // A timed-out cleanup may still own native requests. Never reset/create a
  // successor fixture until that exact owner and its host have actually joined.
  if (retireBrokerRequests) throw new Error("Previous broker request owner is still retiring");
});
afterEach(async () => {
  const retirement = retireBrokerRequests;
  const closeHosts = async () => {
    try {
      for (const host of hosts.splice(0)) await host.close();
    } finally {
      vi.useRealTimers();
    }
  };
  if (!retirement) {
    await closeHosts();
    return;
  }
  // If an earlier hook expired, every later hook joins this same completion;
  // an empty second splice must not release admission while host.close awaits.
  brokerFinalization ??= Promise.resolve().then(async () => {
    try {
      await retirement();
    } finally {
      await closeHosts();
    }
  });
  const completion = brokerFinalization;
  await completion;
  // A rejected retirement/close is not proof that native ownership ended.
  // Keep its exact failed completion and admission fence rather than retrying.
  if (retireBrokerRequests === retirement && brokerFinalization === completion) {
    retireBrokerRequests = undefined;
    brokerFinalization = undefined;
  }
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
  createFailureAt?: number;
  capture?: VisualizationSurface["capture"];
}) {
  const surfaces: (VisualizationSurface & { calls: ReturnType<typeof vi.fn> })[] = [];
  const callbacks: VisualizationSurfaceOptions[] = [];
  const host = new DesktopVisualizationHost({
    stateDirectory: "unused-without-publication",
    preloadPath: "unused-injected-preload",
    ...(options?.now ? { now: options.now } : {}),
    createSurface: (input) => {
      callbacks.push(input);
      if (callbacks.length === options?.createFailureAt)
        throw new Error("private constructor source sentinel");
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
        capture:
          options?.capture ??
          (async () => ({ png: new Uint8Array([1, 2, 3]), width: 400, height: 200 })),
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
  it.each(["initialize", "installSource"] as const)(
    "classifies a synchronous %s rejection separately from an unspent deadline",
    async (stage) => {
      let inspected = 0;
      const opaque = new Error("private startup source sentinel");
      Object.defineProperty(opaque, "toJSON", {
        get: () => {
          inspected += 1;
          throw opaque;
        },
      });
      const f = await fixture({
        [stage]: async () => {
          throw opaque;
        },
      });
      expect(await f.open()).toMatchObject({
        state: "blocked",
        reason: "unavailable",
        expiresAtMs: null,
      });
      expect(f.host.diagnostics()).toMatchObject({
        failureCount: 1,
        lastFailure: {
          lane: "viewer",
          stage: stage === "installSource" ? "install" : stage,
          outcome: "exception",
          allowanceSpent: false,
        },
        retirementCount: 1,
        lastRetirementReason: "unavailable",
        quarantine: null,
      });
      expect(inspected).toBe(0);
      expect(JSON.stringify(f.host.diagnostics())).not.toMatch(
        /private|sentinel|fixture-thread|trusted-document/,
      );
      expect(f.host.capabilities()).toMatchObject({ available: true, reason: "ready" });
    },
  );
  it.each(["initialize", "installSource"] as const)(
    "preserves exact monotonic deadline equality after a %s exception",
    async (stage) => {
      let now = 0;
      const f = await fixture({
        now: () => now,
        [stage]: async () => {
          now = VISUALIZATION_HOST_PREVIEW_MS;
          throw new Error("private late exception sentinel");
        },
      });
      expect(await f.open()).toMatchObject({ state: "blocked", reason: "timeout" });
      expect(f.host.diagnostics()).toMatchObject({
        failureCount: 1,
        lastFailure: {
          stage: stage === "installSource" ? "install" : stage,
          outcome: "exception",
          allowanceSpent: true,
        },
        lastRetirementReason: "timeout",
        quarantine: null,
      });
    },
  );
  it("preserves a constructor quarantine after a healthy sibling later retires", async () => {
    const f = await fixture({ createFailureAt: 2 });
    const sibling = await f.open();
    f.surfaces[0]!.diagnostics = () => nativeSnapshot("retired");
    const nextTicket = "b".repeat(64);
    expect(
      f.host.prepare({
        ...f.input,
        ticket: nextTicket,
        owner: { ...owner, operationId: randomUUID() },
      }).status,
    ).toBe("ready");
    expect(
      await f.host.open(f.window, { ticket: nextTicket, bounds, appearance: "dark" }),
    ).toMatchObject({ state: "quarantined", reason: "retirement-uncertain" });
    const first = f.host.diagnostics();
    expect(first.quarantine).toEqual({
      stage: "create",
      reason: "create-failed",
      failure: { lane: "viewer", stage: "create", outcome: "exception", allowanceSpent: false },
      native: null,
    });
    expect(first).toMatchObject({
      activeCount: 2,
      viewerCount: 2,
      failureCount: 1,
      retirementCount: 0,
      native: null,
    });
    expect((await f.host.retire(f.window, sibling.leaseId)).state).toBe("retired");
    expect(f.host.diagnostics()).toMatchObject({
      activeCount: 1,
      viewerCount: 1,
      retirementCount: 1,
      lastRetirementReason: "owner-revoked",
      quarantine: first.quarantine,
      native: null,
    });
    expect(f.host.capabilities()).toMatchObject({ available: false, reason: "quarantined" });
    expect(JSON.stringify(f.host.diagnostics())).not.toMatch(
      /private|sentinel|fixture-thread|trusted-document/,
    );
  });
  it("preserves replaced-owner truth when a startup exception also reaches its old deadline", async () => {
    let now = 0;
    let frame: { frameToken: string };
    const f = await fixture({
      now: () => now,
      initialize: async () => {
        frame.frameToken = "replacement-owner";
        now = VISUALIZATION_HOST_PREVIEW_MS;
        throw new Error("private stale owner sentinel");
      },
    });
    frame = f.window.webContents.mainFrame as unknown as { frameToken: string };
    expect(await f.open()).toMatchObject({ state: "blocked", reason: "owner-revoked" });
    expect(f.host.diagnostics()).toMatchObject({
      failureCount: 0,
      lastFailure: null,
      quarantine: null,
      lastRetirementReason: "owner-revoked",
    });
    expect(JSON.stringify(f.host.diagnostics())).not.toContain("sentinel");
  });
  it("shows the exact quarantined viewer now while preserving its first scalar snapshot", async () => {
    const f = await fixture();
    const first = await f.open();
    const nextTicket = "b".repeat(64);
    expect(
      f.host.prepare({
        ...f.input,
        ticket: nextTicket,
        owner: { ...owner, operationId: randomUUID() },
      }).status,
    ).toBe("ready");
    const sibling = await f.host.open(f.window, { ticket: nextTicket, bounds, appearance: "dark" });
    let phase: VisualizationSurfaceDiagnostics["phase"] = "quarantined";
    f.surfaces[0]!.diagnostics = () => nativeSnapshot(phase);
    f.surfaces[1]!.diagnostics = () => ({
      ...nativeSnapshot("retired"),
      captureOutcome: "ready",
      captureWidth: 100,
      captureHeight: 80,
    });
    f.surfaces[0]!.retire = async () => false;
    expect((await f.host.retire(f.window, first.leaseId)).state).toBe("quarantined");
    const frozen = f.host.diagnostics().quarantine!;
    expect(frozen).toMatchObject({
      stage: "retire",
      reason: "retirement-uncertain",
      failure: { lane: "viewer", stage: "retire", outcome: "refused", allowanceSpent: false },
      native: { phase: "quarantined" },
    });
    phase = "retiring";
    expect((await f.host.retire(f.window, sibling.leaseId)).state).toBe("retired");
    expect(f.host.diagnostics()).toMatchObject({
      native: { phase: "retiring", captureOutcome: "not-attempted" },
      quarantine: frozen,
      lastRetirementReason: "owner-revoked",
      failureCount: 1,
    });
    Object.assign(frozen.native!, { phase: "active" });
    Object.assign(frozen.failure, { stage: "capture" });
    expect(f.host.diagnostics().quarantine).toMatchObject({
      failure: { stage: "retire" },
      native: { phase: "quarantined" },
    });
    expect(f.host.capabilities()).toMatchObject({ available: false, reason: "quarantined" });
  });
  it("classifies viewer capture exceptions without preserving opaque native causes", async () => {
    const f = await fixture();
    const state = await f.open();
    f.surfaces[0]!.capture = async () => {
      throw new Error("private capture source sentinel");
    };
    expect(await f.host.capture(f.window, state.leaseId)).toBeNull();
    expect(f.host.diagnostics()).toMatchObject({
      failureCount: 1,
      lastFailure: {
        lane: "viewer",
        stage: "capture",
        outcome: "exception",
        allowanceSpent: false,
      },
      quarantine: null,
    });
    expect(JSON.stringify(f.host.diagnostics())).not.toContain("sentinel");
  });
  it.each(["initialize", "installSource", "capture"] as const)(
    "classifies a private preview %s exception without claiming an elapsed deadline",
    async (stage) => {
      const f = await fixture({
        [stage]: async () => {
          throw new Error("private preview source sentinel");
        },
      });
      expect(await f.host.preview(owner, document)).toEqual({
        status: "blocked",
        reason: "unavailable",
      });
      expect(f.host.diagnostics()).toMatchObject({
        failureCount: 1,
        lastFailure: {
          lane: "preview",
          stage: stage === "installSource" ? "install" : stage,
          outcome: "exception",
          allowanceSpent: false,
        },
        quarantine: null,
      });
      expect(f.host.capabilities()).toMatchObject({ available: true, reason: "ready" });
      expect(JSON.stringify(f.host.diagnostics())).not.toContain("sentinel");
    },
  );
  it("rejects preview pixels exactly at the original monotonic deadline", async () => {
    let now = 0;
    const f = await fixture({
      now: () => now,
      capture: async () => {
        now = VISUALIZATION_HOST_PREVIEW_MS;
        return { png: new Uint8Array([1, 2, 3]), width: 400, height: 200 };
      },
    });
    expect(await f.host.preview(owner, document)).toEqual({ status: "blocked", reason: "timeout" });
    expect(f.host.diagnostics()).toMatchObject({
      failureCount: 1,
      lastFailure: { lane: "preview", stage: "capture", outcome: "deadline", allowanceSpent: true },
      quarantine: null,
    });
  });
  it("classifies an opaque retirement exception while preserving quarantine authority", async () => {
    const f = await fixture();
    const state = await f.open();
    f.surfaces[0]!.retire = async () => {
      throw new Error("private retirement source sentinel");
    };
    expect((await f.host.retire(f.window, state.leaseId)).state).toBe("quarantined");
    expect(f.host.diagnostics()).toMatchObject({
      failureCount: 1,
      lastFailure: { lane: "viewer", stage: "retire", outcome: "exception", allowanceSpent: false },
      quarantine: {
        stage: "retire",
        reason: "retirement-uncertain",
        failure: { stage: "retire", outcome: "exception" },
      },
    });
    expect(f.host.capabilities()).toMatchObject({ available: false, reason: "quarantined" });
    expect(JSON.stringify(f.host.diagnostics())).not.toContain("sentinel");
  });
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
  it("authenticates broker generation and rejects source/selector extras without echoing private bytes", async (context) => {
    const started = performance.now();
    type Phase =
      | "fixture-entered"
      | "fixture-ready"
      | "invalid-token-entered"
      | "invalid-token-complete"
      | "extra-source-entered"
      | "extra-source-complete"
      | "wrong-generation-entered"
      | "wrong-generation-complete"
      | "non-ascii-entered"
      | "non-ascii-complete"
      | "nested-entered"
      | "nested-complete"
      | "inspect-entered"
      | "inspect-complete"
      | "retirement-entered"
      | "retirement-complete";
    const phases: { phase: Phase; elapsedMs: number }[] = [];
    let retired = false;
    let observationsRetired = false;
    const mark = (phase: Phase) => {
      if (observationsRetired || phases.length >= 16) return;
      const elapsed = performance.now() - started;
      phases.push({
        phase,
        elapsedMs: Number.isFinite(elapsed)
          ? Math.max(0, Math.min(60_000, Math.round(elapsed)))
          : 0,
      });
    };
    context.onTestFailed(() => {
      try {
        process.stderr.write(`Synthetic broker request phases: ${encodeBrokerPhases(phases)}\n`);
      } catch {
        /* Preserve the original failure when diagnostic delivery is unavailable. */
      }
    });
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    const pending = new Set<Promise<unknown>>();
    const responses = new Set<Response>();
    const track = <T>(operation: Promise<T>): Promise<T> => {
      pending.add(operation);
      void operation.then(
        () => {
          pending.delete(operation);
        },
        () => {
          pending.delete(operation);
        },
      );
      return operation;
    };
    const assertActive = () => {
      if (retired || signal.aborted) throw new Error("Synthetic broker request owner retired");
    };
    const own = <T>(start: () => Promise<T>): Promise<T> => {
      assertActive();
      return track(
        (async () => {
          const result = await start();
          assertActive();
          return result;
        })(),
      );
    };
    const cancelResponses = async () => {
      await Promise.allSettled(
        [...responses].map(async (response) => {
          // The real client owns locked readers and awaits their cancellation in
          // its own finally. Unread refusal bodies otherwise need an exact owner.
          if (response.body && !response.body.locked) await response.body.cancel();
        }),
      );
    };
    let restoreFetch: (() => void) | undefined;
    let retirement: Promise<void> | undefined;
    const cleanup = (): Promise<void> => {
      if (retirement) return retirement;
      // Store the shared completion before synchronous abort can wake another
      // caller. The cleanup itself is never inserted into its pending set.
      retirement = Promise.resolve().then(async () => {
        try {
          await cancelResponses();
          await Promise.allSettled([...pending]);
          // A previously admitted fetch may have delivered its exact response
          // during the drain. No retired continuation can start another call.
          await cancelResponses();
          responses.clear();
        } finally {
          restoreFetch?.();
          mark("retirement-complete");
          observationsRetired = true;
        }
      });
      retired = true;
      mark("retirement-entered");
      controller.abort();
      return retirement;
    };
    retireBrokerRequests = cleanup;
    context.onTestFinished(cleanup);
    const nativeFetch = globalThis.fetch;
    let expectedUrl: string | undefined;
    const fetchObservation = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (input !== expectedUrl) return nativeFetch(input, init);
      assertActive();
      const response = nativeFetch(input, init);
      // Return the original native promise/result/error. This separate observed
      // reaction only retains the response for exact refusal-body retirement.
      track(
        response.then(
          (value) => {
            responses.add(value);
          },
          () => undefined,
        ),
      );
      return response;
    });
    restoreFetch = () => {
      if (globalThis.fetch === fetchObservation) fetchObservation.mockRestore();
    };
    try {
      mark("fixture-entered");
      const f = await own(() => fixture());
      expectedUrl = f.connection.url;
      mark("fixture-ready");
      mark("invalid-token-entered");
      const denied = await own(() =>
        fetch(f.connection.url, {
          method: "POST",
          signal,
          headers: { Authorization: `Bearer ${"b".repeat(64)}` },
          body: JSON.stringify({ source: document.html }),
        }),
      );
      expect(denied.status).toBe(403);
      expect(await own(() => denied.text())).not.toContain("private source sentinel");
      mark("invalid-token-complete");
      mark("extra-source-entered");
      expect(
        await own(() =>
          requestVisualizationHost(
            f.connection,
            "prepareViewer",
            {
              ...f.input,
              path: "/private/secret",
            },
            signal,
          ),
        ),
      ).toEqual({ status: "blocked", reason: "invalid" });
      mark("extra-source-complete");
      mark("wrong-generation-entered");
      await expect(
        own(() =>
          requestVisualizationHost(
            { ...f.connection, generation: randomUUID() },
            "inspectViewer",
            {
              ticket: f.ticket,
              leaseId: randomUUID(),
            },
            signal,
          ),
        ),
      ).rejects.toThrow("Visualization host request was refused.");
      await own(cancelResponses);
      mark("wrong-generation-complete");
      mark("non-ascii-entered");
      const nonAscii = await own(() =>
        fetch(f.connection.url, {
          method: "POST",
          signal,
          headers: { Authorization: `Bearer ${"é".repeat(64)}` },
          body: "{}",
        }),
      );
      expect(nonAscii.status).toBe(403);
      await own(cancelResponses);
      mark("non-ascii-complete");
      mark("nested-entered");
      const nested = await own(() =>
        fetch(f.connection.url, {
          method: "POST",
          signal,
          headers: { Authorization: `Bearer ${f.connection.token}` },
          body: "[".repeat(17) + "0" + "]".repeat(17),
        }),
      );
      expect(nested.status).toBe(400);
      await own(cancelResponses);
      mark("nested-complete");
      mark("inspect-entered");
      expect(
        await own(() =>
          requestVisualizationHost(
            f.connection,
            "inspectViewer",
            {
              ticket: f.ticket,
              leaseId: randomUUID(),
            },
            signal,
          ),
        ),
      ).toBeNull();
      mark("inspect-complete");
    } finally {
      await cleanup();
    }
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
