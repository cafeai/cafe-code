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
  desk: { revision: 0 },
  summaryUnavailable: false,
  summaryOverrides: {} as Record<string, unknown>,
  toast: vi.fn(),
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
      orchestrationStatus?: string;
      createdAt?: string;
      updatedAt?: string;
    } | null,
    modelSelection: { instanceId: "codex-personal", model: "gpt-6.1-sol" },
    createdAt: "2026-10-07T00:00:00.000Z",
    codexThreadId: "native-a",
    error: null as string | null,
    archivedAt: null,
    latestTurn: null as {
      completedAt: string | null;
      startedAt?: string | null;
      turnId?: string;
    } | null,
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
vi.mock("../deskStore", () => ({
  useDeskStore: { getState: () => ({ desk: mocks.desk }) },
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
  selectSidebarThreadSummaryByRef: (
    _store: unknown,
    ref: { environmentId: string; threadId: string },
  ) => {
    if (mocks.summaryUnavailable) return undefined;
    const thread = mocks.threads.find(
      (candidate) => candidate.id === ref.threadId && candidate.environmentId === ref.environmentId,
    );
    return thread
      ? {
          ...thread,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          ...mocks.summaryOverrides,
        }
      : undefined;
  },
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
  toastManager: { add: mocks.toast },
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
  mocks.desk = { revision: 0 };
  mocks.summaryUnavailable = false;
  mocks.summaryOverrides = {};
  mocks.toast.mockClear();
  mocks.clear.mockClear();
  mocks.refreshArchived.mockClear();
  mocks.refreshDeleted.mockClear();
  mocks.fallback = "b";
  mocks.threads.splice(3);
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

/** Each case owns a fresh source identity. Production deliberately has no
 * registry reset that could discard an uncertain native fork's stable receipt.
 * The fixture must not make later tests depend on clearing such a receipt.
 */
function duplicationSource(provider = "codex", environmentId = "fixture") {
  const source: (typeof mocks.threads)[number] = {
    ...mocks.threads[0]!,
    id: crypto.randomUUID(),
    environmentId,
    title: "Reusable source",
    session: {
      provider,
      providerInstanceId: "codex-personal",
      subagentRuntimeId: "duplication-runtime",
      status: "ready",
      orchestrationStatus: "ready",
      createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:01:00.000Z",
    },
    latestTurn: {
      turnId: "completed-source-turn",
      startedAt: "2026-10-15T00:00:00.000Z",
      completedAt: "2026-10-15T00:01:00.000Z",
    },
  };
  mocks.threads.push(source);
  return {
    source,
    ref: {
      environmentId: EnvironmentId.make(environmentId),
      threadId: ThreadId.make(source.id),
    },
  };
}

describe("shared provider-native chat duplication", () => {
  it.each(["codex", "claudeAgent"])(
    "copies the exact clicked %s chat through its own environment without a prompt or source mutation",
    async (provider) => {
      const { source, ref } = duplicationSource(provider, "remote");
      source.title = "A".repeat(300);
      // The active route intentionally belongs to another environment/chat.
      // The menu's captured scope, not the selected route, owns the copy.
      const original = structuredClone(source);
      const remoteDispatch = vi.fn(async (_command: unknown) => {});
      const remoteApi = { orchestration: { dispatchCommand: remoteDispatch } };
      mocks.readApi.mockImplementation((environmentId: string) =>
        environmentId === "remote"
          ? remoteApi
          : { orchestration: { dispatchCommand: mocks.dispatch } },
      );
      const { actions, screen } = await mountActions();
      try {
        await actions.duplicateThread(ref);
        expect(remoteDispatch).toHaveBeenCalledOnce();
        const command = remoteDispatch.mock.calls[0]![0] as {
          type: string;
          commandId: string;
          sourceThreadId: string;
          targetThreadId: string;
          title: string;
          createdAt: string;
        };
        expect(command).toEqual({
          type: "thread.fork",
          commandId: expect.any(String),
          sourceThreadId: source.id,
          targetThreadId: expect.any(String),
          title: `${"A".repeat(180)} (copy)`,
          createdAt: expect.any(String),
        });
        expect(command.targetThreadId).not.toBe(source.id);
        expect(command.commandId).not.toBe(command.targetThreadId);
        expect(Number.isFinite(Date.parse(command.createdAt))).toBe(true);
        expect(mocks.readApi.mock.calls).toEqual([["remote"], ["remote"]]);
        expect(mocks.dispatch).not.toHaveBeenCalled();
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.router.navigate).toHaveBeenCalledExactlyOnceWith({
          to: "/$environmentId/$threadId",
          params: { environmentId: "remote", threadId: command.targetThreadId },
        });
        // Account/model/options, history, context and workspace settings are
        // copied by the established server/native snapshot, not fabricated by
        // this renderer command. Exact shape above forbids a turn or fallback.
        expect(source).toEqual(original);
        expect(mocks.clear).not.toHaveBeenCalled();
        expect(mocks.toast).not.toHaveBeenCalled();
      } finally {
        await screen.unmount();
      }
    },
  );

  it("admits only one command across two mounted action surfaces while acknowledgement is pending", async () => {
    const { ref } = duplicationSource();
    const first = await mountActions();
    const second = await mountActions();
    const acknowledge = holdCommand();
    let pending: Promise<void> | undefined;
    try {
      pending = first.actions.duplicateThread(ref);
      expect(mocks.dispatch).toHaveBeenCalledOnce();
      await second.actions.duplicateThread(ref);
      expect(mocks.dispatch).toHaveBeenCalledOnce();
      expect(mocks.router.navigate).not.toHaveBeenCalled();
      acknowledge();
      await pending;
      expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: "thread.fork", sourceThreadId: ref.threadId }),
      );
      expect(mocks.router.navigate).toHaveBeenCalledOnce();
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      acknowledge();
      await pending;
      await first.screen.unmount();
      await second.screen.unmount();
    }
  });

  it.each([
    "unsupported provider",
    "unsupported Axiom provider",
    "missing session",
    "missing source",
    "running",
    "connecting",
    "active turn",
    "unsettled turn",
    "unstarted turn",
    "missing turn",
    "archived",
    "account mismatch",
    "pending approval",
    "pending question",
    "current child work",
    "missing shell",
    "busy shell",
  ])("re-reads current source and shell admission before copying: %s", async (condition) => {
    const { source, ref } = duplicationSource();
    const { actions, screen } = await mountActions();
    try {
      if (condition === "unsupported provider") source.session!.provider = "grok";
      if (condition === "unsupported Axiom provider") source.session!.provider = "axiom";
      if (condition === "missing session") source.session = null;
      if (condition === "missing source") mocks.threads.splice(mocks.threads.indexOf(source), 1);
      if (condition === "running") source.session!.status = "running";
      if (condition === "connecting") source.session!.status = "connecting";
      if (condition === "active turn") source.session!.activeTurnId = "new-turn";
      if (condition === "unsettled turn") source.latestTurn!.completedAt = null;
      if (condition === "unstarted turn") source.latestTurn!.startedAt = null;
      if (condition === "missing turn") source.latestTurn = null;
      if (condition === "archived")
        Object.assign(source, { archivedAt: "2026-10-15T00:02:00.000Z" });
      if (condition === "account mismatch") source.session!.providerInstanceId = "other-account";
      if (condition === "pending approval") mocks.summaryOverrides = { hasPendingApprovals: true };
      if (condition === "pending question") mocks.summaryOverrides = { hasPendingUserInput: true };
      if (condition === "current child work")
        mocks.summaryOverrides = {
          liveWork: { runtimeId: "duplication-runtime", taskCount: 1, agentCount: 0 },
        };
      if (condition === "missing shell") mocks.summaryUnavailable = true;
      if (condition === "busy shell")
        mocks.summaryOverrides = { session: { ...source.session!, status: "running" } };
      await actions.duplicateThread(ref);
      expect(mocks.readApi).not.toHaveBeenCalled();
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.router.navigate).not.toHaveBeenCalled();
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("refuses a disconnected exact environment without falling back to the selected environment", async () => {
    const { ref } = duplicationSource("codex", "offline");
    mocks.readApi.mockReturnValue(undefined);
    const { actions, screen } = await mountActions();
    try {
      await actions.duplicateThread(ref);
      expect(mocks.readApi).toHaveBeenCalledExactlyOnceWith("offline");
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(mocks.router.navigate).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: "error", title: "Could not duplicate chat" }),
      );
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps opaque failures private and reuses the exact uncertain command from another mounted hook", async () => {
    const { ref } = duplicationSource();
    const first = await mountActions();
    const second = await mountActions();
    const warning = vi.spyOn(console, "warn");
    try {
      mocks.dispatch.mockRejectedValueOnce(new Error("private-provider-credential-fixture"));
      await first.actions.duplicateThread(ref);
      expect(mocks.dispatch).toHaveBeenCalledOnce();
      expect(mocks.dispatch.mock.calls[0]![0].type).toBe("thread.fork");
      expect(mocks.router.navigate).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: "error", title: "Could not duplicate chat" }),
      );
      expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain("private-provider");
      expect(warning).not.toHaveBeenCalled();
      await second.actions.duplicateThread(ref);
      expect(mocks.dispatch).toHaveBeenCalledTimes(2);
      expect(mocks.dispatch.mock.calls[1]![0]).toBe(mocks.dispatch.mock.calls[0]![0]);
      expect(mocks.router.navigate).toHaveBeenCalledOnce();
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      await first.screen.unmount();
      await second.screen.unmount();
    }
  });

  it("reports a committed copy with failed navigation without suggesting another duplication", async () => {
    const { source, ref } = duplicationSource();
    const original = structuredClone(source);
    const { actions, screen } = await mountActions();
    const warning = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    try {
      mocks.router.navigate.mockRejectedValueOnce(new Error("private-router-diagnostic-fixture"));
      await actions.duplicateThread(ref);
      expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: "thread.fork", sourceThreadId: source.id }),
      );
      const command = mocks.dispatch.mock.calls[0]![0];
      expect(command.targetThreadId).not.toBe(source.id);
      expect(mocks.router.navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: ref.environmentId, threadId: command.targetThreadId },
      });
      expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({
        type: "warning",
        title: "Chat duplicated, but could not open it",
        description: "Open the copy from the chat list. Do not duplicate it again.",
      });
      expect(JSON.stringify(mocks.toast.mock.calls)).not.toContain("private-router");
      expect(warning).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(source).toEqual(original);
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      error.mockRestore();
      await screen.unmount();
    }
  });

  it("refuses a changed source after an uncertain outcome rather than minting a second native copy", async () => {
    const { source, ref } = duplicationSource();
    const { actions, screen } = await mountActions();
    try {
      mocks.dispatch.mockRejectedValueOnce(new Error("synthetic lost acknowledgement"));
      await actions.duplicateThread(ref);
      source.title = "A later source revision";
      await actions.duplicateThread(ref);
      expect(mocks.dispatch).toHaveBeenCalledOnce();
      expect(mocks.router.navigate).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalledTimes(2);
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    "another route",
    "away and back",
    "workspace",
    "desk pane",
    "desk away and back",
    "environment connection",
    "source model",
    "selected account",
    "native account",
    "native runtime",
  ])("preserves a completed copy without stealing later %s navigation", async (change) => {
    const { source, ref } = duplicationSource();
    const { actions, screen } = await mountActions();
    const acknowledge = holdCommand();
    let pending: Promise<void> | undefined;
    try {
      pending = actions.duplicateThread(ref);
      expect(mocks.dispatch).toHaveBeenCalledOnce();
      if (change === "another route") navigateTo("b");
      if (change === "away and back") {
        navigateTo("b");
        navigateTo("a");
      }
      if (change === "workspace") mocks.workspace = { environmentId: "other" };
      if (change === "desk pane") mocks.desk = { revision: 1 };
      if (change === "desk away and back") {
        mocks.desk = { revision: 1 };
        mocks.desk = { revision: 0 };
      }
      if (change === "environment connection")
        mocks.readApi.mockReturnValue({ orchestration: { dispatchCommand: mocks.dispatch } });
      if (change === "source model")
        source.modelSelection = { ...source.modelSelection, model: "later-model" };
      // An instance ID is scalar ownership as well as part of the selection
      // object. Mutating it here independently qualifies the captured scalar
      // fence instead of relying only on immutable-object replacement.
      if (change === "selected account") source.modelSelection.instanceId = "later-account";
      if (change === "native account")
        source.session = { ...source.session!, providerInstanceId: "later-account" };
      if (change === "native runtime")
        source.session = { ...source.session!, subagentRuntimeId: "later-native-runtime" };
      acknowledge();
      await pending;
      expect(mocks.dispatch).toHaveBeenCalledOnce();
      expect(mocks.router.navigate).not.toHaveBeenCalled();
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      acknowledge();
      await pending;
      await screen.unmount();
    }
  });

  it("does not revive an unmounted action owner's navigation after a new surface mounts", async () => {
    const { ref } = duplicationSource();
    const first = await mountActions();
    const acknowledge = holdCommand();
    const pending = first.actions.duplicateThread(ref);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    await first.screen.unmount();
    const replacement = await mountActions();
    try {
      acknowledge();
      await pending;
      expect(mocks.dispatch).toHaveBeenCalledOnce();
      expect(mocks.router.navigate).not.toHaveBeenCalled();
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      acknowledge();
      await pending;
      await replacement.screen.unmount();
    }
  });
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
