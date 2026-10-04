import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { CodexReviewTarget } from "@cafecode/contracts";
import { NativeCodexReview } from "./NativeCodexReview";

describe("native Codex review controls", () => {
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
          accountLabel="Codex personal"
          runtimeMode="approval-required"
          disabled={false}
          onStart={start}
        />,
      );
      expect(start).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Native review", exact: true }).click();
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
        accountLabel="Codex work"
        runtimeMode="full-access"
        disabled={false}
        onStart={start}
      />,
    );
    await page.getByRole("button", { name: "Native review", exact: true }).click();
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
        key="personal"
        accountLabel="Personal"
        runtimeMode="approval-required"
        disabled={false}
        onStart={start}
      />,
    );
    await page.getByRole("button", { name: "Native review", exact: true }).click();
    await page.getByRole("button", { name: "Start review", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Starting review…", exact: true }))
      .toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    expect(start).toHaveBeenCalledTimes(1);
    await view.rerender(
      <NativeCodexReview
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
      .element(page.getByRole("button", { name: "Native review", exact: true }))
      .toBeDisabled();
    expect(start).toHaveBeenCalledTimes(1);
  });
});
