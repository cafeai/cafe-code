import "../index.css";
import { EnvironmentId } from "@cafecode/contracts";

import { useState } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { applyInterfaceScalePercent } from "../interfaceScale";

const {
  confirmMock,
  openInPreferredEditorMock,
  readLocalApiMock,
  revealPathMock,
  showContextMenuMock,
} = vi.hoisted(() => ({
  confirmMock: vi.fn(async () => true),
  openInPreferredEditorMock: vi.fn(async () => "vscode"),
  revealPathMock: vi.fn(async () => undefined),
  showContextMenuMock: vi.fn(async () => null as string | null),
  readLocalApiMock: vi.fn(() => ({
    dialogs: { confirm: confirmMock },
    server: { getConfig: vi.fn(async () => ({ availableEditors: ["vscode"] })) },
    shell: {
      openInEditor: vi.fn(async () => undefined),
      revealPath: revealPathMock,
    },
    contextMenu: { show: showContextMenuMock },
  })),
}));

const workspaceFixture = vi.hoisted(() => ({ environmentId: null as EnvironmentId | null }));
vi.mock("../environments/workspace", () => ({
  useWorkspaceEnvironmentId: () => workspaceFixture.environmentId,
}));

function installDesktopCapabilityStub() {
  window.desktopBridge = {
    setTheme: vi.fn(async () => undefined),
  } as unknown as NonNullable<typeof window.desktopBridge>;
}

vi.mock("../editorPreferences", () => ({
  openInPreferredEditor: openInPreferredEditorMock,
}));

vi.mock("../localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: readLocalApiMock,
}));

// Renderer/UI behavior has dedicated MermaidBlock browser coverage. Keep these
// integration fixtures focused on the Markdown boundary: exact source and a
// parser-proven per-fence completion flag must reach that component unchanged.
vi.mock("./MermaidBlock", () => ({
  MermaidBlock({
    code,
    complete,
    theme,
  }: {
    code: string;
    complete: boolean;
    theme: "dark" | "light";
  }) {
    const [expanded, setExpanded] = useState(false);
    return (
      <div
        data-testid="mermaid-block"
        data-complete={String(complete)}
        data-theme={theme}
        data-expanded={String(expanded)}
      >
        <button
          type="button"
          aria-label="Expand diagram fixture"
          aria-expanded={expanded}
          style={{ width: 24, height: 24 }}
          onClick={() => setExpanded((previous) => !previous)}
        />
        <pre>{code}</pre>
      </div>
    );
  },
}));

import ChatMarkdown, { sanitizeHighlightedCodeHtml } from "./ChatMarkdown";

const TABLE_VIEWER_MARKDOWN = [
  "| App | Why consider it | Main tradeoff |",
  "| --- | --- | --- |",
  `| Jamie | \`${"long-unbroken-table-value-".repeat(18)}\` | Deletes audio after transcription |`,
  "| Hedy | Local transcription and speaker labels | Needs the right speech engine |",
].join("\n");

function renderTableViewerFixture(text = TABLE_VIEWER_MARKDOWN) {
  return (
    <div style={{ width: 320 }}>
      <ChatMarkdown
        text={text}
        cwd="/repo/project"
        additionalWorkspaceRoots={["/repo/related-project"]}
        skills={[{ name: "research", displayName: "Research" }]}
      />
    </div>
  );
}

