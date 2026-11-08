import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlideTraySnapshot } from "./activity.ts";

const fixture = vi.hoisted(() => ({
  message: undefined as ((value: unknown) => void) | undefined,
  failure: undefined as (() => void) | undefined,
  send: vi.fn(async (_value: unknown) => undefined),
  stop: vi.fn(async (): Promise<void> => undefined),
}));
vi.mock("./runtime.ts", () => ({
  GlideChild: class {
    constructor(
      _command: string,
      _args: string[],
      message: (value: unknown) => void,
      failure: () => void,
    ) {
      fixture.message = message;
      fixture.failure = failure;
    }
    send(value: unknown) {
      return fixture.send(value);
    }
    stop() {
      return fixture.stop();
    }
  },
}));
import { createGlideTrayHost } from "./tray.ts";
import { createGlideNativePeer } from "./nativeHost.ts";
const snapshot = (state: GlideTraySnapshot["state"]): GlideTraySnapshot => ({ state, rows: [] });
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  fixture.send.mockResolvedValue(undefined);
  fixture.stop.mockResolvedValue(undefined);
});
describe("private native tray transport", () => {
  it("opts only observation frames into private visibility metadata", async () => {
    const peer = createGlideNativePeer("/owned/mac-glide", ["fixture.editor"]);
    try {
      const observation = peer.request({
        method: "get_app_state",
        input: { app: "fixture.editor" },
      });
      expect(fixture.send).toHaveBeenLastCalledWith({
        method: "get_app_state",
        input: { app: "fixture.editor" },
        id: 1,
        visibilityVersion: 1,
      });
      fixture.message?.({ id: 1, result: null });
      await observation;
      const inventory = peer.request({ method: "list_apps", input: {} });
      expect(fixture.send).toHaveBeenLastCalledWith({ method: "list_apps", input: {}, id: 2 });
      fixture.message?.({ id: 2, result: [] });
      await inventory;
    } finally {
      await peer.close();
    }
  });
  it("coalesces images behind one held ACK while stop events retain an independent lane", async () => {
    const event = vi.fn(),
      failure = vi.fn();
    const host = createGlideTrayHost("/owned/mac-glide", event, failure);
    try {
      const initial = host.publish(snapshot("ready"));
      expect(fixture.send).not.toHaveBeenCalled();
      fixture.message?.({ type: "ready" });
      const second = host.publish(snapshot("stopping"));
      const final = host.publish(snapshot("stopped"));
      fixture.message?.({ type: "stop-all" });
      expect(event).toHaveBeenCalledExactlyOnceWith({ type: "stop-all" });
      expect(fixture.send).toHaveBeenCalledTimes(1);
      fixture.message?.({ type: "applied", id: 1 });
      await initial;
      expect(fixture.send).toHaveBeenLastCalledWith({ id: 2, snapshot: snapshot("stopped") });
      fixture.message?.({ type: "applied", id: 2 });
      await Promise.all([second, final]);
      expect(failure).not.toHaveBeenCalled();
    } finally {
      await host.close();
    }
  });
  it("fails closed on a missing native ACK and joins the exact child's held close", async () => {
    vi.useFakeTimers();
    const close = Promise.withResolvers<void>();
    fixture.stop.mockImplementation(() => close.promise);
    const failure = vi.fn();
    const host = createGlideTrayHost("/owned/mac-glide", vi.fn(), failure);
    try {
      fixture.message?.({ type: "ready" });
      const pending = host.publish(snapshot("ready"));
      const refused = expect(pending).rejects.toThrow("unavailable");
      await vi.advanceTimersByTimeAsync(5000);
      await refused;
      expect(failure).toHaveBeenCalledOnce();
      await expect(host.publish(snapshot("ready"))).rejects.toThrow();
      const closing = host.close();
      expect(fixture.stop).toHaveBeenCalledOnce();
      close.resolve();
      await closing;
      expect(fixture.send).toHaveBeenCalledTimes(1);
    } finally {
      close.resolve();
      await host.close();
    }
  });
});
