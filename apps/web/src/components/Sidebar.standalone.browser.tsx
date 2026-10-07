import "../index.css";
import { EnvironmentId, ProviderDriverKind, ThreadId } from "@cafecode/contracts";
import { scopeThreadRef, scopedThreadKey } from "@cafecode/client-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import type { SidebarThreadSummary } from "../types";
import { buildStandaloneCatalog } from "./sidebar/standaloneNavigation.logic";
import { SidebarStandaloneChats } from "./Sidebar";

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  delete: vi.fn(),
  confirmDelete: vi.fn(),
  rename: vi.fn(),
  gitStatus: vi.fn(),
}));
vi.mock("../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    archiveThread: mocks.archive,
    deleteThread: mocks.delete,
    confirmAndDeleteThread: mocks.confirmDelete,
  }),
}));
vi.mock("../threadRename", () => ({ renameThread: mocks.rename }));
vi.mock("../hooks/useSettings", async () => {
  const { DEFAULT_UNIFIED_SETTINGS } = await import("@cafecode/contracts/settings");
  const settings = { ...DEFAULT_UNIFIED_SETTINGS, confirmThreadArchive: false };
  return {
    getClientSettings: () => settings,
    useClientSettingsHydrated: () => true,
    __resetClientSettingsPersistenceForTests: vi.fn(),
    useSettings: (selector?: (settings: typeof DEFAULT_UNIFIED_SETTINGS) => unknown) =>
      selector ? selector(settings) : settings,
    useUpdateSettings: () => ({ updateSettings: vi.fn() }),
  };
});
vi.mock("../lib/gitStatusState", () => ({
  useGitStatus: mocks.gitStatus,
  resetGitStatusStateForTests: vi.fn(),
}));

