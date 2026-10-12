import "../../index.css";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnId,
  type DesktopBridge,
  type EnvironmentApi,
} from "@cafecode/contracts";
import type {
  VisualizationDetailsResult,
  VisualizationTimelineEntry,
} from "@cafecode/contracts/visualizationApi";
import {
  VisualizationArtifactId,
  VisualizationRevisionId,
  GeneratedVisualizationReference,
} from "@cafecode/contracts/visualizations";
import * as Schema from "effect/Schema";
import type { VisualizationHostEvent } from "@cafecode/contracts/visualizationHost";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useLayoutEffect, useState } from "react";
import { getUiLocale, setUiLocale, uiText } from "@cafecode/shared/i18n";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { formatDiagnosticTimestamp } from "../../timestampFormat";
import { VisualizationCard } from "./VisualizationCard";
import { VisualizationViewerProvider } from "./VisualizationViewerProvider";
import { useThreadVisualizations } from "./useThreadVisualizations";
import { visualizationPresentation } from "./visualizationPresentation";
import { visualizationEntryIdentity } from "./visualizationEntryIdentity";
import {
  acquireVisualizationPoster,
  readVisualizationPosterAccounting,
} from "./visualizationPoster";
import { fileRequest } from "../../attachments/fileAttachments";

// Only the authenticated binary transport is controlled. Real bounded response
// reading, PNG dimension admission and Chromium bitmap decoding remain intact.
// No fixture reads a provider profile, credentials or an ambient environment.
vi.mock("../../attachments/fileAttachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../attachments/fileAttachments")>()),
  fileRequest: vi.fn(),
}));

const environmentId = EnvironmentId.make("visualization-fixture-environment");
const threadId = ThreadId.make("visualization-fixture-chat");
const artifactId = VisualizationArtifactId.make("8bdd2475-78f0-4563-9829-f29b073c0689");
const revisionId = VisualizationRevisionId.make("4e27bd63-c586-4f50-99b5-a722994d41dc");
const leaseId = "adf6e758-2797-46b2-9817-bc6f2fc60e27";
const operationId = "ea97fb5b-25fd-4e92-8bc7-86e928414202";
const entry: VisualizationTimelineEntry = {
  messageId: MessageId.make("visualization-fixture-message"),
  turnId: TurnId.make("visualization-fixture-turn"),
  originItemId: "fixture-origin",
  occurredAt: "2026-10-12T12:14:15.000Z",
  actor: { type: "child", id: "fixture-child", label: "Layout reviewer" },
  reference: {
    version: 1,
    purpose: "generated-visualization",
    artifactId,
    revisionId,
    title: "Revenue explorer",
    width: 640,
    height: 240,
  },
};
const privateDetails: VisualizationDetailsResult = {
  threadId,
  artifactId,
  revisionId,
  source: {
    version: 1,
    purpose: "generated-visualization",
    artifactId,
    revisionId,
    source:
      "<script>window.__visualizationPrivateExecuted = true</script><p>private-source-marker</p>",
    assets: [],
  },
  diagnostics: {
    version: 1,
    artifactId,
    revisionId,
    records: [{ classification: "capture-failed", message: "private-diagnostic-marker" }],
    truncated: false,
  },
  rawJson: '{"private-json-marker":"<img src=x onerror=alert(1)>"}',
};
const originalBridge = window.desktopBridge;
const originalLocale = getUiLocale();
const copy = vi.fn(async (_value: string) => undefined);
const download = vi.fn((_value: string) => () => undefined);
vi.mock("../../lib/copyToClipboard", () => ({
  copyTextToClipboard: (value: string) => copy(value),
}));
vi.mock("./visualizationDownload", () => ({
  downloadPortableVisualization: (value: string) => download(value),
}));
vi.mock("../../hooks/useTheme", () => ({
  useTheme: () => ({
    resolvedTheme: document.documentElement.classList.contains("dark") ? "dark" : "light",
  }),
}));

