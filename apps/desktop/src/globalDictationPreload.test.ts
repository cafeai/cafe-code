import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "@cafecode/contracts";
import { DESKTOP_UI_LOCALE_CHANGED_CHANNEL } from "./settings/DesktopUiLocaleBridge.ts";
const electron = vi.hoisted(() => ({
  expose: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  invoke: vi.fn(),
  sendSync: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.expose },
  ipcRenderer: {
    on: electron.on,
    removeListener: electron.removeListener,
    invoke: electron.invoke,
    sendSync: electron.sendSync,
  },
}));
afterEach(() => vi.clearAllMocks());
describe("restricted dictation presentation metadata", () => {
  it("exposes finite language without ordinary settings/filesystem capabilities", async () => {
    await import("./globalDictationPreload.ts");
    const [name, bridge] = electron.expose.mock.calls[0] as [string, Partial<DesktopBridge>];
    expect(name).toBe("desktopBridge");
    expect(Object.keys(bridge).toSorted()).toEqual(
      [
        "getLocalEnvironmentBootstrap",
        "globalDictationAction",
        "initialUiLocale",
        "onGlobalDictationEvent",
        "onUiLocaleChanged",
        "systemUiLocale",
      ].toSorted(),
    );
    const listener = vi.fn();
    const unsubscribe = bridge.onUiLocaleChanged!(listener);
    const [channel, wrapped] = electron.on.mock.calls.at(-1)!;
    expect(channel).toBe(DESKTOP_UI_LOCALE_CHANGED_CHANNEL);
    for (const value of ["en", null, "system", {}, "ja", "ko-KR"]) wrapped({}, value);
    expect(listener.mock.calls).toEqual([["en"], ["ja"]]);
    unsubscribe();
    expect(electron.removeListener).toHaveBeenCalledWith(channel, wrapped);
    expect(electron.invoke).not.toHaveBeenCalled();
    const receive = vi.fn();
    const stop = bridge.onGlobalDictationEvent!(receive);
    const [eventChannel, accept] = electron.on.mock.calls.at(-1)!;
    const base = { type: "start", sessionId: "00000000-0000-0000-0000-000000000000" };
    accept({}, { ...base, guidance: "accessibility_permission_required" });
    accept({}, { ...base, guidance: "private native reason" });
    accept({}, { ...base, reason: "Opaque old-main text." });
    expect(receive.mock.calls).toEqual([
      [{ ...base, guidance: "accessibility_permission_required" }],
      [{ ...base, reason: "Opaque old-main text." }],
    ]);
    stop();
    expect(electron.removeListener).toHaveBeenCalledWith(eventChannel, accept);
  });
});
