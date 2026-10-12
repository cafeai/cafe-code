import "../../index.css";
import { EnvironmentId } from "@cafecode/contracts";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import ChatMarkdown from "../ChatMarkdown";
import { applyInterfaceScalePercent } from "../../interfaceScale";
import { setUiLocale } from "@cafecode/shared/i18n";

const mocks = vi.hoisted(() => ({ fileRequest: vi.fn() }));
vi.mock("../../attachments/fileAttachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../attachments/fileAttachments")>()),
  fileRequest: mocks.fileRequest,
}));

let image: Uint8Array;
let fetcher: Mock<(url: string | URL, init?: RequestInit) => Promise<Response>>;
beforeEach(() => {
  setUiLocale("en");
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 160;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#408060";
  context.fillRect(0, 0, 320, 160);
  image = Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]!), (character) =>
    character.charCodeAt(0),
  );

  fetcher = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const parsed = new URL(url);
    return parsed.searchParams.has("source")
      ? new Response(new Uint8Array(image), { headers: { "content-type": "image/png" } })
      : new Response(
          JSON.stringify([
            {
              source: "/repo/chart%20one.png",
              mimeType: "image/png",
              width: 320,
              height: 160,
              sizeBytes: image.length,
            },
          ]),
        );
  });
  mocks.fileRequest.mockReset();
  mocks.fileRequest.mockImplementation((environmentId, pathname, init, searchParams) =>
    fetcher(
      `https://${environmentId}.example${pathname}?${new URLSearchParams(searchParams)}`,
      init,
    ),
  );
});
afterEach(() => {
  setUiLocale("en");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  applyInterfaceScalePercent(100);
});

it("relabels an existing image across languages without fetching or replacing its bytes", async () => {
  const preview = vi.fn();
  const screen = await render(fixture("remote", false, undefined, preview));
  await expect.element(page.getByRole("img", { name: "Chart" })).toBeVisible();
  const source = page.getByRole("img", { name: "Chart" }).element().getAttribute("src");
  for (const [locale, label] of [
    ["ja", "Chart を拡大"],
    ["ko", "Chart 확대"],
  ] as const) {
    setUiLocale(locale);
    await expect.element(page.getByRole("button", { name: label, exact: true })).toBeVisible();
    await page.getByRole("button", { name: label, exact: true }).click();
    expect(page.getByRole("img", { name: "Chart" }).element().getAttribute("src")).toBe(source);
    expect(fetcher).toHaveBeenCalledTimes(2);
  }
  expect(preview).toHaveBeenCalledTimes(2);
  await screen.unmount();
});

function fixture(
  environment: string,
  streaming = false,
  text = "![Chart](</repo/chart one.png>)",
  onImageExpand = vi.fn(),
) {
  return (
    <ChatMarkdown
      text={text}
      cwd="/repo"
      isStreaming={streaming}
      imageContext={{
        environmentId: EnvironmentId.make(environment),
        threadId: "chat",
        messageId: "assistant-a",
        isStreaming: streaming,
        onImageExpand,
      }}
    />
  );
}

it.each(["primary", "remote"])(
  "renders and enlarges saved images from the selected %s server",
  async (environment) => {
    const preview = vi.fn();
    const revoked = vi.spyOn(URL, "revokeObjectURL");
    const screen = await render(fixture(environment, false, undefined, preview));
    await expect.element(page.getByRole("img", { name: "Chart" })).toBeVisible();
    await page.getByRole("button", { name: "Enlarge Chart" }).click();
    expect(preview).toHaveBeenCalledWith({
      images: [{ src: expect.stringMatching(/^blob:/), name: "Chart" }],
      index: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [target] of fetcher.mock.calls as unknown as [string, RequestInit][]) {
      const url = new URL(target);
      expect(url.pathname).toBe("/api/chat-images");
      expect(url.searchParams.get("threadId")).toBe("chat");
      expect(url.searchParams.get("messageId")).toBe("assistant-a");
      expect(url.search).not.toContain("bearer");
    }
    expect(new URL(fetcher.mock.calls[1]![0]).searchParams.get("source")).toBe(
      "/repo/chart%20one.png",
    );
    await screen.unmount();
    expect(revoked).toHaveBeenCalledWith(expect.stringMatching(/^blob:/));
  },
);

it("waits for complete replies and never imports image examples in code or ordinary links", async () => {
  const screen = await render(fixture("primary", true));
  expect(fetcher).not.toHaveBeenCalled();
  await screen.rerender(fixture("primary"));
  await expect.element(page.getByRole("img", { name: "Chart" })).toBeVisible();
  await screen.rerender(
    fixture(
      "primary",
      false,
      "`![Example](/repo/chart.png)`\n\n```md\n![Example](/repo/chart.png)\n```\n\n[Chart](/repo/chart.png)",
    ),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(page.getByRole("img").elements()).toHaveLength(0);
});

it("shows a compact retry state and recovers without exposing transport errors", async () => {
  fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
  await render(fixture("remote"));
  await expect.element(page.getByText("Chart · Image unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.element(page.getByRole("img", { name: "Chart" })).toBeVisible();
});

it("cancels an unmounted chat's manifest and releases its transfer slot", async () => {
  mocks.fileRequest.mockImplementationOnce(
    (_environment, _path, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      }),
  );
  const screen = await render(fixture("remote"));
  await expect.poll(() => mocks.fileRequest.mock.calls.length).toBe(1);
  const signal = mocks.fileRequest.mock.calls[0]![2].signal as AbortSignal;
  expect(signal.aborted).toBe(false);
  await screen.unmount();
  expect(signal.aborted).toBe(true);
  await render(fixture("primary"));
  await expect.element(page.getByRole("img", { name: "Chart" })).toBeVisible();
});

it.each([80, 130])(
  "fits a narrow chat at %s%% size and retains its aspect ratio",
  async (scale) => {
    applyInterfaceScalePercent(scale);
    await render(<div style={{ width: 200 }}>{fixture("remote")}</div>);
    await expect.element(page.getByRole("img", { name: "Chart" })).toBeVisible();
    const rect = page.getByRole("img", { name: "Chart" }).element().getBoundingClientRect();
    expect(rect.width).toBeLessThanOrEqual(200);
    expect(rect.width / rect.height).toBeCloseTo(2, 1);
  },
);
