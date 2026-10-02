import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSharedHighlighterMock, highlighter } = vi.hoisted(() => {
  const highlighter = { fixture: "highlighter" };
  return {
    highlighter,
    getSharedHighlighterMock: vi.fn(async (_options: { langs: string[] }) => highlighter),
  };
});

vi.mock("@pierre/diffs", () => ({ getSharedHighlighter: getSharedHighlighterMock }));

describe("getChatCodeHighlighter", () => {
  beforeEach(() => {
    vi.resetModules();
    getSharedHighlighterMock.mockReset();
    getSharedHighlighterMock.mockResolvedValue(highlighter);
  });

  it("retains a stable resolved Promise through repeated rendering", async () => {
    const { getChatCodeHighlighter } = await import("./chatCodeHighlighter");
    const first = getChatCodeHighlighter("typescript");
    expect(getChatCodeHighlighter("typescript")).toBe(first);
    await expect(first).resolves.toBe(highlighter);
    expect(getChatCodeHighlighter("typescript")).toBe(first);
    expect(getSharedHighlighterMock).toHaveBeenCalledTimes(1);
  });

  it("keeps unsupported-language fallback settled instead of recreating pending Promises", async () => {
    getSharedHighlighterMock.mockImplementation(async ({ langs }) => {
      if (langs[0] !== "text") throw new Error("Unsupported fixture language");
      return highlighter;
    });
    const { getChatCodeHighlighter } = await import("./chatCodeHighlighter");
    const first = getChatCodeHighlighter("unknown-fixture-language");
    await expect(first).resolves.toBe(highlighter);
    for (let retry = 0; retry < 20; retry += 1) {
      expect(getChatCodeHighlighter("unknown-fixture-language")).toBe(first);
    }
    expect(getSharedHighlighterMock.mock.calls.map(([options]) => options.langs)).toEqual([
      ["unknown-fixture-language"],
      ["text"],
    ]);
  });

  it("retains terminal initialization rejection so the error boundary can observe it", async () => {
    const failure = new Error("Fixture highlighter initialization failed");
    getSharedHighlighterMock.mockRejectedValue(failure);
    const { getChatCodeHighlighter } = await import("./chatCodeHighlighter");
    const first = getChatCodeHighlighter("text");
    await expect(first).rejects.toBe(failure);
    expect(getChatCodeHighlighter("text")).toBe(first);
    expect(getSharedHighlighterMock).toHaveBeenCalledTimes(1);
  });

  it("bounds adversarial labels without evicting resources already in use", async () => {
    const { getChatCodeHighlighter } = await import("./chatCodeHighlighter");
    const first = getChatCodeHighlighter("typescript");
    const requests = Array.from({ length: 500 }, (_, index) =>
      getChatCodeHighlighter(`unknown-fixture-language-${index}`),
    );
    await Promise.all([first, ...requests]);
    expect(getSharedHighlighterMock.mock.calls.length).toBeLessThanOrEqual(128);
    expect(getChatCodeHighlighter("typescript")).toBe(first);
    expect(getChatCodeHighlighter("another-unknown-language")).toBe(getChatCodeHighlighter("text"));
    expect(getChatCodeHighlighter("x".repeat(10_000))).toBe(getChatCodeHighlighter("text"));
  });
});
