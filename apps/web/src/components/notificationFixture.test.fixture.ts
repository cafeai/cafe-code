import type { ReactElement } from "react";
import type { TestContext } from "vitest";
import { render } from "vitest-browser-react";

/** Install before render/input, and join from afterEach before mock resets. */
export function ownNotificationFixture({ signal, onTestFinished }: TestContext) {
  let retired = false;
  let completion: Promise<void> | undefined;
  const renders = new Set<ReturnType<typeof render>>();
  const operations = new Set<Promise<unknown>>();
  const releases = new Set<() => void>();
  const assertActive = () => {
    if (retired || signal.aborted) throw new Error("Notification fixture retired.");
  };
  const retire = () => {
    if (retired) return;
    retired = true;
    signal.removeEventListener("abort", retire);
    for (const release of releases) release();
  };
  const cleanup = () => {
    retire();
    return (completion ??= (async () => {
      await Promise.allSettled(operations);
      for (const pending of renders) {
        const mounted = await pending.catch(() => null);
        await mounted?.unmount();
      }
    })());
  };
  onTestFinished(cleanup);
  signal.addEventListener("abort", retire, { once: true });
  if (signal.aborted) retire();
  return {
    cleanup,
    onRetire: (release: () => void) => releases.add(release),
    async mount(element: ReactElement) {
      assertActive();
      const pending = render(element).then((view) => {
        let unmount: Promise<void> | undefined;
        return { ...view, unmount: () => (unmount ??= view.unmount()) };
      });
      renders.add(pending);
      const mounted = await pending;
      assertActive();
      return mounted;
    },
    async run<A>(operation: () => Promise<A>): Promise<A> {
      assertActive();
      const pending = operation();
      operations.add(pending);
      try {
        const result = await pending;
        assertActive();
        return result;
      } finally {
        operations.delete(pending);
      }
    },
  };
}
