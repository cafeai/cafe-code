import {
  CommandId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ServerProvider,
  type ThreadTurnStartCommand,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { seedScheduledFollowUp } from "../orchestration/scheduledFollowUp.testSupport.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ScheduledFollowups, ScheduledFollowupsLive } from "./service.ts";

const CREATED = "2026-10-08T00:00:00.000Z";
const SESSION_UPDATED = "2026-10-08T00:01:00.000Z";
const COMPLETED = "2026-10-08T00:02:00.000Z";
const NEWER_SESSION = "2026-10-08T00:03:00.000Z";
const threadId = ThreadId.make("isolated-scheduled-admission");
const turnId = TurnId.make("exact-terminal-native-turn");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" };
const disposals: Array<() => Promise<void>> = [];
const provider: ServerProvider = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "fixture-only",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: CREATED,
  availability: "available",
  models: [
    { slug: modelSelection.model, name: "Fixture model", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

afterEach(async () => {
  // Every runtime owns only migrated in-memory SQLite and a filesystem-minted
  // test configuration scope. No provider service, daemon, profile or paid I/O
  // is present; retire the Effect scope before its temporary paths disappear.
  for (const dispose of disposals.splice(0).toReversed()) await dispose();
});

async function harness() {
  const orchestration = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "scheduled-admission-consistency-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(
    ScheduledFollowupsLive.pipe(
      Layer.provideMerge(orchestration),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
      ),
    ),
  );
  disposals.push(() => runtime.dispose());
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const projections = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const service = await runtime.runPromise(Effect.service(ScheduledFollowups));
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  await run(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-isolated-scheduled-admission"),
      threadId,
      projectId: null,
      title: "Isolated scheduler admission",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: CREATED,
    }),
  );
  const command = await run(
    seedScheduledFollowUp(sql, { threadId, modelSelection, createdAt: NEWER_SESSION }),
  );
  const seedTerminal = async (
    completedAt: string | null = COMPLETED,
    state: "completed" | "error" | "interrupted" = "completed",
  ) => {
    // Model a retained native session whose exact turn has independently
    // obtained definitive terminal projection evidence. Direct SQL isolates
    // the raw-row/canonical-reader disagreement without synthesizing provider
    // callbacks or claiming that a final-looking message proves completion.
    await run(sql`INSERT INTO projection_turns
      (thread_id,turn_id,state,requested_at,started_at,completed_at,checkpoint_files_json)
      VALUES (${threadId},${turnId},${state},${CREATED},${SESSION_UPDATED},${completedAt},'[]')`);
    await run(sql`UPDATE projection_threads SET latest_turn_id = ${turnId}
      WHERE thread_id = ${threadId}`);
    await run(sql`INSERT INTO projection_thread_sessions
      (thread_id,status,provider_name,provider_instance_id,runtime_mode,active_turn_id,last_error,updated_at)
      VALUES (${threadId},'running','codex',${modelSelection.instanceId},'approval-required',${turnId},NULL,${SESSION_UPDATED})`);
  };
  const shell = async () => {
    const value = await run(projections.getThreadShellById(threadId));
    expect(Option.isSome(value)).toBe(true);
    if (Option.isNone(value)) throw new Error("Fixture chat shell missing");
    return value.value;
  };
  const expectRejectedBusy = async (target: typeof ThreadTurnStartCommand.Type = command) => {
    await expect(run(engine.dispatch(target))).rejects.toThrow(
      "Scheduled follow-up is waiting for an idle chat.",
    );
    const [occurrence] = await run(sql<{
      state: string;
      intent_sequence: number | null;
      attempt_at: string | null;
    }>`SELECT state,intent_sequence,attempt_at FROM scheduled_followup_runs
      WHERE id = ${target.scheduledFollowUp!.runId}`);
    expect(occurrence).toEqual({ state: "waiting", intent_sequence: null, attempt_at: null });
    const [messages] = await run(sql<{ count: number }>`SELECT COUNT(*) AS count
      FROM projection_thread_messages WHERE message_id = ${target.message.messageId}`);
    expect(messages?.count).toBe(0);
  };
  const expectAdmitted = async () => {
    const receipt = await run(engine.dispatch(command));
    const [occurrence] = await run(sql<{
      state: string;
      intent_sequence: number;
      attempt_at: string | null;
    }>`SELECT state,intent_sequence,attempt_at FROM scheduled_followup_runs
      WHERE id = ${command.scheduledFollowUp!.runId}`);
    expect(occurrence).toEqual({
      state: "dispatching",
      intent_sequence: receipt.sequence,
      attempt_at: null,
    });
    expect(await run(engine.dispatch(command))).toEqual(receipt);
    const [messages] = await run(sql<{ count: number }>`SELECT COUNT(*) AS count
      FROM projection_thread_messages WHERE message_id = ${command.message.messageId}`);
    expect(messages?.count).toBe(1);
  };
  return {
    run,
    engine,
    sql,
    service,
    command,
    seedTerminal,
    shell,
    expectRejectedBusy,
    expectAdmitted,
  };
}

