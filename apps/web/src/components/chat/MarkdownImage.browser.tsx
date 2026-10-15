import "../../index.css";
import { EnvironmentId } from "@cafecode/contracts";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import ChatMarkdown from "../ChatMarkdown";
import { applyInterfaceScalePercent } from "../../interfaceScale";
import { setUiLocale } from "@cafecode/shared/i18n";
import { useTheme } from "../../hooks/useTheme";

const mocks = vi.hoisted(() => ({ fileRequest: vi.fn() }));
vi.mock("../../attachments/fileAttachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../attachments/fileAttachments")>()),
  fileRequest: mocks.fileRequest,
}));

let image: Uint8Array;
let fetcher: Mock<(url: string | URL, init?: RequestInit) => Promise<Response>>;

function pngBytes(width: number, height: number, color: string): Uint8Array {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return Uint8Array.from(atob(canvas.toDataURL("image/png").split(",")[1]!), (character) =>
    character.charCodeAt(0),
  );
}

beforeEach(() => {
  setUiLocale("en");
  image = pngBytes(320, 160, "#408060");

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

it.each([
  ["paragraph", "![Chart](</repo/chart one.png>)"],
  ["list", "- ![Chart](</repo/chart one.png>)"],
  ["link", "[![Chart](</repo/chart one.png>)](https://example.test/chart)"],
])("retains a loaded image in a %s when reply text and context change", async (_kind, markdown) => {
  const preview = vi.fn();
  const updatedPreview = vi.fn();
  const revoked = vi.spyOn(URL, "revokeObjectURL");
  const screen = await render(fixture("remote", false, markdown, preview));
  await expect.element(page.getByRole("img", { name: "Chart" })).toBeVisible();
  const original = page.getByRole("img", { name: "Chart" }).element();
  const source = original.getAttribute("src");
  const height = original.getBoundingClientRect().height;

  await screen.rerender(
    fixture("remote", false, `${markdown}\n\nAdditional reply text.`, updatedPreview),
  );
  await expect.element(page.getByText("Additional reply text.")).toBeVisible();
  expect(page.getByRole("img", { name: "Chart" }).element()).toBe(original);
  expect(original.getAttribute("src")).toBe(source);
  expect(original.getBoundingClientRect().height).toBe(height);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(revoked).not.toHaveBeenCalled();
  // Keep this link's normal default navigation inside the isolated fixture
  // while exercising the real image button and its updated callback.
  if (_kind === "link")
    original
      .closest("a")!
      .addEventListener("click", (event) => event.preventDefault(), { once: true });
  await page.getByRole("button", { name: "Enlarge Chart" }).click();
  expect(updatedPreview).toHaveBeenCalledOnce();
  expect(preview).not.toHaveBeenCalled();
});

function ThemeControls() {
  const { setTheme } = useTheme();
  return (
    <>
      <button type="button" onClick={() => setTheme("light")}>
        Use light theme
      </button>
      <button type="button" onClick={() => setTheme("dark")}>
        Use dark theme
      </button>
    </>
  );
}

it("retains loaded image bytes and geometry through native theme preference updates", async () => {
  const screen = await render(
    <>
      <ThemeControls />
      {fixture("remote")}
    </>,
  );
  await expect.element(page.getByRole("img", { name: "Chart" })).toBeVisible();
  const original = page.getByRole("img", { name: "Chart" }).element();
  const source = original.getAttribute("src");
  const height = original.getBoundingClientRect().height;
  for (const theme of ["light", "dark"] as const) {
    await page.getByRole("button", { name: `Use ${theme} theme` }).click();
    await expect
      .poll(() => document.documentElement.classList.contains("dark"))
      .toBe(theme === "dark");
    expect(page.getByRole("img", { name: "Chart" }).element()).toBe(original);
    expect(original.getAttribute("src")).toBe(source);
    expect(original.getBoundingClientRect().height).toBe(height);
    expect(fetcher).toHaveBeenCalledTimes(2);
  }
  await screen.unmount();
});

it.each(["environment", "thread", "message", "source"] as const)(
  "retires loaded bytes and checks the new exact owner when the %s changes",
  async (field) => {
    const preview = vi.fn();
    const originalContext = {
      environmentId: EnvironmentId.make("primary"),
      threadId: "chat",
      messageId: "assistant-a",
      isStreaming: false,
      onImageExpand: preview,
    };
    const originalSource = "/repo/chart%20one.png";
    const nextSource = field === "source" ? "/repo/chart-two.png" : originalSource;
    const context = {
      ...originalContext,
      environmentId: EnvironmentId.make(field === "environment" ? "remote" : "primary"),
      threadId: field === "thread" ? "other-chat" : "chat",
      messageId: field === "message" ? "assistant-b" : "assistant-a",
    };
    const markdown = (source: string, owner = originalContext) => (
      <ChatMarkdown text={`![Chart](${source})`} cwd="/repo" imageContext={owner} />
    );
    const revoked = vi.spyOn(URL, "revokeObjectURL");
    const screen = await render(markdown(originalSource));
    await expect.element(page.getByRole("img", { name: "Chart" })).toBeVisible();
    const originalUrl = page.getByRole("img", { name: "Chart" }).element().getAttribute("src");
    let releaseManifest!: (response: Response) => void;
    fetcher.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (releaseManifest = resolve)),
    );
    await screen.rerender(markdown(nextSource, context));
    await expect.poll(() => fetcher.mock.calls.length).toBe(3);
    expect(page.getByRole("img").elements()).toHaveLength(0);
    expect(revoked).toHaveBeenCalledWith(originalUrl);
    releaseManifest(
      new Response(
        JSON.stringify([
          {
            source: nextSource,
            mimeType: "image/png",
            width: 320,
            height: 160,
            sizeBytes: image.length,
          },
        ]),
      ),
    );
    await expect.element(page.getByRole("img", { name: "Chart" })).toBeVisible();
    expect(page.getByRole("img", { name: "Chart" }).element().getAttribute("src")).not.toBe(
      originalUrl,
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
    for (const [target] of fetcher.mock.calls.slice(2)) {
      const url = new URL(target);
      expect(url.host).toBe(`${context.environmentId}.example`);
      expect(url.searchParams.get("threadId")).toBe(context.threadId);
      expect(url.searchParams.get("messageId")).toBe(context.messageId);
    }
    expect(new URL(fetcher.mock.calls[3]![0]).searchParams.get("source")).toBe(nextSource);
  },
);

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

interface ImageOwner {
  environment: string;
  threadId: string;
  messageId: string;
  source: string;
}

const originalOwner: ImageOwner = {
  environment: "remote",
  threadId: "chat",
  messageId: "assistant-a",
  source: "/repo/owner-one.png",
};

const ownerChanges = [
  { field: "environment", owner: { ...originalOwner, environment: "primary" } },
  { field: "thread", owner: { ...originalOwner, threadId: "chat-b" } },
  { field: "message", owner: { ...originalOwner, messageId: "assistant-b" } },
  { field: "source", owner: { ...originalOwner, source: "/repo/owner-two.png" } },
] as const;

function ownerFixture(owner: ImageOwner, onImageExpand = vi.fn(), explanation = "") {
  return (
    <ChatMarkdown
      text={`![Chart](<${owner.source}>)${explanation}`}
      cwd="/repo"
      // These are deliberately fresh presentation inputs on every rerender.
      // They must not become new React component types for an existing image.
      additionalWorkspaceRoots={[]}
      skills={[]}
      imageContext={{
        environmentId: EnvironmentId.make(owner.environment),
        threadId: owner.threadId,
        messageId: owner.messageId,
        isStreaming: false,
        onImageExpand,
      }}
    />
  );
}

function manifestResponse(owner: ImageOwner, bytes: Uint8Array, width: number, height: number) {
  return new Response(
    JSON.stringify([
      { source: owner.source, mimeType: "image/png", width, height, sizeBytes: bytes.length },
    ]),
  );
}

function assertOwnerRequests(owner: ImageOwner, offset: number) {
  // Inspect the actual transport arguments outside its mock implementation:
  // production's opaque error handler must not swallow a routing assertion.
  for (const [index, source] of [null, owner.source].entries()) {
    const call = fetcher.mock.calls[offset + index]!;
    const url = new URL(call[0]);
    expect(url.origin).toBe(`https://${owner.environment}.example`);
    expect(url.pathname).toBe("/api/chat-images");
    expect(url.searchParams.get("threadId")).toBe(owner.threadId);
    expect(url.searchParams.get("messageId")).toBe(owner.messageId);
    expect(url.searchParams.get("source")).toBe(source);
    expect([...url.searchParams.keys()].sort()).toEqual(
      source === null ? ["messageId", "threadId"] : ["messageId", "source", "threadId"],
    );
    expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
  }
}

it("retains an image across fresh presentation inputs and uses the latest expansion callback", async () => {
  fetcher.mockImplementation(async (url) =>
    new URL(url).searchParams.has("source")
      ? new Response(new Uint8Array(image), { headers: { "content-type": "image/png" } })
      : manifestResponse(originalOwner, image, 320, 160),
  );
  const previousExpand = vi.fn();
  const currentExpand = vi.fn();
  const revoked = vi.spyOn(URL, "revokeObjectURL");
  const screen = await render(ownerFixture(originalOwner, previousExpand));
  try {
    await expect.element(page.getByRole("img", { name: "Chart" })).toBeVisible();
    const element = page.getByRole("img", { name: "Chart" }).element() as HTMLImageElement;
    await expect.poll(() => element.naturalWidth).toBe(320);
    const source = element.getAttribute("src");
    expect(source).toMatch(/^blob:/);
    assertOwnerRequests(originalOwner, 0);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await screen.rerender(ownerFixture(originalOwner, currentExpand, " Updated explanation."));
    setUiLocale("ja");
    await expect
      .element(page.getByRole("button", { name: "Chart を拡大", exact: true }))
      .toBeVisible();
    await page.getByRole("button", { name: "Chart を拡大", exact: true }).click();
    expect(page.getByRole("img", { name: "Chart" }).element()).toBe(element);
    expect(element.getAttribute("src")).toBe(source);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(revoked).not.toHaveBeenCalled();
    expect(previousExpand).not.toHaveBeenCalled();
    expect(currentExpand).toHaveBeenCalledExactlyOnceWith({
      images: [{ src: source, name: "Chart" }],
      index: 0,
    });
  } finally {
    await screen.unmount();
  }
});

it.each(ownerChanges)(
  "cancels pending old bytes when the image $field changes and rejects their late reply",
  async ({ owner }) => {
    const nextImage = pngBytes(96, 48, "#804060");
    let phase: "old" | "new" = "old";
    let deliverOld!: (response: Response) => void;
    const pendingOld = new Promise<Response>((resolve) => {
      deliverOld = resolve;
    });
    const oldReply = new Response(new Uint8Array(image), {
      headers: { "content-type": "image/png" },
    });
    fetcher.mockImplementation(async (url) => {
      const binary = new URL(url).searchParams.has("source");
      if (phase === "old")
        return binary ? pendingOld : manifestResponse(originalOwner, image, 320, 160);
      return binary
        ? new Response(new Uint8Array(nextImage), { headers: { "content-type": "image/png" } })
        : manifestResponse(owner, nextImage, 96, 48);
    });
    const created = vi.spyOn(URL, "createObjectURL");
    const screen = await render(ownerFixture(originalOwner));
    try {
      await expect.poll(() => fetcher.mock.calls.length).toBe(2);
      assertOwnerRequests(originalOwner, 0);
      const oldSignal = fetcher.mock.calls[1]![1]!.signal as AbortSignal;
      expect(oldSignal.aborted).toBe(false);
      expect(page.getByRole("img", { name: "Chart" }).elements()).toHaveLength(0);
      expect(created).not.toHaveBeenCalled();

      phase = "new";
      await screen.rerender(ownerFixture(owner));
      expect(oldSignal.aborted).toBe(true);
      await expect.element(page.getByRole("img", { name: "Chart" })).toBeVisible();
      const element = page.getByRole("img", { name: "Chart" }).element() as HTMLImageElement;
      await expect.poll(() => element.naturalWidth).toBe(96);
      const source = element.getAttribute("src");
      expect(source).toMatch(/^blob:/);
      expect(fetcher).toHaveBeenCalledTimes(4);
      assertOwnerRequests(owner, 2);
      expect(created).toHaveBeenCalledTimes(1);

      // Simulate a transport that ignores cancellation and still delivers the
      // old body. The real reader may consume it, but cannot publish its Blob.
      deliverOld(oldReply);
      await expect.poll(() => oldReply.bodyUsed).toBe(true);
      for (let frame = 0; frame < 2; frame++)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      expect(page.getByRole("img", { name: "Chart" }).element()).toBe(element);
      expect(element.getAttribute("src")).toBe(source);
      expect(element.naturalWidth).toBe(96);
      expect(created).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      deliverOld(oldReply);
      await screen.unmount();
    }
  },
);

it.each(ownerChanges)(
  "revokes loaded old bytes and routes a changed image $field to its current owner",
  async ({ owner }) => {
    const nextImage = pngBytes(96, 48, "#804060");
    let phase: "old" | "new" = "old";
    fetcher.mockImplementation(async (url) => {
      const binary = new URL(url).searchParams.has("source");
      const currentOwner = phase === "old" ? originalOwner : owner;
      const bytes = phase === "old" ? image : nextImage;
      return binary
        ? new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } })
        : manifestResponse(
            currentOwner,
            bytes,
            phase === "old" ? 320 : 96,
            phase === "old" ? 160 : 48,
          );
    });
    const revoked = vi.spyOn(URL, "revokeObjectURL");
    const screen = await render(ownerFixture(originalOwner));
    let currentSource: string | null = null;
    try {
      await expect.element(page.getByRole("img", { name: "Chart" })).toBeVisible();
      const oldElement = page.getByRole("img", { name: "Chart" }).element() as HTMLImageElement;
      await expect.poll(() => oldElement.naturalWidth).toBe(320);
      const oldSource = oldElement.getAttribute("src");
      expect(oldSource).toMatch(/^blob:/);
      expect(fetcher).toHaveBeenCalledTimes(2);
      assertOwnerRequests(originalOwner, 0);

      phase = "new";
      await screen.rerender(ownerFixture(owner));
      expect(revoked).toHaveBeenCalledExactlyOnceWith(oldSource);
      await expect.element(page.getByRole("img", { name: "Chart" })).toBeVisible();
      const currentElement = page.getByRole("img", { name: "Chart" }).element() as HTMLImageElement;
      await expect.poll(() => currentElement.naturalWidth).toBe(96);
      currentSource = currentElement.getAttribute("src");
      expect(currentSource).toMatch(/^blob:/);
      expect(currentSource).not.toBe(oldSource);
      expect(fetcher).toHaveBeenCalledTimes(4);
      assertOwnerRequests(owner, 2);
    } finally {
      await screen.unmount();
    }
    expect(revoked).toHaveBeenCalledTimes(2);
    expect(revoked).toHaveBeenLastCalledWith(currentSource);
  },
);

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
