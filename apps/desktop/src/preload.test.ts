import type { DesktopBridge } from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as IpcChannels from "./ipc/channels.ts";
import { DESKTOP_UI_LOCALE_CHANGED_CHANNEL } from "./settings/DesktopUiLocaleBridge.ts";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  sendSync: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    sendSync: electron.sendSync,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

const originalMainFrameDescriptor = Object.getOwnPropertyDescriptor(process, "isMainFrame");

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Node does not normally define this Electron-only property. Restore the
  // actual host descriptor instead of leaving the fixture on the test runner.
  if (originalMainFrameDescriptor) {
    Object.defineProperty(process, "isMainFrame", originalMainFrameDescriptor);
  } else {
    Reflect.deleteProperty(process, "isMainFrame");
  }
});

function setMainFrameIdentity(value: boolean | undefined): void {
  Object.defineProperty(process, "isMainFrame", { configurable: true, value });
}

describe("desktop preload capability boundary", () => {
  it("keeps duplicate capacity listeners independently subscribed and fences late observation ACKs", async () => {
    setMainFrameIdentity(true);
    // Spy on the real host WebCrypto method, not deterministic replacement
    // randomness, to qualify the exact sandbox-compatible primitive and size.
    const random = vi.spyOn(globalThis.crypto, "getRandomValues");
    let resolve!: (value: unknown) => void;
    const late = new Promise((done) => {
      resolve = done;
    });
    electron.invoke.mockReturnValueOnce(late).mockResolvedValue(null);
    await import("./preload.ts");
    const [, bridge] = electron.exposeInMainWorld.mock.calls[0] as [string, DesktopBridge];
    const listener = vi.fn(),
      first = bridge.onVisualizationCapacityChanged!(listener),
      second = bridge.onVisualizationCapacityChanged!(listener);
    expect(electron.invoke).toHaveBeenCalledOnce();
    const [channel, deliver] = electron.on.mock.calls.at(-1)!;
    const value = {
      poolVersion: 1,
      sequence: 2,
      available: true,
      viewerCount: 1,
      freeViewers: 3,
      preparedCount: 0,
      freePreparations: 4,
      mcpAppAvailable: true,
      previewBusy: false,
    };
    deliver({}, value);
    expect(listener).toHaveBeenCalledTimes(2);
    first();
    deliver({}, { ...value, sequence: 3 });
    expect(listener).toHaveBeenCalledTimes(3);
    expect(electron.removeListener).not.toHaveBeenCalled();
    second();
    expect(electron.removeListener).toHaveBeenCalledWith(channel, deliver);
    const third = bridge.onVisualizationCapacityChanged!(listener);
    resolve(value);
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(3);
    const observations = electron.invoke.mock.calls
      .filter(([channel]) => channel === IpcChannels.VISUALIZATION_CAPACITY_OBSERVE_CHANNEL)
      .map(([, input]) => input);
    expect(observations[0]).toMatchObject({ observing: true, sequence: 1 });
    expect(observations[1]).toMatchObject({ observing: false, sequence: 1 });
    expect(observations[2]).toMatchObject({ observing: true, sequence: 3 });
    expect(random).toHaveBeenCalledTimes(2);
    for (const [bytes] of random.mock.calls) {
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes!.byteLength).toBe(16);
    }
    expect(observations[0].observerId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(observations[1].observerId).toBe(observations[0].observerId);
    expect(observations[2].observerId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(observations[0].observerId).not.toBe(observations[2].observerId);
    third();
  });
  it.each(["absent", "throws"])(
    "refuses capacity observation without retaining listeners when WebCrypto %s",
    async (failure) => {
      setMainFrameIdentity(true);
      const crypto = globalThis.crypto;
      vi.stubGlobal(
        "crypto",
        failure === "absent"
          ? undefined
          : {
              getRandomValues: () => {
                throw new Error("Private cryptographic diagnostic.");
              },
            },
      );
      electron.invoke.mockResolvedValue(null);
      await import("./preload.ts");
      const [, bridge] = electron.exposeInMainWorld.mock.calls[0] as [string, DesktopBridge];
      const listener = vi.fn();
      const refused = bridge.onVisualizationCapacityChanged!(listener);
      refused();
      refused();
      expect(electron.invoke).not.toHaveBeenCalled();
      expect(electron.on).not.toHaveBeenCalled();
      expect(electron.removeListener).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      // Restoring the real primitive admits one fresh first observer, proving
      // the refusal did not retain an inaccessible registration or epoch.
      vi.stubGlobal("crypto", crypto);
      const admitted = bridge.onVisualizationCapacityChanged!(listener);
      expect(electron.invoke).toHaveBeenCalledExactlyOnceWith(
        IpcChannels.VISUALIZATION_CAPACITY_OBSERVE_CHANNEL,
        expect.objectContaining({ observing: true, sequence: 1 }),
      );
      admitted();
      expect(electron.invoke).toHaveBeenLastCalledWith(
        IpcChannels.VISUALIZATION_CAPACITY_OBSERVE_CHANNEL,
        expect.objectContaining({ observing: false, sequence: 1 }),
      );
    },
  );
  it("delivers only bounded visualization host metadata and exact subscriptions", async () => {
    setMainFrameIdentity(true);
    await import("./preload.ts");
    const [, bridge] = electron.exposeInMainWorld.mock.calls[0] as [string, DesktopBridge];
    const listener = vi.fn();
    const unsubscribe = bridge.onVisualizationHostEvent!(listener);
    const [channel, wrapped] = electron.on.mock.calls.at(-1)!;
    const value = {
      leaseId: "12345678-1234-4123-8123-123456789abc",
      state: "message",
      json: '{"method":"ping"}',
    };
    wrapped({}, value);
    for (const patch of [
      { source: "private" },
      { reason: "private exception" },
      { state: "retired" },
      { json: "日".repeat(50_000) },
      { leaseId: "wrong" },
    ])
      wrapped({}, { ...value, ...patch });
    expect(listener.mock.calls).toEqual([[value]]);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(channel, wrapped);
    expect(electron.invoke).not.toHaveBeenCalled();
  });
  it("delivers only finite locale metadata and retires listeners without invoking IPC", async () => {
    setMainFrameIdentity(true);
    await import("./preload.ts");
    const [, bridge] = electron.exposeInMainWorld.mock.calls[0] as [string, DesktopBridge];
    expect(bridge.systemUiLocale).toBe("en");
    expect(bridge.initialUiLocale).toBe("en");
    const listener = vi.fn();
    const unsubscribe = bridge.onUiLocaleChanged!(listener);
    const [channel, wrapped] = electron.on.mock.calls.at(-1)!;
    expect(channel).toBe(DESKTOP_UI_LOCALE_CHANGED_CHANNEL);
    for (const value of ["ja", {}, "system", "../../secret", "ko", null]) wrapped({}, value);
    expect(listener.mock.calls).toEqual([["ja"], ["ko"]]);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(channel, wrapped);
    expect(electron.invoke).not.toHaveBeenCalled();
    expect(electron.sendSync).not.toHaveBeenCalled();
  });
  it("publishes the working native bridge only into the main frame", async () => {
    setMainFrameIdentity(true);
    await import("./preload.ts");

    expect(electron.exposeInMainWorld).toHaveBeenCalledOnce();
    const [name, bridge] = electron.exposeInMainWorld.mock.calls[0] as [string, DesktopBridge];
    expect(name).toBe("desktopBridge");

    electron.invoke.mockResolvedValueOnce(true);
    await expect(bridge.openExternal("https://example.com/")).resolves.toBe(true);
    expect(electron.invoke).toHaveBeenCalledWith(
      IpcChannels.OPEN_EXTERNAL_CHANNEL,
      "https://example.com/",
    );
    electron.invoke.mockResolvedValueOnce("approved");
    await expect(bridge.prepareRemoteCertificate?.("https://pc.example:3775/")).resolves.toBe(
      "approved",
    );
    expect(electron.invoke).toHaveBeenLastCalledWith(
      IpcChannels.PREPARE_REMOTE_CERTIFICATE_CHANNEL,
      "https://pc.example:3775/",
    );

    const png = new Uint8Array([137, 80, 78, 71]);
    electron.invoke.mockResolvedValueOnce(undefined);
    await expect(bridge.copyPng(png)).resolves.toBeUndefined();
    expect(electron.invoke).toHaveBeenLastCalledWith(IpcChannels.COPY_PNG_CHANNEL, png);
    const imageSave = { png, suggestedName: "diagram.png" };
    electron.invoke.mockResolvedValueOnce("cancelled");
    await expect(bridge.savePng(imageSave)).resolves.toBe("cancelled");
    expect(electron.invoke).toHaveBeenLastCalledWith(IpcChannels.SAVE_PNG_CHANNEL, imageSave);
  });

  it.each([false, undefined])(
    "withholds all native capabilities for non-main or absent frame identity %s",
    async (isMainFrame) => {
      setMainFrameIdentity(isMainFrame);
      await import("./preload.ts");

      expect(electron.exposeInMainWorld).not.toHaveBeenCalled();
      expect(electron.invoke).not.toHaveBeenCalled();
      expect(electron.sendSync).not.toHaveBeenCalled();
      expect(electron.on).not.toHaveBeenCalled();
    },
  );
});
