type Retirement = () => Promise<void>;

interface Lease {
  readonly callback: Retirement;
  completion?: Promise<void>;
}

/**
 * Vitest's shared afterEach runs before per-test onTestFinished callbacks. A
 * scoped chat fixture therefore lends that shared hook its exact caller-owned
 * retirement callback: native actions must join before shared DOM/store resets
 * can expose replacement controls. This lease adds no timeout or cancellation
 * policy; an unsettled owner remains held even if a surrounding hook expires.
 * The callback must return its own cleanup promise, never this lease's join:
 * returning retire() itself would create an unsupported self-dependency.
 */
export function createChatViewFixtureRetirement(): {
  admit(callback: Retirement): void;
  assertIdle(): void;
  retire(): Promise<void>;
} {
  let owner: Lease | undefined;

  const assertIdle = () => {
    if (owner) throw new Error("The previous scoped chat fixture has not finished retirement.");
  };

  return {
    admit(callback) {
      if (owner) {
        if (owner.callback === callback) return;
        throw new Error("A different scoped chat fixture still owns retirement.");
      }
      owner = { callback };
    },

    assertIdle,

    retire() {
      const lease = owner;
      if (!lease) return Promise.resolve();
      if (lease.completion) return lease.completion;

      let resolveCompletion!: () => void;
      let rejectCompletion!: (failure: unknown) => void;
      const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      // Publish the join BEFORE calling user cleanup. Synchronous reentrant
      // retire() calls must observe this exact completion, never call the
      // native/mount cleanup twice or temporarily open another admission slot.
      lease.completion = completion;
      const release = () => {
        if (owner === lease) owner = undefined;
      };
      try {
        void Promise.resolve(lease.callback()).then(
          () => {
            release();
            resolveCompletion();
          },
          (failure: unknown) => {
            release();
            // Received failures are opaque. Preserve their exact identity for
            // the original test/hook; never stringify or wrap them as success.
            rejectCompletion(failure);
          },
        );
      } catch (failure) {
        // A synchronous callback throw is already actual settlement, not a
        // cancellation/deadline signal authorizing premature lease release.
        release();
        rejectCompletion(failure);
      }
      return completion;
    },
  };
}
