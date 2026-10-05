import { CommandId, EnvironmentId, ThreadId } from "@cafecode/contracts";
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
  dispatch: vi.fn<(command: { type: string; threadId: string }) => Promise<void>>(),
  clear: vi.fn(),
  refreshArchived: vi.fn(),
  refreshDeleted: vi.fn(),
  fallback: "b" as string | null,
  threads: ["a", "b", "c"].map((id) => ({
    id,
    environmentId: "fixture",
    projectId: null,
    session: null as { status: string } | null,
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
  readEnvironmentApi: () => ({ orchestration: { dispatchCommand: mocks.dispatch } }),
  ensureEnvironmentApi: vi.fn(),
}));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({ clearDraftThread: mocks.clear, clearProjectDraftThreadById: mocks.clear }),
}));
vi.mock("../lib/utils", () => ({
  newCommandId: () => CommandId.make(crypto.randomUUID()),
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
  readLocalApi: () => ({ dialogs: { confirm: vi.fn(async () => true) } }),
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
  mocks.clear.mockClear();
  mocks.refreshArchived.mockClear();
  mocks.refreshDeleted.mockClear();
  mocks.fallback = "b";
  for (const thread of mocks.threads) thread.session = null;
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
