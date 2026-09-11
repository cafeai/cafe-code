import "../../index.css";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@cafecode/contracts";
import { scopeThreadRef } from "@cafecode/client-runtime";
import { createModelSelection } from "@cafecode/shared/model";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { ThreadAgentControl } from "./ThreadAgentControl";
import { useComposerDraftStore } from "../../composerDraftStore";
import { readEnvironmentApi } from "../../environmentApi";

vi.mock("../../environmentApi", () => ({ readEnvironmentApi: vi.fn() }));
const environmentId = EnvironmentId.make("remote-environment");
const ref = scopeThreadRef(environmentId, ThreadId.make("thread-limit"));
const instanceId = ProviderInstanceId.make("claude-work");
const props = {
  environmentId,
  draftTarget: ref,
  serverThreadRef: ref,
  provider: ProviderDriverKind.make("claudeAgent"),
  modelSelection: createModelSelection(instanceId, "claude-opus-4-6"),
};
afterEach(() => {
  vi.resetAllMocks();
  useComposerDraftStore.setState({ draftsByThreadKey: {}, stickyModelSelectionByProvider: {} });
});

describe("ThreadAgentControl", () => {
  it("validates input, saves the exact server thread, and preserves provider inheritance", async () => {
    const dispatchCommand = vi.fn().mockResolvedValue(undefined);
    vi.mocked(readEnvironmentApi).mockReturnValue({
      orchestration: { dispatchCommand },
    } as unknown as NonNullable<ReturnType<typeof readEnvironmentApi>>);
    const screen = await render(<ThreadAgentControl {...props} />);
    try {
      await page.getByRole("button", { name: "Subagent limit: provider default" }).click();
      const input = page.getByRole("textbox", { name: "Maximum subagents (1–64)" });
      await input.fill("65");
      await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await input.fill("4");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => dispatchCommand.mock.calls.length).toBe(1);
      expect(readEnvironmentApi).toHaveBeenCalledWith(environmentId);
      expect(dispatchCommand.mock.calls[0]?.[0]).toMatchObject({
        type: "thread.meta.update",
        threadId: ref.threadId,
        modelSelection: { instanceId, options: [{ id: "threadSubagentLimit", value: "4" }] },
      });
      expect(useComposerDraftStore.getState().stickyModelSelectionByProvider).toEqual({});
      await page.getByRole("button", { name: "Subagent limit: provider default" }).click();
      await input.fill("");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => dispatchCommand.mock.calls.length).toBe(2);
      expect(dispatchCommand.mock.calls[1]?.[0].modelSelection.options).toEqual([
        { id: "threadSubagentLimit", value: "inherit" },
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("does not persist a draft override when the server rejects the write", async () => {
    const dispatchCommand = vi.fn().mockRejectedValue(new Error("private transport detail"));
    vi.mocked(readEnvironmentApi).mockReturnValue({
      orchestration: { dispatchCommand },
    } as unknown as NonNullable<ReturnType<typeof readEnvironmentApi>>);
    const screen = await render(<ThreadAgentControl {...props} />);
    try {
      await page.getByRole("button", { name: "Subagent limit: provider default" }).click();
      await page.getByRole("textbox", { name: "Maximum subagents (1–64)" }).fill("2");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Could not save the subagent limit.");
      expect(useComposerDraftStore.getState().getComposerDraft(ref)).toBeNull();
      await expect.element(page.getByText("private transport detail")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
