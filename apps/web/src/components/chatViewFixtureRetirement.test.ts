import { describe, expect, it } from "vitest";
import { createChatViewFixtureRetirement } from "./chatViewFixtureRetirement.test.fixture";

function deferred() {
  let resolve!: () => void;
  let reject!: (failure: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("scoped chat fixture retirement", () => {
  it("leaves an idle fixture inert without manufacturing a cleanup owner", async () => {
    const retirement = createChatViewFixtureRetirement();
    expect(() => retirement.assertIdle()).not.toThrow();
    await retirement.retire();
    expect(() => retirement.assertIdle()).not.toThrow();
    let calls = 0;
    retirement.admit(async () => {
      calls += 1;
    });
    await retirement.retire();
    expect(calls).toBe(1);
    expect(() => retirement.assertIdle()).not.toThrow();
  });

  it("holds reset and replacement admission until one exact cleanup actually settles", async () => {
    const retirement = createChatViewFixtureRetirement();
    const held = deferred();
    let calls = 0;
    let replacementCalls = 0;
    const callback = () => {
      calls += 1;
      return held.promise;
    };
    const replacement = async () => {
      replacementCalls += 1;
    };
    retirement.admit(callback);
    retirement.admit(callback);
    expect(() => retirement.assertIdle()).toThrow("not finished retirement");
    expect(() => retirement.admit(replacement)).toThrow("still owns retirement");
    const first = retirement.retire();
    try {
      const second = retirement.retire();
      expect(second).toBe(first);
      expect(calls).toBe(1);
      expect(replacementCalls).toBe(0);
      retirement.admit(callback);
      expect(() => retirement.assertIdle()).toThrow("not finished retirement");
      expect(() => retirement.admit(replacement)).toThrow("still owns retirement");
      expect(calls).toBe(1);
      expect(replacementCalls).toBe(0);
    } finally {
      held.resolve();
      await first;
    }
    expect(() => retirement.assertIdle()).not.toThrow();
    retirement.admit(replacement);
    await retirement.retire();
    expect(replacementCalls).toBe(1);
    expect(calls).toBe(1);
  });

  it("publishes the same join before invoking reentrant caller cleanup", async () => {
    const retirement = createChatViewFixtureRetirement();
    const held = deferred();
    let reentrant: Promise<void> | undefined;
    let calls = 0;
    const callback = () => {
      calls += 1;
      reentrant = retirement.retire();
      retirement.admit(callback);
      expect(() => retirement.assertIdle()).toThrow("not finished retirement");
      expect(() => retirement.admit(async () => {})).toThrow("still owns retirement");
      return held.promise;
    };
    retirement.admit(callback);
    const completion = retirement.retire();
    try {
      expect(reentrant).toBe(completion);
      expect(calls).toBe(1);
      expect(retirement.retire()).toBe(completion);
    } finally {
      held.resolve();
      await completion;
    }
    expect(() => retirement.assertIdle()).not.toThrow();
  });

  it("preserves an opaque cleanup rejection for every join and admits only its settled successor", async () => {
    const retirement = createChatViewFixtureRetirement();
    const held = deferred();
    const failure = Object.freeze({ synthetic: "opaque cleanup failure" });
    let calls = 0;
    retirement.admit(() => {
      calls += 1;
      return held.promise;
    });
    const first = retirement.retire();
    const second = retirement.retire();
    // Attach rejection observation before releasing the exact held promise;
    // neither an ignored finally tail nor raw-error coercion owns this failure.
    const observed = first.then(
      () => undefined,
      (received: unknown) => received,
    );
    try {
      expect(() => retirement.assertIdle()).toThrow("not finished retirement");
      held.reject(failure);
      expect(await observed).toBe(failure);
      await expect(second).rejects.toBe(failure);
    } finally {
      held.resolve();
      await observed;
    }
    expect(calls).toBe(1);
    expect(() => retirement.assertIdle()).not.toThrow();
    let successorCalls = 0;
    retirement.admit(async () => {
      successorCalls += 1;
    });
    await retirement.retire();
    expect(successorCalls).toBe(1);
  });

  it("returns the original synchronous throw as a rejection without replaying cleanup", async () => {
    const retirement = createChatViewFixtureRetirement();
    const failure = Object.freeze({ synthetic: "synchronous cleanup failure" });
    let calls = 0;
    let reentrant: Promise<void> | undefined;
    retirement.admit(() => {
      calls += 1;
      reentrant = retirement.retire();
      throw failure;
    });
    const completion = retirement.retire();
    expect(reentrant).toBe(completion);
    await expect(completion).rejects.toBe(failure);
    expect(calls).toBe(1);
    expect(() => retirement.assertIdle()).not.toThrow();
    await retirement.retire();
    expect(calls).toBe(1);
  });
});
