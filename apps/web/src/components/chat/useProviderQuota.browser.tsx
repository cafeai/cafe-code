import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ProviderSessionQuotaInput,
  type ProviderSessionQuotaResult,
} from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { render } from "vitest-browser-react";
import { createChatViewFixtureRetirement } from "../chatViewFixtureRetirement.test.fixture";
import { page } from "vitest/browser";
import { useProviderQuota, type ProviderQuotaContext } from "./useProviderQuota";

const { subscribe, connection } = vi.hoisted(() => ({
  subscribe:
    vi.fn<
      (
        input: ProviderSessionQuotaInput,
        listener: (result: ProviderSessionQuotaResult) => void,
        options: { onResubscribe?: () => void },
      ) => () => void
    >(),
  connection: vi.fn(),
}));
vi.mock("../../environments/runtime", () => ({
  requireEnvironmentConnection: (id: unknown) => {
    connection(id);
    return { client: { server: { subscribeProviderQuota: subscribe } } };
  },
}));
const context = {
  environmentId: EnvironmentId.make("local"),
  input: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    session: { threadId: ThreadId.make("chat"), runtimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  },
  scopeRevision: "settings-1",
  connected: true,
} satisfies ProviderQuotaContext;
const result: ProviderSessionQuotaResult = {
  report: { source: "claude-session", observedAt: "2026-10-09T00:00:00.000Z", meters: [] },
};
function Harness({
  scope = context,
  visible = true,
}: {
  scope?: ProviderQuotaContext | undefined;
  visible?: boolean;
}) {
  const value = useProviderQuota(scope, visible);
  return (
    <div>
      <span data-testid="status">{value?.status ?? "absent"}</span>
      <span data-testid="received">{value?.report?.observedAt ?? "none"}</span>
    </div>
  );
}
const retirement = createChatViewFixtureRetirement();
beforeEach(() => retirement.assertIdle());
afterEach(async () => {
  // The exact test owner must finish before mock histories or timer globals
  // can be reused by a later case. onTestFinished alone runs after this hook.
  await retirement.retire();
  vi.useRealTimers();
  vi.clearAllMocks();
});

type QuotaFixturePhase =
  | "setup"
  | "bootstrap"
  | "render"
  | "subscription"
  | "assertion"
  | "rerender";