describe("ChatMarkdown", () => {
  afterEach(() => {
    workspaceFixture.environmentId = null;
    confirmMock.mockClear();
    openInPreferredEditorMock.mockClear();
    readLocalApiMock.mockClear();
    revealPathMock.mockClear();
    showContextMenuMock.mockClear();
    localStorage.clear();
    Reflect.deleteProperty(window, "desktopBridge");
    document.body.innerHTML = "";
  });

  it("rewrites file uri hrefs into direct paths before rendering", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    installDesktopCapabilityStub();
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
    installDesktopCapabilityStub();
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
    installDesktopCapabilityStub();
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

  it("reveals markdown file links in the local file manager without line suffixes", async () => {
    showContextMenuMock.mockResolvedValueOnce("reveal");
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    installDesktopCapabilityStub();
    const screen = await render(
      <ChatMarkdown
        text={`[PermissionRule.ts](file://${filePath}#L1C7)`}
        cwd="/Users/yashsingh/p/sco/claude-code-extract"
      />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1:C7" });
      await expect.element(link).toBeInTheDocument();

      const linkElement = document.querySelector<HTMLAnchorElement>(".chat-markdown-file-link");
      expect(linkElement).not.toBeNull();
      linkElement!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 12,
          clientY: 34,
        }),
      );

      await vi.waitFor(() => {
        expect(showContextMenuMock).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              id: "reveal",
              label: expect.stringMatching(/^Open in (Finder|Explorer|Files)$/),
            }),
          ]),
          { x: 12, y: 34 },
        );
      });
      await vi.waitFor(() => {
        expect(revealPathMock).toHaveBeenCalledWith(filePath);
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("classifies angle-bracketed file links with spaces and parentheses", async () => {
    showContextMenuMock.mockResolvedValueOnce("reveal");
    const filePath = "C:/repo/review packets/assurance (final).md";
    installDesktopCapabilityStub();
    const screen = await render(
      <ChatMarkdown
        text="[assurance prompts](<C:/repo/review packets/assurance (final).md>)"
        cwd="C:/repo"
      />,
    );

    try {
      const link = page.getByRole("link", { name: "assurance (final).md" });
      await expect.element(link).toBeInTheDocument();

      const linkElement = document.querySelector<HTMLAnchorElement>(".chat-markdown-file-link");
      expect(linkElement).not.toBeNull();
      linkElement!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 21,
          clientY: 43,
        }),
      );

      await vi.waitFor(() => {
        expect(showContextMenuMock).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({ id: "open", label: "Open file" }),
            expect.objectContaining({
              id: "reveal",
              label: expect.stringMatching(/^Open in (Finder|Explorer|Files)$/),
            }),
          ]),
          { x: 21, y: 43 },
        );
      });
      await vi.waitFor(() => {
        expect(revealPathMock).toHaveBeenCalledWith(filePath);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("classifies relative file links containing spaces and parentheses", async () => {
    const filePath = "C:/repo/project/.cafe-code-link-smoke/folder with spaces/review (final).md";
    installDesktopCapabilityStub();
    const screen = await render(
      <ChatMarkdown
        text="[Relative path with spaces and parentheses](<.cafe-code-link-smoke/folder with spaces/review (final).md>)"
        cwd="C:/repo/project"
      />,
    );

    try {
      const link = page.getByRole("link", { name: "review (final).md" });
      await expect.element(link).toHaveAttribute("href", filePath);
      await link.click();
      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), filePath);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("preserves windows backslash separators that markdown would treat as escapes", async () => {
    const filePath = "C:/repo/Example Project/.docs/runbooks/review-notes.md";
    installDesktopCapabilityStub();
    const screen = await render(
      <ChatMarkdown
        text={"[assurance prompts](<C:\\repo\\Example Project\\.docs\\runbooks\\review-notes.md>)"}
        cwd="C:/repo/Example Project"
      />,
    );

    try {
      const link = page.getByRole("link", {
        name: "review-notes.md",
      });
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

  it.each(["C:/repo", "/Users/example/repo", "/home/example/repo"])(
    "uses the parsed destination for balanced parentheses under %s",
    async (cwd) => {
      const filePath = `${cwd}/review(final).md`;
      installDesktopCapabilityStub();
      const screen = await render(<ChatMarkdown text={`[Review](${filePath})`} cwd={cwd} />);
      try {
        const link = page.getByRole("link", { name: "review(final).md" });
        await expect.element(link).toHaveAttribute("href", filePath);
        await link.click();
        await vi.waitFor(() => {
          expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), filePath);
        });
      } finally {
        await screen.unmount();
      }
    },
  );

  it("uses the parsed destination for reference-style file links", async () => {
    installDesktopCapabilityStub();
    const screen = await render(
      <ChatMarkdown
        text={"[Review][notes]\n\n[notes]: </home/example/repo/review (final).md>"}
        cwd="/home/example/repo"
      />,
    );
    try {
      const link = page.getByRole("link", { name: "review (final).md" });
      await expect.element(link).toHaveAttribute("href", "/home/example/repo/review (final).md");
      await link.click();
      await vi.waitFor(() => {
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(
          expect.anything(),
          "/home/example/repo/review (final).md",
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("decodes Markdown punctuation escapes in POSIX destinations", async () => {
    installDesktopCapabilityStub();
    const screen = await render(
      <ChatMarkdown
        text={String.raw`[Review](/home/example/repo/review\_final.md)`}
        cwd="/home/example/repo"
      />,
    );
    try {
      const link = page.getByRole("link", { name: "review_final.md" });
      await expect.element(link).toHaveAttribute("href", "/home/example/repo/review_final.md");
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    [
      "/Users/example/repo",
      String.raw`[Review](/Users/example/repo/review\(final\).md#L2C7)`,
      "/Users/example/repo/review(final).md:2:7",
    ],
    [
      "/home/example/repo",
      String.raw`[Review](src/review\(final\).md#L2C7)`,
      "/home/example/repo/src/review(final).md:2:7",
    ],
    [
      "C:/repo",
      String.raw`[Review](src/review\(final\).md#L2C7)`,
      "C:/repo/src/review(final).md:2:7",
    ],
    [
      "C:/repo",
      "[Review][notes]\n\n" + String.raw`[notes]: <src/review\(final\).md#L2C7>`,
      "C:/repo/src/review(final).md:2:7",
    ],
    ["C:/repo", String.raw`[Review](review\(final\).md#L2C7)`, "C:/repo/review(final).md:2:7"],
    [
      "C:/repo",
      String.raw`[Review](<C:\repo\.docs\review(final).md#L2C7>)`,
      "C:/repo/.docs/review(final).md:2:7",
    ],
    [
      "C:/repo",
      "[Review][notes]\n\n" + String.raw`[notes]: <C:\repo\.docs\review(final).md#L2C7>`,
      "C:/repo/.docs/review(final).md:2:7",
    ],
    [
      "C:/repo",
      "[Review][notes]\n\n" + String.raw`[notes]: <.\.docs\review(final).md#L2C7>`,
      "C:/repo/./.docs/review(final).md:2:7",
    ],
    [
      String.raw`\\server\share\repo`,
      String.raw`[Review](<\\server\share\repo\.docs\review(final).md#L2C7>)`,
      String.raw`\\server\share\repo\.docs\review(final).md:2:7`,
    ],
    [
      String.raw`\\server\share\repo`,
      "[Review][notes]\n\n" +
        String.raw`[notes]: <\\server\share\repo\.docs\review(final).md#L2C7>`,
      String.raw`\\server\share\repo\.docs\review(final).md:2:7`,
    ],
    [
      String.raw`\\server\share\repo`,
      "[Review](file://server/share/repo/.docs/review(final).md#L2C7)",
      String.raw`\\server\share\repo\.docs\review(final).md:2:7`,
    ],
  ])(
    "preserves exact file destinations and positions under %s: %s",
    async (cwd, text, filePath) => {
      installDesktopCapabilityStub();
      const screen = await render(
        <ChatMarkdown text={`${text}\n\nCompute \\(x + 1\\).`} cwd={cwd} />,
      );
      try {
        const link = page.getByRole("link", { name: "review(final).md · L2:C7" });
        await expect.element(link).toHaveAttribute("href", filePath);
        await expect.element(link).toHaveAttribute("data-open-policy", "direct");
        expect(document.querySelectorAll(".katex").length).toBe(1);
        expect(document.querySelector(".katex-error")).toBeNull();
        await link.click();
        await vi.waitFor(() => {
          expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), filePath);
        });
      } finally {
        await screen.unmount();
      }
    },
  );

  it("uses parsed destinations for reference-link basename disambiguation", async () => {
    const screen = await render(
      <ChatMarkdown
        text={
          "[First][a] and [Second][b]\n\n[a]: </home/example/repo/first/review(final).md>\n[b]: </home/example/repo/second/review(final).md>"
        }
        cwd="/home/example/repo"
      />,
    );
    try {
      await expect
        .element(page.getByRole("link", { name: "review(final).md · repo/first" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: "review(final).md · repo/second" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("renders link-shaped text identifiers inside explicit math without KaTeX failures", async () => {
    const screen = await render(
      <ChatMarkdown
        text={String.raw`The identifier below reads $\texttt{[f](a_b)}$ in this formula. Also $\texttt{[f](a_b.md)}$.`}
        cwd="C:/repo"
      />,
    );
    try {
      expect(document.querySelectorAll(".katex")).toHaveLength(2);
      expect(document.querySelector(".katex-error")).toBeNull();
      expect(document.querySelector(".chat-markdown-file-link")).toBeNull();
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    String.raw`[Review](<C:\repo\.docs\review &amp; notes%20(final).md>)`,
    "[Review][notes]\n\n" + String.raw`[notes]: <C:\repo\.docs\review &amp; notes%20(final).md>`,
  ])(
    "retains Windows separators alongside parser-decoded entities and percent octets: %s",
    async (text) => {
      installDesktopCapabilityStub();
      const screen = await render(<ChatMarkdown text={text} cwd="C:/repo" />);
      try {
        const filePath = "C:/repo/.docs/review & notes (final).md";
        const link = page.getByRole("link", { name: "review & notes (final).md" });
        await expect.element(link).toHaveAttribute("href", filePath);
        await link.click();
        await vi.waitFor(() =>
          expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), filePath),
        );
      } finally {
        await screen.unmount();
      }
    },
  );
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

  it("keeps document fragments inside the current view", async () => {
    const screen = await render(
      <ChatMarkdown text="[Smoke section](#smoke-test-section)" cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "Smoke section" });
      await expect.element(link).toHaveAttribute("href", "#smoke-test-section");
      await expect.element(link).not.toHaveAttribute("target");
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    "[Unsafe](javascript:alert(1))",
    String.raw`[Unsafe](java\script:alert(1))`,
    String.raw`[Unsafe](javascript:alert(1) "fake ](C:\repo\safe.md)")`,
    String.raw`[Unsafe](jav&#x61;script:alert(1) "fake ](C:\repo\safe.md)")`,
    "[Unsafe](data:text/html,alert(1))",
    "[Unsafe][notes]\n\n[notes]: javascript:alert(1)",
  ])("renders sanitized unsafe link destinations as inert text: %s", async (text) => {
    const screen = await render(<ChatMarkdown text={text} cwd="/repo/project" />);

    try {
      await expect.element(page.getByText("Unsafe", { exact: true })).toBeInTheDocument();
      expect(document.querySelector('a[href*="javascript"]')).toBeNull();
      expect(document.querySelector('a[href=""]')).toBeNull();
      expect(document.querySelector(".chat-markdown-file-link")).toBeNull();
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
      expect(revealPathMock).not.toHaveBeenCalled();
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

  it("keeps currency, spacing, and bold emphasis in billing prose", async () => {
    const screen = await render(
      <ChatMarkdown
        text={[
          "Routine CI is separate. Our desktop workflow launches **8 jobs on every push**, including two macOS jobs. If each took 20 minutes, that would cost **$3.36 per push**—an illustration, since we don’t yet have a fully passing baseline. A 10-minute website check costs **$0.06**.",
          "",
          "I also checked September’s billing report: **$12.13 of recorded usage, fully covered by discounts, with $0 net charges reported**. That’s consistent with hitting the included allowance and paid usage being blocked.",
        ].join("\n")}
        cwd="/repo/project"
      />,
    );

    try {
      expect(document.querySelector(".katex")).toBeNull();
      expect(document.querySelector(".katex-error")).toBeNull();
      const strongText = Array.from(
        document.querySelectorAll(".chat-markdown strong"),
        (element) => element.textContent,
      );
      expect(strongText).toEqual([
        "8 jobs on every push",
        "$3.36 per push",
        "$0.06",
        "$12.13 of recorded usage, fully covered by discounts, with $0 net charges reported",
      ]);
      expect(document.querySelector(".chat-markdown")?.textContent).toContain(
        "—an illustration, since we don’t yet have a fully passing baseline.",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("renders genuine formulas alongside bold and plain currency", async () => {
    const screen = await render(
      <ChatMarkdown
        text="The price is **$5**; the variable is **$x$**. Another option costs $10. Compute $2 + 2 = 4$."
        cwd="/repo/project"
      />,
    );

    try {
      expect(document.querySelector(".chat-markdown strong")?.textContent).toBe("$5");
      expect(document.querySelector(".chat-markdown")?.textContent).toContain(
        "Another option costs $10.",
      );
      expect(
        Array.from(
          document.querySelectorAll(".katex-mathml annotation"),
          (element) => element.textContent,
        ),
      ).toEqual(["x", "2 + 2 = 4"]);
      expect(document.querySelector(".katex-error")).toBeNull();
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

  it("renders mixed LaTeX replacement source as code without KaTeX errors", async () => {
    const source = [
      "Replace the source with:",
      "",
      "```latex",
      "Equation \\eqref{eq:composition} is the compatibility condition for",
      "\\eqref{eq:addition}. With the selected convention",
      "\\[",
      "q(x,y)=h(x+y)-h(x)-h(y)",
      "\\]",
      "from \\eqref{eq:prior-result}, the section satisfies $r=-q$.",
      "",
      "\\begin{proposition}[Compatibility]",
      "Let $A$ and $D$ be additive groups.",
      "\\end{proposition}",
      "```",
    ].join("\n");
    const screen = await render(<ChatMarkdown text={source} cwd="/repo/project" />);

    try {
      await vi.waitFor(() => {
        expect(document.querySelector(".chat-markdown-codeblock")).not.toBeNull();
      });
      const codeBlock = document.querySelector(".chat-markdown-codeblock");
      expect(codeBlock?.textContent).toContain("proposition}[Compatibility]");
      expect(codeBlock?.textContent).toContain("Let $A$ and $D$ be additive groups");
      expect(document.querySelector(".katex-error")).toBeNull();
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

  it("renders Claude multiline dollar-display math without a KaTeX error", async () => {
    const screen = await render(
      <ChatMarkdown
        text={[
          "Substituting this in:",
          "",
          "$$\\int_1^\\infty \\left[\\frac{\\sqrt t-1}{2}+\\sqrt t\\,\\psi(t)\\right]t^{-s/2-1}\\,dt",
          "= \\frac12\\int_1^\\infty\\!\\left(t^{-\\frac{s+1}{2}}-t^{-\\frac{s}{2}-1}\\right)dt \\;+\\; \\int_1^\\infty \\psi(t)\\,t^{-\\frac{s+1}{2}}\\,dt.$$",
        ].join("\n")}
        cwd="/repo/project"
      />,
    );

    try {
      await vi.waitFor(() => {
        expect(document.querySelector(".katex-display")).not.toBeNull();
      });
      expect(document.querySelector(".katex-error")).toBeNull();
      expect(document.body.textContent).toContain("Substituting this in");
    } finally {
      await screen.unmount();
    }
  });

  it("renders Codex slash-display math inside numbered-list follow-up prose", async () => {
    const screen = await render(
      <ChatMarkdown
        text={[
          "1. **Readback equality**",
          "   \\[",
          "   \\mathrm{CvSOrdinaryLimit}(f,\\lambda)",
          "   =",
          "   \\mathrm{WeilPacket}(f,\\lambda)",
          "   \\]",
          "   for the actual zeta test-function class.",
          "",
          "2. **Tail/window interchange**",
          "   \\[",
          "   \\lim_{N\\to\\infty}\\left(\\text{CvS truncated packet}_N\\right)",
          "   =",
          "   \\text{ordinary zeta explicit-formula packet}",
          "   \\]",
          "   with enough domination to move limits through the pole/zero/archimedean lanes.",
        ].join("\n")}
        cwd="/repo/project"
      />,
    );

    try {
      await vi.waitFor(() => {
        expect(document.querySelectorAll(".katex-display").length).toBe(2);
      });
      expect(document.body.textContent).toContain("CvSOrdinaryLimit");
      expect(document.body.textContent).toContain("WeilPacket");
      expect(document.body.textContent).toContain("with enough domination to move limits");
      expect(document.querySelector(".katex-error")).toBeNull();
      expect(document.body.textContent).not.toContain("withenoughdomination");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps wide Markdown tables scrollable across chat rerenders", async () => {
    const tableText = [
      "| Case | Expression | Notes |",
      "| --- | --- | --- |",
      "| Long inline math | $f(x)=\\sum_{i=1}^{999999999999999999999999999999999999999999999999} \\frac{x_i}{1+x_i}$ | Should not widen the message column |",
      "| Long code token | `const_veryVeryVeryVeryVeryVeryVeryLongIdentifierNameWithoutBreaksOrSpacesEqualsAnotherVeryVeryVeryVeryLongIdentifierName` | Scroll instead of crushing columns |",
      "| Display math | $$\\prod_{j=1}^{123456789012345678901234567890}\\left(\\frac{a_j+b_j+c_j+d_j+e_j+f_j+g_j+h_j+i_j}{\\omega_j^{98765432109876543210}+\\theta_j^{12345678901234567890}}\\right)$$ | Stays in the table after reload |",
    ].join("\n");
    // Chat renders can supply fresh arrays containing the same workspace and
    // skill values. The table needs a stable DOM node across that render so a
    // horizontal trackpad position does not snap back to the first column.
    const renderWideTable = (text = tableText) => (
      <ChatMarkdown
        text={text}
        cwd="/repo/project"
        additionalWorkspaceRoots={["/repo/related-project"]}
        skills={[{ name: "research", displayName: "Research" }]}
      />
    );
    const screen = await render(renderWideTable());

    try {
      const tableScroll = document.querySelector<HTMLElement>(".chat-markdown-table-scroll");
      const table = tableScroll?.querySelector("table");

      expect(tableScroll).not.toBeNull();
      expect(table).not.toBeNull();
      expect(window.getComputedStyle(tableScroll!).overflowX).toBe("auto");
      expect(window.getComputedStyle(table!).minWidth).toBe("100%");
      expect(tableScroll!.scrollWidth).toBeGreaterThan(tableScroll!.clientWidth);
      expect(table!.getBoundingClientRect().width).toBeGreaterThan(
        tableScroll!.getBoundingClientRect().width,
      );

      const longCode = Array.from(tableScroll!.querySelectorAll("code")).find((node) =>
        node.textContent?.includes("const_veryVeryVeryVeryVeryVeryVeryLongIdentifierName"),
      );
      const longCodeCell = longCode?.closest("td");
      expect(longCode).toBeDefined();
      expect(longCodeCell).not.toBeNull();
      expect(longCode!.getBoundingClientRect().right).toBeLessThanOrEqual(
        longCodeCell!.getBoundingClientRect().right + 1,
      );

      await expect.element(page.getByText("Display math")).toBeInTheDocument();
      await expect.element(page.getByText("Stays in the table after reload")).toBeInTheDocument();
      expect(document.querySelector(".katex")).not.toBeNull();

      tableScroll!.scrollLeft = Math.min(120, tableScroll!.scrollWidth - tableScroll!.clientWidth);
      const positionBeforeRerender = tableScroll!.scrollLeft;
      expect(positionBeforeRerender).toBeGreaterThan(0);

      await screen.rerender(renderWideTable());
      const tableScrollAfterRerender = document.querySelector<HTMLElement>(
        ".chat-markdown-table-scroll",
      );
      expect(tableScrollAfterRerender).toBe(tableScroll);
      expect(tableScrollAfterRerender?.scrollLeft).toBe(positionBeforeRerender);

      await screen.rerender(renderWideTable(`${tableText}\n\nMore chat text arrived.`));
      expect(document.querySelector(".chat-markdown-table-scroll")).toBe(tableScroll);
      expect(tableScroll!.scrollLeft).toBe(positionBeforeRerender);
      await expect.element(page.getByText("More chat text arrived.")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("opens a wide table fitted to the screen and supports zoom and native horizontal scrolling", async () => {
    const screen = await render(renderTableViewerFixture());
    try {
      const expand = page.getByRole("button", { name: "Expand table" });
      await expect.element(expand).toBeVisible();
      await expand.click();

      const dialog = page.getByRole("dialog", { name: "Expanded table" });
      await expect.element(dialog).toBeVisible();
      const dialogElement = dialog.element();
      // Visibility precedes the shared dialog's 98% -> 100% entrance scale.
      // Pixel comparisons must observe the finished presentation so that
      // popup animation cannot be mistaken for a table zoom change.
      await vi.waitFor(() =>
        expect(Number.parseFloat(getComputedStyle(dialogElement).scale)).toBe(1),
      );
      const table = dialogElement.querySelector<HTMLTableElement>("table");
      expect(table).not.toBeNull();
      expect(table!.querySelectorAll("tr")).toHaveLength(3);
      expect(table!.textContent).toContain("Main tradeoff");
      expect(table!.textContent).toContain("Deletes audio after transcription");
      expect(table!.textContent).toContain("Needs the right speech engine");

      const viewport = page
        .getByRole("region", { name: "Expanded table; scroll to inspect" })
        .element() as HTMLElement;
      // Fit is the opening state. Give ResizeObserver its normal frame to
      // measure the dialog before asserting the full table fits the viewport.
      await vi.waitFor(() => {
        expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 2);
        expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight + 2);
      });
      const fitWidth = table!.getBoundingClientRect().width;

      await page.getByRole("button", { name: "Reset", exact: true }).click();
      const resetWidth = table!.getBoundingClientRect().width;
      expect(resetWidth).toBeGreaterThan(fitWidth + 1);
      expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);

      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      expect(table!.getBoundingClientRect().width).toBeGreaterThan(resetWidth);
      expect(page.getByRole("status", { name: "Zoom level" }).element().textContent).toBe("125%");
      await page.getByRole("button", { name: "Zoom out", exact: true }).click();
      expect(page.getByRole("status", { name: "Zoom level" }).element().textContent).toBe("100%");
      expect(table!.getBoundingClientRect().width).toBeCloseTo(resetWidth, 0);
      expect(
        Math.abs(table!.getBoundingClientRect().width - table!.offsetWidth),
      ).toBeLessThanOrEqual(1);

      viewport.focus();
      await userEvent.keyboard("{ArrowRight}");
      await vi.waitFor(() => expect(viewport.scrollLeft).toBeGreaterThan(0));
      await page.getByRole("button", { name: "Fit", exact: true }).click();
      await vi.waitFor(() =>
        expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 2),
      );
      expect(viewport.scrollLeft).toBe(0);

      await userEvent.keyboard("{Escape}");
      await expect.element(dialog).not.toBeInTheDocument();
      await expect.element(expand).toHaveFocus();
    } finally {
      await screen.unmount();
    }
  });

  it("fits every row of a tall table and refits when the window changes size", async () => {
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    const text = [
      "| Item | Detail |",
      "| --- | --- |",
      ...Array.from({ length: 60 }, (_, index) => `| Item ${index + 1} | Detail ${index + 1} |`),
    ].join("\n");
    await page.viewport(900, 700);
    const screen = await render(renderTableViewerFixture(text));
    try {
      await page.getByRole("button", { name: "Expand table" }).click();
      const dialog = page.getByRole("dialog", { name: "Expanded table" });
      await expect.element(dialog).toBeVisible();
      const table = dialog.element().querySelector<HTMLTableElement>("table")!;
      expect(table.querySelectorAll("tbody tr")).toHaveLength(60);
      expect(table.textContent).toContain("Detail 60");
      const viewport = page
        .getByRole("region", { name: "Expanded table; scroll to inspect" })
        .element() as HTMLElement;
      await vi.waitFor(() => {
        expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 2);
        expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight + 2);
        expect(table.getBoundingClientRect().height).toBeLessThanOrEqual(viewport.clientHeight);
      });

      await page.getByRole("button", { name: "Reset", exact: true }).click();
      expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
      viewport.focus();
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(0));

      await page.getByRole("button", { name: "Fit", exact: true }).click();
      await vi.waitFor(() => expect(viewport.scrollTop).toBe(0));
      const initialFittedHeight = table.getBoundingClientRect().height;
      await page.viewport(650, 430);
      await vi.waitFor(() => {
        expect(viewport.scrollHeight).toBeLessThanOrEqual(viewport.clientHeight + 2);
        expect(table.getBoundingClientRect().height).toBeLessThan(initialFittedHeight);
        expect(table.getBoundingClientRect().height).toBeLessThanOrEqual(viewport.clientHeight);
      });
    } finally {
      await screen.unmount();
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });

  it("keeps inline and expanded table scroll positions across chat rerenders", async () => {
    const screen = await render(renderTableViewerFixture());
    try {
      const inlineScroller = document.querySelector<HTMLElement>(".chat-markdown-table-scroll");
      expect(inlineScroller).not.toBeNull();
      expect(inlineScroller!.scrollWidth).toBeGreaterThan(inlineScroller!.clientWidth);
      inlineScroller!.scrollLeft = Math.min(
        80,
        inlineScroller!.scrollWidth - inlineScroller!.clientWidth,
      );
      const inlinePosition = inlineScroller!.scrollLeft;
      expect(inlinePosition).toBeGreaterThan(0);

      const expand = page.getByRole("button", { name: "Expand table" });
      await expand.click();
      const dialog = page.getByRole("dialog", { name: "Expanded table" });
      await expect.element(dialog).toBeVisible();
      const viewport = page
        .getByRole("region", { name: "Expanded table; scroll to inspect" })
        .element() as HTMLElement;
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      viewport.scrollLeft = Math.min(100, viewport.scrollWidth - viewport.clientWidth);
      const expandedPosition = viewport.scrollLeft;
      expect(expandedPosition).toBeGreaterThan(0);

      // Recreate workspace/skill arrays and change prose after the table, as
      // a streaming chat update does. Neither scroll region may be remounted.
      await screen.rerender(
        renderTableViewerFixture(`${TABLE_VIEWER_MARKDOWN}\n\nMore chat text arrived.`),
      );
      await expect.element(dialog).toBeVisible();
      expect(document.querySelector(".chat-markdown-table-scroll")).toBe(inlineScroller);
      expect(inlineScroller!.scrollLeft).toBe(inlinePosition);
      const expandedViewportAfterRerender = page
        .getByRole("region", { name: "Expanded table; scroll to inspect" })
        .element() as HTMLElement;
      expect(expandedViewportAfterRerender).toBe(viewport);
      expect(expandedViewportAfterRerender.scrollLeft).toBe(expandedPosition);
      await expect.element(page.getByText("More chat text arrived.")).toBeInTheDocument();

      await userEvent.keyboard("{Escape}");
      await expect.element(dialog).not.toBeInTheDocument();
      await expect.element(expand).toHaveFocus();
      expect(document.querySelector(".chat-markdown-table-scroll")).toBe(inlineScroller);
      expect(inlineScroller!.scrollLeft).toBe(inlinePosition);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps expanded Markdown file links behind the same workspace consent", async () => {
    installDesktopCapabilityStub();
    confirmMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const path = "/private/etc/hosts";
    const text = [
      "| File | Why inspect it |",
      "| --- | --- |",
      `| [hosts](file://${path}) | Outside this workspace |`,
    ].join("\n");
    const screen = await render(<ChatMarkdown text={text} cwd="/repo/project" />);
    try {
      await page.getByRole("button", { name: "Expand table" }).click();
      const dialog = page.getByRole("dialog", { name: "Expanded table" });
      await expect.element(dialog).toBeVisible();
      const expandedLink = dialog
        .element()
        .querySelector<HTMLAnchorElement>("a.chat-markdown-file-link");
      expect(expandedLink).not.toBeNull();
      expect(expandedLink!.getAttribute("href")).toBe(path);
      expect(expandedLink!.getAttribute("data-open-policy")).toBe("confirm");

      expandedLink!.click();
      await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
      expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining(path));
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();

      expandedLink!.click();
      await vi.waitFor(() => {
        expect(confirmMock).toHaveBeenCalledTimes(2);
        expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), path);
      });
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    { theme: "light", scale: 80 },
    { theme: "dark", scale: 130 },
  ])(
    "keeps the expanded table inside a narrow viewport in $theme at $scale%",
    async ({ theme, scale }) => {
      const root = document.documentElement;
      const originalFontSize = root.style.fontSize;
      const originalDark = root.classList.contains("dark");
      const originalViewport = { width: window.innerWidth, height: window.innerHeight };
      const safeInsets = [
        ["--markdown-table-safe-top", "48px"],
        ["--markdown-table-safe-right", "26px"],
        ["--markdown-table-safe-bottom", "32px"],
        ["--markdown-table-safe-left", "18px"],
      ] as const;
      const originalInsets = safeInsets.map(([property]) => root.style.getPropertyValue(property));
      for (const [property, value] of safeInsets) root.style.setProperty(property, value);
      root.classList.toggle("dark", theme === "dark");
      applyInterfaceScalePercent(scale);
      await page.viewport(390, 700);
      const screen = await render(renderTableViewerFixture());
      try {
        await page.getByRole("button", { name: "Expand table" }).click();
        const dialog = page.getByRole("dialog", { name: "Expanded table" });
        await expect.element(dialog).toBeVisible();
        const popup = dialog.element();
        const close = popup.querySelector<HTMLElement>('[aria-label="Close"]');
        expect(close).not.toBeNull();
        const viewport = page
          .getByRole("region", { name: "Expanded table; scroll to inspect" })
          .element() as HTMLElement;
        await vi.waitFor(() => {
          const bounds = popup.getBoundingClientRect();
          expect(bounds.left).toBeGreaterThanOrEqual(18);
          expect(bounds.top).toBeGreaterThanOrEqual(48);
          expect(bounds.right).toBeLessThanOrEqual(window.innerWidth - 26 + 1);
          expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight - 32 + 1);
          expect(close!.getBoundingClientRect().top).toBeGreaterThanOrEqual(48);
          expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 2);
        });
        expect(document.body.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
      } finally {
        await screen.unmount();
        root.style.fontSize = originalFontSize;
        root.classList.toggle("dark", originalDark);
        safeInsets.forEach(([property], index) => {
          const original = originalInsets[index];
          if (original) root.style.setProperty(property, original);
          else root.style.removeProperty(property);
        });
        await page.viewport(originalViewport.width, originalViewport.height);
      }
    },
  );

  it("asks before opening markdown file links outside the workspace", async () => {
    confirmMock.mockResolvedValueOnce(false);
    installDesktopCapabilityStub();
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

  it.each([
    ["/Users/example/repo", "/Users/example/repo/../outside.md", null],
    ["/home/example/repo", "/home/example/repo/../outside.md", null],
    ["C:/repo/project", "C:/repo/project/../outside.md", "C:/repo/outside.md"],
  ] as const)(
    "requires consent before opening or revealing traversal outside %s",
    async (cwd, filePath, normalizedTarget) => {
      installDesktopCapabilityStub();
      confirmMock.mockResolvedValueOnce(false);
      showContextMenuMock.mockResolvedValueOnce("reveal");
      const screen = await render(<ChatMarkdown text={`[Outside](${filePath})`} cwd={cwd} />);
      try {
        const link = page.getByRole("link", { name: "outside.md" });
        await expect.element(link).toHaveAttribute("data-open-policy", "confirm");
        const anchor = document.querySelector<HTMLAnchorElement>(".chat-markdown-file-link");
        expect(anchor).not.toBeNull();
        const actionPath = anchor!.getAttribute("href")!;
        // Native Windows browser handling can canonicalize drive URL dot
        // segments before delivering the link destination. Accept only that
        // exact alternate spelling of this outside fixture; POSIX retains its
        // source spelling because collapsing segments can change symlink
        // traversal. Consent and both actions must agree on the rendered target.
        const allowedTargets = normalizedTarget ? [filePath, normalizedTarget] : [filePath];
        expect(allowedTargets).toContain(actionPath);
        await link.click();
        await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
        expect(confirmMock).toHaveBeenLastCalledWith(expect.stringContaining(actionPath));
        expect(openInPreferredEditorMock).not.toHaveBeenCalled();

        confirmMock.mockResolvedValueOnce(false);
        anchor!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(2));
        expect(confirmMock).toHaveBeenLastCalledWith(expect.stringContaining(actionPath));
        expect(revealPathMock).not.toHaveBeenCalled();

        await link.click();
        await vi.waitFor(() =>
          expect(openInPreferredEditorMock).toHaveBeenCalledWith(expect.anything(), actionPath),
        );
        expect(openInPreferredEditorMock).toHaveBeenCalledTimes(1);
        expect(confirmMock).toHaveBeenCalledTimes(3);
        expect(confirmMock).toHaveBeenLastCalledWith(expect.stringContaining(actionPath));
        showContextMenuMock.mockResolvedValueOnce("reveal");
        anchor!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(revealPathMock).toHaveBeenCalledWith(actionPath));
        expect(revealPathMock).toHaveBeenCalledTimes(1);
        expect(confirmMock).toHaveBeenCalledTimes(4);
        expect(confirmMock).toHaveBeenLastCalledWith(expect.stringContaining(actionPath));
      } finally {
        await screen.unmount();
      }
    },
  );

  it("copies markdown file paths instead of opening editors in pure browser sessions", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const filePath = "/Users/yashsingh/p/t3code/apps/web/src/components/ChatMarkdown.tsx";
    const screen = await render(
      <ChatMarkdown
        text={`[ChatMarkdown.tsx](file://${filePath})`}
        cwd="/Users/yashsingh/p/t3code"
      />,
    );

    try {
      const link = page.getByRole("link", { name: "ChatMarkdown.tsx" });
      await link.click();

      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(filePath);
      });
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("copies remote file paths even when a local desktop editor is available", async () => {
    workspaceFixture.environmentId = EnvironmentId.make("remote-pc");
    const copyText = vi.fn(async () => undefined);
    installDesktopCapabilityStub();
    window.desktopBridge!.copyText = copyText;
    const filePath = "/remote/repo/src/file.ts";
    const screen = await render(
      <ChatMarkdown text={`[file.ts](${filePath})`} cwd="/remote/repo" />,
    );
    try {
      await page.getByRole("link", { name: "file.ts", exact: true }).click();
      await vi.waitFor(() => expect(copyText).toHaveBeenCalledWith(filePath));
      expect(openInPreferredEditorMock).not.toHaveBeenCalled();
      expect(revealPathMock).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
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

  it("renders a closed Mermaid fence while the remainder of the message is streaming", async () => {
    const diagram = "```mermaid\ngraph TD\n  A --> B\n```";
    const screen = await render(
      <ChatMarkdown text={`${diagram}\n\nStill writing`} cwd="/repo/project" isStreaming />,
    );

    try {
      const block = page.getByTestId("mermaid-block");
      await expect.element(block).toHaveAttribute("data-complete", "true");
      expect(block.element().textContent).toBe("graph TD\n  A --> B");
      expect(document.querySelector(".chat-markdown-shiki")).toBeNull();

      await screen.rerender(
        <ChatMarkdown
          text={`${diagram}\n\nStill writing more prose\n\n~~~mermaid\nsequenceDiagram`}
          cwd="/repo/project"
          isStreaming
        />,
      );
      const blocks = document.querySelectorAll('[data-testid="mermaid-block"]');
      expect(Array.from(blocks, (node) => node.getAttribute("data-complete"))).toEqual([
        "true",
        "false",
      ]);
      expect(blocks[0]?.textContent).toBe("graph TD\n  A --> B");
    } finally {
      await screen.unmount();
    }
  });

  it("settles unsupported code-language fallback across repeated streamed prose updates", async () => {
    const diagram = '```cafe-unknown-fixture-language\nconst literal = "<tag>";\n```';
    const consoleError = vi.spyOn(console, "error");
    const screen = await render(<ChatMarkdown text={diagram} cwd="/repo/project" isStreaming />);

    try {
      await vi.waitFor(() => {
        expect(document.querySelector(".chat-markdown-shiki code")?.textContent).toContain(
          'const literal = "<tag>";',
        );
      });
      for (let update = 0; update < 3; update += 1) {
        await screen.rerender(
          <ChatMarkdown
            text={`${diagram}\n\nAdditional streamed prose ${update}.`}
            cwd="/repo/project"
            isStreaming
          />,
        );
        expect(document.querySelector(".chat-markdown-shiki code")?.textContent).toContain(
          'const literal = "<tag>";',
        );
      }
      expect(
        consoleError.mock.calls.some((args) =>
          args.some((value) => typeof value === "string" && value.includes("uncached promise")),
        ),
      ).toBe(false);
    } finally {
      await screen.unmount();
      consoleError.mockRestore();
    }
  });

  it("keeps an incomplete Mermaid fence as source even when a truncated message is terminal", async () => {
    const text = "````mermaid\ngraph TD\n  A --> B\n```";
    const screen = await render(
      <ChatMarkdown text={text} cwd="/repo/project" isStreaming={false} />,
    );

    try {
      const block = page.getByTestId("mermaid-block");
      await expect.element(block).toHaveAttribute("data-complete", "false");
      expect(block.element().textContent).toBe("graph TD\n  A --> B\n```");

      await screen.rerender(<ChatMarkdown text={`${text}\``} cwd="/repo/project" isStreaming />);
      await expect.element(block).toHaveAttribute("data-complete", "true");
      expect(block.element().textContent).toBe("graph TD\n  A --> B");
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    ["top-level", "```mermaid\ngraph TD\n  A --> B\n```"],
    ["nested", "> 1. ```mermaid\n>    graph TD\n>      A --> B\n>    ```"],
  ])("retains a %s diagram's view state when later prose streams", async (_location, diagram) => {
    const screen = await render(
      <ChatMarkdown
        text={`${diagram}\n\nSee [first](src/example.ts).`}
        cwd="/repo/project"
        isStreaming
      />,
    );

    try {
      const block = page.getByTestId("mermaid-block");
      const initialElement = block.element();
      await page.getByRole("button", { name: "Expand diagram fixture" }).click();
      await expect.element(block).toHaveAttribute("data-expanded", "true");

      // This also changes file-link basename disambiguation, the text-derived
      // map that previously recreated the complete renderer component map.
      const completedText = `${diagram}\n\nSee [first](src/example.ts). More prose and [second](tests/example.ts).`;
      await screen.rerender(<ChatMarkdown text={completedText} cwd="/repo/project" isStreaming />);
      expect(block.element()).toBe(initialElement);
      await expect.element(block).toHaveAttribute("data-expanded", "true");
      await expect.element(block).toHaveAttribute("data-complete", "true");

      await screen.rerender(
        <ChatMarkdown text={completedText} cwd="/repo/project" isStreaming={false} />,
      );
      expect(block.element()).toBe(initialElement);
      await expect.element(block).toHaveAttribute("data-expanded", "true");
    } finally {
      await screen.unmount();
    }
  });

  it("preserves nested Mermaid source and nearby math, native file links and ordinary code", async () => {
    const source =
      'graph TD\n  A["literal & <tag> \\(x\\) \\[y\\] $\\texttt{a_b}$"] --> B\n  B["\uE200cite\uE202turn3view0\uE201"]\n';
    const screen = await render(
      <ChatMarkdown
        text={[
          "> 1. Diagram",
          ">",
          ">    ~~~mermaid",
          ...source.split("\n").map((line) => `>    ${line}`),
          ">    ~~~",
          "",
          "$x^2$ and [source](src/example.ts)",
          "",
          "```text",
          "graph LR",
          "  X --> Y",
          "```",
        ].join("\n")}
        cwd="/repo/project"
        normalizeCodexCitations
      />,
    );

    try {
      const block = page.getByTestId("mermaid-block");
      await expect.element(block).toHaveAttribute("data-complete", "true");
      expect(block.element().textContent).toBe(source);
      expect(document.querySelectorAll('[data-testid="mermaid-block"]')).toHaveLength(1);
      expect(document.querySelector(".katex")).not.toBeNull();
      expect(document.querySelector(".chat-markdown-file-link")?.getAttribute("href")).toBe(
        "/repo/project/src/example.ts",
      );
      expect(document.querySelector(".chat-markdown-codeblock")?.textContent).toContain("graph LR");
    } finally {
      await screen.unmount();
    }
  });
});
