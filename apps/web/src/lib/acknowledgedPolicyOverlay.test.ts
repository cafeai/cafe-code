import { describe, expect, it, vi } from "vitest";
import {
  saveAcknowledgedPolicyOverlay,
  type PolicyOverlayScope,
} from "./acknowledgedPolicyOverlay";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((succeed, fail) => {
    resolve = succeed;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Policy = number | null | { codex?: number; claude?: number };
function harness(requested: Policy) {
  const scope: PolicyOverlayScope = { active: true, dispose: null };
  const listeners = new Set<() => void>();
  let sequence: number | undefined;
  let canonical: Policy | undefined;
  let overlay: Policy | undefined;
  let current = true;
  const ack = deferred<{ sequence: number }>();
  const dispatch = vi.fn(() => ack.promise);
  const unsubscribe = vi.fn();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const input = {
    scope,
    requested,
    dispatch,
    isCurrent: () => current,
    readSequence: () => sequence,
    readCanonical: () => canonical,
    readOverlay: () => overlay,
    writeOverlay: (value: Policy | undefined) => {
      overlay = value;
      notify();
    },
    equal: (left: Policy | undefined, right: Policy | undefined) =>
      JSON.stringify(left) === JSON.stringify(right),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        unsubscribe();
        listeners.delete(listener);
      };
    },
  };
  return {
    scope,
    input,
    ack,
    dispatch,
    unsubscribe,
    listeners,
    read: () => overlay,
    retire() {
      current = false;
      scope.active = false;
      scope.dispose?.();
    },
    setOverlay(value: Policy) {
      overlay = value;
    },
    project(value: Policy, cursor?: number) {
      canonical = value;
      sequence = cursor;
      notify();
    },
    unrelatedProjection: notify,
    save: () => saveAcknowledgedPolicyOverlay(input),
  };
}

describe.each([700_000, null, { codex: 6, claude: 8 }, { claude: 8 }] satisfies Policy[])(
  "ACK overlay for %j",
  (requested) => {
    it.each(["before", "after"])("lets newer canonical policy win %s the ACK", async (timing) => {
      const h = harness(requested);
      const save = h.save();
      expect(h.dispatch).toHaveBeenCalledOnce();
      expect(h.read()).toBeUndefined();
      if (timing === "after") {
        h.ack.resolve({ sequence: 2 });
        await save;
        expect(h.read()).toEqual(requested);
      }
      h.project(900_000, 3);
      h.ack.resolve({ sequence: 2 });
      await save;
      expect(h.read()).toBeUndefined();
      expect(h.listeners.size).toBe(0);
      expect(h.unsubscribe).toHaveBeenCalledOnce();
    });
    it("waits for the exact field witness and preserves lag through unrelated projections", async () => {
      const h = harness(requested);
      h.project(900_000, 1);
      const save = h.save();
      h.ack.resolve({ sequence: 2 });
      await save;
      expect(h.read()).toEqual(requested);
      h.unrelatedProjection();
      expect(h.read()).toEqual(requested);
      h.project(requested, 2);
      expect(h.read()).toBeUndefined();
      expect(h.unsubscribe).toHaveBeenCalledOnce();
    });
    it.each(["before", "after"])("retires exact owner authority %s the ACK", async (timing) => {
      const h = harness(requested);
      const save = h.save();
      if (timing === "after") {
        h.ack.resolve({ sequence: 2 });
        await save;
        expect(h.read()).toEqual(requested);
      }
      h.retire();
      h.ack.resolve({ sequence: 2 });
      await save;
      expect(h.read()).toBeUndefined();
      expect(h.listeners.size).toBe(0);
      expect(h.unsubscribe).toHaveBeenCalledOnce();
    });
    it("does not clear a replacement draft value when the owner retires", async () => {
      const h = harness(requested);
      const save = h.save();
      h.ack.resolve({ sequence: 2 });
      await save;
      h.setOverlay(123_456);
      h.retire();
      expect(h.read()).toBe(123_456);
    });
    it("does not reinstall an earlier write after a replacement write has ownership", async () => {
      const h = harness(requested);
      const old = h.save();
      const latest = deferred<{ sequence: number }>();
      const replacement = saveAcknowledgedPolicyOverlay({
        ...h.input,
        requested: 123_456,
        dispatch: () => latest.promise,
      });
      latest.resolve({ sequence: 3 });
      await replacement;
      h.ack.resolve({ sequence: 2 });
      await old;
      expect(h.read()).toBe(123_456);
      expect(h.listeners.size).toBe(1);
      h.project(123_456, 3);
      expect(h.read()).toBeUndefined();
      expect(h.listeners.size).toBe(0);
    });
    it("releases a failed write without installing policy", async () => {
      const h = harness(requested);
      const saved = h.save();
      const rejected = expect(saved).rejects.toThrow("refused");
      h.ack.reject(new Error("refused"));
      await rejected;
      expect(h.read()).toBeUndefined();
      expect(h.listeners.size).toBe(0);
      expect(h.unsubscribe).toHaveBeenCalledOnce();
    });
  },
);