/** Own original asynchronous operations before the first module/render await. */
function ownQuotaFixture(context: TestContext) {
  let retired = false;
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  let completion: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  let phase: QuotaFixturePhase = "setup";
  let bootstrapReady = false;
  let reportedFailure = false;
  const reportFailure = () => {
    if (reportedFailure) return;
    reportedFailure = true;
    try {
      // Fixed, bounded observations only; no scope IDs or received payloads.
      console.error("Synthetic quota fixture failure phase", {
        phase,
        bootstrapReady,
        pending: Math.min(32, pending.size),
        mounted: mounted !== undefined,
        connectionCalls: Math.min(32, connection.mock.calls.length),
        subscriptionCalls: Math.min(32, subscribe.mock.calls.length),
      });
    } catch {
      // Diagnostics must preserve the original assertion/cleanup outcome.
    }
  };
  const active = () => {
    if (retired || context.signal.aborted) throw new Error("Quota fixture retired");
  };
  const own = async <T,>(step: QuotaFixturePhase, run: () => PromiseLike<T>): Promise<T> => {
    active();
    phase = step;
    const actual = Promise.resolve(run());
    pending.add(actual);
    try {
      const value = await actual;
      active();
      return value;
    } finally {
      pending.delete(actual);
    }
  };
  const cleanup = (): Promise<void> => {
    retired = true;
    context.signal.removeEventListener("abort", onAbort);
    return (completion ??= Promise.resolve().then(async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      await mounted?.unmount();
      mounted = undefined;
    }));
  };
  const onAbort = () => {
    reportFailure();
    void cleanup().catch(() => undefined);
  };
  retirement.admit(cleanup);
  context.onTestFailed(reportFailure);
  context.onTestFinished(cleanup);
  context.signal.addEventListener("abort", onAbort, { once: true });
  if (context.signal.aborted) onAbort();
  return {
    own,
    render: (...args: Parameters<typeof render>) =>
      own("render", async () => {
        // Retain a late mount for exact cleanup before own() fences its caller.
        mounted = await render(...args);
        return mounted;
      }),
    async run(body: () => Promise<void>) {
      let failed = false;
      try {
        // The real hook awaits this already-mocked module before subscribing.
        // Resolve that dependency inside the unchanged enclosing test budget;
        // the original poll still verifies the hook's actual subscription.
        await own("bootstrap", async () => {
          await import("../../environments/runtime");
          bootstrapReady = true;
        });
        active();
        await body();
      } catch (failure) {
        reportFailure();
        failed = true;
        throw failure;
      } finally {
        try {
          await cleanup();
        } catch (failure) {
          if (!failed) throw failure;
        }
      }
    },
  };
}
describe("passive Claude session quota subscription", () => {
  it("accepts native account allowances without a query and rejects an older owner's passive fallback", async (testContext) => {
    const fixture = ownQuotaFixture(testContext);
    await fixture.run(async () => {
      const close = vi.fn();
      subscribe.mockReturnValue(close);
      const scope: ProviderQuotaContext = {
        ...context,
        input: { instanceId: context.input.instanceId },
        nativeOnly: true,
      };
      const mounted = await fixture.render(<Harness scope={scope} />);
      await fixture.own("subscription", () =>
        expect.poll(() => subscribe.mock.calls.length).toBe(1),
      );
      expect(subscribe).toHaveBeenCalledWith(scope.input, expect.any(Function), expect.any(Object));
      subscribe.mock.calls[0]![1](result);
      await fixture.own("assertion", () =>
        expect.element(page.getByTestId("status")).toHaveTextContent("unavailable"),
      );
      await fixture.own("assertion", () =>
        expect.element(page.getByTestId("received")).toHaveTextContent("none"),
      );
      const native: ProviderSessionQuotaResult = {
        report: { ...result.report!, source: "claude-cli" },
      };
      subscribe.mock.calls[0]![1](native);
      await fixture.own("assertion", () =>
        expect.element(page.getByTestId("status")).toHaveTextContent("available"),
      );
      await fixture.own("rerender", () =>
        mounted.rerender(<Harness scope={{ ...scope, selectedModel: "fable" }} />),
      );
      subscribe.mock.calls[0]![2].onResubscribe?.();
      await fixture.own("assertion", () =>
        expect.element(page.getByTestId("status")).toHaveTextContent("loading"),
      );
      expect(subscribe).toHaveBeenCalledOnce();
      const old = subscribe.mock.calls[0]![1];
      await fixture.own("rerender", () =>
        mounted.rerender(<Harness scope={{ ...scope, connected: false }} />),
      );
      old(native);
      await fixture.own("assertion", () =>
        expect.element(page.getByTestId("status")).toHaveTextContent("offline"),
      );
      await fixture.own("assertion", () =>
        expect.element(page.getByTestId("received")).toHaveTextContent("none"),
      );
      expect(close).toHaveBeenCalledOnce();
    });
  });

  it("subscribes only while visible, using the exact environment and typed session", async (testContext) => {
    const fixture = ownQuotaFixture(testContext);
    await fixture.run(async () => {
      const close = vi.fn();
      subscribe.mockReturnValue(close);
      const mounted = await fixture.render(<Harness visible={false} />);
      expect(subscribe).not.toHaveBeenCalled();
      await fixture.own("rerender", () => mounted.rerender(<Harness />));
      await fixture.own("subscription", () =>
        expect.poll(() => subscribe.mock.calls.length).toBe(1),
      );
      expect(connection).toHaveBeenCalledWith(context.environmentId);
      expect(subscribe).toHaveBeenCalledWith(
        context.input,
        expect.any(Function),
        expect.objectContaining({ retryNonTransportErrors: false }),
      );
      subscribe.mock.calls[0]![1](result);
      await fixture.own("assertion", () =>
        expect.element(page.getByTestId("status")).toHaveTextContent("available"),
      );
      await fixture.own("rerender", () => mounted.rerender(<Harness scope={{ ...context }} />));
      expect(subscribe).toHaveBeenCalledOnce();
      await fixture.own("rerender", () => mounted.rerender(<Harness visible={false} />));
      expect(close).toHaveBeenCalledOnce();
      await fixture.own("assertion", () =>
        expect.element(page.getByTestId("received")).toHaveTextContent("none"),
      );
    });
  });
  it("clears previous reports and rejects retired callbacks on exact scope changes", async (testContext) => {
    const fixture = ownQuotaFixture(testContext);
    await fixture.run(async () => {
      subscribe.mockReturnValue(vi.fn());
      const mounted = await fixture.render(<Harness />);
      await fixture.own("subscription", () =>
        expect.poll(() => subscribe.mock.calls.length).toBe(1),
      );
      for (const scope of [
        { ...context, scopeRevision: "reconfigured" },
        { ...context, environmentId: EnvironmentId.make("remote") },
        { ...context, input: { instanceId: ProviderInstanceId.make("different-account") } },
        {
          ...context,
          input: {
            ...context.input,
            session: {
              threadId: ThreadId.make("other-chat"),
              runtimeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            },
          },
        },
      ]) {
        const count = subscribe.mock.calls.length;
        const old = subscribe.mock.calls.at(-1)![1];
        old(result);
        await fixture.own("assertion", () =>
          expect.element(page.getByTestId("received")).toHaveTextContent(result.report!.observedAt),
        );
        await fixture.own("rerender", () => mounted.rerender(<Harness scope={scope} />));
        old(result);
        await fixture.own("subscription", () =>
          expect.poll(() => subscribe.mock.calls.length).toBe(count + 1),
        );
        await fixture.own("assertion", () =>
          expect.element(page.getByTestId("received")).toHaveTextContent("none"),
        );
        await fixture.own("assertion", () =>
          expect.element(page.getByTestId("status")).toHaveTextContent("loading"),
        );
      }
    });
  });
  it("does not subscribe or retain a report when the Claude quota scope is explicitly denied", async (testContext) => {
    const fixture = ownQuotaFixture(testContext);
    await fixture.run(async () => {
      subscribe.mockReturnValue(vi.fn());
      const mounted = await fixture.render(<Harness scope={{ ...context, input: null }} />);
      await fixture.own("assertion", () =>
        expect.element(page.getByTestId("status")).toHaveTextContent("unavailable"),
      );
      expect(subscribe).not.toHaveBeenCalled();
      await fixture.own("rerender", () => mounted.rerender(<Harness />));
      await fixture.own("subscription", () =>
        expect.poll(() => subscribe.mock.calls.length).toBe(1),
      );
      const old = subscribe.mock.calls[0]![1];
      old(result);
      await fixture.own("assertion", () =>
        expect.element(page.getByTestId("received")).toHaveTextContent(result.report!.observedAt),
      );
      await fixture.own("rerender", () =>
        mounted.rerender(<Harness scope={{ ...context, input: null }} />),
      );
      old(result);
      await fixture.own("assertion", () =>
        expect.element(page.getByTestId("received")).toHaveTextContent("none"),
      );
      expect(subscribe).toHaveBeenCalledOnce();
    });
  });
});
