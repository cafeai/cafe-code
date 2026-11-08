// Synthetic native-pipe ownership fixture; no filesystem or process is acquired.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi, type TestContext } from "vitest";
import { startMacPowerLease } from "./MacKeepAwakeNative.ts";
import type { MacPowerLease } from "./MacKeepAwakeController.ts";

const native = vi.hoisted(() => ({ spawn: vi.fn(), lstat: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: native.spawn }));
vi.mock("node:fs/promises", () => ({ lstat: native.lstat }));

function fixture(context: TestContext) {
  const spawned = Promise.withResolvers<void>();
  const input = Object.assign(new EventEmitter(), {
    writableLength: 0,
    destroyed: false,
    write: vi.fn((_value: string) => true),
    end: vi.fn(),
  });
  const child = Object.assign(new EventEmitter(), {
    stdin: input,
    stdout: new EventEmitter(),
    kill: vi.fn(),
  });
  let current = true;
  let adopted = false;
  let physical: boolean | null = null;
  let closed = false;
  let pending: Promise<MacPowerLease | null> | undefined;
  const state = vi.fn();
  const observe = vi.fn((value: boolean | null) => {
    physical = value;
    adopted = false;
  });
  const close = () => {
    if (closed) return;
    closed = true;
    child.emit("close", 0, null);
  };
  const retire = () => {
    current = false;
    close();
  };
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(async () => {
    retire();
    await pending?.catch(() => {});
  });
  native.lstat.mockReset().mockResolvedValue({
    isFile: () => true,
    isSymbolicLink: () => false,
    nlink: 1,
    mode: 0o755,
  });
  native.spawn.mockReset().mockImplementation(() => {
    spawned.resolve();
    return child;
  });
  const emit = (value: Record<string, unknown>) =>
    child.stdout.emit("data", Buffer.from(JSON.stringify(value) + "\n"));
  return {
    input,
    child,
    state,
    observe,
    emit,
    lid: (
      sequence: unknown,
      closed: boolean | null,
      internalOnly: boolean | null = closed === true ? true : null,
    ) => emit({ event: "lid", sequence, closed, internalOnly }),
    close,
    revoke: () => {
      current = false;
    },
    adopt: () => {
      adopted = true;
    },
    frames: () => input.write.mock.calls.map(([value]) => JSON.parse(value)),
    ready: async () => {
      pending = startMacPowerLease(["/fixed/mac-keep-awake"], {
        current: () => current,
        state,
        exited: vi.fn(),
        display: { observe, maySleep: () => adopted && physical === true, close: async () => {} },
      });
      await spawned.promise;
      emit({ event: "ready" });
      const lease = await pending;
      expect(lease).not.toBeNull();
      return lease!;
    },
  };
}

describe("native lid/display policy acknowledgement", () => {
  it("echoes only the current lid sequence after actual policy adoption", async (context) => {
    const f = fixture(context);
    const lease = await f.ready();
    lease.renew();
    expect(f.frames().at(-1)).toEqual({
      command: "renew",
      lidSequence: null,
      displayMaySleep: false,
    });
    f.lid(1, true);
    expect(f.observe).toHaveBeenLastCalledWith(true);
    lease.renew();
    expect(f.frames().at(-1)).toEqual({ command: "renew", lidSequence: 1, displayMaySleep: false });
    f.adopt();
    lease.renew();
    expect(f.frames().at(-1)).toEqual({ command: "renew", lidSequence: 1, displayMaySleep: true });
    f.lid(2, false);
    lease.renew();
    expect(f.frames().at(-1)).toEqual({ command: "renew", lidSequence: 2, displayMaySleep: false });
    const calls = f.observe.mock.calls.length;
    const closing = lease.close();
    expect(f.input.end).toHaveBeenCalledTimes(1);
    f.lid(3, true);
    expect(f.observe).toHaveBeenCalledTimes(calls);
    f.close();
    await closing;
    expect(f.observe).toHaveBeenLastCalledWith(null);
  });
  for (const sequence of [1, "2", 1.5]) {
    it(`retires replayed or unsafe lid metadata before policy mutation: ${typeof sequence}`, async (context) => {
      const f = fixture(context);
      const lease = await f.ready();
      f.lid(1, true);
      f.lid(sequence, false);
      expect(f.observe).toHaveBeenCalledTimes(1);
      expect(f.state).toHaveBeenCalledWith({ phase: "unavailable", reason: "native-protocol" });
      expect(f.input.end).toHaveBeenCalledTimes(1);
      f.close();
      await lease.close();
    });
  }
  it("withdraws adoption on unknown lid state, pause and owner retirement", async (context) => {
    const f = fixture(context);
    const lease = await f.ready();
    f.lid(1, true);
    f.adopt();
    f.lid(2, null);
    lease.renew();
    expect(f.frames().at(-1).displayMaySleep).toBe(false);
    f.lid(3, true);
    f.adopt();
    f.emit({ event: "paused", reason: "battery-low" });
    expect(f.observe).toHaveBeenLastCalledWith(null);
    lease.renew();
    expect(f.frames().at(-1).displayMaySleep).toBe(false);
    f.revoke();
    const calls = f.observe.mock.calls.length;
    f.lid(4, true);
    expect(f.observe).toHaveBeenCalledTimes(calls);
    const writes = f.input.write.mock.calls.length;
    lease.renew();
    expect(f.input.write).toHaveBeenCalledTimes(writes);
    f.close();
    await lease.close();
  });
  it("retains ordinary display policy for external monitors and withholds new grants for unknown topology", async (context) => {
    const f = fixture(context);
    const lease = await f.ready();
    f.lid(1, true, false);
    expect(f.observe).toHaveBeenLastCalledWith(false);
    f.adopt();
    lease.renew();
    expect(f.frames().at(-1).displayMaySleep).toBe(false);

    f.lid(2, true, true);
    expect(f.observe).toHaveBeenLastCalledWith(true);
    lease.renew();
    expect(f.frames().at(-1).displayMaySleep).toBe(false);
    f.adopt();
    lease.renew();
    expect(f.frames().at(-1).displayMaySleep).toBe(true);

    const calls = f.observe.mock.calls.length;
    f.lid(3, true, null);
    expect(f.observe).toHaveBeenCalledTimes(calls);
    lease.renew();
    expect(f.frames().at(-1)).toEqual({ command: "renew", lidSequence: 3, displayMaySleep: false });

    f.lid(4, true, false);
    expect(f.observe).toHaveBeenLastCalledWith(false);
    lease.renew();
    expect(f.frames().at(-1).displayMaySleep).toBe(false);
    f.close();
    await lease.close();
  });
});
