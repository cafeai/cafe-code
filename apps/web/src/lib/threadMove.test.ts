import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import type { Project, SidebarThreadSummary } from "../types";
import { canMoveThread, threadMoveCandidates } from "./threadMove";
import { openThreadMoveDialog, useThreadMoveDialogStore } from "../threadMoveDialogStore";

const environmentId = EnvironmentId.make("local");
const source: SidebarThreadSummary = {
  environmentId,
  id: ThreadId.make("chat"),
  projectId: null,
  title: "Chat",
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
const session: NonNullable<SidebarThreadSummary["session"]> = {
  provider: ProviderDriverKind.make("codex"),
  status: "ready",
  orchestrationStatus: "ready",
  createdAt: source.createdAt,
  updatedAt: source.createdAt,
  subagentRuntimeId: "runtime",
};
function project(id: string, name: string, owner = environmentId): Project {
  return {
    id: ProjectId.make(id),
    environmentId: owner,
    name,
    cwd: `/fixture/${id}`,
    defaultModelSelection: null,
    scripts: [],
  };
}

describe("chat project moves", () => {
  it("admits saved idle chats with or without an initialized provider or project", () => {
    expect(canMoveThread(source)).toBe(true);
    expect(canMoveThread({ ...source, session })).toBe(true);
    expect(canMoveThread({ ...source, projectId: ProjectId.make("old") })).toBe(true);
    expect(canMoveThread(undefined)).toBe(false);
  });

  it.each<Partial<SidebarThreadSummary>>([
    { archivedAt: source.createdAt },
    { session: { ...session, status: "running" } },
    { session: { ...session, status: "connecting" } },
    { session: { ...session, orchestrationStatus: "starting" } },
    { session: { ...session, orchestrationStatus: "running" } },
    { session: { ...session, activeTurnId: TurnId.make("unsettled") } },
    {
      latestTurn: {
        turnId: TurnId.make("accepted"),
        state: "running",
        requestedAt: source.createdAt,
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    },
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { session, liveWork: { runtimeId: "runtime", taskCount: 1, agentCount: 0 } },
    { session, liveWork: { runtimeId: "runtime", taskCount: 0, agentCount: 1 } },
  ])("refuses a busy, unresolved or archived source: %j", (fields) => {
    expect(canMoveThread({ ...source, ...fields })).toBe(false);
  });

  it("does not treat retired runtime work as current", () => {
    expect(
      canMoveThread({
        ...source,
        session,
        liveWork: { runtimeId: "retired", taskCount: 1, agentCount: 1 },
      }),
    ).toBe(true);
  });

  it("offers only other projects in the exact owning environment in stable name order", () => {
    const alpha = project("a", "Alpha"),
      beta = project("b", "Beta");
    const foreign = project("a", "Foreign", EnvironmentId.make("remote"));
    expect(threadMoveCandidates([beta, foreign, alpha], source)).toEqual([alpha, beta]);
    expect(
      threadMoveCandidates([beta, foreign, alpha], { ...source, projectId: alpha.id }),
    ).toEqual([beta]);
  });

  it("does not let an old chooser acknowledgement close its replacement", () => {
    const ref = { environmentId, threadId: source.id };
    openThreadMoveDialog(ref);
    const previous = useThreadMoveDialogStore.getState().target!;
    openThreadMoveDialog(ref);
    const current = useThreadMoveDialogStore.getState().target!;
    expect(previous.id).not.toBe(current.id);
    useThreadMoveDialogStore.getState().close(previous);
    expect(useThreadMoveDialogStore.getState().target).toBe(current);
    useThreadMoveDialogStore.getState().close(current);
    expect(useThreadMoveDialogStore.getState().target).toBeNull();
  });
});
