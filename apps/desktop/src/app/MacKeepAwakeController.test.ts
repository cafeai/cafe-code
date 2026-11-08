import { describe, expect, it, vi } from "vitest";
import {
  MacKeepAwakeController,
  type MacKeepAwakeControllerOptions,
  type MacPowerLease,
} from "./MacKeepAwakeController.ts";

function harness(supported = true) {
  let time = 0;
  let wall = 0;
  const leases: Array<
    MacPowerLease & { renew: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  > = [];
  const bindings: Array<Parameters<MacKeepAwakeControllerOptions["start"]>[0]> = [];
  const start = vi.fn(async (input: Parameters<MacKeepAwakeControllerOptions["start"]>[0]) => {
    bindings.push(input);
    const lease = { renew: vi.fn(), close: vi.fn(async () => {}) };
    leases.push(lease);
    input.state({ phase: "active", reason: null });
    return lease;
  });
  const controller = new MacKeepAwakeController({
    supported,
    start,
    now: () => time,
    wallNow: () => wall,
  });
  return {
    controller,
    start,
    leases,
    bindings,
    advance: (ms: number) => {
      time += ms;
      wall += ms;
    },
    setWall: (value: number) => {
      wall = value;
    },
  };
}
const frame = (sequence: number, enabled = true, workActive = true) => ({
  version: 1 as const,
  sequence,
  enabled,
  workActive,
});

describe("macOS local-work power owner", () => {
  it("defaults off and never launches a native helper for a disabled preference or unsupported host", async () => {
    for (const supported of [false, true]) {
      const h = harness(supported);
      const owner = h.controller.bindBackend();
      owner.observe(frame(0, false));
      h.controller.tick();
      await h.controller.settled();
      expect(h.start).not.toHaveBeenCalled();
      expect(h.controller.snapshot().phase).toBe("off");
      if (!supported) {
        owner.observe(frame(1));
        await h.controller.settled();
        expect(h.start).not.toHaveBeenCalled();
      }
      await h.controller.close();
    }
  });
  it("uses fresh exact-backend work, releases at idle, and rearms for a later turn", async () => {
    const h = harness();
    const owner = h.controller.bindBackend();
    owner.observe(frame(0, true, false));
    await h.controller.settled();
    expect(h.controller.snapshot().phase).toBe("idle");
    expect(h.start).not.toHaveBeenCalled();
    owner.observe(frame(1));
    await h.controller.settled();
    expect(h.start).toHaveBeenCalledTimes(1);
    h.advance(1000);
    owner.observe(frame(2));
    h.controller.tick();
    await h.controller.settled();
    expect(h.leases[0]!.renew).toHaveBeenCalledTimes(2);
    owner.observe(frame(3, true, false));
    await h.controller.settled();
    expect(h.leases[0]!.close).toHaveBeenCalled();
    owner.observe(frame(4));
    await h.controller.settled();
    expect(h.start).toHaveBeenCalledTimes(2);
    await h.controller.close();
  });
  it("a missing heartbeat, replay, or backwards wall clock cannot refresh a lease", async () => {
    const h = harness();
    const owner = h.controller.bindBackend();
    owner.observe(frame(1));
    await h.controller.settled();
    h.advance(5000);
    owner.observe(frame(1));
    h.controller.tick();
    await h.controller.settled();
    expect(h.leases[0]!.close).toHaveBeenCalled();
    expect(h.controller.snapshot()).toEqual({ phase: "off", reason: "backend-unavailable" });
    owner.observe(frame(2));
    await h.controller.settled();
    h.setWall(0);
    h.controller.tick();
    await h.controller.settled();
    expect(h.leases[1]!.close).toHaveBeenCalled();
    await h.controller.close();
  });
  it("retires the old runtime synchronously and rejects all its late frames and native status", async () => {
    const h = harness();
    const old = h.controller.bindBackend();
    old.observe(frame(0));
    await h.controller.settled();
    const next = h.controller.bindBackend();
    expect(h.leases[0]!.close).toHaveBeenCalled();
    next.observe(frame(0, false));
    old.observe(frame(100));
    h.bindings[0]!.state({ phase: "active", reason: null });
    await h.controller.settled();
    expect(h.controller.snapshot().phase).toBe("off");
    expect(h.start).toHaveBeenCalledTimes(1);
    await h.controller.close();
  });
  it("joins a held old child before replacement admission", async () => {
    const h = harness();
    const old = h.controller.bindBackend();
    old.observe(frame(0));
    await h.controller.settled();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.leases[0]!.close.mockImplementation(() => held);
    const next = h.controller.bindBackend();
    next.observe(frame(0));
    expect(h.start).toHaveBeenCalledTimes(1);
    release();
    await h.controller.settled();
    expect(h.start).toHaveBeenCalledTimes(2);
    await h.controller.close();
  });
  it("closes a late startup result after owner loss instead of adopting it", async () => {
    let release!: (lease: MacPowerLease) => void;
    const start = vi.fn(
      () =>
        new Promise<MacPowerLease>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new MacKeepAwakeController({ supported: true, start });
    const owner = controller.bindBackend();
    await controller.settled();
    owner.observe(frame(0));
    owner.retire();
    const lease = { renew: vi.fn(), close: vi.fn(async () => {}) };
    release(lease);
    await controller.settled();
    expect(lease.renew).not.toHaveBeenCalled();
    expect(lease.close).toHaveBeenCalledTimes(1);
    await controller.close();
  });
  it("does not restart a failed helper on ordinary heartbeat refreshes", async () => {
    const h = harness();
    const owner = h.controller.bindBackend();
    owner.observe(frame(0));
    await h.controller.settled();
    h.bindings[0]!.exited();
    await h.controller.settled();
    owner.observe(frame(1));
    h.controller.tick();
    await h.controller.settled();
    expect(h.start).toHaveBeenCalledTimes(1);
    owner.observe(frame(2, false));
    await h.controller.settled();
    owner.observe(frame(3));
    await h.controller.settled();
    expect(h.start).toHaveBeenCalledTimes(2);
    await h.controller.close();
  });
  it("revokes native input immediately even if persistence keeps publishing the older enabled preference", async () => {
    const h = harness();
    const owner = h.controller.bindBackend();
    owner.observe(frame(0));
    await h.controller.settled();
    h.controller.setIntent(false);
    expect(h.leases[0]!.close).toHaveBeenCalled();
    owner.observe(frame(1));
    h.controller.tick();
    await h.controller.settled();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.controller.snapshot()).toEqual({ phase: "off", reason: null });
    const replacement = h.controller.bindBackend();
    replacement.observe(frame(0));
    await h.controller.settled();
    expect(h.start).toHaveBeenCalledTimes(1);
    replacement.observe(frame(1, false));
    h.controller.setIntent(true);
    await h.controller.settled();
    expect(h.start).toHaveBeenCalledTimes(1);
    replacement.observe(frame(2));
    await h.controller.settled();
    expect(h.start).toHaveBeenCalledTimes(2);
    await h.controller.close();
  });
  it("latches a native protocol failure and rejects its late status until deliberate rearming", async () => {
    const h = harness();
    const owner = h.controller.bindBackend();
    owner.observe(frame(0));
    await h.controller.settled();
    h.bindings[0]!.state({ phase: "unavailable", reason: "native-protocol" });
    await h.controller.settled();
    owner.observe(frame(1));
    h.controller.tick();
    await h.controller.settled();
    h.bindings[0]!.state({ phase: "active", reason: null });
    expect(h.controller.snapshot()).toEqual({ phase: "unavailable", reason: "native-protocol" });
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.leases[0]!.close).toHaveBeenCalled();
    h.controller.setIntent(true);
    await h.controller.settled();
    expect(h.start).toHaveBeenCalledTimes(2);
    await h.controller.close();
  });
  it("retains a refused native reset after Off and never admits a replacement over failed close", async () => {
    const h = harness();
    const owner = h.controller.bindBackend();
    owner.observe(frame(0));
    await h.controller.settled();
    h.leases[0]!.close.mockImplementation(async () => {
      throw new Error("fixture cleanup refusal");
    });
    h.controller.setIntent(false);
    await h.controller.settled();
    expect(h.controller.snapshot()).toEqual({ phase: "unavailable", reason: "cleanup-failed" });
    h.controller.setIntent(true);
    owner.observe(frame(1));
    await h.controller.settled();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.controller.snapshot()).toEqual({ phase: "unavailable", reason: "cleanup-failed" });
    await h.controller.close();
  });
});