const environmentId = EnvironmentId.make("standalone-navigation-fixture");
const saved: SidebarThreadSummary = {
  environmentId,
  id: ThreadId.make("saved-chat"),
  projectId: null,
  title: "Saved standalone chat",
  interactionMode: "default",
  session: null,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-02T00:00:00Z",
  archivedAt: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
function standaloneFixture(
  id: string,
  title: string,
  latestUserMessageAt: string,
  extra: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return { ...saved, id: ThreadId.make(id), title, latestUserMessageAt, ...extra };
}
const draftId = DraftId.make("unsent-standalone-draft");
beforeEach(async () => {
  await page.viewport(1100, 800);
  mocks.archive.mockReset();
  mocks.archive.mockResolvedValue(undefined);
  mocks.delete.mockReset();
  mocks.delete.mockResolvedValue(undefined);
  mocks.confirmDelete.mockReset();
  mocks.confirmDelete.mockResolvedValue(undefined);
  mocks.rename.mockReset();
  mocks.rename.mockResolvedValue(undefined);
  mocks.gitStatus.mockReset();
  mocks.gitStatus.mockReturnValue({ data: null });
  useThreadSelectionStore.getState().clearSelection();
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  useComposerDraftStore
    .getState()
    .createStandaloneDraftSession(
      draftId,
      environmentId,
      ThreadId.make("future-chat"),
      "2026-09-03T00:00:00Z",
    );
});
afterEach(() => {
  useThreadSelectionStore.getState().clearSelection();
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
});

async function setup(threads: readonly SidebarThreadSummary[] = [saved]) {
  const onOpen = vi.fn();
  const onExpansionChange = vi.fn();
  const onNewChat = vi.fn();
  const screen = await render(
    <div className="w-72">
      <SidebarStandaloneChats
        onNewChat={onNewChat}
        entries={buildStandaloneCatalog({ threads, sortOrder: "updated_at" })}
        previewCount={8}
        expanded={false}
        activeTarget={null}
        jumpLabelByKey={new Map()}
        onOpen={onOpen}
        onExpansionChange={onExpansionChange}
      />
    </div>,
  );
  return { screen, onOpen, onNewChat };
}

describe("standalone Chats catalog", () => {
  it("offers archive without an inline delete action or row navigation", async () => {
    const { screen, onOpen } = await setup();
    try {
      const row = screen.getByTestId(`thread-row-${saved.id}`);
      await row.hover();
      await expect
        .element(screen.getByRole("button", { name: `Delete ${saved.title}`, exact: true }))
        .not.toBeInTheDocument();
      const archive = screen.getByRole("button", { name: `Archive ${saved.title}`, exact: true });
      await expect.element(archive).toBeVisible();
      (archive.element() as HTMLElement).focus();
      await userEvent.keyboard("{Enter}");
      expect(mocks.archive).toHaveBeenCalledExactlyOnceWith(
        scopeThreadRef(environmentId, saved.id),
      );
      expect(mocks.delete).not.toHaveBeenCalled();
      expect(mocks.confirmDelete).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
  it("keeps unsent drafts out of the saved Chats catalog without discarding content", async () => {
    useComposerDraftStore.getState().setPrompt(draftId, "Keep this unsent message");
    const original = useComposerDraftStore.getState().getDraftSession(draftId);
    const { screen, onOpen, onNewChat } = await setup([]);
    try {
      await expect.element(screen.getByText("No chats yet")).toBeVisible();
      await screen.getByRole("button", { name: "New chat", exact: true }).click();
      expect(onNewChat).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[data-testid^="thread-row-"]')).toBeNull();
      await expect.element(screen.getByText("Keep this unsent message")).not.toBeInTheDocument();
      expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBe(original);
      expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
        "Keep this unsent message",
      );
      expect(mocks.archive).not.toHaveBeenCalled();
      expect(mocks.delete).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
  it("never treats forged standalone branch/worktree metadata as repository authority", async () => {
    const forged = buildStandaloneCatalog({
      threads: [{ ...saved, branch: "foreign-branch", worktreePath: "/private/foreign-project" }],
      sortOrder: "updated_at",
    });
    const screen = await render(
      <SidebarStandaloneChats
        onNewChat={vi.fn()}
        entries={forged}
        previewCount={8}
        expanded={false}
        activeTarget={null}
        jumpLabelByKey={new Map()}
        onOpen={vi.fn()}
        onExpansionChange={vi.fn()}
      />,
    );
    try {
      expect(mocks.gitStatus).toHaveBeenCalledWith({ environmentId, cwd: null });
      expect(mocks.gitStatus.mock.calls.every(([options]) => options.cwd === null)).toBe(true);
    } finally {
      await screen.unmount();
    }
  });
  it("reuses saved-row hover actions, inline F2 rename, exact scoped archive and timestamps", async () => {
    const { screen, onOpen } = await setup();
    try {
      const row = screen.getByTestId(`thread-row-${saved.id}`);
      await row.click();
      expect(onOpen).toHaveBeenCalledExactlyOnceWith(
        {
          kind: "server",
          threadRef: scopeThreadRef(environmentId, saved.id),
        },
        true,
      );
      const rename = screen.getByRole("button", { name: `Rename ${saved.title}`, exact: true });
      const archive = screen.getByTestId(`thread-archive-${saved.id}`);
      (row.element() as HTMLElement).blur();
      await screen.getByText("Chats", { exact: true }).hover();
      const cluster = rename.element().parentElement!;
      const timestamp = cluster.parentElement!.lastElementChild!;
      await vi.waitFor(() => expect(getComputedStyle(cluster).opacity).toBe("0"));
      await row.hover();
      await vi.waitFor(() => {
        expect(getComputedStyle(cluster).opacity).toBe("1");
        expect(getComputedStyle(timestamp).opacity).toBe("0");
      });
      (row.element() as HTMLElement).focus();
      await userEvent.keyboard("{F2}");
      const input = screen.getByRole("textbox", { name: "Chat title" });
      await input.fill("Canonical title");
      await userEvent.keyboard("{Enter}");
      await expect.element(input).not.toBeInTheDocument();
      expect(mocks.rename).toHaveBeenCalledExactlyOnceWith(
        scopeThreadRef(environmentId, saved.id),
        "Canonical title",
        saved.title,
      );
      await row.hover();
      expect(rename.element().getBoundingClientRect().right).toBeLessThanOrEqual(
        archive.element().getBoundingClientRect().left + 1,
      );
      await archive.click();
      expect(mocks.archive).toHaveBeenCalledExactlyOnceWith(
        scopeThreadRef(environmentId, saved.id),
      );
    } finally {
      await screen.unmount();
    }
  });
  it("aligns its overflow toggle with chat titles and summarizes urgent hidden chats", async () => {
    // The "updated" sort follows the latest user message, so a long-running
    // chat and a later approval request can both sit below the preview.
    const threads = [
      standaloneFixture("overflow-newest", "Newest chat", "2026-09-05T00:00:00Z"),
      standaloneFixture("overflow-second", "Second chat", "2026-09-04T00:00:00Z"),
      standaloneFixture("overflow-running", "Long running chat", "2026-09-03T00:00:00Z", {
        session: {
          provider: ProviderDriverKind.make("codex"),
          status: "running",
          createdAt: "2026-09-03T00:00:00Z",
          updatedAt: "2026-09-05T00:00:00Z",
          orchestrationStatus: "running",
        },
      }),
      standaloneFixture("overflow-approval", "Approval chat", "2026-09-02T00:00:00Z", {
        hasPendingApprovals: true,
      }),
    ];
    const entries = buildStandaloneCatalog({ threads, sortOrder: "updated_at" });
    const onExpansionChange = vi.fn();
    const view = (expanded: boolean) => (
      <div className="w-72">
        <SidebarStandaloneChats
          onNewChat={vi.fn()}
          entries={entries}
          previewCount={2}
          expanded={expanded}
          activeTarget={null}
          jumpLabelByKey={new Map()}
          onOpen={vi.fn()}
          onExpansionChange={onExpansionChange}
        />
      </div>
    );
    const screen = await render(view(false));
    try {
      const label = screen.getByTestId("sidebar-thread-overflow-label");
      const referenceRow = screen.getByTestId("thread-row-overflow-second");
      const referenceTitle = screen.getByTestId("thread-title-overflow-second");
      const collapsed = screen.getByRole("button", {
        name: "Show 2 more chats, 1 needs approval",
        exact: true,
      });
      await expect.element(collapsed).toHaveAttribute("aria-expanded", "false");
      await expect.element(label).toHaveTextContent("2 more");
      await expect
        .element(screen.getByTestId("sidebar-thread-overflow-summary"))
        .toHaveTextContent("1 needs approval");
      await expect.element(screen.getByText("Long running chat")).not.toBeInTheDocument();
      const collapsedLeft = label.element().getBoundingClientRect().left;
      expect(collapsedLeft).toBeCloseTo(referenceTitle.element().getBoundingClientRect().left, 1);
      expect(collapsed.element().getBoundingClientRect().height).toBeCloseTo(
        referenceRow.element().getBoundingClientRect().height,
        1,
      );
      await collapsed.click();
      expect(onExpansionChange).toHaveBeenCalledExactlyOnceWith(true);

      await screen.rerender(view(true));
      const expanded = screen.getByRole("button", { name: "Show fewer chats", exact: true });
      await expect.element(expanded).toHaveAttribute("aria-expanded", "true");
      await expect.element(label).toHaveTextContent("Show fewer");
      await expect
        .element(screen.getByTestId("sidebar-thread-overflow-summary"))
        .not.toBeInTheDocument();
      await expect.element(screen.getByText("Long running chat")).toBeVisible();
      // The label must not jump horizontally when the list is toggled.
      expect(label.element().getBoundingClientRect().left).toBeCloseTo(collapsedLeft, 1);
      await expanded.click();
      expect(onExpansionChange).toHaveBeenLastCalledWith(false);
    } finally {
      await screen.unmount();
    }
  });
  it("keeps modified selection environment-scoped and does not navigate on Ctrl/Cmd click", async () => {
    const { screen, onOpen } = await setup();
    try {
      const key = scopedThreadKey(scopeThreadRef(environmentId, saved.id));
      const row = screen.getByTestId(`thread-row-${saved.id}`);
      row
        .element()
        .dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true, metaKey: true }));
      await vi.waitFor(() =>
        expect(useThreadSelectionStore.getState().selectedThreadKeys.has(key)).toBe(true),
      );
      expect(onOpen).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
  it("retains the existing two-step mobile archive confirmation for saved standalone chats", async () => {
    await page.viewport(390, 800);
    const { screen } = await setup();
    try {
      const archive = screen.getByTestId(`thread-archive-${saved.id}`);
      await expect.element(archive).toBeVisible();
      await archive.click();
      expect(mocks.archive).not.toHaveBeenCalled();
      await screen.getByTestId(`thread-archive-confirm-${saved.id}`).click();
      expect(mocks.archive).toHaveBeenCalledExactlyOnceWith(
        scopeThreadRef(environmentId, saved.id),
      );
    } finally {
      await screen.unmount();
    }
  });
});