describe("scheduled admission and canonical session consistency", () => {
  it.each(["completed", "error", "interrupted"] as const)(
    "admits the canonical idle shell for the exact definitively %s active turn",
    async (state) => {
      const h = await harness();
      await h.seedTerminal(COMPLETED, state);
      expect((await h.shell()).session).toMatchObject({
        status: state === "completed" ? "ready" : state,
        activeTurnId: null,
        updatedAt: COMPLETED,
      });
      // Confirm that canonical reconciliation has not rewritten lifecycle
      // storage. Admission must evaluate this exact stale row under the writer
      // instead of trusting the process-local shell or deleting a receipt.
      const [raw] = await h.run(h.sql<{ status: string; active_turn_id: string }>`
        SELECT status,active_turn_id FROM projection_thread_sessions WHERE thread_id = ${threadId}`);
      expect(raw).toEqual({ status: "running", active_turn_id: turnId });
      await h.expectAdmitted();
    },
  );

  it("admits a failed run's owner-approved Run now retry exactly once across scheduler sweeps", async () => {
    const h = await harness();
    await h.seedTerminal(COMPLETED, "error");
    const prior = h.command.scheduledFollowUp!;
    // This fixture records an exact terminal native turn and already-settled
    // failed occurrence. It does not infer provider failure from prose or
    // modify an uncertain attempt. The persisted session remains stale as in
    // the canonical-reader mismatch above, independently of this run ledger.
    await h.run(h.sql`UPDATE scheduled_followup_runs
      SET state = 'failed',turn_id = ${turnId},completed_at = ${COMPLETED},error_code = 'turn-failed'
      WHERE id = ${prior.runId}`);
    await h.run(h.sql`UPDATE scheduled_followups SET state = 'needs_attention',next_run_at = NULL
      WHERE id = ${prior.scheduleId}`);
    const list = await h.run(h.service.list({ threadId }));
    const schedule = list.schedules[0]!;
    expect(schedule.lastRun).toMatchObject({ state: "failed", turnId });
    const resumed = await h.run(
      h.service.setStatus({
        threadId,
        id: schedule.id,
        expectedRevision: schedule.revision,
        state: "active",
      }),
    );
    const retry = await h.run(
      h.service.runNow({ threadId, id: resumed.id, expectedRevision: resumed.revision }),
    );
    expect((await h.shell()).session).toMatchObject({ status: "error", activeTurnId: null });
    const readRetry = async () => {
      const history = await h.run(h.service.history({ threadId, id: resumed.id }));
      return history.runs.find((entry) => entry.id === retry.id);
    };
    await h.run(h.service.tick);
    const admitted = await readRetry();
    expect(admitted).toMatchObject({ state: "dispatching" });
    expect(admitted?.intentSequence).not.toBeNull();
    await h.run(h.service.tick);
    expect(await readRetry()).toEqual(admitted);
    const [attempts] = await h.run(h.sql<{ count: number }>`SELECT COUNT(*) AS count
      FROM scheduled_followup_runs WHERE schedule_id = ${resumed.id} AND attempt_at IS NOT NULL`);
    expect(attempts?.count).toBe(0);
    const [messages] = await h.run(h.sql<{ count: number }>`SELECT COUNT(*) AS count
      FROM projection_thread_messages WHERE message_id = ${admitted!.messageId}`);
    expect(messages?.count).toBe(1);
  });

  it("admits an authoritative ready session with no active turn", async () => {
    const h = await harness();
    await h.seedTerminal();
    await h.run(h.sql`UPDATE projection_thread_sessions SET status = 'ready',active_turn_id = NULL,
      updated_at = ${COMPLETED} WHERE thread_id = ${threadId}`);
    const receipt = await h.run(h.engine.dispatch(h.command));
    const [occurrence] = await h.run(h.sql<{ state: string; intent_sequence: number }>`
      SELECT state,intent_sequence FROM scheduled_followup_runs
      WHERE id = ${h.command.scheduledFollowUp!.runId}`);
    expect(occurrence).toEqual({ state: "dispatching", intent_sequence: receipt.sequence });
  });

  it("admits exact terminal evidence published at the session's same timestamp", async () => {
    const h = await harness();
    await h.seedTerminal(SESSION_UPDATED);
    expect((await h.shell()).session).toMatchObject({ status: "ready", activeTurnId: null });
    await h.expectAdmitted();
  });

  it.each(["completed", "error", "interrupted"] as const)(
    "keeps %s evidence without its definitive timestamp busy",
    async (state) => {
      const h = await harness();
      await h.seedTerminal(null, state);
      expect((await h.shell()).session).toMatchObject({
        status: state === "completed" ? "running" : state,
        activeTurnId: state === "completed" ? turnId : null,
      });
      await h.expectRejectedBusy();
    },
  );

  it("retains a newer distinct native active turn despite historical completion", async () => {
    const h = await harness();
    await h.seedTerminal();
    await h.run(h.sql`UPDATE projection_thread_sessions SET active_turn_id = 'newer-live-native-turn',
      updated_at = ${NEWER_SESSION} WHERE thread_id = ${threadId}`);
    expect((await h.shell()).session).toMatchObject({
      status: "running",
      activeTurnId: "newer-live-native-turn",
    });
    await h.expectRejectedBusy();
  });

  it("retains a newer generation and clock even when its active turn spelling matches history", async () => {
    const h = await harness();
    await h.seedTerminal();
    await h.run(h.sql`UPDATE projection_thread_sessions
      SET subagent_runtime_id = '43bded0a-2b67-4d85-9d3d-b45632c270b2',updated_at = ${NEWER_SESSION}
      WHERE thread_id = ${threadId}`);
    // The existing reader discards this active id from exact-turn terminal
    // evidence regardless of age. Scheduling must remain more conservative
    // when an independently newer runtime/session might own new native work.
    expect((await h.shell()).session).toMatchObject({ status: "ready", activeTurnId: null });
    await h.expectRejectedBusy();
  });

  it("retains a distinct raw active turn even when another later terminal turn makes the shell idle", async () => {
    const h = await harness();
    await h.seedTerminal();
    await h.run(h.sql`UPDATE projection_thread_sessions SET active_turn_id = 'unbound-native-turn'
      WHERE thread_id = ${threadId}`);
    // Matching timestamp alone cannot attest that the different active native
    // id ended. The scheduler must require the exact latest terminal identity.
    expect((await h.shell()).session).toMatchObject({ status: "ready", activeTurnId: null });
    await h.expectRejectedBusy();
  });

  it("keeps provisional startup busy after an older turn completed", async () => {
    const h = await harness();
    await h.seedTerminal();
    await h.run(h.sql`UPDATE projection_thread_sessions SET status = 'starting',active_turn_id = NULL,
      updated_at = ${NEWER_SESSION} WHERE thread_id = ${threadId}`);
    expect((await h.shell()).session).toMatchObject({ status: "starting", activeTurnId: null });
    await h.expectRejectedBusy();
  });

  it("keeps startup with a retained active turn busy even when a later terminal timestamp exists", async () => {
    const h = await harness();
    await h.seedTerminal("2026-10-08T00:04:00.000Z");
    await h.run(h.sql`UPDATE projection_thread_sessions SET status = 'starting',updated_at = ${NEWER_SESSION}
      WHERE thread_id = ${threadId}`);
    // The canonical reader resolves the old turn to idle, but startup is a
    // distinct admission boundary. Definitive history must not release it.
    expect((await h.shell()).session).toMatchObject({ status: "ready", activeTurnId: null });
    await h.expectRejectedBusy();
  });

  it.each(["running", "ready"] as const)(
    "does not let terminal evidence authorize a queued newer pending start with a raw %s session",
    async (status) => {
      const h = await harness();
      await h.seedTerminal();
      if (status === "ready") {
        // Isolate the NULL-turn clause: neither the ordinary raw-session gate
        // nor the latest-terminal join can detect this independently queued
        // pending start after the fixture's session is already ready/null.
        await h.run(h.sql`UPDATE projection_thread_sessions SET status = 'ready',active_turn_id = NULL
          WHERE thread_id = ${threadId}`);
      }
      await h.run(h.sql`INSERT INTO projection_turns
        (thread_id,turn_id,pending_message_id,state,requested_at,checkpoint_files_json)
        VALUES (${threadId},NULL,'newer-pending-user-message','pending',${NEWER_SESSION},'[]')`);
      expect((await h.shell()).session).toMatchObject({ status: "ready", activeTurnId: null });
      await h.expectRejectedBusy();
    },
  );

  it.each(["pending", "running"] as const)(
    "keeps an incomplete latest %s turn busy when session evidence is absent",
    async (state) => {
      const h = await harness();
      await h.seedTerminal();
      await h.run(h.sql`DELETE FROM projection_thread_sessions WHERE thread_id = ${threadId}`);
      await h.run(h.sql`UPDATE projection_turns SET state = ${state},completed_at = NULL
        WHERE thread_id = ${threadId} AND turn_id = ${turnId}`);
      expect((await h.shell()).session).toBeNull();
      await h.expectRejectedBusy();
    },
  );

  it.each(["approval count", "approval row", "user input", "another unknown occurrence"] as const)(
    "retains the independent %s barrier when terminal session evidence is present",
    async (variant) => {
      const h = await harness();
      await h.seedTerminal();
      // Clear only the synthetic fixture's raw active session to prove this
      // independent barrier, rather than accidentally passing through the
      // preexisting stale-session rejection path.
      await h.run(h.sql`UPDATE projection_thread_sessions
        SET status = 'ready',active_turn_id = NULL,updated_at = ${COMPLETED}
        WHERE thread_id = ${threadId}`);
      if (variant === "approval count") {
        await h.run(h.sql`UPDATE projection_threads SET pending_approval_count = 1
          WHERE thread_id = ${threadId}`);
      } else if (variant === "approval row") {
        await h.run(h.sql`INSERT INTO projection_pending_approvals
          (request_id,thread_id,turn_id,status,decision,created_at,resolved_at)
          VALUES ('pending-authorization-fixture',${threadId},${turnId},'pending',NULL,${NEWER_SESSION},NULL)`);
      } else if (variant === "user input") {
        await h.run(h.sql`UPDATE projection_threads SET pending_user_input_count = 1
          WHERE thread_id = ${threadId}`);
      } else {
        const other = await h.run(
          seedScheduledFollowUp(h.sql, { threadId, modelSelection, createdAt: NEWER_SESSION }),
        );
        await h.run(h.sql`UPDATE scheduled_followup_runs SET state = 'unknown',attempt_at = ${SESSION_UPDATED}
          WHERE id = ${other.scheduledFollowUp!.runId}`);
      }
      await h.expectRejectedBusy();
    },
  );

  it.each(["account", "revision"] as const)(
    "does not substitute terminal session evidence for the exact %s authority fence",
    async (variant) => {
      const h = await harness();
      await h.seedTerminal();
      if (variant === "account") {
        await h.run(h.sql`UPDATE scheduled_followups SET authorized_instance_id = 'another-account'
          WHERE id = ${h.command.scheduledFollowUp!.scheduleId}`);
      } else {
        await h.run(h.sql`UPDATE scheduled_followups SET revision = revision + 1
          WHERE id = ${h.command.scheduledFollowUp!.scheduleId}`);
      }
      await expect(h.run(h.engine.dispatch(h.command))).rejects.toThrow(
        "Scheduled follow-up authorization no longer matches this chat.",
      );
      const [occurrence] = await h.run(h.sql<{
        state: string;
        intent_sequence: number | null;
        attempt_at: string | null;
      }>`SELECT state,intent_sequence,attempt_at FROM scheduled_followup_runs
        WHERE id = ${h.command.scheduledFollowUp!.runId}`);
      expect(occurrence).toEqual({ state: "waiting", intent_sequence: null, attempt_at: null });
    },
  );
});
