import "../../index.css";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ThreadId,
  ProviderDriverKind,
  type DesktopBridge,
  type NativeControlActivity,
} from "@cafecode/contracts";
import { ComputerUseButton } from "./ComputerUseButton";
import { TooltipProvider } from "../ui/tooltip";

it("shares one authoritative feed, shows activity and sends exact Stop without changing another chat", async () => {
  const previous = window.desktopBridge;
  const threadId = ThreadId.make("indicator-browser-fixture");
  const initial: NativeControlActivity = {
    version: 1,
    generation: "browser-indicator-fixture",
    sequence: 0,
    episode: null,
    threadId: null,
    provider: null,
    providerInstanceId: null,
    phase: "inactive",
    inputPolicy: "foreground-allowed",
    inputRoute: "unknown",
    usingSystemPointer: false,
    target: null,
    lastCaptureAt: null,
  };
  let listener: ((activity: NativeControlActivity) => void) | undefined;
  const subscribe = vi.fn((next: typeof listener) => {
    listener = next;
    return () => {
      listener = undefined;
    };
  });
  const stop = vi.fn(async () => {});
  const getActivity = vi.fn(async () => initial);
  window.desktopBridge = {
    ...previous,
    getNativeControlActivity: getActivity,
    onNativeControlActivity: subscribe,
    stopNativeControlActivity: stop,
    getNativeControlChatState: async (requestedId) => ({
      threadId: requestedId,
      revision: 1,
      enabled: true,
      control: {
        platform: "darwin",
        enabled: true,
        phase: "ready",
        driverVersion: "fixture",
        runtimeAvailable: true,
        detail: "fixture",
      },
    }),
    setNativeControlChatEnabled: vi.fn(),
    onNativeControlChanged: () => () => {},
  } as DesktopBridge;
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={query}>
      <TooltipProvider>
        <ComputerUseButton threadId={threadId} provider={ProviderDriverKind.make("codex")} local />
        <ComputerUseButton
          threadId={ThreadId.make("other-chat")}
          provider={ProviderDriverKind.make("codex")}
          local
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  try {
    await expect
      .element(page.getByRole("button", { name: "Computer use", exact: true }).first())
      .toBeVisible();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(getActivity).toHaveBeenCalledOnce();
    listener!({
      ...initial,
      sequence: 1,
      episode: "episode",
      threadId,
      provider: "codex",
      providerInstanceId: "fixture-account",
      phase: "capturing",
      target: { scope: "window", app: "Fixture", title: "Canvas" },
    });
    await expect.element(page.getByRole("status")).toHaveTextContent("Taking a screenshot");
    await page.getByRole("button", { name: "Stop computer use", exact: true }).click();
    expect(stop).toHaveBeenCalledExactlyOnceWith("episode");
    listener!({ ...initial, sequence: 0 });
    await expect.element(page.getByRole("status")).toHaveTextContent("Taking a screenshot");
    listener!({
      ...initial,
      sequence: 2,
      episode: "episode",
      threadId,
      provider: "codex",
      phase: "stopping",
    });
    await expect.element(page.getByRole("status")).toHaveTextContent("Stopping…");
    await expect
      .element(page.getByRole("button", { name: "Stop computer use", exact: true }))
      .toBeDisabled();
    expect(getActivity).toHaveBeenCalledOnce();
  } finally {
    await view.unmount();
    if (previous) window.desktopBridge = previous;
    else delete window.desktopBridge;
    query.clear();
  }
});
