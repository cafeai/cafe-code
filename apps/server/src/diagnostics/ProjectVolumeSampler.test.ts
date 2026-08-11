import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerProjectVolumeTelemetry } from "@cafecode/contracts";
import * as Schema from "effect/Schema";

import type { ProjectVolumeCounters, ProjectVolumeReader } from "./ProjectVolumeTelemetry.ts";
import {
  makeProjectVolumeSampler,
  PROJECT_VOLUME_RETRY_COOLDOWN_MS,
} from "./ProjectVolumeSampler.ts";

const AVAILABLE_COUNTERS: ProjectVolumeCounters = {
  blockSize: 10n,
  blocks: 100n,
  freeBlocks: 30n,
  availableBlocks: 20n,
};

const decodeServerProjectVolumeTelemetry = Schema.decodeUnknownSync(ServerProjectVolumeTelemetry);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function unavailableResult() {
  return {
    status: "unavailable",
    totalBytes: null,
    usedBytes: null,
    availableBytes: null,
    utilizationPercent: null,
    projectVolumeOnly: true,
    detail: "Project-volume telemetry is unavailable.",
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ProjectVolumeSampler", () => {
  it("caches a successful read for ten seconds from operation completion", async () => {
    let now = 100;
    const read = vi.fn(async () => AVAILABLE_COUNTERS);
    const sampler = makeProjectVolumeSampler({ read }, { nowMonotonicMillis: () => now });

    const first = await sampler.read("project-root");
    now = 10_099;
    const cached = await sampler.read("project-root");
    now = 10_100;
    const refreshed = await sampler.read("project-root");

    expect(first.status).toBe("available");
    expect(cached).toBe(first);
    expect(refreshed.status).toBe("available");
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(1, "project-root", 2_000);
  });

  it("coalesces concurrent waiters for the exact same root", async () => {
    const operation = deferred<ProjectVolumeCounters>();
    const read = vi.fn(() => operation.promise);
    const sampler = makeProjectVolumeSampler({ read }, { nowMonotonicMillis: () => 1_000 });

    const first = sampler.read("project-root");
    const second = sampler.read("project-root");
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);

    operation.resolve(AVAILABLE_COUNTERS);
    await expect(first).resolves.toMatchObject({ status: "available" });
    await expect(second).resolves.toMatchObject({ status: "available" });
  });

  it("holds bounded admission until actual operations settle", async () => {
    const operations = new Map<string, ReturnType<typeof deferred<ProjectVolumeCounters>>>();
    const reader: ProjectVolumeReader = {
      read: (root) => {
        const operation = deferred<ProjectVolumeCounters>();
        operations.set(root, operation);
        return operation.promise;
      },
    };
    const sampler = makeProjectVolumeSampler(
      reader,
      { nowMonotonicMillis: () => 1_000 },
      {
        maxInFlightReads: 2,
      },
    );

    const first = sampler.read("root-a");
    const second = sampler.read("root-b");
    await Promise.resolve();
    await expect(sampler.read("root-c")).resolves.toEqual(unavailableResult());

    operations.get("root-a")?.resolve(AVAILABLE_COUNTERS);
    await expect(first).resolves.toMatchObject({ status: "available" });
    const third = sampler.read("root-c");
    await Promise.resolve();
    expect(operations.has("root-c")).toBe(true);

    operations.get("root-b")?.resolve(AVAILABLE_COUNTERS);
    operations.get("root-c")?.resolve(AVAILABLE_COUNTERS);
    await expect(second).resolves.toMatchObject({ status: "available" });
    await expect(third).resolves.toMatchObject({ status: "available" });
  });

  it("does not release admission or start cooldown when only a waiter times out", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const operation = deferred<ProjectVolumeCounters>();
    const read = vi.fn(() => operation.promise);
    const sampler = makeProjectVolumeSampler({ read }, { nowMonotonicMillis: () => now });

    const first = sampler.read("project-root");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_250);
    await expect(first).resolves.toEqual(unavailableResult());

    now = 2_000;
    const second = sampler.read("project-root");
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    operation.resolve(AVAILABLE_COUNTERS);
    await expect(second).resolves.toMatchObject({ status: "available" });
  });

  it("starts retry cooldown only after an actual rejected operation", async () => {
    let now = 1_000;
    const read = vi
      .fn<ProjectVolumeReader["read"]>()
      .mockRejectedValueOnce(new Error("private root detail"))
      .mockResolvedValue(AVAILABLE_COUNTERS);
    const sampler = makeProjectVolumeSampler({ read }, { nowMonotonicMillis: () => now });

    await expect(sampler.read("private-root")).resolves.toEqual(unavailableResult());
    now += PROJECT_VOLUME_RETRY_COOLDOWN_MS - 1;
    await expect(sampler.read("private-root")).resolves.toEqual(unavailableResult());
    expect(read).toHaveBeenCalledTimes(1);

    now += 1;
    await expect(sampler.read("private-root")).resolves.toMatchObject({ status: "available" });
    expect(read).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(await sampler.read("private-root"))).not.toContain("private-root");
  });

  it("places invalid counter results in the same operation-owned cooldown", async () => {
    let now = 10;
    const read = vi
      .fn<ProjectVolumeReader["read"]>()
      .mockResolvedValueOnce({ ...AVAILABLE_COUNTERS, availableBlocks: 31n })
      .mockResolvedValue(AVAILABLE_COUNTERS);
    const sampler = makeProjectVolumeSampler({ read }, { nowMonotonicMillis: () => now });

    await expect(sampler.read("project-root")).resolves.toEqual(unavailableResult());
    now += PROJECT_VOLUME_RETRY_COOLDOWN_MS - 1;
    await expect(sampler.read("project-root")).resolves.toEqual(unavailableResult());
    now += 1;
    await expect(sampler.read("project-root")).resolves.toMatchObject({ status: "available" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("invalidates cache and cooldown safely after a monotonic-clock rollback", async () => {
    let now = 1_000;
    const read = vi
      .fn<ProjectVolumeReader["read"]>()
      .mockResolvedValueOnce(AVAILABLE_COUNTERS)
      .mockRejectedValueOnce(new Error("failure"))
      .mockResolvedValue(AVAILABLE_COUNTERS);
    const sampler = makeProjectVolumeSampler({ read }, { nowMonotonicMillis: () => now });

    await sampler.read("cached-root");
    now = 500;
    await sampler.read("cached-root");
    expect(read).toHaveBeenCalledTimes(2);

    now = 400;
    await sampler.read("cached-root");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("evicts the oldest success when the bounded cache is full", async () => {
    let now = 1_000;
    const read = vi.fn(async () => AVAILABLE_COUNTERS);
    const sampler = makeProjectVolumeSampler(
      { read },
      { nowMonotonicMillis: () => now },
      {
        maxCachedRoots: 2,
      },
    );

    await sampler.read("root-a");
    now += 1;
    await sampler.read("root-b");
    now += 1;
    await sampler.read("root-c");
    now += 1;
    await sampler.read("root-a");

    expect(read).toHaveBeenCalledTimes(4);
  });

  it("keeps roots isolated and never sends one root's sample to another", async () => {
    const reader: ProjectVolumeReader = {
      read: async (root) =>
        root === "root-a"
          ? AVAILABLE_COUNTERS
          : { ...AVAILABLE_COUNTERS, freeBlocks: 10n, availableBlocks: 10n },
    };
    const sampler = makeProjectVolumeSampler(reader, { nowMonotonicMillis: () => 1_000 });

    const first = await sampler.read("root-a");
    const second = await sampler.read("root-b");

    expect(first).toMatchObject({ usedBytes: 700, availableBytes: 200 });
    expect(second).toMatchObject({ usedBytes: 900, availableBytes: 100 });
  });

  it("fails an invalid root closed without invoking the reader", async () => {
    const read = vi.fn(async () => AVAILABLE_COUNTERS);
    const sampler = makeProjectVolumeSampler({ read }, { nowMonotonicMillis: () => 1_000 });

    await expect(sampler.read("")).resolves.toEqual(unavailableResult());
    expect(read).not.toHaveBeenCalled();
  });

  it("produces results that decode at the transport schema boundary", async () => {
    const sampler = makeProjectVolumeSampler(
      { read: async () => AVAILABLE_COUNTERS },
      { nowMonotonicMillis: () => 1_000 },
    );
    const result = await sampler.read("project-root");

    expect(decodeServerProjectVolumeTelemetry(result)).toEqual(result);
  });
});
