import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { confirmMock, openInPreferredEditorMock, readLocalApiMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(async () => true),
  openInPreferredEditorMock: vi.fn(async () => "vscode"),
  readLocalApiMock: vi.fn(() => ({
    dialogs: { confirm: confirmMock },
    server: { getConfig: vi.fn(async () => ({ availableEditors: ["vscode"] })) },
    shell: { openInEditor: vi.fn(async () => undefined) },
  })),
}));

vi.mock("../editorPreferences", () => ({
  openInPreferredEditor: openInPreferredEditorMock,
}));

vi.mock("../localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: readLocalApiMock,
}));

import ChatMarkdown, { sanitizeHighlightedCodeHtml } from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  afterEach(() => {
    confirmMock.mockClear();
    openInPreferredEditorMock.mockClear();
    readLocalApiMock.mockClear();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("rewrites file uri hrefs into direct paths before rendering", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown
        text={`[PermissionRule.ts](file://${filePath})`}
        cwd="/Users/yashsingh/p/sco/claude-code-extract"
      />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", filePath);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), filePath);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps line anchors working after rewriting file uri hrefs", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown
        text={`[PermissionRule.ts:1](file://${filePath}#L1)`}
        cwd="/Users/yashsingh/p/sco/claude-code-extract"
      />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}:1`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), `${filePath}:1`);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows column information inline when present", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown
        text={`[PermissionRule.ts](file://${filePath}#L1C7)`}
        cwd="/Users/yashsingh/p/sco/claude-code-extract"
      />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1:C7" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}:1:7`);

      await link.click();

      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          `${filePath}:1:7`,
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("disambiguates duplicate file basenames inline", async () => {
    const firstPath = "/Users/yashsingh/p/t3code/apps/web/src/components/chat/MessagesTimeline.tsx";
    const secondPath = "/Users/yashsingh/p/t3code/apps/web/src/components/MessagesTimeline.tsx";
    const screen = await render(
      <ChatMarkdown
        text={`See [MessagesTimeline.tsx](file://${firstPath}) and [MessagesTimeline.tsx](file://${secondPath}).`}
        cwd="/Users/yashsingh/p/t3code"
      />,
    );

    try {
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · components/chat" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · src/components" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps normal web links unchanged", async () => {
    const screen = await render(
      <ChatMarkdown text="[OpenAI](https://openai.com/docs)" cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "OpenAI" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", "https://openai.com/docs");
      await expect.element(link).toHaveAttribute("target", "_blank");
    } finally {
      await screen.unmount();
    }
  });

  it("normalizes Codex private-use citation markers for display", async () => {
    const screen = await render(
      <ChatMarkdown
        text={"Reference \uE200cite\uE202turn4search3\uE201 stays readable."}
        cwd="/repo/project"
        normalizeCodexCitations
      />,
    );

    try {
      await expect.element(page.getByText("Reference [1] stays readable.")).toBeInTheDocument();
      await expect.element(page.getByText("\uE200")).not.toBeInTheDocument();
      await expect.element(page.getByText("turn4search3")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("renders Codex math fences with KaTeX instead of code highlighting", async () => {
    const screen = await render(
      <ChatMarkdown text={["```math", "E = mc^2", "```"].join("\n")} cwd="/repo/project" />,
    );

    try {
      await vi.waitFor(() => {
        expect(document.querySelector(".katex")).not.toBeNull();
      });
      expect(document.querySelector(".chat-markdown-codeblock")).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("renders Claude inline and display math delimiters with KaTeX", async () => {
    const screen = await render(
      <ChatMarkdown
        text={"For every \\(x\\), use the identity.\\n\\n\\[x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}\\]"}
        cwd="/repo/project"
      />,
    );

    try {
      await vi.waitFor(() => {
        expect(document.querySelector(".katex")).not.toBeNull();
      });
      expect(document.querySelector(".katex-display")).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("asks before opening markdown file links outside the workspace", async () => {
    confirmMock.mockResolvedValueOnce(false);
    const screen = await render(
      <ChatMarkdown text="[hosts](file:///private/etc/hosts)" cwd="/Users/yashsingh/p/t3code" />,
    );

    try {
      const link = page.getByRole("link", { name: "hosts" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("data-open-policy", "confirm");

      await link.click();

      await vi.waitFor(() => {
        expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("/private/etc/hosts"));
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("sanitizes hostile highlighted code markup before HTML insertion", () => {
    const sanitized = sanitizeHighlightedCodeHtml(`
      <pre class="shiki" onclick="alert(1)" data-extra="drop">
        <code>
          <span class="line">
            <span style="color:#fff;background-image:url(javascript:alert(1))" onmouseover="alert(1)">
              safe text
            </span>
            <script>alert(1)</script>
            <svg onload="alert(1)"><a href="javascript:alert(1)">bad</a></svg>
            <span class="safe-token" style="color:#00c8d7">token</span>
          </span>
        </code>
      </pre>
    `);

    const container = document.createElement("div");
    container.innerHTML = sanitized;

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("[onclick],[onmouseover],[onload]")).toBeNull();
    expect(container.querySelector("[data-extra]")).toBeNull();
    expect(container.innerHTML).not.toContain("javascript:");
    expect(container.textContent).toContain("safe text");
    expect(container.textContent).toContain("token");
  });
});
