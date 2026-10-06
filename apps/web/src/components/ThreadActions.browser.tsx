import { CommandId, EnvironmentId, ThreadId } from "@cafecode/contracts";
import { CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE } from "@cafecode/shared/codexHistorySafety";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useThreadActions } from "../hooks/useThreadActions";

const mocks = vi.hoisted(() => ({
  router: {
    state: {
      location: { href: "/fixture/a" },
      matches: [{ params: { environmentId: "fixture", threadId: "a" } }],
    },
    navigate: vi.fn(async (_options: unknown) => {}),
  },
  dispatch:
    vi.fn<
      (command: {
        type: string;
        threadId?: string;
        sourceThreadId?: string;
        targetThreadId?: string;
        commandId?: string;
      }) => Promise<void>
    >(),
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  readApi: vi.fn(),
  workspace: { environmentId: "fixture" },
  clear: vi.fn(),
  refreshArchived: vi.fn(),
  refreshDeleted: vi.fn(),
  fallback: "b" as string | null,
  threads: ["a", "b", "c"].map((id) => ({
    id,
    environmentId: "fixture",
    projectId: null,
    session: null as {
      status: string;
      provider?: string;
      providerInstanceId?: string;
      subagentRuntimeId?: string;
      activeTurnId?: string;
    } | null,
    modelSelection: { instanceId: "codex-personal", model: "gpt-6.1-sol" },
    createdAt: "2026-10-07T00:00:00.000Z",
    codexThreadId: "native-a",
    error: null as string | null,
    archivedAt: null,
    latestTurn: null as { completedAt: string | null } | null,
    branch: null,
    worktreePath: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    title: id,
  })),
}));

// Render the real action hook, with React mount/unmount behavior intact. Only
// external service boundaries are synthetic: these tests cannot contact a
// server, stop a provider, delete history, or touch an actual worktree.
vi.mock("@tanstack/react-router", () => ({ useRouter: () => mocks.router }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => ({
    handleNewThread: vi.fn(),
    handleNewStandaloneChat: vi.fn(),
  }),
}));
vi.mock("../hooks/useSettings", () => ({
  useSettings: (select: (settings: unknown) => unknown) =>
    select({ sidebarThreadSortOrder: "updated", confirmThreadDelete: false }),
}));
vi.mock("../environmentApi", () => ({
  readEnvironmentApi: mocks.readApi,
  ensureEnvironmentApi: vi.fn(),
}));
vi.mock("../environments/workspace", () => ({
  readWorkspaceEnvironmentId: () => mocks.workspace.environmentId,
  useWorkspaceSelection: { getState: () => mocks.workspace },
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({ clearDraftThread: mocks.clear, clearProjectDraftThreadById: mocks.clear }),
}));
vi.mock("../lib/utils", () => ({
  newCommandId: () => CommandId.make(crypto.randomUUID()),
  newThreadId: () => ThreadId.make(crypto.randomUUID()),
}));
vi.mock("../store", () => ({
  useStore: { getState: () => ({}) },
  selectThreadByRef: (_store: unknown, ref: { environmentId: string; threadId: string }) =>
    mocks.threads.find(
      (thread) => thread.id === ref.threadId && thread.environmentId === ref.environmentId,
    ),
  selectThreadsForEnvironment: () => mocks.threads,
  selectProjectByRef: () => undefined,
}));
vi.mock("./Sidebar.logic", () => ({ getFallbackThreadIdAfterDelete: () => mocks.fallback }));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }),
}));
vi.mock("../worktreeCleanup", () => ({
  getOrphanedWorktreePathForThread: () => null,
  formatWorktreePathForDisplay: (path: string) => path,
}));
vi.mock("../lib/gitReactQuery", () => ({ invalidateGitQueries: vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: mocks.refreshArchived,
}));
vi.mock("../lib/deletedThreadsState", () => ({
  refreshDeletedThreadsForEnvironment: mocks.refreshDeleted,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (value: unknown) => value,
}));

type Actions = ReturnType<typeof useThreadActions>;
function Harness({ ready }: { ready: (actions: Actions) => void }) {
  const actions = useThreadActions();
  useLayoutEffect(() => ready(actions), [actions, ready]);
  return <div>Action fixture</div>;
}

