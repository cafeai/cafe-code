import { afterEach, expect, it, vi } from "vitest";
import { deferred } from "../../../test/deferred";
import { subscribeMetadata } from "./metadataSubscription";
afterEach(() => vi.useRealTimers());
it("publishes snapshots, revalidates on reconnect and fences retired callbacks", () => {
  vi.useFakeTimers();
  const values: string[] = [];
  const close = vi.fn();
  let push!: (v: string) => void, reset!: () => void;
  const dispose = subscribeMetadata({
    loading: "loading",
    unavailable: "unavailable",
    publish: (v) => values.push(v),
    subscribe: (p, r) => {
      push = p;
      reset = r;
      return close;
    },
  });
  expect(values).toEqual(["loading"]);
  push("current");
  vi.advanceTimersByTime(6000);
  expect(values).toEqual(["loading", "current"]);
  reset();
  vi.advanceTimersByTime(6000);
  expect(values.at(-1)).toBe("unavailable");
  push("recovered");
  expect(values.at(-1)).toBe("recovered");
  dispose();
  dispose();
  push("retired");
  reset();
  vi.advanceTimersByTime(6000);
  expect(values.at(-1)).toBe("recovered");
  expect(close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("closes a subscription acquired after retirement without publishing stale data", async () => {
  vi.useFakeTimers();
  const acquired = deferred<() => void>();
  const close = vi.fn(),
    publish = vi.fn();
  let push!: (v: string) => void;
  const dispose = subscribeMetadata({
    loading: "loading",
    unavailable: "unavailable",
    publish,
    subscribe: (p) => {
      push = p;
      return acquired.promise;
    },
  });
  dispose();
  acquired.resolve(close);
  await acquired.promise;
  await Promise.resolve();
  push("stale");
  expect(publish).toHaveBeenCalledExactlyOnceWith("loading");
  expect(close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["throw", "reject"] as const)(
  "maps %s to unavailable without exposing received errors",
  async (mode) => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const dispose = subscribeMetadata({
      loading: "loading",
      unavailable: "unavailable",
      publish,
      subscribe: () => {
        if (mode === "throw") throw new Error("private");
        return Promise.reject(new Error("private"));
      },
    });
    await Promise.resolve();
    expect(publish).toHaveBeenLastCalledWith("unavailable");
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  },
);
