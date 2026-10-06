import "../../index.css";
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { CodexReviewTarget, RuntimeMode } from "@cafecode/contracts";
import { useState, type FormEvent } from "react";
import { NativeCodexReview } from "./NativeCodexReview";

/** The composer owns the menu gesture and open state; the native operation is
 * only a controlled dialog and must never put another tab on the editor. */
function ReviewDialogHarness({
  disabled = false,
  accountLabel = "Codex personal",
  runtimeMode = "approval-required",
  onStart,
}: {
  disabled?: boolean;
  accountLabel?: string;
  runtimeMode?: RuntimeMode;
  onStart: (target: CodexReviewTarget) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open review dialog
      </button>
      <NativeCodexReview
        open={open}
        onOpenChange={setOpen}
        accountLabel={accountLabel}
        runtimeMode={runtimeMode}
        disabled={disabled}
        onStart={onStart}
      />
    </>
  );
}

describe("native Codex review dialog", () => {
  it("renders no standalone review tab or minimize control while closed", async () => {
    const start = vi.fn<(target: CodexReviewTarget) => Promise<void>>().mockResolvedValue();
    await render(
      <NativeCodexReview
        open={false}
        onOpenChange={vi.fn()}
        accountLabel="Codex personal"
        runtimeMode="approval-required"
        disabled={false}
        onStart={start}
      />,
    );
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button")).not.toBeInTheDocument();
    expect(document.querySelector(".cafe-code-review-tab")).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("submits only the review from its portalled dialog inside a composer form", async () => {
    const start = vi.fn<(target: CodexReviewTarget) => Promise<void>>().mockResolvedValue();
    const submitComposer = vi.fn((event: FormEvent) => event.preventDefault());
    await render(
      <form onSubmit={submitComposer}>
        <ReviewDialogHarness onStart={start} />
      </form>,
    );
    await page.getByRole("button", { name: "Open review dialog", exact: true }).click();
    expect(start).not.toHaveBeenCalled();
    expect(submitComposer).not.toHaveBeenCalled();
    await expect.element(page.getByRole("dialog", { name: "Start a Codex review" })).toBeVisible();
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
      await render(<ReviewDialogHarness onStart={start} />);
      expect(start).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Open review dialog", exact: true }).click();
      await expect
        .element(
          page.getByText(
            "Ask Codex to check code for bugs and risks. Findings appear in this chat. Review in this chat with Codex personal. Uses the current native session and its review-model settings, not unsent composer changes.",
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

  it("rejects unsafe reference spelling, has no automatic retry and sanitizes failures", async () => {
    const start = vi.fn().mockRejectedValue(new Error("private-token-and-path"));
    await render(
      <ReviewDialogHarness accountLabel="Codex work" runtimeMode="full-access" onStart={start} />,
    );
    await page.getByRole("button", { name: "Open review dialog", exact: true }).click();
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

  it("keeps an acknowledged submission single-flight as the chat becomes busy", async () => {
    let resolve!: () => void;
    const start = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const view = await render(<ReviewDialogHarness onStart={start} />);
    await page.getByRole("button", { name: "Open review dialog", exact: true }).click();
    await page.getByRole("button", { name: "Start review", exact: true }).click();
    await view.rerender(<ReviewDialogHarness disabled onStart={start} />);
    await expect
      .element(page.getByRole("button", { name: "Starting review…", exact: true }))
      .toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    expect(start).toHaveBeenCalledTimes(1);
    resolve();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("does not let an old acknowledgement close a replacement dialog with the same account key", async () => {
    let acknowledge!: () => void;
    const pending = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const start = vi.fn(() => pending);
    // The composer owner survives account switches. Reuse its callback so an
    // old instance's late close would reach the replacement account's state.
    const onOpenChange = vi.fn();
    const dialog = (
      <NativeCodexReview
        key="same-codex-account"
        open
        onOpenChange={onOpenChange}
        accountLabel="Codex personal"
        runtimeMode="approval-required"
        disabled={false}
        onStart={start}
      />
    );
    const view = await render(dialog);
    try {
      await page.getByRole("button", { name: "Start review", exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: "Starting review…", exact: true }))
        .toBeDisabled();
      await view.rerender(<span>Claude selected</span>);
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      await view.rerender(dialog);
      await page.getByRole("combobox", { name: "Review target" }).selectOptions("custom");
      await page
        .getByRole("textbox", { name: "Review instructions" })
        .fill("Replacement review draft");
      acknowledge();
      await pending;
      expect(onOpenChange).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("dialog", { name: "Start a Codex review" }))
        .toBeVisible();
      await expect
        .element(page.getByRole("textbox", { name: "Review instructions" }))
        .toHaveValue("Replacement review draft");
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      acknowledge();
      await view.unmount();
    }
  });
});
