import "../../index.css";
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { CodexReviewTarget } from "@cafecode/contracts";
import type { FormEvent } from "react";
import { NativeCodexReview } from "./NativeCodexReview";
import { useUiStateStore } from "../../uiStateStore";

const expandedTabProps = { collapsed: false, onCollapsedChange: () => {} };

function EditorReviewTab({
  label,
  onStart,
}: {
  label: string;
  onStart: (target: CodexReviewTarget) => Promise<void>;
}) {
  const collapsed = useUiStateStore((store) => store.codeReviewCollapsed);
  const onCollapsedChange = useUiStateStore((store) => store.setCodeReviewCollapsed);
  return (
    <section aria-label={label}>
      <NativeCodexReview
        accountLabel={label}
        runtimeMode="approval-required"
        disabled={false}
        collapsed={collapsed}
        onCollapsedChange={onCollapsedChange}
        onStart={onStart}
      />
    </section>
  );
}

describe("native Codex review controls", () => {
  it("shares minimize and restore across open panes and newly opened chats", async () => {
    const originalCollapsed = useUiStateStore.getState().codeReviewCollapsed;
    const start = vi.fn<(target: CodexReviewTarget) => Promise<void>>().mockResolvedValue();
    const content = (labels: string[]) => (
      <>
        {labels.map((label) => (
          <EditorReviewTab key={label} label={label} onStart={start} />
        ))}
      </>
    );
    useUiStateStore.getState().setCodeReviewCollapsed(false);
    try {
      const view = await render(content(["Local chat", "Remote chat"]));
      await page
        .getByRole("region", { name: "Local chat" })
        .getByRole("button", { name: "Minimize code review", exact: true })
        .click();
      for (const label of ["Local chat", "Remote chat"]) {
        const region = page.getByRole("region", { name: label });
        await expect
          .element(region.getByRole("button", { name: "Expand code review", exact: true }))
          .toBeEnabled();
        await expect
          .element(
            region.getByRole("button", { name: "Code review", exact: true, includeHidden: true }),
          )
          .not.toBeVisible();
      }
      await view.rerender(content(["Remote chat", "New chat"]));
      await expect
        .element(
          page
            .getByRole("region", { name: "New chat" })
            .getByRole("button", { name: "Expand code review", exact: true }),
        )
        .toBeEnabled();
      await page
        .getByRole("region", { name: "Remote chat" })
        .getByRole("button", { name: "Expand code review", exact: true })
        .click();
      await view.rerender(content(["Local chat", "Remote chat", "New chat"]));
      for (const label of ["Local chat", "Remote chat", "New chat"]) {
        await expect
          .element(
            page
              .getByRole("region", { name: label })
              .getByRole("button", { name: "Code review", exact: true }),
          )
          .toBeEnabled();
      }
      expect(start).not.toHaveBeenCalled();
    } finally {
      useUiStateStore.getState().setCodeReviewCollapsed(originalCollapsed);
    }
  });

  it("can minimize and expand without submitting a review or a chat prompt", async () => {
    const start = vi.fn<(target: CodexReviewTarget) => Promise<void>>().mockResolvedValue();
    const collapse = vi.fn();
    const submitComposer = vi.fn((event: FormEvent) => event.preventDefault());
    const content = (collapsed: boolean) => (
      <form onSubmit={submitComposer}>
        <NativeCodexReview
          accountLabel="Codex personal"
          runtimeMode="approval-required"
          disabled={false}
          collapsed={collapsed}
          onCollapsedChange={collapse}
          onStart={start}
        />
      </form>
    );
    const view = await render(content(false));
    await page.getByRole("button", { name: "Minimize code review", exact: true }).click();
    expect(collapse).toHaveBeenCalledExactlyOnceWith(true);
    await view.rerender(content(true));
    const expand = page.getByRole("button", { name: "Expand code review", exact: true });
    await expect.element(expand).toBeEnabled();
    await expect.element(expand).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(page.getByRole("button", { name: "Code review", exact: true, includeHidden: true }))
      .not.toBeVisible();
    await expand.click();
    expect(collapse).toHaveBeenLastCalledWith(false);
    await view.rerender(content(false));
    await expect
      .element(page.getByRole("button", { name: "Code review", exact: true }))
      .toBeEnabled();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
    expect(submitComposer).not.toHaveBeenCalled();
  });

  it("hides unavailable review controls while letting an already submitted review settle", async () => {
    let resolve!: () => void;
    const start = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const content = (disabled: boolean, collapsed = false) => (
      <NativeCodexReview
        {...expandedTabProps}
        accountLabel="Codex personal"
        runtimeMode="approval-required"
        disabled={disabled}
        collapsed={collapsed}
        onStart={start}
      />
    );
    const view = await render(content(false));
    await page.getByRole("button", { name: "Code review", exact: true }).click();
    await page.getByRole("button", { name: "Start review", exact: true }).click();
    await view.rerender(content(true));
    await expect
      .element(page.getByRole("button", { name: "Code review", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Minimize code review", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Starting review…", exact: true }))
      .toBeDisabled();
    expect(start).toHaveBeenCalledTimes(1);
    resolve();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await view.rerender(content(true, true));
    await expect
      .element(page.getByRole("button", { name: "Expand code review", exact: true }))
      .not.toBeInTheDocument();
    await view.rerender(content(false, true));
    await expect
      .element(page.getByRole("button", { name: "Expand code review", exact: true }))
      .toBeVisible();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("explains the tab on hover and submits only the review from its portalled dialog", async () => {
    const start = vi.fn<(target: CodexReviewTarget) => Promise<void>>().mockResolvedValue();
    const submitComposer = vi.fn((event: FormEvent) => event.preventDefault());
    await render(
      <form onSubmit={submitComposer}>
        <NativeCodexReview
          {...expandedTabProps}
          accountLabel="Codex personal"
          runtimeMode="approval-required"
          disabled={false}
          onStart={start}
        />
      </form>,
    );
    const tab = page.getByRole("button", { name: "Code review", exact: true });
    await tab.hover();
    await expect
      .element(page.getByRole("tooltip"))
      .toHaveTextContent(
        "Ask Codex to review code for bugs and risks. Choose uncommitted changes, a branch, a commit, or custom instructions. Findings appear in this chat.",
      );
    expect(start).not.toHaveBeenCalled();
    expect(submitComposer).not.toHaveBeenCalled();
    await tab.click();
    await expect.element(page.getByRole("dialog", { name: "Start a code review" })).toBeVisible();
    await page.getByRole("button", { name: "Start review", exact: true }).click();
    expect(start).toHaveBeenCalledExactlyOnceWith({ type: "uncommittedChanges" });
    expect(submitComposer).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "uncommittedChanges", label: null, value: "", target: { type: "uncommittedChanges" } },
    {
      kind: "baseBranch",
      label: "Base branch",
      value: "origin/main",
      target: { type: "baseBranch", branch: "origin/main" },
    },
    {
      kind: "commit",
      label: "Commit SHA",
      value: "abcdef1234567",
      target: { type: "commit", sha: "abcdef1234567" },
    },
    {
      kind: "custom",
      label: "Review instructions",
      value: "Inspect concurrency.\nDo not edit files.",
      target: { type: "custom", instructions: "Inspect concurrency.\nDo not edit files." },
    },
  ])(
    "submits the exact $kind structured target only after an explicit gesture",
    async ({ kind, label, value, target }) => {
      const start = vi.fn<(target: CodexReviewTarget) => Promise<void>>().mockResolvedValue();
      await render(
        <NativeCodexReview
          {...expandedTabProps}
          accountLabel="Codex personal"
          runtimeMode="approval-required"
          disabled={false}
          onStart={start}
        />,
      );
      expect(start).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Code review", exact: true }).click();
      await expect
        .element(
          page.getByText(
            "Review in this chat with Codex personal. Uses the current native session and its review-model settings, not unsent composer changes.",
            { exact: true },
          ),
        )
        .toBeVisible();
      await expect
        .element(
          page.getByText(
            /Codex’s native reviewer runs non-interactively, without approval prompts/,
          ),
        )
        .toBeVisible();
      await page.getByRole("combobox", { name: "Review target" }).selectOptions(kind);
      if (label) {
        await expect
          .element(page.getByRole("button", { name: "Start review", exact: true }))
          .toBeDisabled();
        await page.getByRole("textbox", { name: label, exact: true }).fill(value);
      }
      await page.getByRole("button", { name: "Start review", exact: true }).click();
      expect(start).toHaveBeenCalledExactlyOnceWith(target);
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("rejects unsafe reference spelling, has no hidden automatic retry and sanitizes failures", async () => {
    const start = vi.fn().mockRejectedValue(new Error("private-token-and-path"));
    await render(
      <NativeCodexReview
        {...expandedTabProps}
        accountLabel="Codex work"
        runtimeMode="full-access"
        disabled={false}
        onStart={start}
      />,
    );
    await page.getByRole("button", { name: "Code review", exact: true }).click();
    await expect.element(page.getByText(/This chat currently has full access/)).toBeVisible();
    await page.getByRole("combobox", { name: "Review target" }).selectOptions("baseBranch");
    await page.getByRole("textbox", { name: "Base branch" }).fill("--upload-pack=evil");
    await expect
      .element(page.getByRole("button", { name: "Start review", exact: true }))
      .toBeDisabled();
    await page.getByRole("textbox", { name: "Base branch" }).fill("main");
    await page.getByRole("button", { name: "Start review", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "The review could not be confirmed. Check the chat’s work log and provider connection before trying again; it was not automatically resent.",
      );
    await expect.element(page.getByText("private-token-and-path")).not.toBeInTheDocument();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("blocks duplicate submission while acknowledgement is pending and resets on exact account identity change", async () => {
    let resolve!: () => void;
    const start = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const view = await render(
      <NativeCodexReview
        {...expandedTabProps}
        key="personal"
        accountLabel="Personal"
        runtimeMode="approval-required"
        disabled={false}
        onStart={start}
      />,
    );
    await page.getByRole("button", { name: "Code review", exact: true }).click();
    await page.getByRole("button", { name: "Start review", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Starting review…", exact: true }))
      .toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    expect(start).toHaveBeenCalledTimes(1);
    await view.rerender(
      <NativeCodexReview
        {...expandedTabProps}
        key="work"
        accountLabel="Work"
        runtimeMode="approval-required"
        disabled={true}
        onStart={start}
      />,
    );
    resolve();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Code review", exact: true }))
      .not.toBeInTheDocument();
    expect(start).toHaveBeenCalledTimes(1);
  });
});
