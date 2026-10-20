import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { randomUUID } from "node:crypto";
import type * as Electron from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopVisualizations } from "../../visualizations/DesktopVisualizations.ts";
import { DesktopVisualizationHost } from "../../visualizations/DesktopVisualizationHost.ts";
import type { DesktopIpcInvokeEvent } from "../DesktopIpc.ts";
import {
  captureVisualization,
  openVisualization,
  retireVisualization,
  sendVisualizationMessage,
} from "./visualizations.ts";

const native = vi.hoisted(() => ({ fromWebContents: vi.fn() }));
vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: native.fromWebContents } }));
beforeEach(() => vi.clearAllMocks());

function fixture() {
  const frame = { frameToken: "fixture-owner", url: "file:///fixture/index.html", detached: false };
  const contents = { isDestroyed: () => false, mainFrame: frame };
  const window = {
    isDestroyed: () => false,
    webContents: contents,
  } as unknown as Electron.BrowserWindow;
  native.fromWebContents.mockReturnValue(window);
  const host = new DesktopVisualizationHost({
    stateDirectory: "unused-private-fixture",
    preloadPath: "unused-preload",
  });
  const state = {
    leaseId: randomUUID(),
    state: "active" as const,
    expiresAtMs: DateTime.toEpochMillis(DateTime.nowUnsafe()) + 1000,
  };
  const open = vi.spyOn(host, "open").mockResolvedValue(state);
  const capture = vi.spyOn(host, "capture").mockResolvedValue(null);
  const retire = vi.spyOn(host, "retire").mockResolvedValue({ ...state, state: "retired" });
  const send = vi.spyOn(host, "send").mockReturnValue(false);
  const event: DesktopIpcInvokeEvent = { sender: contents, senderFrame: frame };
  const input = {
    ticket: "a".repeat(64),
    bounds: { x: 0, y: 0, width: 400, height: 200 },
    appearance: "light",
  };
  return { host, state, window, event, input, open, capture, retire, send };
}

describe("native visualization IPC owner and privacy fences", () => {
  it("passes only a private ticket and binds the exact requesting native window", async () => {
    const f = fixture();
    expect(
      await Effect.runPromise(
        openVisualization
          .handler(f.input, f.event)
          .pipe(Effect.provideService(DesktopVisualizations, f.host)),
      ),
    ).toEqual(f.state);
    expect(f.open).toHaveBeenCalledWith(f.window, f.input);
  });
  it("refuses raw source and selectors without retaining schema issue details", async () => {
    const f = fixture();
    for (const raw of [
      { ...f.input, html: "private source sentinel" },
      { ...f.input, path: "/private/secret" },
      { ...f.input, ticket: "private bearer" },
    ]) {
      await expect(
        Effect.runPromise(
          openVisualization
            .handler(raw, f.event)
            .pipe(Effect.provideService(DesktopVisualizations, f.host)),
        ),
      ).rejects.toThrow("Visualization request was refused.");
    }
    expect(f.open).not.toHaveBeenCalled();
  });
  it("refuses child, detached and replaced native documents before host authority", async () => {
    const f = fixture();
    for (const patch of [
      { frameToken: "replacement" },
      { url: "file:///other.html" },
      { detached: true },
      { detached: undefined },
    ]) {
      const malformed = { ...f.event.senderFrame!, ...patch } as unknown as NonNullable<
        DesktopIpcInvokeEvent["senderFrame"]
      >;
      await expect(
        Effect.runPromise(
          openVisualization
            .handler(f.input, { ...f.event, senderFrame: malformed })
            .pipe(Effect.provideService(DesktopVisualizations, f.host)),
        ),
      ).rejects.toThrow("Visualization request was refused.");
    }
    expect(f.open).not.toHaveBeenCalled();
  });
  it("binds capture, retirement and Apps relay to the native owner", async () => {
    const f = fixture();
    const input = { leaseId: f.state.leaseId };
    await Effect.runPromise(
      captureVisualization
        .handler(input, f.event)
        .pipe(Effect.provideService(DesktopVisualizations, f.host)),
    );
    await Effect.runPromise(
      retireVisualization
        .handler(input, f.event)
        .pipe(Effect.provideService(DesktopVisualizations, f.host)),
    );
    await Effect.runPromise(
      sendVisualizationMessage
        .handler({ ...input, json: '{"method":"ping"}' }, f.event)
        .pipe(Effect.provideService(DesktopVisualizations, f.host)),
    );
    expect(f.capture).toHaveBeenCalledWith(f.window, input.leaseId);
    expect(f.retire).toHaveBeenCalledWith(f.window, input.leaseId);
    expect(f.send).toHaveBeenCalledWith(f.window, input.leaseId, '{"method":"ping"}');
  });
});
