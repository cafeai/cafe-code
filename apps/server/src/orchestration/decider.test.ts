import {
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { sessionLifecycleSnapshot, SESSION_LIFECYCLE_SUPERSEDED } from "./sessionLifecycle.ts";

const now = "2026-09-23T10:43:00.000Z";
const threadId = ThreadId.make("root-replacement-thread");
const oldRoot = TurnId.make("completed-root");
const newRoot = TurnId.make("replacement-root");
const instanceId = ProviderInstanceId.make("codex");
const decodeClientCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);

function makeThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("root-replacement-project"),
    title: "Root replacement",
    modelSelection: { instanceId, model: "gpt-6-astra" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: oldRoot,
      state: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId,
      status: "running",
      providerName: "codex",
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
      activeTurnId: oldRoot,
      lastError: null,
      updatedAt: now,
    },
  };
}

function makeCommand(): Extract<OrchestrationCommand, { type: "thread.session.set" }> {
  return {
    type: "thread.session.set",
    commandId: CommandId.make("server:root-replacement"),
    threadId,
    session: { ...makeThread().session!, activeTurnId: newRoot },
    codexRootReplacement: {
      expectedTurnId: oldRoot,
      providerInstanceId: instanceId,
      messageId: MessageId.make("saved-steer"),
      intentSequence: 10,
    },
    createdAt: now,
  };
}

function decide(
  thread = makeThread(),
  command = makeCommand(),
  codexRootReplacementVerified = true,
) {
  const readModel: OrchestrationReadModel = {
    snapshotSequence: 10,
    projects: [],
    threads: [thread],
    updatedAt: now,
  };
  return decideOrchestrationCommand({ command, readModel, codexRootReplacementVerified });
}

describe("Codex completed-root replacement admission", () => {
  it("admits the exact authorized replacement without persisting its admission guard", async () => {
    const event = await Effect.runPromise(decide());
    expect(event).toMatchObject({
      type: "thread.session-set",
      payload: { threadId, session: { activeTurnId: newRoot } },
    });
    expect(event).not.toHaveProperty("payload.codexRootReplacement");
  });

  it("fails closed without the engine's durable barrier verification", async () => {
    expect(
      await Effect.runPromise(Effect.exit(decide(makeThread(), makeCommand(), false))),
    ).toMatchObject({ _tag: "Failure" });
  });

  it.each([
    ["archived", (thread: OrchestrationThread) => ({ ...thread, archivedAt: now })],
    ["deleted", (thread: OrchestrationThread) => ({ ...thread, deletedAt: now })],
    ["missing session", (thread: OrchestrationThread) => ({ ...thread, session: null })],
    [
      "stopped",
      (thread: OrchestrationThread) => ({
        ...thread,
        session: { ...thread.session!, status: "stopped" as const, activeTurnId: null },
      }),
    ],
    [
      "newer root",
      (thread: OrchestrationThread) => ({
        ...thread,
        session: { ...thread.session!, activeTurnId: TurnId.make("newer-root") },
      }),
    ],
    [
      "newer latest turn",
      (thread: OrchestrationThread) => ({
        ...thread,
        latestTurn: { ...thread.latestTurn!, turnId: TurnId.make("newer-root") },
      }),
    ],
    [
      "changed provider",
      (thread: OrchestrationThread) => ({
        ...thread,
        session: { ...thread.session!, providerName: "claude" as const },
      }),
    ],
    [
      "changed instance",
      (thread: OrchestrationThread) => ({
        ...thread,
        session: { ...thread.session!, providerInstanceId: ProviderInstanceId.make("codex-other") },
      }),
    ],
  ] as const)("rejects %s even with matching timestamps", async (_label, mutate) => {
    expect(await Effect.runPromise(Effect.exit(decide(mutate(makeThread()))))).toMatchObject({
      _tag: "Failure",
    });
  });

  it.each([
    "client identity",
    "wrong thread",
    "wrong provider",
    "wrong instance",
    "same root",
    "no root",
  ] as const)("rejects an invalid replacement candidate: %s", async (variant) => {
    const command = makeCommand();
    const candidate = {
      ...command,
      ...(variant === "client identity" ? { commandId: CommandId.make("client-replacement") } : {}),
      session: {
        ...command.session,
        ...(variant === "wrong thread" ? { threadId: ThreadId.make("different-thread") } : {}),
        ...(variant === "wrong provider" ? { providerName: "claude" as const } : {}),
        ...(variant === "wrong instance"
          ? { providerInstanceId: ProviderInstanceId.make("different") }
          : {}),
        ...(variant === "same root" ? { activeTurnId: oldRoot } : {}),
        ...(variant === "no root" ? { activeTurnId: null } : {}),
      },
    };
    expect(await Effect.runPromise(Effect.exit(decide(makeThread(), candidate)))).toMatchObject({
      _tag: "Failure",
    });
  });

  it("does not expose session-set or replacement authority through the client command schema", () => {
    expect(() => decodeClientCommand(makeCommand())).toThrow();
  });
});