const target = { environmentId: EnvironmentId.make("fixture"), threadId: ThreadId.make("a") };
function navigateTo(threadId: string, environmentId = "fixture") {
  mocks.router.state.location = { href: `/${environmentId}/${threadId}` };
  mocks.router.state.matches = [{ params: { environmentId, threadId } }];
}
function holdCommand() {
  let acknowledge!: () => void;
  const promise = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  mocks.dispatch.mockReturnValueOnce(promise);
  return acknowledge;
}
async function mountActions() {
  let actions!: Actions;
  const screen = await render(
    <Harness
      ready={(value) => {
        actions = value;
      }}
    />,
  );
  return { actions, screen };
}

beforeEach(() => {
  navigateTo("a");
  mocks.router.navigate.mockClear();
  mocks.dispatch.mockReset();
  mocks.dispatch.mockResolvedValue(undefined);
  mocks.confirm.mockReset().mockResolvedValue(true);
  mocks.readApi.mockReset().mockReturnValue({ orchestration: { dispatchCommand: mocks.dispatch } });
  mocks.workspace = { environmentId: "fixture" };
  mocks.clear.mockClear();
  mocks.refreshArchived.mockClear();
  mocks.refreshDeleted.mockClear();
  mocks.fallback = "b";
  for (const thread of mocks.threads) {
    thread.session = null;
    thread.error = null;
    thread.latestTurn = null;
    thread.modelSelection = { instanceId: "codex-personal", model: "gpt-6.1-sol" };
  }
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("delete acknowledgement navigation ownership", () => {
  it.each(["another chat", "another environment", "away and back"])(
    "preserves a later selection of %s while still deleting only the captured chat",
    async (selection) => {
      const { actions, screen } = await mountActions();
      try {
        const acknowledge = holdCommand();
        const pending = actions.deleteThread(target);
        expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ type: "thread.delete", threadId: "a" }),
        );
        if (selection === "another environment") navigateTo("a", "other");
        else {
          navigateTo("c");
          if (selection === "away and back") navigateTo("a");
        }
        acknowledge();
        await pending;
        expect(mocks.router.navigate).not.toHaveBeenCalled();
        expect(mocks.clear).toHaveBeenCalledExactlyOnceWith(target);
        expect(mocks.refreshDeleted).toHaveBeenCalledWith(target.environmentId);
        expect(mocks.dispatch).toHaveBeenCalledOnce();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("does not revive navigation authority after its action surface unmounts", async () => {
    const { actions, screen } = await mountActions();
    const acknowledge = holdCommand();
    const pending = actions.deleteThread(target);
    await screen.unmount();
    const replacement = await mountActions();
    try {
      acknowledge();
      await pending;
      expect(mocks.router.navigate).not.toHaveBeenCalled();
      expect(mocks.clear).toHaveBeenCalledExactlyOnceWith(target);
    } finally {
      await replacement.screen.unmount();
    }
  });

  it("captures navigation before waiting for the original session to stop", async () => {
    const { actions, screen } = await mountActions();
    try {
      mocks.threads[0]!.session = { status: "ready" };
      const acknowledgeStop = holdCommand();
      const pending = actions.deleteThread(target);
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "thread.session.stop", threadId: "a" }),
      );
      navigateTo("c");
      navigateTo("a");
      acknowledgeStop();
      await pending;
      expect(mocks.dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "thread.delete", threadId: "a" }),
      );
      expect(mocks.router.navigate).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it.each(["b", null])(
    "navigates normally when the original route still owns deletion (%s)",
    async (fallback) => {
      const { actions, screen } = await mountActions();
      try {
        mocks.fallback = fallback;
        const acknowledge = holdCommand();
        const pending = actions.deleteThread(target);
        acknowledge();
        await pending;
        expect(mocks.router.navigate).toHaveBeenCalledExactlyOnceWith(
          fallback
            ? {
                to: "/$environmentId/$threadId",
                params: { environmentId: "fixture", threadId: fallback },
                replace: true,
              }
            : { to: "/", replace: true },
        );
      } finally {
        await screen.unmount();
      }
    },
  );
});

