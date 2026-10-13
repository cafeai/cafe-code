import "../../index.css";
import { EnvironmentId, ThreadId, type EnvironmentApi } from "@cafecode/contracts";
import {
  VisualizationArtifactId,
  VisualizationRevisionId,
} from "@cafecode/contracts/visualizations";
import type { VisualizationInlineResult } from "@cafecode/contracts/visualizationApi";
import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { InlineMcpAppBridge } from "./InlineMcpAppBridge";

const environmentId = EnvironmentId.make("inline-app-fixture-environment");
const threadId = ThreadId.make("inline-app-fixture-chat");
const artifactId = VisualizationArtifactId.make("b334c0d1-8c2a-4c47-9b07-70a280984ada");
const revisionId = VisualizationRevisionId.make("a844c0d1-8c2a-4c47-9b07-70a280984ada");
const reference = {
  version: 1 as const,
  purpose: "mcp-app" as const,
  artifactId,
  revisionId,
  title: "Owned App",
  serverLabel: "Fixture server",
  width: 640,
  height: 240,
};
const payload: VisualizationInlineResult = {
  threadId,
  artifactId,
  revisionId,
  purpose: "mcp-app",
  fullAccess: true,
  html: "",
  frameId: "d334c0d1-8c2a-4c47-9b07-70a280984ada",
  ticket: "a".repeat(64),
  expiresAtMs: Date.now() + 30_000,
};

/** Actual ordinary srcdoc/WindowProxy messages, not fabricated MessageEvents or
 * a mocked native lease. Backend protocol/operation admission is tested in its
 * own credential-free suite; these assertions qualify the browser channel. */
function Fixture({
  source,
  onClose = () => undefined,
  current = () => true,
}: {
  source: string;
  onClose?: () => void;
  current?: () => boolean;
}) {
  const element = useRef<HTMLIFrameElement | null>(null);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  useLayoutEffect(() => {
    setFrame(element.current);
  }, []);
  return (
    <>
      <iframe ref={element} title="App protocol fixture" />
      {frame ? (
        <InlineMcpAppBridge
          environmentId={environmentId}
          threadId={threadId}
          reference={reference}
          payload={payload}
          frame={frame}
          current={current}
          onDisplayMode={async () => true}
          onClose={onClose}
          onReady={() => {
            frame.srcdoc = source;
          }}
        />
      ) : null}
    </>
  );
}
function api() {
  const prepare = vi.fn<NonNullable<EnvironmentApi["mcpApps"]>["prepare"]>(async (input) => {
    const value = JSON.parse(input.requestJson);
    return { kind: "reply", json: JSON.stringify({ jsonrpc: "2.0", id: value.id, result: {} }) };
  });
  const resolve = vi.fn<NonNullable<EnvironmentApi["mcpApps"]>["resolve"]>(async () => ({
    json: '{"jsonrpc":"2.0","id":2,"result":{"content":[]}}',
  }));
  const details = vi.fn<NonNullable<EnvironmentApi["mcpApps"]>["details"]>(async () => ({
    json: '{"private":"fixture-secret"}',
  }));
  __setEnvironmentApiOverrideForTests(environmentId, {
    mcpApps: { prepare, resolve, details },
  } as unknown as EnvironmentApi);
  return { prepare, resolve, details };
}
function documentFor(method = "ui/initialize") {
  return `<!doctype html><body><button id="request">Ask operation</button><script>
    window.replies=[]; window.addEventListener('message', e => { if(e.source===parent) window.replies.push(e.data); });
    parent.postMessage({jsonrpc:'2.0',id:1,method:'${method}',params:{}},'*');
    document.getElementById('request').onclick=()=>parent.postMessage({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'act',arguments:{count:1}}},'*');
  </script></body>`;
}
function child() {
  const frame = document.querySelector<HTMLIFrameElement>('iframe[title="App protocol fixture"]')!;
  return frame.contentWindow as Window & { replies: unknown[] };
}
afterEach(() => __resetEnvironmentApiOverridesForTests());

