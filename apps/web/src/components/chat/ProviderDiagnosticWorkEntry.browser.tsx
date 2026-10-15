import "../../index.css";
import {
  EnvironmentId,
  EventId,
  ThreadId,
  TurnId,
  type EnvironmentApi,
  type ProviderDiagnosticSnapshot,
} from "@cafecode/contracts";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { getUiLocale, setUiLocale } from "@cafecode/shared/i18n";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { copyTextToClipboard } from "../../lib/copyToClipboard";
import { formatDiagnosticTimestamp } from "../../timestampFormat";
import {
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "../../rpc/wsConnectionState";
import { SubagentAvatar } from "../subagents/SubagentAvatar";
import { ProviderDiagnosticWorkEntry } from "./ProviderDiagnosticWorkEntry";

vi.mock("../../lib/copyToClipboard", () => ({
  copyTextToClipboard: vi.fn(() => Promise.resolve()),
}));
const connectionFixture = vi.hoisted(() => ({
  current: null as object | null,
  listeners: new Set<() => void>(),
  runtime: null as { connectionState: string; authState: string; role: string | null } | null,
  statusListeners: new Set<() => void>(),
}));
vi.mock("../../environments/runtime", () => ({
  readEnvironmentConnection: () => connectionFixture.current,
  subscribeEnvironmentConnections: (listener: () => void) => {
    connectionFixture.listeners.add(listener);
    return () => connectionFixture.listeners.delete(listener);
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      byId: { "provider-diagnostic-fixture-environment": connectionFixture.runtime },
    }),
    subscribe: (listener: () => void) => {
      connectionFixture.statusListeners.add(listener);
      return () => connectionFixture.statusListeners.delete(listener);
    },
  },
}));

const environmentId = EnvironmentId.make("provider-diagnostic-fixture-environment");
const threadId = ThreadId.make("provider-diagnostic-fixture-chat");
const turnId = TurnId.make("provider-diagnostic-fixture-turn");
const activityId = EventId.make("provider-diagnostic-fixture-event");
const createdAt = "2026-10-12T05:32:08.000Z";
const snapshot: ProviderDiagnosticSnapshot = {
  version: 1,
  observedAt: createdAt,
  source: "codex.error",
  method: "error",
  native: {
    eventId: "private-native-event",
    threadId: "private-native-thread",
    turnId: "private-native-turn",
    subagentRuntimeId: "private-native-generation",
    requestId: "native-request-correlation",
  },
  message: "Stream disconnected before completion: private provider diagnostic",
  json: JSON.stringify(
    {
      willRetry: true,
      error: {
        message: '<img src=x onerror="alert(1)"> [link](javascript:alert(1))',
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
        authorization: "[Redacted: credential material]",
      },
    },
    null,
    2,
  ),
  redacted: true,
  truncated: true,
  omittedFields: true,
};
const baseProps = {
  diagnostic: {
    recorded: true,
    summary: {
      version: 1 as const,
      status: "retry" as const,
      subject: {
        kind: "subagent" as const,
        id: "exact-child-avatar-seed",
        label: "Layout reviewer",
      },
      observedRetryCount: 12,
    },
  },
  environmentId,
  threadId,
  turnId,
  activityId,
  createdAt,
  timestampFormat: "24-hour" as const,
};
const triggerName = "Inspect provider diagnostic: Layout reviewer · Provider retry · 12";

function installReader(
  read: Mock<(input: unknown) => Promise<unknown>> = vi.fn(async (input: unknown) => ({
    ...(input as object),
    diagnostic: snapshot,
  })),
) {
  __setEnvironmentApiOverrideForTests(environmentId, {
    orchestration: { getThreadActivityDiagnostic: read },
  } as unknown as EnvironmentApi);
  return read;
}

