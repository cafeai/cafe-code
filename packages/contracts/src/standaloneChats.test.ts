import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  ClientOrchestrationCommand,
  OrchestrationRpcSchemas,
  OrchestrationShellSnapshot,
  OrchestrationSubscribeThreadInput,
  OrchestrationThread,
  OrchestrationThreadShell,
  ThreadCreatedPayload,
  ThreadMetaUpdatedPayload,
} from "./orchestration.ts";

const timestamp = "2026-10-03T04:00:00.000Z";
const createFields = {
  title: "A conversation without a folder",
  modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: timestamp,
};
const createCommand = {
  type: "thread.create",
  commandId: "standalone-create",
  threadId: "standalone-thread",
  projectId: null,
  ...createFields,
};
const shell = {
  id: "standalone-thread",
  projectId: null,
  ...createFields,
  latestTurn: null,
  updatedAt: timestamp,
  archivedAt: null,
  deletedAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

describe("standalone conversation contracts", () => {
  it.each([null, "existing-project"])(
    "round-trips explicit project association %s",
    (projectId) => {
      const decode = Schema.decodeUnknownSync(ClientOrchestrationCommand);
      const parsed = decode({ ...createCommand, projectId });
      expect(parsed.type).toBe("thread.create");
      if (parsed.type !== "thread.create") throw new Error("Unexpected command type");
      expect(parsed.projectId).toBe(projectId);
      expect(Schema.encodeSync(ClientOrchestrationCommand)(parsed)).toMatchObject({ projectId });
    },
  );

  it("does not turn a missing association into an implicit standalone or inherited project", () => {
    const { projectId: _association, ...missing } = createCommand;
    expect(() => Schema.decodeUnknownSync(ClientOrchestrationCommand)(missing)).toThrow();
  });

  it.each(["", 7, {}, []])("rejects malformed non-null project identity %j", (projectId) => {
    expect(() =>
      Schema.decodeUnknownSync(ClientOrchestrationCommand)({ ...createCommand, projectId }),
    ).toThrow();
  });

  it.each([null, "existing-project"])("keeps created-event replay association %s", (projectId) => {
    const decoded = Schema.decodeUnknownSync(ThreadCreatedPayload)({
      threadId: "standalone-thread",
      projectId,
      ...createFields,
      updatedAt: timestamp,
    });
    expect(decoded.projectId).toBe(projectId);
    expect(decoded.runtimeMode).toBe("approval-required");
    expect(Schema.encodeSync(ThreadCreatedPayload)(decoded).projectId).toBe(projectId);
  });

  it("decodes legacy linked creation without changing historical permission defaults", () => {
    const { runtimeMode: _mode, interactionMode: _interaction, ...legacy } = createFields;
    const decoded = Schema.decodeUnknownSync(ThreadCreatedPayload)({
      ...legacy,
      threadId: "old-thread",
      projectId: "old-project",
      updatedAt: timestamp,
    });
    expect(decoded.projectId).toBe("old-project");
    expect(decoded.runtimeMode).toBe("full-access");
  });

  it("preserves omitted, detached, and explicitly assigned update semantics", () => {
    const decode = Schema.decodeUnknownSync(ThreadMetaUpdatedPayload);
    const base = { threadId: "standalone-thread", title: "Renamed", updatedAt: timestamp };
    const unchanged = decode(base);
    const detached = decode({ ...base, projectId: null });
    const attached = decode({ ...base, projectId: "target-project" });
    expect(unchanged.projectId).toBeUndefined();
    expect(detached.projectId).toBeNull();
    expect(attached.projectId).toBe("target-project");
    expect(Schema.encodeSync(ThreadMetaUpdatedPayload)(unchanged)).not.toHaveProperty("projectId");
    expect(Schema.encodeSync(ThreadMetaUpdatedPayload)(detached)).toHaveProperty("projectId", null);
  });

  it.each([undefined, null, "target-project"])(
    "decodes metadata commands association %s",
    (projectId) => {
      const input = {
        type: "thread.meta.update",
        commandId: "rename-or-move",
        threadId: "standalone-thread",
        ...(projectId !== undefined ? { projectId } : {}),
        title: "Renamed",
      };
      const command = Schema.decodeUnknownSync(ClientOrchestrationCommand)(input);
      if (command.type !== "thread.meta.update") throw new Error("Unexpected command type");
      expect(command.projectId).toBe(projectId);
    },
  );

  it("admits standalone first-send bootstrap with the existing attachment envelope", () => {
    const command = Schema.decodeUnknownSync(ClientOrchestrationCommand)({
      type: "thread.turn.start",
      commandId: "standalone-first-send",
      threadId: "standalone-thread",
      message: { messageId: "first-message", role: "user", text: "Hello", attachments: [] },
      runtimeMode: "approval-required",
      interactionMode: "default",
      bootstrap: { createThread: { ...createFields, projectId: null } },
      createdAt: timestamp,
    });
    if (command.type !== "thread.turn.start") throw new Error("Unexpected command type");
    expect(command.bootstrap?.createThread?.projectId).toBeNull();
    expect(command.bootstrap?.prepareWorktree).toBeUndefined();
    expect(command.bootstrap?.runSetupScript).toBeUndefined();
  });

  it("keeps standalone shell and full detail identities without a sentinel project", () => {
    const decodedShell = Schema.decodeUnknownSync(OrchestrationThreadShell)(shell);
    const decodedThread = Schema.decodeUnknownSync(OrchestrationThread)({
      ...shell,
      messages: [],
      activities: [],
      checkpoints: [],
    });
    expect(decodedShell.projectId).toBeNull();
    expect(decodedThread.projectId).toBeNull();
    const snapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot)({
      snapshotSequence: 1,
      projects: [],
      threads: [shell],
      updatedAt: timestamp,
    });
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.threads).toHaveLength(1);
  });

  it("does not assume a legacy environment supports standalone conversations", () => {
    const descriptor = {
      environmentId: "environment-1",
      label: "Local",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0",
      capabilities: { repositoryIdentity: true },
    };
    const decode = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
    expect(decode(descriptor).capabilities.standaloneChats).toBeUndefined();
    expect(
      decode({ ...descriptor, capabilities: { standaloneChats: true } }).capabilities
        .standaloneChats,
    ).toBe(true);
    expect(
      decode({ ...descriptor, capabilities: { standaloneChats: false } }).capabilities
        .standaloneChats,
    ).toBe(false);
  });

  it("retains opt-in absence on legacy catalog and thread requests", () => {
    for (const schema of [
      OrchestrationRpcSchemas.subscribeShell.input,
      OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
      OrchestrationRpcSchemas.getDeletedShellSnapshot.input,
    ]) {
      const decode = Schema.decodeUnknownSync(schema);
      expect(decode({})).toEqual({});
      expect(decode({ includeStandaloneChats: true })).toEqual({ includeStandaloneChats: true });
      expect(() => decode({ includeStandaloneChats: "true" })).toThrow();
    }
    expect(
      Schema.decodeUnknownSync(OrchestrationSubscribeThreadInput)({ threadId: "linked" }),
    ).toEqual({ threadId: "linked" });
    expect(
      Schema.decodeUnknownSync(OrchestrationRpcSchemas.replayEvents.input)({
        fromSequenceExclusive: 0,
      }),
    ).toEqual({ fromSequenceExclusive: 0 });
  });
});
