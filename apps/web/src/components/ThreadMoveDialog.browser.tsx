import "../index.css";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@cafecode/contracts";
import { afterEach, beforeEach, expect, it, vi, type TestContext } from "vitest";
import { render } from "vitest-browser-react";
import type { Project, SidebarThreadSummary } from "../types";
import { openThreadMoveDialog, useThreadMoveDialogStore } from "../threadMoveDialogStore";
import { ThreadMoveDialogHost } from "./ThreadMoveDialog";

const mocks = vi.hoisted(() => ({
  state: { threads: [] as SidebarThreadSummary[], projects: [] as Project[] },
  listeners: new Set<() => void>(),
  dispatch: vi.fn<(command: ClientOrchestrationCommand) => Promise<void>>(),
  readApi: vi.fn(),
  supported: true,
}));
vi.mock("../environmentApi", () => ({ readEnvironmentApi: mocks.readApi }));
vi.mock("../lib/standaloneChats", () => ({ supportsStandaloneChats: () => mocks.supported }));
vi.mock("../store", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => {
      mocks.listeners.delete(listener);
    };
  };
  return {
    useStore: Object.assign(
      (select: (state: typeof mocks.state) => unknown) =>
        useSyncExternalStore(subscribe, () => select(mocks.state)),
      { getState: () => mocks.state },
    ),
    selectSidebarThreadSummaryByRef: (
      state: typeof mocks.state,
      ref: { environmentId: string; threadId: string },
    ) =>
      state.threads.find(
        (thread) => thread.id === ref.threadId && thread.environmentId === ref.environmentId,
      ),
    selectProjectsForEnvironment: (state: typeof mocks.state, environmentId: string) =>
      state.projects.filter((project) => project.environmentId === environmentId),
  };
});

const environmentId = EnvironmentId.make("move-fixture");
const source: SidebarThreadSummary = {
  environmentId,
  id: ThreadId.make("source"),
  projectId: null,
  title: "Existing conversation",
  interactionMode: "default",
  session: null,
  createdAt: "2026-11-14T00:00:00Z",
  archivedAt: null,
  latestTurn: null,
  branch: null,
  worktreePath: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
const ref = { environmentId, threadId: source.id };
const project: Project = {
  environmentId,
  id: ProjectId.make("destination"),
  name: "Target project",
  cwd: "/fixture/target",
  defaultModelSelection: null,
  scripts: [],
};
const api = { orchestration: { dispatchCommand: mocks.dispatch } };
function update(state: typeof mocks.state) {
  mocks.state = state;
  for (const listener of mocks.listeners) listener();
}
let ownedCleanup: (() => Promise<void>) | null = null;

/** Register retirement before rendering, release exact held dispatches and join
 * native input before unmounting and before shared store/mock cleanup. */
function fixture(context: TestContext) {
  let retired = false;
  let mounting: ReturnType<typeof render> | undefined;
  let completion: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const releases = new Set<() => void>();
  const cleanup = () => {
    retired = true;
    for (const release of releases) release();
    return (completion ??= Promise.resolve().then(async () => {
      await Promise.allSettled([...pending]);
      const screen = await mounting?.catch(() => null);
      await screen?.unmount();
      context.signal.removeEventListener("abort", retire);
    }));
  };
  const retire = () => {
    void cleanup();
  };
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(cleanup);
  ownedCleanup = cleanup;
  if (context.signal.aborted) retire();
  return {
    async mount() {
      if (retired) throw new Error("Move fixture retired");
      openThreadMoveDialog(ref);
      mounting = render(<ThreadMoveDialogHost />);
      const screen = await mounting;
      if (retired) {
        await cleanup();
        throw new Error("Move fixture retired");
      }
      return screen;
    },
    async run<T>(operation: () => Promise<T>) {
      if (retired) throw new Error("Move fixture retired");
      const result = operation();
      pending.add(result);
      try {
        return await result;
      } finally {
        pending.delete(result);
      }
    },
    holdDispatch() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      releases.add(release);
      pending.add(promise);
      mocks.dispatch.mockReturnValue(promise);
      return release;
    },
  };
}

beforeEach(() => {
  mocks.dispatch.mockReset().mockResolvedValue(undefined);
  mocks.readApi.mockReset().mockReturnValue(api);
  mocks.supported = true;
  update({ threads: [{ ...source }], projects: [{ ...project }] });
});
afterEach(async () => {
  const cleanup = ownedCleanup;
  ownedCleanup = null;
  await cleanup?.();
  const target = useThreadMoveDialogStore.getState().target;
  if (target) useThreadMoveDialogStore.getState().close(target);
  mocks.listeners.clear();
});

