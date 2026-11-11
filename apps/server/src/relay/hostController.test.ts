import { expect, it, vi, type TestContext } from "vitest";
import { Lifetime } from "@cafecode/relay/lifetime";
import { RelayHostController, type ControlledRelayHost } from "./hostController.ts";

function fixture(test: TestContext) {
  const gates: (() => void)[] = [];
  const owners: { close: () => Promise<void> }[] = [];
  // Register retirement before starting any asynchronous acquisition. Held
  // fixture gates always drain before the exact controller is joined.
  const retire = () => {
    for (const gate of gates) gate();
    for (const owner of owners) void owner.close().catch(() => {});
  };
  test.signal.addEventListener("abort", retire, { once: true });
  test.onTestFinished(async () => {
    retire();
    await Promise.allSettled(owners.map((owner) => owner.close()));
    test.signal.removeEventListener("abort", retire);
  });
  return {
    gate() {
      const gate = Promise.withResolvers<void>();
      gates.push(() => gate.resolve());
      return gate;
    },
    own<T extends ControlledRelayHost>(owner: RelayHostController<T>) {
      owners.push(owner);
      return owner;
    },
  };
}

function host() {
  let active = true;
  return {
    get active() {
      return active;
    },
    stats: () => ({ servingNodes: ["node"], sessions: 0, pendingHandshakes: 0 }),
    start: vi.fn(async () => {}),
    retire: vi.fn(() => {
      active = false;
    }),
    close: vi.fn(async () => {
      active = false;
    }),
  };
}

it("stays off until enabled and persisted, then revokes before waiting for native close", async (test) => {
  const f = fixture(test),
    value = host(),
    closed = f.gate(),
    started = f.gate();
  value.close.mockImplementation(() => closed.promise);
  const create = vi.fn(async (_: Lifetime) => [{ host: value }]);
  const owner = f.own(new RelayHostController(create, () => started.resolve()));
  owner.start();
  owner.request(true, false);
  await Promise.resolve();
  expect(create).not.toHaveBeenCalled();
  owner.request(true, true);
  await started.promise;
  expect(owner.phase).toBe("connected");
  owner.request(false, false);
  expect(value.active).toBe(false);
  expect(owner.entries).toEqual([]);
  expect(owner.phase).toBe("stopping");
  const closing = owner.close();
  closed.resolve();
  await closing;
  expect(owner.phase).toBe("off");
  expect(create).toHaveBeenCalledTimes(1);
});

it("coalesces close/open/close/on behind a held preparation and joins it before replacement", async (test) => {
  const f = fixture(test),
    preparation = f.gate(),
    closing = f.gate(),
    secondStarted = f.gate();
  const first = host(),
    second = host();
  first.close.mockImplementation(() => closing.promise);
  const create = vi.fn(async (lifetime: Lifetime) => {
    if (create.mock.calls.length === 1) await preparation.promise;
    if (create.mock.calls.length === 1) expect(lifetime.active).toBe(false);
    return [{ host: create.mock.calls.length === 1 ? first : second }];
  });
  const onStarted = vi.fn(() => secondStarted.resolve());
  const owner = f.own(new RelayHostController(create, onStarted));
  owner.request(true, true);
  owner.start();
  owner.request(false, false);
  owner.request(true, true);
  owner.request(false, false);
  owner.request(true, true);
  preparation.resolve();
  await expect.poll(() => first.close.mock.calls.length).toBe(1);
  expect(create).toHaveBeenCalledTimes(1);
  expect(onStarted).not.toHaveBeenCalled();
  closing.resolve();
  await secondStarted.promise;
  expect(create).toHaveBeenCalledTimes(2);
  expect(first.start).not.toHaveBeenCalled();
  expect(second.start).toHaveBeenCalledTimes(1);
  expect(onStarted).toHaveBeenCalledExactlyOnceWith({ host: second });
});

it("rediscovers after a retired descriptor and preserves the exact failed-stop owner", async (test) => {
  const f = fixture(test),
    first = host(),
    second = host();
  const started = f.gate(),
    replacement = f.gate();
  const create = vi.fn(async (_: Lifetime) => [
    { host: create.mock.calls.length === 1 ? first : second },
  ]);
  const owner = f.own(
    new RelayHostController(create, () => {
      if (create.mock.calls.length === 1) started.resolve();
      else replacement.resolve();
    }),
  );
  owner.request(true, true);
  owner.start();
  await started.promise;
  first.retire();
  owner.request(true, true);
  await replacement.promise;
  expect(first.close).toHaveBeenCalledTimes(1);
  expect(owner.entries).toEqual([{ host: second }]);
  second.close.mockRejectedValue(new Error("test-owned-stop-refusal"));
  owner.request(true, true, true);
  await expect.poll(() => second.close.mock.calls.length).toBe(1);
  owner.request(true, true, true);
  await Promise.resolve();
  expect(create).toHaveBeenCalledTimes(2);
  expect(owner.entries).toEqual([]);
});

it("never publishes a late start after Off and close joins the original start", async (test) => {
  const f = fixture(test),
    value = host(),
    entering = f.gate(),
    start = f.gate();
  value.start.mockImplementation(async () => {
    entering.resolve();
    await start.promise;
  });
  const adopted = vi.fn();
  const owner = f.own(new RelayHostController(async () => [{ host: value }], adopted));
  owner.request(true, true);
  owner.start();
  await entering.promise;
  owner.request(false, false);
  expect(value.active).toBe(false);
  const closing = owner.close();
  start.resolve();
  await closing;
  expect(adopted).not.toHaveBeenCalled();
  expect(owner.entries).toEqual([]);
});