describe("inline App protocol channel", () => {
  it("registers before parsing, forwards replies to only the exact frame, and keeps that document across parent renders", async () => {
    const peer = api();
    const source = documentFor();
    const view = await render(<Fixture source={source} />);
    await expect.poll(() => peer.prepare.mock.calls.length).toBe(1);
    expect(peer.prepare.mock.calls[0]![0]).toMatchObject({
      threadId,
      artifactId,
      revisionId,
      leaseId: payload.frameId,
      ticket: payload.ticket,
    });
    await expect.poll(() => child().replies.length).toBe(1);
    const before = child().document;
    expect(before.URL).toBe("about:srcdoc");
    expect(
      document.querySelector('iframe[title="App protocol fixture"]')!.hasAttribute("sandbox"),
    ).toBe(false);
    await view.rerender(<Fixture source={source} />);
    expect(child().document).toBe(before);
    expect(peer.prepare).toHaveBeenCalledTimes(1);
    expect(peer.resolve).not.toHaveBeenCalled();
    expect(peer.details).not.toHaveBeenCalled();
  });
  it("requires an actual one-use permission gesture and keeps private JSON behind explicit inspection", async () => {
    const peer = api();
    peer.prepare
      .mockResolvedValueOnce({ kind: "reply", json: '{"jsonrpc":"2.0","id":1,"result":{}}' })
      .mockResolvedValueOnce({
        kind: "consent",
        expiresAtMs: Date.now() + 30_000,
        operationId: "c334c0d1-8c2a-4c47-9b07-70a280984ada",
        method: "tools/call",
        name: "act",
      });
    await render(<Fixture source={documentFor()} />);
    await expect.poll(() => child()?.replies?.length).toBe(1);
    child().document.getElementById("request")!.click();
    await expect
      .element(page.getByText("Allow this one App operation?", { exact: true }))
      .toBeVisible();
    expect(peer.resolve).not.toHaveBeenCalled();
    expect(peer.details).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("fixture-secret");
    // A received page's synthetic parent click is not a human approval. Full
    // access still permits parent authority; this is only broker UI hygiene.
    (
      page.getByRole("button", { name: "Allow once", exact: true }).element() as HTMLElement
    ).click();
    expect(peer.resolve).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Private details", exact: true }).click();
    await expect.poll(() => peer.details.mock.calls.length).toBe(1);
    await expect
      .element(page.getByText('{"private":"fixture-secret"}', { exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect.poll(() => peer.resolve.mock.calls.length).toBe(1);
    expect(peer.resolve.mock.calls[0]![0]).toEqual({
      operationId: "c334c0d1-8c2a-4c47-9b07-70a280984ada",
      decision: "approve",
    });
    await expect.poll(() => child().replies.length).toBe(2);
    expect(document.body.textContent).not.toContain("fixture-secret");
  });
  it("does not route messages from sibling frames or accept a late reply after access loss", async () => {
    const peer = api();
    let permit = true,
      settle!: (value: unknown) => void;
    peer.prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve as (value: unknown) => void;
        }),
    );
    await render(<Fixture source={documentFor()} current={() => permit} />);
    await expect.poll(() => peer.prepare.mock.calls.length).toBe(1);
    const sibling = document.createElement("iframe");
    document.body.append(sibling);
    try {
      sibling.srcdoc = documentFor();
      await new Promise<void>((resolve) => {
        sibling.onload = () => resolve();
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(peer.prepare).toHaveBeenCalledTimes(1);
      permit = false;
      settle({ kind: "reply", json: '{"jsonrpc":"2.0","id":1,"result":{}}' });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(child().replies).toEqual([]);
    } finally {
      sibling.remove();
    }
  });
  it("refuses an already expired server consent instead of granting a fresh client-side allowance", async () => {
    const peer = api();
    const onClose = vi.fn();
    peer.prepare
      .mockResolvedValueOnce({ kind: "reply", json: '{"jsonrpc":"2.0","id":1,"result":{}}' })
      .mockResolvedValueOnce({
        kind: "consent",
        expiresAtMs: Date.now() - 1,
        operationId: "c334c0d1-8c2a-4c47-9b07-70a280984ada",
        method: "tools/call",
        name: "act",
      });
    await render(<Fixture source={documentFor()} onClose={onClose} />);
    await expect.poll(() => child()?.replies?.length).toBe(1);
    child().document.getElementById("request")!.click();
    await expect.poll(() => onClose.mock.calls.length).toBe(1);
    expect(peer.resolve).not.toHaveBeenCalled();
    expect(peer.details).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Allow this one App operation?");
  });
});