it("moves the exact saved standalone chat only after an explicit confirmation", async (context) => {
  const owner = fixture(context);
  const release = owner.holdDispatch();
  const screen = await owner.mount();
  await expect
    .element(screen.getByText('Choose a project for "Existing conversation".'))
    .toBeVisible();
  expect(mocks.dispatch).not.toHaveBeenCalled();
  await owner.run(() => screen.getByRole("button", { name: "Move", exact: true }).click());
  await expect.element(screen.getByRole("button", { name: "Moving…" })).toBeDisabled();
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: "thread.meta.update",
    commandId: expect.any(String),
    threadId: source.id,
    projectId: project.id,
    worktreePath: null,
  });
  release();
  await expect.poll(() => useThreadMoveDialogStore.getState().target).toBeNull();
});

it("cancels without changing the chat", async (context) => {
  const owner = fixture(context),
    screen = await owner.mount();
  await owner.run(() => screen.getByRole("button", { name: "Cancel", exact: true }).click());
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(mocks.state.threads[0]!.projectId).toBeNull();
});

it("lets the person choose another project without exposing foreign-environment destinations", async (context) => {
  const owner = fixture(context);
  const second = {
    ...project,
    id: ProjectId.make("second"),
    name: "Second project",
    cwd: "/fixture/second",
  };
  const foreign = {
    ...project,
    environmentId: EnvironmentId.make("foreign"),
    name: "Foreign project",
  };
  update({ ...mocks.state, projects: [project, second, foreign] });
  const screen = await owner.mount();
  await owner.run(() =>
    screen.getByRole("combobox", { name: "Destination project folder" }).click(),
  );
  await expect
    .element(screen.getByRole("option", { name: /Foreign project/ }))
    .not.toBeInTheDocument();
  await owner.run(() => screen.getByRole("option", { name: /Second project/ }).click());
  await owner.run(() => screen.getByRole("button", { name: "Move", exact: true }).click());
  expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ threadId: source.id, projectId: second.id }),
  );
});

it("keeps unsupported standalone servers unavailable", async (context) => {
  const owner = fixture(context);
  mocks.supported = false;
  const screen = await owner.mount();
  await expect.element(screen.getByRole("button", { name: "Move", exact: true })).toBeDisabled();
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it("rechecks standalone support at the actual move", async (context) => {
  const owner = fixture(context),
    screen = await owner.mount();
  mocks.supported = false;
  await owner.run(() => screen.getByRole("button", { name: "Move", exact: true }).click());
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("The chat or destination changed. Close this dialog and try again.");
  expect(mocks.dispatch).not.toHaveBeenCalled();
});

it.for(["busy", "changed project", "destination removed", "missing chat"] as const)(
  "refuses a move after %s",
  async (change, context) => {
    const owner = fixture(context),
      screen = await owner.mount();
    if (change === "busy")
      update({ ...mocks.state, threads: [{ ...source, hasPendingApprovals: true }] });
    if (change === "changed project")
      update({ ...mocks.state, threads: [{ ...source, projectId: ProjectId.make("elsewhere") }] });
    if (change === "destination removed") update({ ...mocks.state, projects: [] });
    if (change === "missing chat") update({ ...mocks.state, threads: [] });
    await expect.element(screen.getByRole("button", { name: "Move", exact: true })).toBeDisabled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  },
);

it("rechecks exact transport identity before dispatch", async (context) => {
  const owner = fixture(context),
    screen = await owner.mount();
  const replacementDispatch = vi.fn();
  mocks.readApi.mockReturnValue({ orchestration: { dispatchCommand: replacementDispatch } });
  await owner.run(() => screen.getByRole("button", { name: "Move", exact: true }).click());
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("The chat or destination changed. Close this dialog and try again.");
  expect(mocks.dispatch).not.toHaveBeenCalled();
  expect(replacementDispatch).not.toHaveBeenCalled();
});

it("reports an opaque failure without changing the source or automatically retrying", async (context) => {
  const owner = fixture(context);
  mocks.dispatch.mockRejectedValue(new Error("private-fixture-error"));
  const screen = await owner.mount();
  await owner.run(() => screen.getByRole("button", { name: "Move", exact: true }).click());
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(
      "Could not move chat. Check its connection and current activity before trying again.",
    );
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  expect(mocks.state.threads[0]!.projectId).toBeNull();
  await expect.element(screen.getByText("private-fixture-error")).not.toBeInTheDocument();
});

it("does not close a replacement chooser when an earlier move completes", async (context) => {
  const owner = fixture(context),
    release = owner.holdDispatch();
  const screen = await owner.mount();
  await owner.run(() => screen.getByRole("button", { name: "Move", exact: true }).click());
  await expect.element(screen.getByRole("button", { name: "Moving…" })).toBeDisabled();
  await owner.run(() => screen.getByRole("button", { name: "Cancel", exact: true }).click());
  const next = { ...source, id: ThreadId.make("next"), title: "Another conversation" };
  update({ ...mocks.state, threads: [...mocks.state.threads, next] });
  openThreadMoveDialog({ environmentId, threadId: next.id });
  const target = useThreadMoveDialogStore.getState().target;
  release();
  await expect
    .element(screen.getByText('Choose a project for "Another conversation".'))
    .toBeVisible();
  expect(useThreadMoveDialogStore.getState().target).toBe(target);
});