describe("Provider observation lifecycle admission", () => {
  function completionCommand() {
    const thread = makeThread();
    return {
      type: "thread.session.set" as const,
      commandId: CommandId.make("provider:observed-terminal"),
      threadId,
      expectedSessionLifecycle: sessionLifecycleSnapshot(thread.session),
      session: { ...thread.session!, status: "ready" as const, activeTurnId: null },
      // An authoritative provider completion may have an older clock than
      // Cafe's ACK. Equality of the observed state, not wall-clock order, owns
      // admission, so this legitimate terminal transition must remain valid.
      createdAt: "2026-09-23T10:42:59.000Z",
    };
  }

  it("accepts the unchanged lifecycle without persisting the server-only guard", async () => {
    const event = await Effect.runPromise(decide(makeThread(), completionCommand()));
    expect(event).toMatchObject({
      type: "thread.session-set",
      payload: { session: { status: "ready", activeTurnId: null } },
    });
    expect(event).not.toHaveProperty("payload.expectedSessionLifecycle");
    expect(() => decodeClientCommand(completionCommand())).toThrow();
  });

  it("allows the exact active turn to finish after a newer same-turn heartbeat", async () => {
    const thread = makeThread();
    const event = await Effect.runPromise(
      decide(
        {
          ...thread,
          session: { ...thread.session!, updatedAt: "2026-09-23T10:44:00.000Z" },
        },
        completionCommand(),
      ),
    );
    expect(event).toMatchObject({ payload: { session: { status: "ready", activeTurnId: null } } });
  });

  const absentRuntimeCases = [
    { name: "omitted", fields: {} },
    { name: "undefined", fields: { subagentRuntimeId: undefined } },
    { name: "null", fields: { subagentRuntimeId: null } },
  ] as const;
  for (const status of ["running", "starting"] as const) {
    it.each(
      absentRuntimeCases.flatMap((current) =>
        absentRuntimeCases.map((expected) => ({ current, expected })),
      ),
    )(
      `admits ${status} lifecycle with current $current.name and legacy expected $expected.name generation`,
      async ({ current, expected }) => {
        const original = makeThread();
        const observed = {
          ...original.session!,
          status,
          providerName: "grok",
          providerInstanceId: ProviderInstanceId.make("grok"),
          activeTurnId: status === "running" ? oldRoot : null,
        };
        // Deliberately construct the captured guard without calling the new
        // normalizer: real legacy/SQL observations can still omit this field.
        const expectedSessionLifecycle = {
          status: observed.status,
          activeTurnId: observed.activeTurnId,
          providerName: observed.providerName,
          providerInstanceId: observed.providerInstanceId,
          updatedAt: observed.updatedAt,
          ...expected.fields,
        };
        const event = await Effect.runPromise(
          decide(
            {
              ...original,
              session: {
                ...observed,
                ...current.fields,
                // Exercise the concrete-turn comparison separately from the
                // full tuple path used for a provisional Starting session.
                ...(status === "running" ? { updatedAt: "2026-09-23T10:44:00.000Z" } : {}),
              },
            },
            {
              ...completionCommand(),
              expectedSessionLifecycle,
              session: { ...observed, status: "ready", activeTurnId: null },
            },
          ),
        );
        expect(event).toMatchObject({
          type: "thread.session-set",
          payload: { session: { providerName: "grok", status: "ready", activeTurnId: null } },
        });
        expect(event).not.toHaveProperty("payload.expectedSessionLifecycle");
      },
    );
  }

  it.each([
    ["omitted", {}],
    ["explicitly absent", { subagentRuntimeId: null }],
    ["replacement", { subagentRuntimeId: "00000000-0000-4000-8000-000000000002" }],
  ] as const)(
    "rejects an exact-generation observation when current evidence is %s",
    async (_name, fields) => {
      const original = makeThread();
      const result = await Effect.runPromise(
        Effect.exit(
          decide(
            { ...original, session: { ...original.session!, ...fields } },
            {
              ...completionCommand(),
              expectedSessionLifecycle: sessionLifecycleSnapshot({
                ...original.session!,
                subagentRuntimeId: "00000000-0000-4000-8000-000000000001",
              }),
            },
          ),
        ),
      );
      expect(result).toMatchObject({ _tag: "Failure" });
      expect(JSON.stringify(result)).toContain(SESSION_LIFECYCLE_SUPERSEDED);
    },
  );

  it("keeps an explicitly absent session guard distinct from a session with no generation", async () => {
    const result = await Effect.runPromise(
      Effect.exit(decide(makeThread(), { ...completionCommand(), expectedSessionLifecycle: null })),
    );
    expect(result).toMatchObject({ _tag: "Failure" });
    expect(JSON.stringify(result)).toContain(SESSION_LIFECYCLE_SUPERSEDED);
  });

  it("fences positive native admission separately from ordinary turn ACK races", async () => {
    const original = makeThread();
    const runtimeId = "00000000-0000-4000-8000-000000000001";
    const command = {
      ...completionCommand(),
      expectedSessionLifecycle: undefined,
      expectedSubagentRuntimeId: null,
    };
    const result = await Effect.runPromise(
      Effect.exit(
        decide(
          {
            ...original,
            session: {
              ...original.session!,
              subagentRuntimeId: runtimeId,
            },
          },
          command,
        ),
      ),
    );
    expect(result).toMatchObject({ _tag: "Failure" });
    expect(JSON.stringify(result)).toContain(SESSION_LIFECYCLE_SUPERSEDED);
  });

  it.each([
    ["accepted newer turn", { activeTurnId: newRoot }],
    ["Stop", { status: "interrupted" as const, activeTurnId: null }],
    ["new start intent", { status: "starting" as const, activeTurnId: null }],
    ["changed runtime", { providerInstanceId: ProviderInstanceId.make("another-instance") }],
    ["changed driver", { providerName: "claude" }],
    ["changed native context", { subagentRuntimeId: "00000000-0000-4000-8000-000000000001" }],
  ])("rejects an observation superseded by %s", async (_label, change) => {
    const original = makeThread();
    const result = await Effect.runPromise(
      Effect.exit(
        decide({ ...original, session: { ...original.session!, ...change } }, completionCommand()),
      ),
    );
    expect(result).toMatchObject({ _tag: "Failure" });
    expect(JSON.stringify(result)).toContain(SESSION_LIFECYCLE_SUPERSEDED);
  });
});