function markHistoryBlocked() {
  mocks.threads[0]!.error = CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE;
  mocks.threads[0]!.session = {
    provider: "codex",
    providerInstanceId: "codex-personal",
    status: "error",
    subagentRuntimeId: "native-runtime-a",
  };
}
function holdConfirmation() {
  let respond!: (accepted: boolean) => void;
  mocks.confirm.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      respond = resolve;
    }),
  );
  return respond;
}

describe("explicit poisoned-history continuation", () => {
  it("binds repeated chat IDs to the selected remote workspace and its transport", async () => {
    markHistoryBlocked();
    const remote = { ...mocks.threads[0]!, environmentId: "remote", title: "Remote chat" };
    mocks.threads.push(remote);
    mocks.workspace = { environmentId: "remote" };
    navigateTo("a", "remote");
    const remoteDispatch = vi.fn(async (_command: unknown) => {});
    mocks.readApi.mockImplementation((environmentId: string) => ({
      orchestration: {
        dispatchCommand: environmentId === "remote" ? remoteDispatch : mocks.dispatch,
      },
    }));
    const { actions, screen } = await mountActions();
    try {
      await actions.continueInNewChat(
        { ...target, environmentId: EnvironmentId.make("remote") },
        () => true,
      );
      expect(remoteDispatch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          type: "thread.duplicate",
          sourceThreadId: "a",
          title: "Remote chat (continued)",
        }),
      );
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.readApi).toHaveBeenCalledExactlyOnceWith("remote");
      expect(mocks.router.navigate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          params: expect.objectContaining({ environmentId: "remote" }),
        }),
      );
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
      mocks.threads.pop();
    }
  });

  it("confirms a visible-history copy without a native fork, inference, or draft mutation", async () => {
    markHistoryBlocked();
    const { actions, screen } = await mountActions();
    try {
      await actions.continueInNewChat(target, () => true);
      expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("No prompt is sent automatically"),
      );
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.stringContaining("original chat and workspace files remain unchanged"),
      );
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.stringContaining("hidden native history is not copied"),
      );
      expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining("new empty workspace"));
      expect(mocks.dispatch).toHaveBeenCalledOnce();
      const command = mocks.dispatch.mock.calls[0]![0];
      expect(command).toMatchObject({ type: "thread.duplicate", sourceThreadId: "a" });
      expect(command.targetThreadId).not.toBe("a");
      expect(mocks.router.navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: "fixture", threadId: command.targetThreadId },
      });
      expect(mocks.readApi).toHaveBeenCalledExactlyOnceWith(target.environmentId);
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("cancellation and a second gesture during confirmation cannot create a chat", async () => {
    markHistoryBlocked();
    const { actions, screen } = await mountActions();
    try {
      const respond = holdConfirmation();
      const pending = actions.continueInNewChat(target, () => true);
      await actions.continueInNewChat(target, () => true);
      expect(mocks.confirm).toHaveBeenCalledOnce();
      respond(false);
      await pending;
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.router.navigate).not.toHaveBeenCalled();
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    "another chat",
    "away and back",
    "workspace",
    "account",
    "runtime",
    "new work",
    "pending turn",
    "error cleared",
    "inactive pane",
  ])("rejects confirmation after ownership changes: %s", async (change) => {
    markHistoryBlocked();
    const { actions, screen } = await mountActions();
    let foreground = true;
    try {
      const respond = holdConfirmation();
      const pending = actions.continueInNewChat(target, () => foreground);
      expect(mocks.confirm).toHaveBeenCalledOnce();
      if (change === "another chat") navigateTo("b");
      if (change === "away and back") {
        navigateTo("b");
        navigateTo("a");
      }
      if (change === "workspace") mocks.workspace = { environmentId: "remote" };
      if (change === "account")
        mocks.threads[0] = {
          ...mocks.threads[0]!,
          modelSelection: { instanceId: "codex-other", model: "gpt-6.1-sol" },
        };
      if (change === "runtime")
        mocks.threads[0] = {
          ...mocks.threads[0]!,
          session: { ...mocks.threads[0]!.session!, subagentRuntimeId: "replacement-runtime" },
        };
      if (change === "new work")
        mocks.threads[0] = {
          ...mocks.threads[0]!,
          session: { ...mocks.threads[0]!.session!, status: "running", activeTurnId: "new-turn" },
        };
      if (change === "pending turn")
        mocks.threads[0] = { ...mocks.threads[0]!, latestTurn: { completedAt: null } };
      if (change === "error cleared") mocks.threads[0] = { ...mocks.threads[0]!, error: null };
      if (change === "inactive pane") foreground = false;
      respond(true);
      await pending;
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.router.navigate).not.toHaveBeenCalled();
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it.each(["another chat", "another workspace", "away and back", "account"])(
    "keeps a committed copy without taking over later %s selection",
    async (change) => {
      markHistoryBlocked();
      const { actions, screen } = await mountActions();
      try {
        const acknowledge = holdCommand();
        const pending = actions.continueInNewChat(target, () => true);
        await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
        if (change === "another chat") navigateTo("b");
        if (change === "away and back") {
          navigateTo("b");
          navigateTo("a");
        }
        if (change === "another workspace") mocks.workspace = { environmentId: "remote" };
        if (change === "account")
          mocks.threads[0] = {
            ...mocks.threads[0]!,
            modelSelection: { instanceId: "codex-other", model: "gpt-6.1-sol" },
          };
        acknowledge();
        await pending;
        expect(mocks.dispatch).toHaveBeenCalledOnce();
        expect(mocks.router.navigate).not.toHaveBeenCalled();
        expect(mocks.clear).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    },
  );

  it.each(["confirmation", "acknowledgement"])("retires unmounted %s authority", async (phase) => {
    markHistoryBlocked();
    const { actions, screen } = await mountActions();
    const respond = phase === "confirmation" ? holdConfirmation() : null;
    const acknowledge = phase === "acknowledgement" ? holdCommand() : null;
    const pending = actions.continueInNewChat(target, () => true);
    if (acknowledge) await vi.waitFor(() => expect(mocks.dispatch).toHaveBeenCalledOnce());
    await screen.unmount();
    respond?.(true);
    acknowledge?.();
    await pending;
    expect(mocks.dispatch).toHaveBeenCalledTimes(acknowledge ? 1 : 0);
    expect(mocks.router.navigate).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("explicit retry after an uncertain response reuses the exact copy command", async () => {
    markHistoryBlocked();
    const { actions, screen } = await mountActions();
    try {
      mocks.dispatch.mockRejectedValueOnce(new Error("synthetic transport lost after admission"));
      await expect(actions.continueInNewChat(target, () => true)).rejects.toThrow("transport lost");
      expect(mocks.router.navigate).not.toHaveBeenCalled();
      await actions.continueInNewChat(target, () => true);
      expect(mocks.confirm).toHaveBeenCalledTimes(2);
      expect(mocks.dispatch.mock.calls[1]![0]).toBe(mocks.dispatch.mock.calls[0]![0]);
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("reuses an acknowledged copy if its first navigation fails", async () => {
    markHistoryBlocked();
    const { actions, screen } = await mountActions();
    try {
      mocks.router.navigate.mockRejectedValueOnce(new Error("synthetic navigation failure"));
      await expect(actions.continueInNewChat(target, () => true)).rejects.toThrow(
        "navigation failure",
      );
      await actions.continueInNewChat(target, () => true);
      expect(mocks.dispatch.mock.calls[1]![0]).toBe(mocks.dispatch.mock.calls[0]![0]);
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it.each(["ordinary error", "lookalike text", "wrong provider", "different workspace"])(
    "does not offer mutation authority for %s",
    async (condition) => {
      markHistoryBlocked();
      const { actions, screen } = await mountActions();
      try {
        if (condition === "ordinary error") mocks.threads[0]!.error = "Bad Request";
        if (condition === "lookalike text") mocks.threads[0]!.error += " extra untrusted text";
        if (condition === "wrong provider")
          mocks.threads[0]!.session = { ...mocks.threads[0]!.session!, provider: "claudeAgent" };
        if (condition === "different workspace") mocks.workspace = { environmentId: "remote" };
        await actions.continueInNewChat(target, () => true);
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.dispatch).not.toHaveBeenCalled();
        expect(mocks.router.navigate).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    },
  );
});
