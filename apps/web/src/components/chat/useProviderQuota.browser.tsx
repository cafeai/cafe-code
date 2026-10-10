import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ProviderSessionQuotaInput,
  type ProviderSessionQuotaResult,
} from "@cafecode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
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
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("passive Claude session quota subscription", () => {
  it("subscribes only while visible, using the exact environment and typed session", async () => {
    const close = vi.fn();
    subscribe.mockReturnValue(close);
    const mounted = await render(<Harness visible={false} />);
    expect(subscribe).not.toHaveBeenCalled();
    await mounted.rerender(<Harness />);
    await expect.poll(() => subscribe.mock.calls.length).toBe(1);
    expect(connection).toHaveBeenCalledWith(context.environmentId);
    expect(subscribe).toHaveBeenCalledWith(
      context.input,
      expect.any(Function),
      expect.objectContaining({ retryNonTransportErrors: false }),
    );
    subscribe.mock.calls[0]![1](result);
    await expect.element(page.getByTestId("status")).toHaveTextContent("available");
    await mounted.rerender(<Harness scope={{ ...context }} />);
    expect(subscribe).toHaveBeenCalledOnce();
    await mounted.rerender(<Harness visible={false} />);
    expect(close).toHaveBeenCalledOnce();
    await expect.element(page.getByTestId("received")).toHaveTextContent("none");
  });
  it("clears previous reports and rejects retired callbacks on exact scope changes", async () => {
    subscribe.mockReturnValue(vi.fn());
    const mounted = await render(<Harness />);
    await expect.poll(() => subscribe.mock.calls.length).toBe(1);
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
      await expect
        .element(page.getByTestId("received"))
        .toHaveTextContent(result.report!.observedAt);
      await mounted.rerender(<Harness scope={scope} />);
      old(result);
      await expect.poll(() => subscribe.mock.calls.length).toBe(count + 1);
      await expect.element(page.getByTestId("received")).toHaveTextContent("none");
      await expect.element(page.getByTestId("status")).toHaveTextContent("loading");
    }
  });
  it("clears offline and resubscribe readings, handles null snapshots without zero, then recovers", async () => {
    subscribe.mockReturnValue(vi.fn());
    const mounted = await render(<Harness />);
    await expect.poll(() => subscribe.mock.calls.length).toBe(1);
    const old = subscribe.mock.calls[0]![1];
    old(result);
    await expect.element(page.getByTestId("status")).toHaveTextContent("available");
    subscribe.mock.calls[0]![2].onResubscribe?.();
    await expect.element(page.getByTestId("received")).toHaveTextContent("none");
    old({ report: null });
    await expect.element(page.getByTestId("status")).toHaveTextContent("unavailable");
    await mounted.rerender(<Harness scope={{ ...context, connected: false }} />);
    old(result);
    await expect.element(page.getByTestId("status")).toHaveTextContent("offline");
    await expect.element(page.getByTestId("received")).toHaveTextContent("none");
    await mounted.rerender(<Harness />);
    await expect.poll(() => subscribe.mock.calls.length).toBe(2);
    subscribe.mock.calls.at(-1)![1](result);
    await expect.element(page.getByTestId("status")).toHaveTextContent("available");
  });
  it("shows unavailable for an older/failed endpoint and an undelivered first snapshot", async () => {
    subscribe.mockImplementationOnce(() => {
      throw new Error("unsupported endpoint");
    });
    const mounted = await render(<Harness />);
    await expect.element(page.getByTestId("status")).toHaveTextContent("unavailable");
    vi.useFakeTimers();
    subscribe.mockReturnValue(vi.fn());
    await mounted.rerender(<Harness scope={{ ...context, scopeRevision: "new-generation" }} />);
    await expect.poll(() => subscribe.mock.calls.length).toBe(2);
    await vi.advanceTimersByTimeAsync(6_000);
    await expect.element(page.getByTestId("status")).toHaveTextContent("unavailable");
  });
  it("does not borrow an instance-wide report when a Claude chat has no exact native query", async () => {
    subscribe.mockReturnValue(vi.fn());
    const mounted = await render(<Harness scope={{ ...context, input: null }} />);
    await expect.element(page.getByTestId("status")).toHaveTextContent("unavailable");
    expect(subscribe).not.toHaveBeenCalled();
    await mounted.rerender(<Harness />);
    await expect.poll(() => subscribe.mock.calls.length).toBe(1);
    const old = subscribe.mock.calls[0]![1];
    old(result);
    await expect.element(page.getByTestId("received")).toHaveTextContent(result.report!.observedAt);
    await mounted.rerender(<Harness scope={{ ...context, input: null }} />);
    old(result);
    await expect.element(page.getByTestId("received")).toHaveTextContent("none");
    expect(subscribe).toHaveBeenCalledOnce();
  });
});