async function waitForExpandedGeometry() {
  await vi.waitFor(() => {
    const row = document.querySelector<HTMLElement>("[data-provider-diagnostic]")!;
    const panel = row.querySelector<HTMLElement>('[data-slot="collapsible-panel"]')!;
    const body = row.querySelector<HTMLElement>("[data-provider-diagnostic-details]")!;
    expect(panel.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(panel.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(
      body.getBoundingClientRect().bottom - 1,
    );
  });
}

describe("expandable private provider diagnostic work entries", () => {
  const originalLocale = getUiLocale();
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    __resetEnvironmentApiOverridesForTests();
    vi.mocked(copyTextToClipboard).mockClear();
    connectionFixture.current = null;
    connectionFixture.runtime = null;
    expect(connectionFixture.listeners.size).toBe(0);
    expect(connectionFixture.statusListeners.size).toBe(0);
    setUiLocale(originalLocale);
    resetWsConnectionStateForTests();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.removeProperty("font-size");
    await page.viewport(originalViewport.width, originalViewport.height);
  });

  for (const [width, dark, scale] of [
    [430, true, "130%"],
    [960, false, "80%"],
  ] as const) {
    it(`reads only after explicit keyboard expansion and keeps inert details shrink-safe at ${width}px`, async () => {
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.fontSize = scale;
      await page.viewport(width + 24, 1000);
      const read = installReader();
      mounted = await render(
        <div style={{ width, maxWidth: "100%" }}>
          <ProviderDiagnosticWorkEntry {...baseProps} />
          <span data-avatar-reference="true">
            <SubagentAvatar seed="exact-child-avatar-seed" />
          </span>
        </div>,
      );
      const trigger = page.getByRole("button", { name: triggerName, exact: true });
      await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
      expect(read).not.toHaveBeenCalled();
      expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull();
      expect(document.body.textContent).not.toContain(snapshot.message);
      expect(document.body.innerHTML).not.toContain("private-native");
      expect(document.body.innerHTML).not.toContain("httpStatusCode");
      expect(trigger.element().getAttribute("aria-label")).not.toContain("private");
      expect(document.querySelector("[data-provider-diagnostic] svg")?.innerHTML).toBe(
        document.querySelector("[data-avatar-reference] svg")?.innerHTML,
      );
      expect(document.querySelector("[data-provider-diagnostic-time]")?.textContent).toBe(
        formatDiagnosticTimestamp(createdAt, "24-hour"),
      );
      trigger.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
      await expect.element(page.getByText(snapshot.message!, { exact: true })).toBeVisible();
      expect(read).toHaveBeenCalledExactlyOnceWith({ threadId, turnId, activityId });
      expect(document.querySelector("[data-provider-diagnostic-json]")?.textContent).toBe(
        snapshot.json,
      );
      await expect.element(page.getByText("Native request ID", { exact: true })).toBeVisible();
      await expect
        .element(
          page.getByText("Diagnostic content was truncated to the retained size limit.", {
            exact: true,
          }),
        )
        .toBeVisible();
      await expect
        .element(
          page.getByText("Some fields were omitted from this diagnostic copy.", { exact: true }),
        )
        .toBeVisible();
      const row = document.querySelector<HTMLElement>("[data-provider-diagnostic]")!;
      await waitForExpandedGeometry();
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      expect(row.querySelector("a, img, script")).toBeNull();
      expect(row.querySelector("[data-provider-diagnostic-details]")?.className).not.toContain(
        "overflow-y-auto",
      );
      await page.getByRole("button", { name: "Copy JSON", exact: true }).click();
      expect(copyTextToClipboard).toHaveBeenCalledWith(snapshot.json);
      await page.getByRole("button", { name: "Copy details", exact: true }).click();
      expect(vi.mocked(copyTextToClipboard).mock.calls.at(-1)?.[0]).toContain(
        "private-native-generation",
      );
      await mounted.rerender(
        <div style={{ width, maxWidth: "100%" }}>
          <ProviderDiagnosticWorkEntry {...baseProps} timestampFormat="12-hour" />
        </div>,
      );
      await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
      expect(read).toHaveBeenCalledOnce();
      expect(document.querySelector("[data-provider-diagnostic-time]")?.textContent).toBe(
        formatDiagnosticTimestamp(createdAt, "12-hour"),
      );
      trigger.element().focus();
      await userEvent.keyboard(" ");
      await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
      expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull();
      expect(document.body.innerHTML).not.toContain("private-native");
      expect(document.body.textContent).not.toContain(snapshot.message);
    });
  }

  it("refreshes diagnostic labels in ja/ko without refetching or translating private evidence", async () => {
    setUiLocale("en");
    const read = installReader();
    mounted = await render(
      <ProviderDiagnosticWorkEntry
        {...baseProps}
        diagnostic={{
          recorded: true,
          summary: { version: 1, status: "error", subject: { kind: "root" } },
        }}
      />,
    );
    await page
      .getByRole("button", {
        name: "Inspect provider diagnostic: Root · Provider error",
        exact: true,
      })
      .click();
    await expect.element(page.getByText(snapshot.message!, { exact: true })).toBeVisible();
    for (const [locale, name, copyName, copyHeading] of [
      [
        "ja",
        "プロバイダーの診断を確認: ルート · プロバイダーのエラー",
        "詳細をコピー",
        "プロバイダーの診断",
      ],
      ["ko", "제공자 진단 확인: 루트 · 제공자 오류", "세부 정보 복사", "제공자 진단"],
    ] as const) {
      setUiLocale(locale);
      await expect
        .element(page.getByRole("button", { name, exact: true }))
        .toHaveAttribute("aria-expanded", "true");
      expect(read).toHaveBeenCalledOnce();
      expect(document.querySelector("[data-provider-diagnostic-json]")?.textContent).toBe(
        snapshot.json,
      );
      expect(document.querySelector("[data-provider-diagnostic-time]")?.textContent).toBe(
        formatDiagnosticTimestamp(createdAt, "24-hour"),
      );
      await expect.element(page.getByText(snapshot.message!, { exact: true })).toBeVisible();
      // Locale and copy-status labels change the real measured disclosure's
      // geometry. Qualify the newly visible button's action only after that
      // existing panel has laid out, without forcing input or its animation.
      await waitForExpandedGeometry();
      const copyCallIndex = vi.mocked(copyTextToClipboard).mock.calls.length;
      await page.getByRole("button", { name: copyName, exact: true }).click();
      // A previous locale's successful call is not evidence that this exact
      // native click reached its current handler. Bind the assertion to one
      // fresh invocation, then retain the exact locale and private-byte proof.
      await vi.waitFor(() => expect(copyTextToClipboard).toHaveBeenCalledTimes(copyCallIndex + 1));
      const copied = vi.mocked(copyTextToClipboard).mock.calls[copyCallIndex]?.[0];
      expect(copied).toContain(copyHeading);
      expect(copied).toContain(snapshot.json);
    }
  });

  it("ignores a late response after changing exact chat, turn, event or environment ownership", async () => {
    let resolve!: (value: unknown) => void;
    const read = installReader(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    mounted = await render(<ProviderDiagnosticWorkEntry {...baseProps} />);
    await page.getByRole("button", { name: triggerName, exact: true }).click();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const otherProps = {
      ...baseProps,
      environmentId: EnvironmentId.make("different-environment"),
      threadId: ThreadId.make("different-chat"),
      turnId: TurnId.make("different-turn"),
      activityId: EventId.make("different-event"),
    };
    await mounted.rerender(<ProviderDiagnosticWorkEntry {...otherProps} />);
    await expect
      .element(page.getByRole("button", { name: triggerName, exact: true }))
      .toHaveAttribute("aria-expanded", "false");
    resolve({ threadId, turnId, activityId, diagnostic: snapshot });
    await vi.waitFor(() =>
      expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull(),
    );
    expect(document.body.innerHTML).not.toContain("private-native");
    expect(document.body.textContent).not.toContain(snapshot.message);
    expect(read).toHaveBeenCalledOnce();
  });

  it("rejects foreign echoed identities and retries only the selected read explicitly", async () => {
    const read = installReader(
      vi.fn(async (input: unknown) => ({
        ...(input as object),
        activityId: "foreign-event",
        diagnostic: snapshot,
      })),
    );
    mounted = await render(<ProviderDiagnosticWorkEntry {...baseProps} />);
    await page.getByRole("button", { name: triggerName, exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Retry details", exact: true }))
      .toBeVisible();
    expect(document.body.innerHTML).not.toContain("private-native");
    read.mockImplementation(async (input: unknown) => ({
      ...(input as object),
      activityId,
      diagnostic: snapshot,
    }));
    await page.getByRole("button", { name: "Retry details", exact: true }).click();
    await expect.element(page.getByText(snapshot.message!, { exact: true })).toBeVisible();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("revokes retained private details when the exact owning connection is replaced without refetching", async () => {
    connectionFixture.current = { generation: "first-synthetic-owner" };
    const read = installReader();
    mounted = await render(<ProviderDiagnosticWorkEntry {...baseProps} />);
    await page.getByRole("button", { name: triggerName, exact: true }).click();
    await expect.element(page.getByText(snapshot.message!, { exact: true })).toBeVisible();
    expect(connectionFixture.listeners.size).toBe(1);
    connectionFixture.current = { generation: "replacement-synthetic-owner" };
    for (const listener of connectionFixture.listeners) listener();
    await expect
      .element(page.getByRole("button", { name: "Retry details", exact: true }))
      .toBeVisible();
    expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull();
    expect(document.body.innerHTML).not.toContain("private-native");
    expect(document.body.textContent).not.toContain(snapshot.message);
    expect(read).toHaveBeenCalledOnce();
    expect(copyTextToClipboard).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Retry details", exact: true }).click();
    await expect.element(page.getByText(snapshot.message!, { exact: true })).toBeVisible();
    expect(read).toHaveBeenCalledTimes(2);
    expect(connectionFixture.listeners.size).toBe(1);
  });

  it("rejects an in-flight private response after the exact owning connection disconnects", async () => {
    connectionFixture.current = { generation: "synthetic-disconnecting-owner" };
    let resolve!: (value: unknown) => void;
    const read = installReader(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    mounted = await render(<ProviderDiagnosticWorkEntry {...baseProps} />);
    await page.getByRole("button", { name: triggerName, exact: true }).click();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    connectionFixture.current = null;
    for (const listener of connectionFixture.listeners) listener();
    resolve({ threadId, turnId, activityId, diagnostic: snapshot });
    await expect
      .element(page.getByRole("button", { name: "Retry details", exact: true }))
      .toBeVisible();
    expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull();
    expect(document.body.innerHTML).not.toContain("private-native");
    expect(document.body.textContent).not.toContain(snapshot.message);
    expect(read).toHaveBeenCalledOnce();
    expect(copyTextToClipboard).not.toHaveBeenCalled();
  });

  it("revokes a same-object saved transport loss, ignores its late response and does not reread on reconnect", async () => {
    const connection = { kind: "saved", generation: "same-synthetic-connection" };
    connectionFixture.current = connection;
    connectionFixture.runtime = {
      connectionState: "connected",
      authState: "authenticated",
      role: "owner",
    };
    let resolve!: (value: unknown) => void;
    const read = installReader(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    mounted = await render(<ProviderDiagnosticWorkEntry {...baseProps} />);
    await page.getByRole("button", { name: triggerName, exact: true }).click();
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    connectionFixture.runtime = { ...connectionFixture.runtime, connectionState: "disconnected" };
    for (const listener of connectionFixture.statusListeners) listener();
    await expect
      .element(page.getByRole("button", { name: "Retry details", exact: true }))
      .toBeVisible();
    resolve({ threadId, turnId, activityId, diagnostic: snapshot });
    connectionFixture.runtime = { ...connectionFixture.runtime, connectionState: "connected" };
    for (const listener of connectionFixture.statusListeners) listener();
    expect(connectionFixture.current).toBe(connection);
    expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull();
    expect(document.body.innerHTML).not.toContain("private-native");
    expect(read).toHaveBeenCalledOnce();
    read.mockImplementation(async (input: unknown) => ({
      ...(input as object),
      diagnostic: snapshot,
    }));
    await page.getByRole("button", { name: "Retry details", exact: true }).click();
    await expect.element(page.getByText(snapshot.message!, { exact: true })).toBeVisible();
    expect(read).toHaveBeenCalledTimes(2);
    connectionFixture.runtime = { ...connectionFixture.runtime, role: "client" };
    for (const listener of connectionFixture.statusListeners) listener();
    await expect
      .element(page.getByRole("button", { name: "Retry details", exact: true }))
      .toBeVisible();
    expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull();
    expect(document.body.textContent).not.toContain(snapshot.message);
    await page.getByRole("button", { name: "Retry details", exact: true }).click();
    expect(read).toHaveBeenCalledTimes(2);
    expect(copyTextToClipboard).not.toHaveBeenCalled();
  });

  it("revokes same-object primary disconnects and keeps private rereads explicit after reopening", async () => {
    const connection = { kind: "primary", generation: "same-primary-connection" };
    connectionFixture.current = connection;
    recordWsConnectionOpened();
    const read = installReader();
    mounted = await render(<ProviderDiagnosticWorkEntry {...baseProps} />);
    await page.getByRole("button", { name: triggerName, exact: true }).click();
    await expect.element(page.getByText(snapshot.message!, { exact: true })).toBeVisible();
    recordWsConnectionClosed({ code: 1006 });
    await expect
      .element(page.getByRole("button", { name: "Retry details", exact: true }))
      .toBeVisible();
    expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull();
    expect(document.body.innerHTML).not.toContain("private-native");
    recordWsConnectionOpened();
    expect(connectionFixture.current).toBe(connection);
    expect(read).toHaveBeenCalledOnce();
    await page.getByRole("button", { name: "Retry details", exact: true }).click();
    await expect.element(page.getByText(snapshot.message!, { exact: true })).toBeVisible();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shows unknown legacy attribution and missing details without a reader call", async () => {
    const read = installReader();
    mounted = await render(
      <ProviderDiagnosticWorkEntry
        {...baseProps}
        diagnostic={{
          recorded: false,
          summary: { version: 1, status: "error", subject: { kind: "unknown" } },
        }}
      />,
    );
    await page
      .getByRole("button", {
        name: "Inspect provider diagnostic: Agent not recorded · Provider error",
        exact: true,
      })
      .click();
    await expect
      .element(
        page.getByText("Diagnostic details were not recorded for this event.", { exact: true }),
      )
      .toBeVisible();
    expect(read).not.toHaveBeenCalled();
    expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull();
    await expect
      .element(page.getByRole("button", { name: "Copy JSON", exact: true }))
      .not.toBeInTheDocument();
  });

  it("keeps an authenticated reader refusal content-free and never copies unavailable diagnostics", async () => {
    const read = installReader(
      vi.fn(() => Promise.reject(new Error("private credential-shaped server error"))),
    );
    mounted = await render(
      <ProviderDiagnosticWorkEntry
        {...baseProps}
        diagnostic={{
          recorded: true,
          summary: { version: 1, status: "error", subject: { kind: "root" } },
        }}
      />,
    );
    await page
      .getByRole("button", {
        name: "Inspect provider diagnostic: Root · Provider error",
        exact: true,
      })
      .click();
    await expect
      .element(page.getByRole("button", { name: "Retry details", exact: true }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("private credential");
    expect(document.querySelector("[data-provider-diagnostic-json]")).toBeNull();
    expect(copyTextToClipboard).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
  });
});
