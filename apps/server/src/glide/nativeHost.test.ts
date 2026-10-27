import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GlideNativeHost, GlideNativeTransportError, type GlideNativePeer } from "./nativeHost.ts";
import { unknownActionReceipt } from "./protocol.ts";

const app = { name: "Editor", bundleId: "fixture.editor", path: "/fixture/Editor.app", pid: 10 };
const observation = {
  app: app.path,
  text: "1: AXTextField",
  screenshot: null,
  revision: 1,
  pid: 10,
  windowId: 7,
  accessibilityAvailable: true,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  screenshotWidth: 100,
  screenshotHeight: 100,
  capturedAt: "2026-10-17T00:00:00.000Z",
};
const owner = () => ({ executionId: randomUUID(), deadline: performance.now() + 5000 });
const observed = {
  method: "get_app_state",
  input: { app: app.bundleId, windowId: 7, includeScreenshot: false },
} as const;
const type = {
  method: "type_text",
  input: { app: app.bundleId, windowId: 7, text: "owned" },
} as const;
function fixture() {
  const frames: Record<string, unknown>[] = [];
  const close = vi.fn(async () => undefined);
  const request = vi.fn(async (frame: Record<string, unknown>): Promise<unknown> => {
    frames.push(frame);
    if (frame.method === "list_apps")
      return [app, { ...app, bundleId: "foreign.app", path: "/foreign.app" }];
    if (frame.method === "get_app_state") return observation;
    return null;
  });
  const factory = vi.fn((_apps: readonly string[]): GlideNativePeer => ({ request, close }));
  const host = new GlideNativeHost(factory);
  let live = true;
  const authorize = vi.fn(async () => ({ apps: [app.bundleId], current: () => live }));
  return {
    host,
    frames,
    request,
    close,
    factory,
    authorize,
    revoke: () => {
      live = false;
    },
  };
}