function installApi(details = vi.fn(async () => privateDetails)) {
  const list = vi.fn<NonNullable<EnvironmentApi["visualizations"]>["list"]>(async () => ({
    entries: [entry],
  }));
  const viewerTicket = vi.fn(async () => ({
    threadId,
    artifactId,
    revisionId,
    ticket: "f".repeat(64),
    expiresAtMs: Date.now() + 10_000,
  }));
  const prepare = vi.fn<NonNullable<EnvironmentApi["mcpApps"]>["prepare"]>(async () => ({
    kind: "reply",
    json: "{}",
  }));
  const resolve = vi.fn<NonNullable<EnvironmentApi["mcpApps"]>["resolve"]>(async () => ({
    json: '{"jsonrpc":"2.0","id":1,"result":{}}',
  }));
  const appDetails = vi.fn(async () => ({ json: '{"private-arguments-marker":true}' }));
  const exportHtml = vi.fn(async () => ({
    threadId,
    artifactId,
    revisionId,
    html: "<p>private-portable-source</p>",
  }));
  // Only this fixture's typed artifact namespace is used. Other backend APIs
  // are deliberately absent; these tests never start a provider or live host.
  const artifactApi = {
    visualizations: { list, details, viewerTicket, exportHtml },
    mcpApps: { prepare, resolve, details: appDetails },
  } satisfies Pick<EnvironmentApi, "visualizations" | "mcpApps">;
  __setEnvironmentApiOverrideForTests(environmentId, artifactApi as unknown as EnvironmentApi);
  return { list, details, viewerTicket, prepare, resolve, appDetails, exportHtml };
}
function installBridge() {
  const listeners = new Set<(event: VisualizationHostEvent) => void>();
  const expiresAtMs = Date.now() + 300_000;
  const state = () => ({ leaseId, state: "active" as const, expiresAtMs });
  const open = vi.fn<NonNullable<DesktopBridge["openVisualization"]>>(async () => state());
  const update = vi.fn<NonNullable<DesktopBridge["updateVisualization"]>>(async () => state());
  const retire = vi.fn<NonNullable<DesktopBridge["retireVisualization"]>>(async () => ({
    ...state(),
    state: "retired" as const,
  }));
  const suspend = vi.fn<NonNullable<DesktopBridge["suspendVisualization"]>>(async () => true);
  const send = vi.fn<NonNullable<DesktopBridge["sendVisualizationMessage"]>>(async () => true);
  const capabilities = vi.fn<NonNullable<DesktopBridge["getVisualizationHostCapabilities"]>>(
    async () => ({
      available: true,
      reason: "ready" as const,
      maxActive: 1 as const,
      activeLeaseMs: 300000 as const,
    }),
  );
  const bridge = {
    getVisualizationHostCapabilities: capabilities,
    openVisualization: open,
    updateVisualization: update,
    retireVisualization: retire,
    captureVisualization: async () => null,
    suspendVisualization: suspend,
    sendVisualizationMessage: send,
    onVisualizationHostEvent: (listener: (event: VisualizationHostEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } satisfies Pick<
    DesktopBridge,
    | "getVisualizationHostCapabilities"
    | "openVisualization"
    | "updateVisualization"
    | "retireVisualization"
    | "captureVisualization"
    | "suspendVisualization"
    | "sendVisualizationMessage"
    | "onVisualizationHostEvent"
  >;
  window.desktopBridge = bridge as unknown as DesktopBridge;
  return {
    open,
    update,
    retire,
    suspend,
    send,
    capabilities,
    state,
    emit: (event: VisualizationHostEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}
function Fixture({
  value = entry,
  second = false,
}: {
  value?: VisualizationTimelineEntry;
  second?: boolean;
}) {
  const [mounted, setMounted] = useState(true);
  return (
    <VisualizationViewerProvider>
      <div style={{ width: 700, height: 600 }}>
        <button onClick={() => setMounted(false)}>Recycle card</button>
        {mounted ? (
          <VisualizationCard
            environmentId={environmentId}
            threadId={threadId}
            entry={value}
            timestampFormat="24-hour"
          />
        ) : null}
        {second ? (
          <VisualizationCard
            environmentId={environmentId}
            threadId={threadId}
            entry={{
              ...value,
              reference: {
                ...value.reference,
                artifactId: VisualizationArtifactId.make("487ff16c-9561-447c-abf0-4f551d30a35c"),
              },
            }}
            timestampFormat="24-hour"
          />
        ) : null}
      </div>
    </VisualizationViewerProvider>
  );
}
function InvocationFixture({
  ownerMounted = true,
  duplicate = true,
  sameInvocation = false,
}: {
  ownerMounted?: boolean;
  duplicate?: boolean;
  sameInvocation?: boolean;
}) {
  const root: VisualizationTimelineEntry = {
    ...entry,
    actor: { type: "root" },
    originItemId: "root-call",
  };
  const child: VisualizationTimelineEntry = {
    ...entry,
    actor: { type: "child", id: "second-child", label: "Second inspector" },
    originItemId: "child-call",
  };
  return (
    <VisualizationViewerProvider>
      <div style={{ width: 700, height: 600 }}>
        <div data-invocation-owner>
          {ownerMounted ? (
            <VisualizationCard
              environmentId={environmentId}
              threadId={threadId}
              entry={root}
              timestampFormat="24-hour"
            />
          ) : null}
        </div>
        <div data-invocation-duplicate>
          {duplicate ? (
            <VisualizationCard
              environmentId={environmentId}
              threadId={threadId}
              entry={sameInvocation ? root : child}
              timestampFormat="24-hour"
            />
          ) : null}
        </div>
      </div>
    </VisualizationViewerProvider>
  );
}
function ModalFixture({
  second = false,
  value = entry,
}: {
  second?: boolean;
  value?: VisualizationTimelineEntry;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open unrelated modal</button>
      <Fixture second={second} value={value} />
      {open ? (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-background">
          Other modal
          <button onClick={() => setOpen(false)}>Close unrelated modal</button>
        </div>
      ) : null}
    </>
  );
}

/** Fixture-owned finite responses; neither the page nor the bridge starts a real host. */
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Value>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  __resetEnvironmentApiOverridesForTests();
  setUiLocale(originalLocale);
  copy.mockClear();
  download.mockClear();
  vi.mocked(fileRequest).mockReset();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("--primary");
  document.documentElement.style.removeProperty("--accent");
  document.documentElement.style.removeProperty("font-size");
});

describe("generated visualization presentation", () => {
  it("keeps source/JSON private until expanded, escapes it, and clears on collapse", async () => {
    const api = installApi();
    await render(<Fixture />);
    await expect.element(page.getByText("Revenue explorer")).toBeVisible();
    expect(api.details).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private-json-marker");
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    await expect.element(page.getByText("private-source-marker", { exact: false })).toBeVisible();
    expect(document.querySelector("[data-visualization-card] script")).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Copy JSON", exact: true }));
    expect(copy).toHaveBeenCalledWith(privateDetails.rawJson);
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    expect(document.body.textContent).not.toContain("private-json-marker");
    expect(document.body.textContent).not.toContain("private-source-marker");
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    await vi.waitFor(() => expect(api.details).toHaveBeenCalledTimes(2));
  });
  it("refuses wrong private revision and never prints received error bodies", async () => {
    const details = vi.fn(async () => ({
      ...privateDetails,
      revisionId: VisualizationRevisionId.make("572dddf7-83e1-4505-bf08-53b67e82bb7f"),
    }));
    installApi(details);
    await render(<Fixture />);
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    await expect.element(page.getByText("Private details unavailable.")).toBeVisible();
    expect(document.body.textContent).not.toContain("private-json-marker");
  });
  it("does not publish a late details read after collapse", async () => {
    let complete!: (value: VisualizationDetailsResult) => void;
    const api = installApi(
      vi.fn(
        () =>
          new Promise<VisualizationDetailsResult>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    await render(<Fixture />);
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    await vi.waitFor(() => expect(api.details).toHaveBeenCalledTimes(1));
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    complete(privateDetails);
    await Promise.resolve();
    expect(document.body.textContent).not.toContain("private-json-marker");
  });
  it("revokes a late private read when the exact environment adapter is replaced", async () => {
    let complete!: (value: VisualizationDetailsResult) => void;
    const api = installApi(
      vi.fn(
        () =>
          new Promise<VisualizationDetailsResult>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    await render(<Fixture />);
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    await vi.waitFor(() => expect(api.details).toHaveBeenCalledTimes(1));
    installApi();
    complete(privateDetails);
    await Promise.resolve();
    expect(document.body.textContent).not.toContain("private-json-marker");
    expect(document.body.textContent).not.toContain("private-source-marker");
  });
  it("bounds private text layout while preserving every page and exact full-copy JSON", async () => {
    const rawJson = JSON.stringify({ text: `${"x".repeat(40_000)}private-final-page-marker` });
    installApi(vi.fn(async () => ({ ...privateDetails, rawJson })));
    await render(<Fixture />);
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    await expect.element(page.getByText("Page 1 of 2", { exact: true })).toBeVisible();
    expect(document.body.textContent).not.toContain("private-final-page-marker");
    await userEvent.click(page.getByRole("button", { name: "Next details page", exact: true }));
    await expect
      .element(page.getByText("private-final-page-marker", { exact: false }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Copy JSON", exact: true }));
    expect(copy).toHaveBeenLastCalledWith(rawJson);
    await userEvent.click(
      page.getByRole("button", { name: "Private source and JSON", exact: true }),
    );
    expect(document.body.textContent).not.toContain("private-final-page-marker");
  });
  it("uses canonical child identity and native system timestamp formatting", async () => {
    installApi();
    await render(<Fixture />);
    await expect
      .element(page.getByRole("img", { name: "Layout reviewer", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText(formatDiagnosticTimestamp(entry.occurredAt, "24-hour")))
      .toBeVisible();
  });
  it.each(["en", "ja", "ko"] as const)(
    "renders private disclosure and actions in %s",
    async (locale) => {
      installApi();
      setUiLocale(locale);
      await render(<Fixture />);
      await expect
        .element(page.getByRole("button", { name: uiText("Private source and JSON"), exact: true }))
        .toBeVisible();
      await userEvent.click(
        page.getByRole("button", { name: uiText("Private source and JSON"), exact: true }),
      );
      await expect
        .element(page.getByRole("button", { name: uiText("Copy JSON"), exact: true }))
        .toBeVisible();
    },
  );
  it("refuses execution in a plain browser without creating an iframe", async () => {
    const api = installApi();
    delete window.desktopBridge;
    await render(<Fixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect
      .element(page.getByText("Interactive viewing requires the local desktop host."))
      .toBeVisible();
    expect(api.viewerTicket).not.toHaveBeenCalled();
    expect(document.querySelector("[data-visualization-card] iframe")).toBeNull();
  });
  it("admits one native lease and preserves it through expansion and row recycling", async () => {
    installApi();
    const bridge = installBridge();
    await render(<Fixture second />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }).first());
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
    await userEvent.click(page.getByRole("button", { name: "Expand", exact: true }));
    await expect
      .element(page.getByRole("button", { name: "Back to chat", exact: true }))
      .toBeVisible();
    expect(bridge.open.mock.calls[0]?.[0].displayMode).toBe("inline");
    await vi.waitFor(() =>
      expect(
        bridge.update.mock.calls.some(
          ([value]) => value.leaseId === leaseId && value.displayMode === "fullscreen",
        ),
      ).toBe(true),
    );
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.retire).not.toHaveBeenCalled();
    // Programmatic parent unmount represents virtualizer recycling, not a fake
    // mouse/media event. Real controls still exercise the native browser layout.
    document.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-visualization-card]").length).toBe(1),
    );
    expect(bridge.retire).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Back to chat", exact: true }));
    await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledTimes(1));
  });
  it.each([false, true])(
    "binds one inline anchor independently of reused content and duplicate panes %s",
    async (sameInvocation) => {
      installApi();
      const bridge = installBridge();
      const view = await render(<InvocationFixture sameInvocation={sameInvocation} />);
      try {
        await userEvent.click(page.getByRole("button", { name: "Run", exact: true }).first());
        await expect
          .element(page.getByRole("button", { name: "Expand", exact: true }))
          .toBeVisible();
        expect(page.getByRole("button", { name: "Stop", exact: true }).all()).toHaveLength(1);
        await expect.element(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
        expect(document.querySelector("[data-invocation-duplicate]")?.textContent).not.toContain(
          "Interactive · maximum",
        );
        await view.rerender(
          <InvocationFixture duplicate={false} sameInvocation={sameInvocation} />,
        );
        expect(bridge.retire).not.toHaveBeenCalled();
        await expect.element(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
        await view.rerender(<InvocationFixture sameInvocation={sameInvocation} />);
        await userEvent.click(page.getByRole("button", { name: "Expand", exact: true }));
        await expect
          .element(page.getByRole("button", { name: "Back to chat", exact: true }))
          .toBeVisible();
        // Recycling the active inline row must not transfer its expanded lease
        // to the other invocation/pane, nor retire the independent expanded view.
        await view.rerender(
          <InvocationFixture ownerMounted={false} sameInvocation={sameInvocation} />,
        );
        expect(bridge.retire).not.toHaveBeenCalled();
        expect(bridge.open).toHaveBeenCalledTimes(1);
        expect(document.querySelector("[data-invocation-duplicate]")?.textContent).not.toContain(
          "Interactive · maximum",
        );
        await userEvent.click(page.getByRole("button", { name: "Back to chat", exact: true }));
        await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledTimes(1));
        expect(bridge.retire).toHaveBeenCalledWith({ leaseId });
        await expect.element(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
      } finally {
        await view.unmount();
      }
    },
  );
  it("does not release an uncertain native retirement or admit a competitor", async () => {
    installApi();
    const bridge = installBridge();
    bridge.retire.mockRejectedValue(new Error("private-native-error"));
    await render(<Fixture second />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }).first());
    await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }));
    await expect
      .element(page.getByText("Viewer unavailable until retirement is verified."))
      .toBeVisible();
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("private-native-error");
    await expect
      .element(page.getByRole("button", { name: "Run", exact: true }).last())
      .toBeDisabled();
  });
  it("retires the eventual exact lease after cancellation during native open", async () => {
    installApi();
    const bridge = installBridge();
    let opened!: (value: ReturnType<typeof bridge.state>) => void;
    bridge.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          opened = resolve;
        }),
    );
    await render(<Fixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(1));
    await userEvent.click(page.getByRole("button", { name: "Recycle card", exact: true }));
    expect(bridge.retire).not.toHaveBeenCalled();
    opened(bridge.state());
    await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledWith({ leaseId }));
  });
  it("revokes a deferred capability admission when a modal opens, even after the modal closes", async () => {
    const api = installApi();
    const bridge = installBridge();
    const pending = deferred<Awaited<ReturnType<typeof bridge.capabilities>>>();
    bridge.capabilities.mockImplementationOnce(() => pending.promise);
    await render(<ModalFixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await vi.waitFor(() => expect(bridge.capabilities).toHaveBeenCalledTimes(1));
    await userEvent.click(page.getByRole("button", { name: "Open unrelated modal", exact: true }));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Close unrelated modal", exact: true }));
    pending.resolve({ available: true, reason: "ready", maxActive: 1, activeLeaseMs: 300000 });
    await expect.element(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
    expect(api.viewerTicket).not.toHaveBeenCalled();
    expect(bridge.open).not.toHaveBeenCalled();
    expect(bridge.update).not.toHaveBeenCalled();
    expect(bridge.retire).not.toHaveBeenCalled();
  });
  it("revokes a deferred viewer ticket before native open when an unrelated modal appears", async () => {
    const api = installApi();
    const bridge = installBridge();
    const pending = deferred<Awaited<ReturnType<typeof api.viewerTicket>>>();
    api.viewerTicket.mockImplementationOnce(() => pending.promise);
    await render(<ModalFixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await vi.waitFor(() => expect(api.viewerTicket).toHaveBeenCalledTimes(1));
    await userEvent.click(page.getByRole("button", { name: "Open unrelated modal", exact: true }));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    pending.resolve({
      threadId,
      artifactId,
      revisionId,
      ticket: "f".repeat(64),
      expiresAtMs: Date.now() + 10_000,
    });
    await expect
      .element(page.getByText("Interactive viewing requires the local desktop host."))
      .toBeVisible();
    expect(bridge.open).not.toHaveBeenCalled();
    expect(bridge.update).not.toHaveBeenCalled();
    expect(bridge.retire).not.toHaveBeenCalled();
  });
  it("retires a deferred native ACK without a visibility commit after modal startup revocation", async () => {
    const api = installApi();
    const bridge = installBridge();
    const pending = deferred<ReturnType<typeof bridge.state>>();
    bridge.open.mockImplementationOnce(() => pending.promise);
    const appEntry: VisualizationTimelineEntry = {
      ...entry,
      reference: { ...entry.reference, purpose: "mcp-app", serverLabel: "Fixture server" },
    };
    await render(<ModalFixture second value={appEntry} />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }).first());
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(1));
    expect(bridge.update).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Open unrelated modal", exact: true }));
    await expect
      .element(page.getByText("Viewer unavailable until retirement is verified."))
      .toBeVisible();
    expect(bridge.retire).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("button", { name: "Run", exact: true }).last())
      .toBeDisabled();
    // A valid early App message still has no authority after the modal revokes
    // startup. Neither the exact ACK nor later removal of the modal revives it.
    bridge.emit({
      leaseId,
      state: "message",
      json: '{"jsonrpc":"2.0","id":1,"method":"ui/initialize"}',
    });
    await userEvent.click(page.getByRole("button", { name: "Close unrelated modal", exact: true }));
    pending.resolve(bridge.state());
    await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledWith({ leaseId }));
    await expect
      .element(page.getByText("Viewer stopped. Run again to start a new document."))
      .toBeVisible();
    expect(bridge.update).not.toHaveBeenCalled();
    expect(bridge.send).not.toHaveBeenCalled();
    expect(api.prepare).not.toHaveBeenCalled();
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(page.getByRole("button", { name: "Expand", exact: true }).query()).toBeNull();
  });
  it("retains quarantine after a modal revokes startup and its native ACK is lost", async () => {
    installApi();
    const bridge = installBridge();
    const pending = deferred<ReturnType<typeof bridge.state>>();
    bridge.open.mockImplementationOnce(() => pending.promise);
    await render(<ModalFixture second />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }).first());
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(1));
    await userEvent.click(page.getByRole("button", { name: "Open unrelated modal", exact: true }));
    await expect
      .element(page.getByText("Viewer unavailable until retirement is verified."))
      .toBeVisible();
    pending.reject(new Error("private-modal-open-ack-error"));
    await userEvent.click(page.getByRole("button", { name: "Close unrelated modal", exact: true }));
    await expect
      .element(page.getByRole("button", { name: "Run", exact: true }).last())
      .toBeDisabled();
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(bridge.update).not.toHaveBeenCalled();
    expect(bridge.retire).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private-modal-open-ack-error");
  });
  it("keeps an uncertain open acknowledgement quarantined rather than admitting a competitor", async () => {
    installApi();
    const bridge = installBridge();
    bridge.open.mockRejectedValueOnce(new Error("private-lost-acknowledgement"));
    await render(<Fixture second />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }).first());
    await expect
      .element(page.getByText("Viewer unavailable until retirement is verified."))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Run", exact: true }).last())
      .toBeDisabled();
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("private-lost-acknowledgement");
  });
  it("does not revive a lease whose trusted retirement event arrived before its open acknowledgement", async () => {
    installApi();
    const bridge = installBridge();
    bridge.open.mockImplementationOnce(async () => {
      bridge.emit({ leaseId, state: "retired" });
      return bridge.state();
    });
    await render(<Fixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect
      .element(page.getByText("Viewer stopped. Run again to start a new document."))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Expand", exact: true }).query()).toBeNull();
    expect(bridge.send).not.toHaveBeenCalled();
  });
  it("does not lose App initialization that arrives before the exact open acknowledgement", async () => {
    const api = installApi();
    const bridge = installBridge();
    bridge.open.mockImplementationOnce(async () => {
      bridge.emit({
        leaseId: "5025adcf-e51b-4c66-a12f-6d2872ecba76",
        state: "message",
        json: '{"jsonrpc":"2.0","id":8,"method":"ping"}',
      });
      bridge.emit({
        leaseId,
        state: "message",
        json: '{"jsonrpc":"2.0","id":1,"method":"ui/initialize"}',
      });
      return bridge.state();
    });
    const appEntry: VisualizationTimelineEntry = {
      ...entry,
      reference: { ...entry.reference, purpose: "mcp-app", serverLabel: "Fixture server" },
    };
    await render(<Fixture value={appEntry} />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await vi.waitFor(() => expect(api.prepare).toHaveBeenCalledTimes(1));
    expect(api.prepare).toHaveBeenCalledWith({
      threadId,
      artifactId,
      revisionId,
      leaseId,
      ticket: "f".repeat(64),
      requestJson: '{"jsonrpc":"2.0","id":1,"method":"ui/initialize"}',
    });
    await vi.waitFor(() => expect(bridge.send).toHaveBeenCalledWith({ leaseId, json: "{}" }));
  });
  it("forwards initialized original messages once in order and honors same-lease display requests", async () => {
    const api = installApi();
    const bridge = installBridge();
    api.prepare.mockResolvedValueOnce({
      kind: "reply",
      json: "",
      messages: ['{"input":true}', '{"result":true}'],
    });
    api.prepare.mockResolvedValueOnce({
      kind: "reply",
      json: '{"mode":"fullscreen"}',
      displayMode: "fullscreen",
    });
    const appEntry: VisualizationTimelineEntry = {
      ...entry,
      reference: { ...entry.reference, purpose: "mcp-app", serverLabel: "Fixture server" },
    };
    await render(<Fixture value={appEntry} />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    bridge.emit({
      leaseId,
      state: "message",
      json: '{"jsonrpc":"2.0","method":"ui/notifications/initialized"}',
    });
    await vi.waitFor(() => expect(bridge.send).toHaveBeenCalledTimes(2));
    expect(bridge.send.mock.calls.map(([value]) => value.json)).toEqual([
      '{"input":true}',
      '{"result":true}',
    ]);
    bridge.emit({
      leaseId,
      state: "message",
      json: '{"jsonrpc":"2.0","id":2,"method":"ui/request-display-mode","params":{"mode":"fullscreen"}}',
    });
    await expect
      .element(page.getByRole("button", { name: "Back to chat", exact: true }))
      .toBeVisible();
    expect(bridge.open).toHaveBeenCalledTimes(1);
  });
  it("updates accent, interface scale and theme without restarting or extending the lease", async () => {
    installApi();
    const bridge = installBridge();
    await render(<Fixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    document.documentElement.style.setProperty("--accent", "#ffffff");
    document.documentElement.style.setProperty("--primary", "#123abc");
    document.documentElement.style.setProperty("font-size", "20px");
    document.documentElement.classList.add("dark");
    await vi.waitFor(() =>
      expect(
        bridge.update.mock.calls.some(
          ([value]) =>
            value.presentation?.colors.accent === "#123abc" && value.presentation.scale === 1.25,
        ),
      ).toBe(true),
    );
    expect(visualizationPresentation("en").colors.accent).toBe("#123abc");
    expect(bridge.open).toHaveBeenCalledTimes(1);
    await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }));
    await expect.element(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
    expect(document.activeElement).toBe(
      page.getByRole("button", { name: "Run", exact: true }).element(),
    );
  });
  it("yields an active native surface to an unrelated modal instead of drawing above it", async () => {
    installApi();
    const bridge = installBridge();
    await render(<ModalFixture />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Open unrelated modal", exact: true }));
    await vi.waitFor(() => expect(bridge.retire).toHaveBeenCalledWith({ leaseId }));
  });
  it.each([
    { platform: "Win32", scale: 80, inset: 40 },
    { platform: "Win32", scale: 130, inset: 40 },
    { platform: "MacIntel", scale: 100, inset: 0 },
    { platform: "Linux x86_64", scale: 100, inset: 0 },
  ])(
    "keeps expanded controls usable in a short $platform window at $scale%",
    async ({ platform, scale, inset }) => {
      const root = document.documentElement;
      const originalWco = root.classList.contains("wco");
      const originalViewport = { width: window.innerWidth, height: window.innerHeight };
      const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      root.classList.add("wco");
      root.style.fontSize = `${scale}%`;
      await page.viewport(640, 320);
      try {
        installApi();
        const bridge = installBridge();
        await render(<Fixture />);
        await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
        await expect
          .element(page.getByRole("button", { name: "Expand", exact: true }))
          .toBeVisible();
        await userEvent.click(page.getByRole("button", { name: "Expand", exact: true }));
        const back = page.getByRole("button", { name: "Back to chat", exact: true });
        await expect.element(back).toBeVisible();
        const popup = document.querySelector<HTMLElement>("[data-visualization-viewer]")!;
        await vi.waitFor(() => {
          const bounds = popup.getBoundingClientRect();
          expect(bounds.top).toBeGreaterThanOrEqual(inset);
          expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
          expect(back.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(inset);
          expect(back.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
            window.innerHeight,
          );
        });
        expect(popup.className.includes("wco:[--cafe-visualization-titlebar-inset")).toBe(
          inset > 0,
        );
        expect(bridge.open).toHaveBeenCalledTimes(1);
        await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }).last());
      } finally {
        root.classList.toggle("wco", originalWco);
        root.style.removeProperty("font-size");
        platformSpy.mockRestore();
        await page.viewport(originalViewport.width, originalViewport.height);
      }
    },
  );
  it("routes App requests to exact one-operation consent and hides private arguments by default", async () => {
    const api = installApi();
    api.prepare.mockResolvedValue({
      kind: "consent",
      operationId,
      method: "tools/call",
      name: "lookup",
    });
    const bridge = installBridge();
    const appEntry: VisualizationTimelineEntry = {
      ...entry,
      reference: { ...entry.reference, purpose: "mcp-app", serverLabel: "Fixture server" },
    };
    await render(<Fixture value={appEntry} />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    bridge.emit({
      leaseId: "5025adcf-e51b-4c66-a12f-6d2872ecba76",
      state: "message",
      json: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
    });
    expect(api.prepare).not.toHaveBeenCalled();
    bridge.emit({
      leaseId,
      state: "message",
      json: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
    });
    await expect
      .element(page.getByRole("button", { name: "Allow once", exact: true }))
      .toBeVisible();
    expect(api.appDetails).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private-arguments-marker");
    expect(bridge.suspend).toHaveBeenCalledWith({
      leaseId,
      consentId: operationId,
      suspended: true,
    });
    await userEvent.click(page.getByRole("button", { name: "Private details", exact: true }));
    await expect
      .element(page.getByText('"private-arguments-marker"', { exact: false }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Deny", exact: true }));
    await vi.waitFor(() =>
      expect(api.resolve).toHaveBeenCalledWith({ operationId, decision: "deny" }),
    );
    await vi.waitFor(() =>
      expect(bridge.suspend).toHaveBeenCalledWith({
        leaseId,
        consentId: operationId,
        suspended: false,
      }),
    );
    expect(bridge.retire).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private-arguments-marker");
  });
  it("refuses a late approved App reply after native retirement", async () => {
    const api = installApi();
    const bridge = installBridge();
    api.prepare.mockResolvedValue({
      kind: "consent",
      operationId,
      method: "tools/call",
      name: "lookup",
    });
    let complete!: (value: { json: string }) => void;
    api.resolve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const appEntry: VisualizationTimelineEntry = {
      ...entry,
      reference: { ...entry.reference, purpose: "mcp-app", serverLabel: "Fixture server" },
    };
    await render(<Fixture value={appEntry} />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    bridge.emit({
      leaseId,
      state: "message",
      json: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
    });
    await expect
      .element(page.getByRole("button", { name: "Allow once", exact: true }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Allow once", exact: true }));
    bridge.emit({ leaseId, state: "retired" });
    complete({ json: '{"private-late-operation":true}' });
    await Promise.resolve();
    expect(bridge.send).not.toHaveBeenCalled();
    expect(bridge.suspend).not.toHaveBeenCalledWith({
      leaseId,
      consentId: operationId,
      suspended: false,
    });
    expect(document.body.textContent).not.toContain("private-late-operation");
  });
  it("uses fresh exact consent identities for sequential operations and clears private details on quarantine", async () => {
    const api = installApi();
    const bridge = installBridge();
    const secondOperation = "ec3f962b-792c-45bb-a98b-a30a7c02bdb3";
    api.prepare.mockResolvedValueOnce({
      kind: "consent",
      operationId,
      method: "tools/call",
      name: "lookup",
    });
    api.prepare.mockResolvedValueOnce({
      kind: "consent",
      operationId: secondOperation,
      method: "resources/read",
      name: "read",
    });
    const appEntry: VisualizationTimelineEntry = {
      ...entry,
      reference: { ...entry.reference, purpose: "mcp-app", serverLabel: "Fixture server" },
    };
    await render(<Fixture value={appEntry} />);
    await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
    await expect.element(page.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
    bridge.emit({
      leaseId,
      state: "message",
      json: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
    });
    await expect.element(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Private details", exact: true }));
    await expect
      .element(page.getByText('"private-arguments-marker"', { exact: false }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Deny", exact: true }));
    await vi.waitFor(() =>
      expect(bridge.suspend).toHaveBeenCalledWith({
        leaseId,
        consentId: operationId,
        suspended: false,
      }),
    );
    bridge.emit({
      leaseId,
      state: "message",
      json: '{"jsonrpc":"2.0","id":2,"method":"resources/read"}',
    });
    await expect.element(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
    expect(bridge.suspend).toHaveBeenCalledWith({
      leaseId,
      consentId: secondOperation,
      suspended: true,
    });
    expect(api.appDetails).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("private-arguments-marker");
    await userEvent.click(page.getByRole("button", { name: "Private details", exact: true }));
    await expect
      .element(page.getByText('"private-arguments-marker"', { exact: false }))
      .toBeVisible();
    bridge.emit({ leaseId, state: "quarantined" });
    await expect
      .element(page.getByText("Viewer unavailable until retirement is verified."))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("private-arguments-marker");
    await vi.waitFor(() =>
      expect(page.getByRole("button", { name: "Allow once", exact: true }).query()).toBeNull(),
    );
  });
  it("requires executable export consent and never exports App tools or permissions", async () => {
    const api = installApi();
    await render(<Fixture />);
    await userEvent.click(page.getByRole("button", { name: "Export HTML…", exact: true }));
    await expect
      .element(
        page.getByRole("heading", {
          name: "Export executable HTML? · Revenue explorer",
          exact: true,
        }),
      )
      .toBeVisible();
    expect(api.exportHtml).not.toHaveBeenCalled();
    expect(api.details).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
    expect(api.exportHtml).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Export HTML…", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Download HTML", exact: true }));
    await expect.element(page.getByText("Download started", { exact: true })).toBeVisible();
    expect(download).toHaveBeenCalledWith("<p>private-portable-source</p>");
    expect(api.exportHtml).toHaveBeenCalledWith({ threadId, artifactId, revisionId });
    expect(document.querySelector("[data-visualization-card] iframe")).toBeNull();
  });
  it("does not hand off wrong-revision HTML or a late export from a replaced owner", async () => {
    const api = installApi();
    api.exportHtml.mockResolvedValueOnce({
      threadId,
      artifactId,
      revisionId: VisualizationRevisionId.make("572dddf7-83e1-4505-bf08-53b67e82bb7f"),
      html: "private-wrong-revision",
    });
    await render(<Fixture />);
    await userEvent.click(page.getByRole("button", { name: "Export HTML…", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Download HTML", exact: true }));
    await expect.element(page.getByText("Export unavailable.", { exact: true })).toBeVisible();
    expect(download).not.toHaveBeenCalled();
    let complete!: (value: Awaited<ReturnType<typeof api.exportHtml>>) => void;
    api.exportHtml.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await userEvent.click(page.getByRole("button", { name: "Export HTML…", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Download HTML", exact: true }));
    await vi.waitFor(() => expect(api.exportHtml).toHaveBeenCalledTimes(2));
    installApi();
    complete({ threadId, artifactId, revisionId, html: "private-late-export" });
    await Promise.resolve();
    expect(download).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private-late-export");
  });
  it("does not offer portable HTML for an App", async () => {
    installApi();
    const appEntry: VisualizationTimelineEntry = {
      ...entry,
      reference: { ...entry.reference, purpose: "mcp-app", serverLabel: "Fixture server" },
    };
    await render(<Fixture value={appEntry} />);
    expect(page.getByRole("button", { name: "Export HTML…", exact: true }).query()).toBeNull();
  });
});

/** A bounded received-page fixture; no private source or native host is started. */
function historyValues(count: number): VisualizationTimelineEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    ...entry,
    messageId: MessageId.make(`archive-message-${index + 1}`),
    turnId: TurnId.make(`archive-turn-${index + 1}`),
    originItemId: `archive-origin-${index + 1}`,
    // Some oldest stored rows have newer display timestamps. Retention must
    // still follow exact page admission rather than trust this presentation.
    occurredAt: new Date(
      Date.UTC(2026, 9, 12, 0, 0, index < 20 ? count + index : index),
    ).toISOString(),
    reference: {
      ...entry.reference,
      revisionId: VisualizationRevisionId.make(
        `60000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      ),
    },
  }));
}

function archivePage(values: readonly VisualizationTimelineEntry[], before = values.length + 1) {
  const last = Math.min(values.length, before - 1);
  const first = Math.max(1, last - 49);
  return {
    entries: values.slice(first - 1, last).toReversed(),
    ...(first > 1
      ? { nextCursor: `70000000-0000-4000-8000-${String(first).padStart(12, "0")}` }
      : {}),
  };
}

function HistoryReviewFixture({
  onObserve,
}: {
  onObserve: (result: ReturnType<typeof useThreadVisualizations>) => void;
}) {
  const [revision, setRevision] = useState(0);
  const result = useThreadVisualizations(environmentId, threadId, true, String(revision));
  useLayoutEffect(() => {
    onObserve(result);
  });
  return (
    <>
      <button disabled={result.loading} onClick={result.loadOlder}>
        Load older archive
      </button>
      <button onClick={() => setRevision((value) => value + 1)}>New live event</button>
      {result.reviewingOlder ? (
        <button onClick={result.returnToLatest}>{uiText("Return to latest")}</button>
      ) : null}
      {result.failed ? <button onClick={result.refresh}>Retry archive</button> : null}
      <output
        data-review-mode={result.reviewingOlder}
        data-reference-count={result.entries.length}
      />
    </>
  );
}

describe("durable compact visualization history", () => {
  it("makes every stored page reachable through a capped older-review window and explicit return to latest", async () => {
    const api = installApi();
    const values = historyValues(1_300);
    let published = 1_250;
    api.list.mockImplementation(async (input) =>
      archivePage(
        values.slice(0, published),
        input.cursor ? Number(input.cursor.slice(-12)) : undefined,
      ),
    );
    let observed: ReturnType<typeof useThreadVisualizations> | undefined;
    let peakReferences = 0;
    const started = performance.now();
    const view = await render(
      <HistoryReviewFixture
        onObserve={(result) => {
          observed = result;
          peakReferences = Math.max(peakReferences, result.entries.length);
        }}
      />,
    );
    try {
      await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
      for (let pageIndex = 1; pageIndex < 20; pageIndex += 1) {
        await userEvent.click(
          page.getByRole("button", { name: "Load older archive", exact: true }),
        );
        await vi.waitFor(() => expect(observed?.entries).toHaveLength((pageIndex + 1) * 50));
      }
      expect(observed?.hasOlder).toBe(true);
      const retainedOverlap = observed!.entries.find(
        (value) => value.originItemId === "archive-origin-500",
      );
      for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
        const calls = api.list.mock.calls.length + 1;
        await userEvent.click(
          page.getByRole("button", { name: "Load older archive", exact: true }),
        );
        await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(calls));
        await vi.waitFor(() => expect(observed?.loading).toBe(false));
        expect(observed?.entries).toHaveLength(1_000);
        expect(observed?.reviewingOlder).toBe(true);
      }
      expect(new Set(observed!.entries.map(visualizationEntryIdentity))).toEqual(
        new Set(values.slice(0, 1_000).map(visualizationEntryIdentity)),
      );
      expect(observed?.entries.find((value) => value.originItemId === "archive-origin-500")).toBe(
        retainedOverlap,
      );
      expect(observed?.hasOlder).toBe(false);
      await expect
        .element(page.getByRole("button", { name: "Return to latest", exact: true }))
        .toBeVisible();
      const reviewed = observed!.entries;
      published = 1_300;
      for (let event = 0; event < 3; event += 1)
        await userEvent.click(page.getByRole("button", { name: "New live event", exact: true }));
      expect(api.list).toHaveBeenCalledTimes(25);
      expect(observed?.entries).toBe(reviewed);
      await userEvent.click(page.getByRole("button", { name: "Return to latest", exact: true }));
      await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
      expect(new Set(observed!.entries.map(visualizationEntryIdentity))).toEqual(
        new Set(values.slice(1_250).map(visualizationEntryIdentity)),
      );
      expect(observed?.reviewingOlder).toBe(false);
      expect(api.list).toHaveBeenCalledTimes(26);
      expect(peakReferences).toBe(1_000);
      expect(api.details).not.toHaveBeenCalled();
      expect(api.viewerTicket).not.toHaveBeenCalled();
      expect(document.querySelector("iframe")).toBeNull();
      console.info(
        "visualization-sliding-history-qualification",
        JSON.stringify({
          storedReferences: published,
          peakReferences,
          explicitOlderPages: 24,
          listRequests: api.list.mock.calls.length,
          observedMs: Number((performance.now() - started).toFixed(2)),
        }),
      );
    } finally {
      await view.unmount();
    }
  });
  it("revokes a deferred older page before one return-to-latest replacement, without overlapping requests", async () => {
    const api = installApi();
    const values = historyValues(1_100);
    const pending = deferred<Awaited<ReturnType<typeof api.list>>>();
    let held: Awaited<ReturnType<typeof api.list>> | undefined;
    let holdOlder = false;
    let concurrent = 0;
    let peakRequests = 0;
    api.list.mockImplementation(async (input) => {
      concurrent += 1;
      peakRequests = Math.max(peakRequests, concurrent);
      try {
        const result = archivePage(
          values,
          input.cursor ? Number(input.cursor.slice(-12)) : undefined,
        );
        if (input.cursor && holdOlder) {
          holdOlder = false;
          held = result;
          return await pending.promise;
        }
        return result;
      } finally {
        concurrent -= 1;
      }
    });
    let observed: ReturnType<typeof useThreadVisualizations> | undefined;
    const admittedSnapshots: string[][] = [];
    const view = await render(
      <HistoryReviewFixture
        onObserve={(result) => {
          observed = result;
          admittedSnapshots.push(result.entries.map((value) => value.originItemId));
        }}
      />,
    );
    try {
      await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
      for (let pageIndex = 1; pageIndex < 20; pageIndex += 1) {
        await userEvent.click(
          page.getByRole("button", { name: "Load older archive", exact: true }),
        );
        await vi.waitFor(() => expect(observed?.entries).toHaveLength((pageIndex + 1) * 50));
      }
      holdOlder = true;
      await userEvent.click(page.getByRole("button", { name: "Load older archive", exact: true }));
      await vi.waitFor(() => expect(held).toBeDefined());
      expect(observed?.reviewingOlder).toBe(true);
      await userEvent.click(page.getByRole("button", { name: "Return to latest", exact: true }));
      for (let event = 0; event < 3; event += 1)
        await userEvent.click(page.getByRole("button", { name: "New live event", exact: true }));
      expect(api.list).toHaveBeenCalledTimes(21);
      pending.resolve(held!);
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(22));
      await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
      expect(observed?.reviewingOlder).toBe(false);
      expect(admittedSnapshots.some((snapshot) => snapshot.includes("archive-origin-51"))).toBe(
        false,
      );
      expect(new Set(observed!.entries.map(visualizationEntryIdentity))).toEqual(
        new Set(values.slice(-50).map(visualizationEntryIdentity)),
      );
      expect(peakRequests).toBe(1);
      expect(concurrent).toBe(0);
    } finally {
      pending.resolve(held ?? { entries: [] });
      await view.unmount();
    }
  });
  it.each(["empty", "failure"] as const)(
    "keeps return-to-latest available after an older-review %s",
    async (outcome) => {
      const api = installApi();
      const values = historyValues(1_100);
      api.list.mockImplementation(async (input) =>
        archivePage(values, input.cursor ? Number(input.cursor.slice(-12)) : undefined),
      );
      let observed: ReturnType<typeof useThreadVisualizations> | undefined;
      const view = await render(
        <HistoryReviewFixture
          onObserve={(result) => {
            observed = result;
          }}
        />,
      );
      try {
        await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
        for (let pageIndex = 1; pageIndex < 20; pageIndex += 1) {
          await userEvent.click(
            page.getByRole("button", { name: "Load older archive", exact: true }),
          );
          await vi.waitFor(() => expect(observed?.entries).toHaveLength((pageIndex + 1) * 50));
        }
        if (outcome === "empty") api.list.mockResolvedValueOnce({ entries: [] });
        else api.list.mockRejectedValueOnce(new Error("private-history-failure"));
        await userEvent.click(
          page.getByRole("button", { name: "Load older archive", exact: true }),
        );
        await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(21));
        await vi.waitFor(() => expect(observed?.loading).toBe(false));
        expect(observed?.entries).toHaveLength(1_000);
        expect(observed?.reviewingOlder).toBe(true);
        await expect
          .element(page.getByRole("button", { name: "Return to latest", exact: true }))
          .toBeVisible();
        if (outcome === "failure") {
          expect(document.body.textContent).not.toContain("private-history-failure");
          await userEvent.click(page.getByRole("button", { name: "Retry archive", exact: true }));
          await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(22));
          expect(api.list.mock.calls[21]?.[0]).toEqual(api.list.mock.calls[20]?.[0]);
          await vi.waitFor(() => expect(observed?.loading).toBe(false));
          expect(
            observed?.entries.some((value) => value.originItemId === "archive-origin-51"),
          ).toBe(true);
        }
        await userEvent.click(page.getByRole("button", { name: "Return to latest", exact: true }));
        await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
        expect(observed?.reviewingOlder).toBe(false);
        expect(api.list.mock.calls.at(-1)?.[0]).toEqual({ threadId });
      } finally {
        await view.unmount();
      }
    },
  );
  it("retains separate exact root and child invocations of the same immutable revision across refreshes", async () => {
    const api = installApi();
    const root: VisualizationTimelineEntry = {
      ...entry,
      actor: { type: "root" },
      originItemId: "root-call",
    };
    const child: VisualizationTimelineEntry = {
      ...entry,
      actor: { type: "child", id: "other-child" },
      originItemId: "child-call",
    };
    api.list.mockResolvedValue({ entries: [root, child] });
    let observed: ReturnType<typeof useThreadVisualizations> | undefined;
    const view = await render(
      <HistoryReviewFixture
        onObserve={(result) => {
          observed = result;
        }}
      />,
    );
    try {
      await vi.waitFor(() => expect(observed?.entries).toHaveLength(2));
      const initial = observed!.entries;
      await userEvent.click(page.getByRole("button", { name: "New live event", exact: true }));
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(observed?.loading).toBe(false));
      expect(observed?.entries).toHaveLength(2);
      expect(observed?.entries[0]).toBe(initial[0]);
      expect(observed?.entries[1]).toBe(initial[1]);
      expect(new Set(observed!.entries.map(visualizationEntryIdentity)).size).toBe(2);
      expect(observed?.entries.map((value) => value.actor.type)).toEqual(["root", "child"]);
      expect(api.details).not.toHaveBeenCalled();
      expect(api.viewerTicket).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });
  it.each([50, 1_000])(
    "fills a 120-reference refresh gap without dropping the %i-reference retained window",
    async (initialCount) => {
      const api = installApi();
      const values = Array.from(
        { length: initialCount + 120 },
        (_, index): VisualizationTimelineEntry => ({
          ...entry,
          occurredAt: new Date(Date.UTC(2026, 9, 12, 0, 0, index)).toISOString(),
          reference: {
            ...entry.reference,
            revisionId: VisualizationRevisionId.make(
              `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
            ),
            title: `Burst chart ${index + 1}`,
          },
        }),
      );
      let publishedCount = initialCount;
      const cursorFor = (index: number) =>
        `30000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      api.list.mockImplementation(async (input) => {
        // Cursor identity is an immutable row boundary, not an offset that
        // shifts when new rows arrive. This matches the actual list contract.
        const before = input.cursor ? Number(input.cursor.slice(-12)) : publishedCount + 1;
        const last = Math.min(publishedCount, before - 1);
        const first = Math.max(1, last - 49);
        return {
          entries: values.slice(first - 1, last).toReversed(),
          ...(first > 1 ? { nextCursor: cursorFor(first) } : {}),
        };
      });
      let observed: ReturnType<typeof useThreadVisualizations> | undefined;
      function History() {
        const [revision, setRevision] = useState(0);
        const result = useThreadVisualizations(environmentId, threadId, true, String(revision));
        useLayoutEffect(() => {
          observed = result;
        });
        return (
          <>
            <button onClick={result.loadOlder}>Older burst references</button>
            <button onClick={() => setRevision((value) => value + 1)}>
              Refresh burst references
            </button>
          </>
        );
      }
      const view = await render(<History />);
      try {
        await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
        for (let pageIndex = 1; pageIndex < initialCount / 50; pageIndex += 1) {
          await userEvent.click(
            page.getByRole("button", { name: "Older burst references", exact: true }),
          );
          await vi.waitFor(() => expect(observed?.entries).toHaveLength((pageIndex + 1) * 50));
        }
        expect(observed?.hasOlder).toBe(false);
        publishedCount += 120;
        await userEvent.click(
          page.getByRole("button", { name: "Refresh burst references", exact: true }),
        );
        await vi.waitFor(() =>
          expect(observed?.entries.at(-1)?.reference.revisionId).toBe(
            values.at(-1)!.reference.revisionId,
          ),
        );
        expect(observed?.hasOlder).toBe(true);
        // One refresh plus two explicit pages reconnect to the original known
        // head, including when retained memory is already at its 1,000-row cap.
        for (let pageIndex = 0; pageIndex < 2; pageIndex += 1) {
          const expectedCalls = api.list.mock.calls.length + 1;
          await userEvent.click(
            page.getByRole("button", { name: "Older burst references", exact: true }),
          );
          await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(expectedCalls));
          await vi.waitFor(() => expect(observed?.loading).toBe(false));
        }
        expect(observed?.entries.map((value) => value.reference.revisionId)).toEqual(
          values.slice(-1_000).map((value) => value.reference.revisionId),
        );
        expect(observed?.hasOlder).toBe(initialCount === 1_000);
        expect(api.list).toHaveBeenCalledTimes(initialCount / 50 + 3);
        if (initialCount === 1_000) {
          // Reconstructing the capped latest window evicted a known tail. Its
          // original end cursor must not strand those rows; the exact gap page
          // continuation remains explicitly browseable all the way to row one.
          for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
            const calls = api.list.mock.calls.length + 1;
            await userEvent.click(
              page.getByRole("button", { name: "Older burst references", exact: true }),
            );
            await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(calls));
            await vi.waitFor(() => expect(observed?.loading).toBe(false));
            expect(observed?.entries).toHaveLength(1_000);
          }
          expect(observed?.entries.map((value) => value.reference.revisionId)).toEqual(
            values.slice(0, 1_000).map((value) => value.reference.revisionId),
          );
          expect(observed?.hasOlder).toBe(false);
          expect(observed?.reviewingOlder).toBe(true);
        }
        expect(api.details).not.toHaveBeenCalled();
        expect(api.viewerTicket).not.toHaveBeenCalled();
      } finally {
        await view.unmount();
      }
    },
  );
  it("retains the original gap boundary when a later burst refresh follows an in-flight older page", async () => {
    const api = installApi();
    const values = Array.from({ length: 250 }, (_, index): VisualizationTimelineEntry => ({
      ...entry,
      occurredAt: new Date(Date.UTC(2026, 9, 12, 0, 0, index)).toISOString(),
      reference: {
        ...entry.reference,
        revisionId: VisualizationRevisionId.make(
          `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        ),
      },
    }));
    let publishedCount = 50;
    let deferredOlder = false;
    const pending = deferred<Awaited<ReturnType<typeof api.list>>>();
    let pendingPage: Awaited<ReturnType<typeof api.list>> | undefined;
    api.list.mockImplementation((input) => {
      const before = input.cursor ? Number(input.cursor.slice(-12)) : publishedCount + 1;
      const last = Math.min(publishedCount, before - 1);
      const first = Math.max(1, last - 49);
      const result = {
        entries: values.slice(first - 1, last).toReversed(),
        ...(first > 1
          ? { nextCursor: `50000000-0000-4000-8000-${String(first).padStart(12, "0")}` }
          : {}),
      };
      if (input.cursor && deferredOlder) {
        deferredOlder = false;
        pendingPage = result;
        return pending.promise;
      }
      return Promise.resolve(result);
    });
    let observed: ReturnType<typeof useThreadVisualizations> | undefined;
    function History() {
      const [revision, setRevision] = useState(0);
      const result = useThreadVisualizations(environmentId, threadId, true, String(revision));
      useLayoutEffect(() => {
        observed = result;
      });
      return (
        <>
          <button onClick={result.loadOlder}>Older overlapping references</button>
          <button onClick={() => setRevision((value) => value + 1)}>
            Refresh overlapping references
          </button>
        </>
      );
    }
    const view = await render(<History />);
    try {
      await vi.waitFor(() => expect(observed?.entries).toHaveLength(50));
      publishedCount = 170;
      await userEvent.click(
        page.getByRole("button", { name: "Refresh overlapping references", exact: true }),
      );
      await vi.waitFor(() =>
        expect(observed?.entries.at(-1)?.reference.revisionId).toBe(
          values[169]!.reference.revisionId,
        ),
      );
      deferredOlder = true;
      await userEvent.click(
        page.getByRole("button", { name: "Older overlapping references", exact: true }),
      );
      await vi.waitFor(() => expect(pendingPage).toBeDefined());
      const beforeRefreshCalls = api.list.mock.calls.length;
      publishedCount = 250;
      await userEvent.click(
        page.getByRole("button", { name: "Refresh overlapping references", exact: true }),
      );
      expect(api.list).toHaveBeenCalledTimes(beforeRefreshCalls);
      pending.resolve(pendingPage!);
      await vi.waitFor(() =>
        expect(observed?.entries.at(-1)?.reference.revisionId).toBe(
          values[249]!.reference.revisionId,
        ),
      );
      expect(api.list).toHaveBeenCalledTimes(beforeRefreshCalls + 1);
      for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
        const expectedCalls = api.list.mock.calls.length + 1;
        await userEvent.click(
          page.getByRole("button", { name: "Older overlapping references", exact: true }),
        );
        await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(expectedCalls));
        await vi.waitFor(() => expect(observed?.loading).toBe(false));
      }
      expect(observed?.entries.map((value) => value.reference.revisionId)).toEqual(
        values.map((value) => value.reference.revisionId),
      );
      expect(observed?.hasOlder).toBe(false);
      expect(api.list).toHaveBeenCalledTimes(8);
      expect(api.details).not.toHaveBeenCalled();
      expect(api.viewerTicket).not.toHaveBeenCalled();
    } finally {
      if (pendingPage) pending.resolve(pendingPage);
      await view.unmount();
    }
  });
  it("retains at most 1,000 compact references through explicit bounded pagination", async () => {
    const api = installApi();
    const values = Array.from({ length: 1_000 }, (_, index): VisualizationTimelineEntry => ({
      ...entry,
      reference: {
        ...entry.reference,
        revisionId: VisualizationRevisionId.make(
          `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        ),
        title: `Compact chart ${index + 1}`,
      },
    }));
    // Synthetic retention stress exceeds the store's per-chat publication quota;
    // it qualifies the reader bound, not permission to publish 1,000 artifacts.
    const cursorFor = (index: number) =>
      `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    api.list.mockImplementation(async (input) => {
      const offset = input.cursor ? Number(input.cursor.slice(-12)) : 0;
      return {
        entries: values.slice(offset, offset + 50),
        ...(offset + 50 < values.length ? { nextCursor: cursorFor(offset + 50) } : {}),
      };
    });
    let firstReference: VisualizationTimelineEntry | undefined;
    let latestFirstReference: VisualizationTimelineEntry | undefined;
    let observedCount = 0;
    function History() {
      const [revision, setRevision] = useState("one");
      const result = useThreadVisualizations(environmentId, threadId, true, revision);
      observedCount = result.entries.length;
      firstReference ??= result.entries[0];
      latestFirstReference = result.entries[0];
      return (
        <>
          <button onClick={result.loadOlder}>Older compact references</button>
          <button onClick={() => setRevision("two")}>Refresh compact references</button>
          <output data-compact-count={result.entries.length} data-has-older={result.hasOlder} />
        </>
      );
    }
    const started = performance.now();
    const view = await render(<History />);
    try {
      await vi.waitFor(() => expect(observedCount).toBe(50));
      for (let pageIndex = 1; pageIndex < 20; pageIndex += 1) {
        await userEvent.click(
          page.getByRole("button", { name: "Older compact references", exact: true }),
        );
        await vi.waitFor(() => expect(observedCount).toBe((pageIndex + 1) * 50));
      }
      expect(api.list).toHaveBeenCalledTimes(20);
      expect(document.querySelector("output")?.getAttribute("data-has-older")).toBe("false");
      await userEvent.click(
        page.getByRole("button", { name: "Older compact references", exact: true }),
      );
      expect(api.list).toHaveBeenCalledTimes(20);
      await userEvent.click(
        page.getByRole("button", { name: "Refresh compact references", exact: true }),
      );
      await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(21));
      expect(observedCount).toBe(1_000);
      expect(latestFirstReference).toBe(firstReference);
      expect(api.details).not.toHaveBeenCalled();
      expect(api.viewerTicket).not.toHaveBeenCalled();
      expect(document.querySelector("iframe")).toBeNull();
      console.info(
        "visualization-history-qualification",
        JSON.stringify({
          references: observedCount,
          pageSize: 50,
          listRequests: api.list.mock.calls.length,
          compactJsonBytes: new TextEncoder().encode(JSON.stringify(values)).byteLength,
          observedMs: Number((performance.now() - started).toFixed(2)),
        }),
      );
    } finally {
      await view.unmount();
    }
  });
  it("coalesces a burst while one list request is in flight and ignores late old-chat results", async () => {
    let complete!: (value: { entries: VisualizationTimelineEntry[] }) => void;
    const api = installApi();
    api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    function History() {
      const [revision, setRevision] = useState("one");
      const [thread, setThread] = useState(threadId);
      const result = useThreadVisualizations(environmentId, thread, true, revision);
      return (
        <>
          <button
            onClick={() => {
              setRevision("two");
            }}
          >
            New event
          </button>
          <button onClick={() => setThread(ThreadId.make("another-chat"))}>Switch chat</button>
          <output>{result.entries.map((value) => value.reference.title).join(",")}</output>
        </>
      );
    }
    await render(<History />);
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    await userEvent.click(page.getByRole("button", { name: "New event", exact: true }));
    expect(api.list).toHaveBeenCalledTimes(1);
    api.list.mockResolvedValue({ entries: [] });
    await userEvent.click(page.getByRole("button", { name: "Switch chat", exact: true }));
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
    complete({ entries: [entry] });
    await Promise.resolve();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(document.querySelector("output")!.textContent).toBe("");
  });
});

describe("bounded visualization resource qualification", () => {
  it("limits poster transport to two active reads and eight cancellable waiting reads", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("fixture-png-unavailable"))),
        "image/png",
      ),
    );
    const png = new Uint8Array(await blob.arrayBuffer());
    const reference = Schema.decodeUnknownSync(GeneratedVisualizationReference)({
      ...entry.reference,
      poster: { id: "945c84d1-2b36-4ff2-a6e5-554fa5df36cd", width: 16, height: 16 },
    });
    const finish: ((response: Response) => void)[] = [];
    vi.mocked(fileRequest).mockImplementation(
      () => new Promise<Response>((resolve) => finish.push(resolve)),
    );
    const controllers = Array.from({ length: 11 }, () => new AbortController());
    // Attach both outcomes immediately: saturating/cancelling received work
    // must not create an unhandled rejection or leave an unbounded promise tail.
    const outcomes = controllers.map((controller) =>
      acquireVisualizationPoster(environmentId, threadId, reference, controller.signal).then(
        (lease) => {
          lease.release();
          return "decoded";
        },
        () => "refused",
      ),
    );
    try {
      expect(readVisualizationPosterAccounting()).toMatchObject({
        activeTransfers: 2,
        queuedTransfers: 8,
      });
      expect(fileRequest).toHaveBeenCalledTimes(2);
      for (const controller of controllers.slice(2)) controller.abort();
      expect(readVisualizationPosterAccounting().queuedTransfers).toBe(0);
      for (const complete of finish)
        complete(new Response(png.slice().buffer, { headers: { "content-type": "image/png" } }));
      const settled = await Promise.all(outcomes);
      expect(settled.filter((value) => value === "decoded")).toHaveLength(2);
      expect(settled.filter((value) => value === "refused")).toHaveLength(9);
      expect(fileRequest).toHaveBeenCalledTimes(2);
      expect(readVisualizationPosterAccounting()).toMatchObject({
        activeTransfers: 0,
        queuedTransfers: 0,
        retainedItems: 0,
        retainedBytes: 0,
      });
    } finally {
      for (const controller of controllers) controller.abort();
      for (const complete of finish)
        complete(new Response(png.slice().buffer, { headers: { "content-type": "image/png" } }));
      await Promise.all(outcomes);
    }
  });
  it("completes fifty distinct Run/Stop cycles with one synthetic native owner and no idle private DOM", async () => {
    const api = installApi();
    const bridge = installBridge();
    const live = new Set<string>();
    let maxConcurrent = 0;
    let currentExpires = 0;
    api.viewerTicket.mockImplementation(async () => ({
      threadId,
      artifactId,
      revisionId,
      ticket: Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join(""),
      expiresAtMs: Date.now() + 10_000,
    }));
    bridge.open.mockImplementation(async () => {
      expect(live.size).toBe(0);
      const fresh = crypto.randomUUID();
      live.add(fresh);
      maxConcurrent = Math.max(maxConcurrent, live.size);
      currentExpires = Date.now() + 300_000;
      return { leaseId: fresh, state: "active", expiresAtMs: currentExpires };
    });
    bridge.update.mockImplementation(async (input) => {
      expect(live.has(input.leaseId)).toBe(true);
      return { leaseId: input.leaseId, state: "active", expiresAtMs: currentExpires };
    });
    bridge.retire.mockImplementation(async (input) => {
      expect(live.delete(input.leaseId)).toBe(true);
      return { leaseId: input.leaseId, state: "retired", expiresAtMs: currentExpires };
    });
    const started = performance.now();
    const view = await render(<Fixture />);
    try {
      for (let cycle = 0; cycle < 50; cycle += 1) {
        await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));
        await expect.element(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
        await userEvent.click(page.getByRole("button", { name: "Stop", exact: true }));
        await expect.element(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
      }
      await userEvent.click(
        page.getByRole("button", { name: "Private source and JSON", exact: true }),
      );
      await expect.element(page.getByText("private-json-marker", { exact: false })).toBeVisible();
      await userEvent.click(
        page.getByRole("button", { name: "Private source and JSON", exact: true }),
      );
      await vi.waitFor(() =>
        expect(document.body.textContent).not.toContain("private-json-marker"),
      );
      expect(live.size).toBe(0);
      expect(maxConcurrent).toBe(1);
      expect(bridge.open).toHaveBeenCalledTimes(50);
      expect(bridge.retire).toHaveBeenCalledTimes(50);
      expect(new Set(bridge.retire.mock.calls.map(([input]) => input.leaseId)).size).toBe(50);
      expect(document.querySelector("iframe")).toBeNull();
      console.info(
        "visualization-cycle-qualification",
        JSON.stringify({
          cycles: 50,
          maxSyntheticOwners: maxConcurrent,
          idleSyntheticOwners: live.size,
          observedMs: Number((performance.now() - started).toFixed(2)),
        }),
      );
    } finally {
      await view.unmount();
    }
    expect(live.size).toBe(0);
    expect(document.querySelector("[data-visualization-card]")).toBeNull();
    expect(document.body.textContent).not.toContain("private-source-marker");
    expect(readVisualizationPosterAccounting().retainedBytes).toBe(0);
  });

  it("accounts real bitmap bytes before decoding and revokes the last poster URL on release", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 2000;
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("fixture-png-unavailable"))),
        "image/png",
      ),
    );
    const png = new Uint8Array(await blob.arrayBuffer());
    const reference = Schema.decodeUnknownSync(GeneratedVisualizationReference)({
      ...entry.reference,
      poster: { id: "945c84d1-2b36-4ff2-a6e5-554fa5df36cd", width: 1600, height: 2000 },
    });
    const second = {
      ...reference,
      revisionId: VisualizationRevisionId.make("3902c28e-399e-4d3a-9539-3f7c117c9d76"),
    };
    vi.mocked(fileRequest).mockImplementation(
      async () => new Response(png.slice().buffer, { headers: { "content-type": "image/png" } }),
    );
    const decode = vi.spyOn(window, "createImageBitmap");
    const createUrl = vi.spyOn(URL, "createObjectURL");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL");
    let first: Awaited<ReturnType<typeof acquireVisualizationPoster>> | undefined;
    let shared: Awaited<ReturnType<typeof acquireVisualizationPoster>> | undefined;
    let next: Awaited<ReturnType<typeof acquireVisualizationPoster>> | undefined;
    const started = performance.now();
    try {
      expect(readVisualizationPosterAccounting().retainedBytes).toBe(0);
      first = await acquireVisualizationPoster(
        environmentId,
        threadId,
        reference,
        new AbortController().signal,
      );
      shared = await acquireVisualizationPoster(
        environmentId,
        threadId,
        reference,
        new AbortController().signal,
      );
      expect(shared.url).toBe(first.url);
      expect(readVisualizationPosterAccounting()).toEqual({
        activeTransfers: 0,
        queuedTransfers: 0,
        retainedItems: 1,
        retainedBytes: 1600 * 2000 * 4 + png.byteLength,
        maxRetainedBytes: 16 * 1024 * 1024,
      });
      await expect(
        acquireVisualizationPoster(environmentId, threadId, second, new AbortController().signal),
      ).rejects.toThrow("poster-busy");
      expect(decode).toHaveBeenCalledTimes(1);
      expect(createUrl).toHaveBeenCalledTimes(1);
      first.release();
      expect(revokeUrl).not.toHaveBeenCalled();
      shared.release();
      expect(revokeUrl).toHaveBeenCalledWith(first.url);
      expect(readVisualizationPosterAccounting().retainedItems).toBe(0);
      next = await acquireVisualizationPoster(
        environmentId,
        threadId,
        second,
        new AbortController().signal,
      );
      expect(decode).toHaveBeenCalledTimes(2);
      next.release();
      expect(revokeUrl).toHaveBeenCalledTimes(2);
      expect(readVisualizationPosterAccounting()).toEqual({
        activeTransfers: 0,
        queuedTransfers: 0,
        retainedItems: 0,
        retainedBytes: 0,
        maxRetainedBytes: 16 * 1024 * 1024,
      });
      console.info(
        "visualization-poster-qualification",
        JSON.stringify({
          pngBytes: png.byteLength,
          conservativePeakOwnedBytes: 1600 * 2000 * 4 + png.byteLength,
          bitmapDecodes: decode.mock.calls.length,
          createdUrls: createUrl.mock.calls.length,
          revokedUrls: revokeUrl.mock.calls.length,
          idleOwnedBytes: 0,
          observedMs: Number((performance.now() - started).toFixed(2)),
        }),
      );
    } finally {
      first?.release();
      shared?.release();
      next?.release();
      decode.mockRestore();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    }
  });
});
