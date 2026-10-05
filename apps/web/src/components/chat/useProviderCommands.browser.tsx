import { useState } from "react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderCommandsInput,
  type ProviderCommandCatalog,
} from "@cafecode/contracts";
import { render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { useProviderCommands } from "./useProviderCommands";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";

const { subscribe } = vi.hoisted(() => ({
  subscribe:
    vi.fn<
      (
        input: ProviderCommandsInput,
        listener: (catalog: ProviderCommandCatalog) => void,
        options: { onResubscribe?: () => void },
      ) => () => void
    >(),
}));
vi.mock("../../environments/runtime", () => ({
  requireEnvironmentConnection: () => ({
    client: { server: { subscribeProviderCommands: subscribe } },
  }),
}));
const environmentId = EnvironmentId.make("local");
const scope: ProviderCommandsInput = {
  threadId: ThreadId.make("chat"),
  instanceId: ProviderInstanceId.make("claudeAgent"),
  runtimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const catalog = (...names: string[]): ProviderCommandCatalog => ({
  status: names.length ? "available" : "empty",
  commands: names.map((name) => ({ name, description: "Provider command" })),
});
function Harness({
  input = scope,
  revision = "",
  connected = true,
}: {
  input?: ProviderCommandsInput | null;
  revision?: string;
  connected?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const result = useProviderCommands(environmentId, input, open, revision, connected);
  const items: ComposerCommandItem[] = [
    {
      id: "built-in",
      type: "slash-command",
      command: "model",
      label: "/model",
      description: "Built-in",
    },
    ...result.commands.map((command) => ({
      id: command.name,
      type: "provider-slash-command" as const,
      provider: ProviderDriverKind.make("claudeAgent"),
      command,
      label: `/${command.name}`,
      description: command.description ?? "",
    })),
  ];
  return (
    <>
      <button onClick={() => setOpen(!open)}>{open ? "Close" : "Open"}</button>
      <input
        aria-label="Manual command"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {open ? (
        <>
          <span data-testid="catalog-status">{result.status}</span>
          <ComposerCommandMenu
            items={items}
            resolvedTheme="dark"
            isLoading={result.status === "loading"}
            triggerKind="slash-command"
            activeItemId={null}
            onHighlightedItemChange={() => {}}
            statusText={
              result.status === "unavailable"
                ? "Claude commands unavailable. Type a command manually."
                : undefined
            }
            onSelect={(item) => {
              if (item.type === "provider-slash-command") setText(`/${item.command.name} `);
            }}
          />
        </>
      ) : null}
    </>
  );
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("live Claude command picker", () => {
  it("subscribes on opening, replaces additions/removals/renames and inserts the exact native token", async () => {
    const close = vi.fn();
    subscribe.mockReturnValue(close);
    await render(<Harness />);
    expect(subscribe).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Open", exact: true }).click();
    expect(subscribe).toHaveBeenCalledWith(
      scope,
      expect.any(Function),
      expect.objectContaining({ retryNonTransportErrors: true }),
    );
    const push = subscribe.mock.calls[0]![1];
    push(catalog("plugin:Old", "added"));
    await expect.element(page.getByText("/plugin:Old", { exact: true })).toBeVisible();
    push(catalog("plugin:Renamed"));
    await expect.element(page.getByText("/plugin:Old", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("/added", { exact: true })).not.toBeInTheDocument();
    await page.getByText("/plugin:Renamed", { exact: true }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Manual command" }))
      .toHaveValue("/plugin:Renamed ");
    push(catalog());
    await expect
      .element(page.getByText("/plugin:Renamed", { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("/model", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    expect(close).toHaveBeenCalledOnce();
  });
  it("drops old callbacks synchronously across account/project/query changes", async () => {
    subscribe.mockReturnValue(vi.fn());
    const view = await render(<Harness />);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    const old = subscribe.mock.calls[0]![1];
    old(catalog("old-private"));
    await expect.element(page.getByText("/old-private", { exact: true })).toBeVisible();
    for (const props of [
      { revision: "moved-project" },
      { input: { ...scope, instanceId: ProviderInstanceId.make("other-account") } },
      { input: { ...scope, runtimeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
    ]) {
      await view.rerender(<Harness {...props} />);
      old(catalog("late-private"));
      await expect.element(page.getByText("/old-private", { exact: true })).not.toBeInTheDocument();
      await expect
        .element(page.getByText("/late-private", { exact: true }))
        .not.toBeInTheDocument();
      await expect.element(page.getByTestId("catalog-status")).toHaveTextContent("loading");
    }
  });
  it("clears disconnected/reconnecting catalogs, recovers snapshots, and leaves manual commands usable on failure", async () => {
    subscribe.mockReturnValue(vi.fn());
    const view = await render(<Harness />);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    const first = subscribe.mock.calls[0]!;
    first[1](catalog("connected"));
    await expect.element(page.getByText("/connected", { exact: true })).toBeVisible();
    first[2].onResubscribe?.();
    await expect.element(page.getByText("/connected", { exact: true })).not.toBeInTheDocument();
    first[1](catalog("reconnected"));
    await expect.element(page.getByText("/reconnected", { exact: true })).toBeVisible();
    await view.rerender(<Harness connected={false} />);
    first[1](catalog("late-offline"));
    await expect.element(page.getByText("/reconnected", { exact: true })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Claude commands unavailable. Type a command manually.");
    await page.getByRole("textbox", { name: "Manual command" }).fill("/manual exact args");
    await expect
      .element(page.getByRole("textbox", { name: "Manual command" }))
      .toHaveValue("/manual exact args");
    await view.rerender(<Harness connected />);
    const next = subscribe.mock.calls.at(-1)!;
    next[1]({ status: "unavailable", commands: [] });
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Claude commands unavailable. Type a command manually.");
    next[1](catalog("recovered"));
    await expect.element(page.getByText("/recovered", { exact: true })).toBeVisible();
  });
  it("shows unavailable for failed setup or a chat without a live query without blocking built-ins", async () => {
    subscribe.mockImplementation(() => {
      throw new Error("private transport diagnostic");
    });
    const view = await render(<Harness />);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Claude commands unavailable. Type a command manually.");
    await expect.element(page.getByText("private transport diagnostic")).not.toBeInTheDocument();
    await view.rerender(<Harness input={null} />);
    await expect.element(page.getByText("/model", { exact: true })).toBeVisible();
    expect(subscribe).toHaveBeenCalledOnce();
  });
  it("bounds a stalled initial snapshot and recovers when metadata eventually arrives", async () => {
    subscribe.mockReturnValue(vi.fn());
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await render(<Harness />);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect.element(page.getByTestId("catalog-status")).toHaveTextContent("loading");
    await vi.advanceTimersByTimeAsync(6_000);
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Claude commands unavailable. Type a command manually.");
    subscribe.mock.calls[0]![1](catalog("late-valid"));
    await expect.element(page.getByText("/late-valid", { exact: true })).toBeVisible();
  });
});