describe("shared Glide native host", () => {
  it("publishes the real private thumbnail to the tray without returning it to the model", async () => {
    const f = fixture();
    const preview = "data:image/jpeg;base64,AA==";
    const received: string[] = [];
    const bridge = f.host.attach(randomUUID(), f.authorize, async (event) => {
      if (event.phase === "observation" && event.observation.screenshotPreview)
        received.push(event.observation.screenshotPreview);
    });
    try {
      f.request.mockImplementation(async (frame) =>
        frame.method === "list_apps"
          ? [app]
          : {
              ...observation,
              processBirth: "100:10",
              windowTitle: "Notes",
              screenshot: { url: "data:image/png;base64,AA==" },
              screenshotPreview: preview,
            },
      );
      const result = await bridge.invoke(observed, owner());
      expect(received).toEqual([preview]);
      expect(result).not.toHaveProperty("screenshotPreview");
      expect(result).toMatchObject({ windowId: 7, windowTitle: "Notes" });
    } finally {
      await f.host.close();
    }
  });
  it("waits for visible native activity and rechecks cancellation before capture dispatch", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const visible = Promise.withResolvers<void>();
    const events: string[] = [];
    const bridge = f.host.attach(randomUUID(), f.authorize, async (event) => {
      events.push(event.phase);
      if (event.phase === "start") {
        entered.resolve();
        await visible.promise;
      }
    });
    try {
      const result = bridge.invoke(observed, owner());
      const refused = expect(result).rejects.toThrow();
      await entered.promise;
      expect(f.frames.filter((frame) => frame.method === "get_app_state")).toHaveLength(0);
      await bridge.retire();
      visible.resolve();
      await refused;
      await f.host.close();
      expect(f.frames.filter((frame) => frame.method === "get_app_state")).toHaveLength(0);
      expect(events).toEqual(["start", "end"]);
    } finally {
      visible.resolve();
      await f.host.close();
    }
  });
  it("requires a fresh observation after an action reports an uncertain outcome", async () => {
    const f = fixture();
    const bridge = f.host.attach(randomUUID(), f.authorize);
    try {
      await bridge.invoke(observed, owner());
      f.request.mockResolvedValueOnce([app]);
      f.request.mockResolvedValueOnce(unknownActionReceipt("type_text", "uncertain:1"));
      expect(await bridge.invoke(type, owner())).toMatchObject({ status: "uncertain" });
      await expect(bridge.invoke(type, owner())).rejects.toThrow("fresh observation");
      expect(f.request.mock.calls.filter(([frame]) => frame.method === "type_text")).toHaveLength(
        1,
      );
      await bridge.invoke(observed, owner());
      await bridge.invoke(type, owner());
      expect(f.request.mock.calls.filter(([frame]) => frame.method === "type_text")).toHaveLength(
        2,
      );
    } finally {
      await f.host.close();
    }
  });
  it("launches a stopped app only through fresh installed identity and requires a new observation", async () => {
    const frames: Record<string, unknown>[] = [];
    const installed = { name: app.name, bundleId: app.bundleId, path: app.path };
    let running = false;
    const resolver = vi.fn(async () => installed);
    const factory = vi.fn((allowed: readonly string[]): GlideNativePeer => ({
      close: async () => undefined,
      request: async (frame) => {
        frames.push(frame);
        expect(allowed).toEqual([app.bundleId]);
        if (frame.method === "resolve_app") return installed;
        if (frame.method === "launch_app") {
          running = true;
          return null;
        }
        if (frame.method === "list_apps") return running ? [app] : [];
        if (frame.method === "get_app_state") return observation;
        return null;
      },
    }));
    const host = new GlideNativeHost(factory, async () => (running ? [app] : []), resolver);
    const bridge = host.attach(randomUUID(), async () => ({
      apps: [],
      desktop: true,
      current: () => true,
    }));
    try {
      expect(
        await bridge.invoke({ method: "resolve_app", input: { app: app.bundleId } }, owner()),
      ).toEqual(installed);
      expect(frames.filter((frame) => frame.method === "launch_app")).toHaveLength(0);
      await bridge.invoke({ method: "launch_app", input: { app: app.path } }, owner());
      expect(frames.filter((frame) => frame.method === "launch_app")).toHaveLength(1);
      expect(frames.find((frame) => frame.method === "launch_app")!.input).toEqual({
        app: app.path,
      });
      await expect(bridge.invoke(type, owner())).rejects.toThrow("fresh observation");
      await bridge.invoke(observed, owner());
      await bridge.invoke(type, owner());
      await bridge.invoke(
        { method: "restore_window", input: { app: app.path, windowId: 7 } },
        owner(),
      );
      await expect(bridge.invoke(type, owner())).rejects.toThrow("fresh observation");
      expect(resolver).toHaveBeenCalledTimes(2);
    } finally {
      await host.close();
    }
  });
  it("rechecks revocation after installed resolution and rejects a native installation substitution", async () => {
    const gate = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    let live = true;
    const factory = vi.fn((): GlideNativePeer => ({
      close: async () => undefined,
      request: async () => ({ name: app.name, bundleId: app.bundleId, path: "/substitute.app" }),
    }));
    const host = new GlideNativeHost(
      factory,
      async () => [],
      () => {
        entered.resolve();
        return gate.promise;
      },
    );
    const bridge = host.attach(randomUUID(), async () => ({
      apps: [],
      desktop: true,
      current: () => live,
    }));
    try {
      const launch = bridge.invoke({ method: "launch_app", input: { app: app.bundleId } }, owner());
      const refused = expect(launch).rejects.toThrow("revoked");
      await entered.promise;
      live = false;
      gate.resolve({ name: app.name, bundleId: app.bundleId, path: app.path });
      await refused;
      expect(factory).not.toHaveBeenCalled();
      live = true;
      await expect(
        bridge.invoke({ method: "launch_app", input: { app: app.bundleId } }, owner()),
      ).rejects.toThrow("exact app grant");
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      gate.resolve(null);
      await host.close();
    }
  });
  it("keeps installed application resolution inside a legacy app allowlist", async () => {
    const f = fixture();
    f.request.mockImplementation(async (frame) =>
      frame.method === "resolve_app"
        ? { name: "Foreign", bundleId: "foreign.app", path: "/foreign.app" }
        : null,
    );
    const bridge = f.host.attach(randomUUID(), f.authorize);
    try {
      await expect(
        bridge.invoke({ method: "launch_app", input: { app: "foreign.app" } }, owner()),
      ).rejects.toThrow("exact app grant");
      expect(f.frames.some((frame) => frame.method === "launch_app")).toBe(false);
      expect(f.request.mock.calls.map(([frame]) => frame.method)).toEqual(["resolve_app"]);
    } finally {
      await f.host.close();
    }
  });
  it("discovers a full desktop but launches only the exact observed target, retaining legacy chat restrictions", async () => {
    let inventory = Array.from({ length: 24 }, (_, i) => ({
      ...app,
      name: `Editor ${i}`,
      bundleId: `fixture.editor${i}`,
      path: `/Editor${i}.app`,
      pid: 10 + i,
    }));
    inventory[0] = app;
    const frames: Record<string, unknown>[] = [];
    const factory = vi.fn((allowed: readonly string[]): GlideNativePeer => ({
      close: async () => undefined,
      request: async (frame) => {
        frames.push(frame);
        if (frame.method === "list_apps")
          return inventory.filter((a) => allowed.includes(a.bundleId));
        if (frame.method === "get_app_state") return observation;
        return null;
      },
    }));
    const host = new GlideNativeHost(factory, async () => inventory);
    const desktop = host.attach(randomUUID(), async () => ({
      apps: [],
      desktop: true,
      current: () => true,
    }));
    const restricted = host.attach(randomUUID(), async () => ({
      apps: [app.bundleId],
      current: () => true,
    }));
    try {
      expect(await desktop.invoke({ method: "list_apps", input: {} }, owner())).toHaveLength(24);
      expect(factory).not.toHaveBeenCalled();
      await desktop.invoke(observed, owner());
      await desktop.invoke(type, owner());
      expect(factory.mock.calls).toEqual([[[app.bundleId]]]);
      expect(await restricted.invoke({ method: "list_apps", input: {} }, owner())).toEqual([app]);
      await expect(
        restricted.invoke({ method: "list_windows", input: { app: "fixture.editor1" } }, owner()),
      ).rejects.toThrow("explicitly allowed");
      inventory = [
        ...inventory,
        { ...app, name: "New Editor", bundleId: "fixture.new", path: "/New.app", pid: 90 },
      ];
      expect(await desktop.invoke({ method: "list_apps", input: {} }, owner())).toHaveLength(25);
      await desktop.invoke({ method: "list_windows", input: { app: "fixture.new" } }, owner());
      expect(factory.mock.calls.at(-1)).toEqual([["fixture.new"]]);
      await expect(desktop.invoke(type, owner())).rejects.toThrow("fresh observation");
      const inputCount = frames.filter((f) => f.method === "type_text").length;
      inventory = [{ ...app, path: "/different/Editor.app" }];
      await expect(
        desktop.invoke({ method: "list_windows", input: { app: app.path } }, owner()),
      ).rejects.toThrow("running application");
      expect(frames.filter((f) => f.method === "type_text")).toHaveLength(inputCount);
    } finally {
      await host.close();
    }
  });
  it("rechecks desktop revocation after an awaited inventory before creating any native peer", async () => {
    const reading = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    const factory = vi.fn((): GlideNativePeer => {
      throw new Error("No native peer is authorized.");
    });
    const host = new GlideNativeHost(factory, () => {
      entered.resolve();
      return reading.promise;
    });
    let live = true;
    const desktop = host.attach(randomUUID(), async () => ({
      apps: [],
      desktop: true,
      current: () => live,
    }));
    try {
      const pending = desktop.invoke(observed, owner());
      const refused = expect(pending).rejects.toThrow("revoked");
      await entered.promise;
      live = false;
      reading.resolve([app]);
      await refused;
      expect(factory).not.toHaveBeenCalled();
    } finally {
      reading.resolve([]);
      await host.close();
    }
  });
  it("joins a broken transport and requires fresh observations without replaying failed input", async () => {
    const f = fixture();
    const a = f.host.attach(randomUUID(), f.authorize);
    const original = f.request.getMockImplementation()!;
    try {
      await a.invoke(observed, owner());
      f.request
        .mockImplementationOnce(async (frame) => {
          return original(frame);
        })
        .mockImplementationOnce(async () => {
          throw new GlideNativeTransportError("Exact host exited.");
        });
      await expect(a.invoke(type, owner())).rejects.toThrow("Exact host exited");
      expect(f.close).toHaveBeenCalledOnce();
      await expect(a.invoke(type, owner())).rejects.toThrow("fresh observation");
      expect(f.frames.some((frame) => frame.method === "type_text")).toBe(false);
      await a.invoke(observed, owner());
      await a.invoke(type, owner());
      expect(f.factory).toHaveBeenCalledTimes(2);
      expect(f.frames.filter((frame) => frame.method === "type_text")).toHaveLength(1);
    } finally {
      await f.host.close();
    }
  });
  it("lets native window identity select among processes of one canonical app while refusing distinct installations", async () => {
    const f = fixture();
    const a = f.host.attach(randomUUID(), f.authorize);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (frame) =>
      frame.method === "list_apps" ? [app, { ...app, pid: 20 }] : original(frame),
    );
    try {
      await a.invoke(observed, owner());
      await a.invoke(type, owner());
      expect(f.frames.at(-1)?.input).toEqual({ ...type.input, app: app.path });
      f.request.mockImplementation(async (frame) =>
        frame.method === "list_apps"
          ? [app, { ...app, path: "/other/Editor.app", pid: 20 }]
          : original(frame),
      );
      await expect(a.invoke(type, owner())).rejects.toThrow("explicitly allowed");
      expect(f.frames.filter((frame) => frame.method === "type_text")).toHaveLength(1);
    } finally {
      await f.host.close();
    }
  });
  it("keeps uncertain native cleanup as a sticky refusal instead of starting a competitor", async () => {
    const f = fixture();
    const a = f.host.attach(randomUUID(), f.authorize),
      b = f.host.attach(randomUUID(), f.authorize);
    const entered = Promise.withResolvers<void>();
    const input = Promise.withResolvers<unknown>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((frame) => {
      if (frame.method === "type_text") {
        entered.resolve();
        return input.promise;
      }
      return original(frame);
    });
    f.close.mockImplementation(async () => {
      input.reject(new Error("Input ownership lost."));
      throw new Error("Cleanup uncertain.");
    });
    try {
      await a.invoke(observed, owner());
      const active = a.invoke(type, owner());
      const refused = expect(active).rejects.toThrow("cancelled");
      await entered.promise;
      await expect(a.retire()).rejects.toThrow("Cleanup uncertain");
      await refused;
      await expect(b.invoke({ method: "list_apps", input: {} }, owner())).rejects.toThrow(
        "Cleanup uncertain",
      );
      expect(f.factory).toHaveBeenCalledOnce();
    } finally {
      await expect(f.host.close()).rejects.toThrow("Cleanup uncertain");
    }
  });
  it("retires the exact active operation and invalidates foreign observations before host reuse", async () => {
    const f = fixture();
    const a = f.host.attach(randomUUID(), f.authorize),
      b = f.host.attach(randomUUID(), f.authorize);
    let rejected!: (error: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((yes) => {
      entered = yes;
    });
    try {
      await a.invoke(observed, owner());
      await b.invoke(observed, owner());
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation((frame) =>
        frame.method === "type_text"
          ? new Promise((_yes, no) => {
              rejected = no;
              entered();
            })
          : original(frame),
      );
      f.close.mockImplementation(async () => {
        rejected?.(new Error("Exact peer closed."));
      });
      const activeOwner = owner();
      const active = a.invoke(type, activeOwner);
      const refusal = expect(active).rejects.toThrow("cancelled");
      await started;
      await a.retire(activeOwner.executionId);
      await refusal;
      expect(f.close).toHaveBeenCalledOnce();
      await expect(b.invoke(type, owner())).rejects.toThrow("fresh observation");
      expect(f.factory).toHaveBeenCalledTimes(2);
    } finally {
      await f.host.close();
    }
  });
  it("isolates observation authority and forwards only server-minted sessions and canonical allowed paths", async () => {
    const f = fixture();
    const idA = randomUUID(),
      idB = randomUUID();
    const a = f.host.attach(idA, f.authorize),
      b = f.host.attach(idB, f.authorize);
    try {
      expect(await a.invoke({ method: "list_apps", input: {} }, owner())).toEqual([app]);
      await a.invoke(observed, owner());
      await expect(b.invoke(type, owner())).rejects.toThrow("fresh observation");
      await a.invoke(type, owner());
      expect(f.frames.filter((frame) => frame.method === "type_text")).toEqual([
        expect.objectContaining({ sessionId: idA, input: { ...type.input, app: app.path } }),
      ]);
      await expect(
        a.invoke({ ...type, input: { ...type.input, app: "foreign.app" } }, owner()),
      ).rejects.toThrow("explicitly allowed");
      await b.invoke(observed, owner());
      await a.close();
      await b.invoke(type, owner());
      expect(f.factory).toHaveBeenCalledTimes(1);
    } finally {
      await f.host.close();
    }
  });
  it("cancels queued work without terminating the foreign active operation", async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const admission = new Promise<void>((yes) => {
      entered = yes;
    });
    const gate = new Promise<void>((yes) => {
      release = yes;
    });
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (frame) => {
      if (frame.method === "get_app_state") {
        entered();
        await gate;
      }
      return original(frame);
    });
    const a = f.host.attach(randomUUID(), f.authorize),
      b = f.host.attach(randomUUID(), f.authorize);
    const active = a.invoke(observed, owner());
    await admission;
    const queued = b.invoke(observed, owner());
    const refusal = expect(queued).rejects.toThrow("cancelled");
    const retired = b.retire();
    expect(f.close).not.toHaveBeenCalled();
    release();
    try {
      await Promise.all([active, retired, refusal]);
      expect(f.close).not.toHaveBeenCalled();
    } finally {
      release();
      await f.host.close();
    }
  });
  it("checks grant revocation again after awaited discovery before dispatching input", async () => {
    const f = fixture();
    const a = f.host.attach(randomUUID(), f.authorize);
    try {
      await a.invoke(observed, owner());
      const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (frame) => {
        const result = await original(frame);
        if (frame.method === "list_apps") f.revoke();
        return result;
      });
      await expect(a.invoke(type, owner())).rejects.toThrow("revoked");
      expect(f.frames.some((frame) => frame.method === "type_text")).toBe(false);
    } finally {
      await f.host.close();
    }
  });
  it("invalidates old observations when the immutable helper app allowlist changes", async () => {
    const f = fixture();
    const a = f.host.attach(randomUUID(), f.authorize);
    const b = f.host.attach(randomUUID(), async () => ({
      apps: ["fixture.second"],
      current: () => true,
    }));
    try {
      await a.invoke(observed, owner());
      await b.invoke({ method: "list_apps", input: {} }, owner());
      await expect(a.invoke(type, owner())).rejects.toThrow("fresh observation");
      await a.invoke(observed, owner());
      await a.invoke(type, owner());
      expect(f.factory).toHaveBeenCalledTimes(3);
    } finally {
      await f.host.close();
    }
  });
  it("refuses expired work and bounds live sessions and queued requests", async () => {
    const f = fixture();
    const a = f.host.attach(randomUUID(), f.authorize);
    try {
      await expect(
        a.invoke(observed, { executionId: "expired", deadline: performance.now() - 1 }),
      ).rejects.toThrow("expired");
      expect(f.factory).not.toHaveBeenCalled();
      for (let index = 1; index < 32; index++) f.host.attach(randomUUID(), f.authorize);
      expect(() => f.host.attach(randomUUID(), f.authorize)).toThrow("admitted");
      const jobs = Array.from({ length: 64 }, () =>
        a.invoke({ method: "list_apps", input: {} }, owner()),
      );
      await expect(a.invoke(observed, owner())).rejects.toThrow("queue is full");
      await Promise.all(jobs);
    } finally {
      await f.host.close();
    }
  });
});
