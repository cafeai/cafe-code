import type { DesktopBridge } from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as IpcChannels from "./ipc/channels.ts";

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
