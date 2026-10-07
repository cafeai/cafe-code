import * as Crypto from "node:crypto";
import {
  CommandId,
  MessageId,
  ScheduledFollowupDraft,
  ScheduledFollowupError,
  ScheduledFollowupId,
  ScheduledFollowupRunId,
  ScheduledFollowupRecord,
  ScheduledFollowupRun,
  ScheduledFollowupSaveInput,
  ScheduledFollowupSetStatusInput,
  ScheduledFollowupRunNowInput,
  ScheduledFollowupHistoryInput,
  ScheduledFollowupListInput,
  SCHEDULED_FOLLOWUP_MAX_SCHEDULES_PER_THREAD,
  type ScheduledFollowupHistoryResult,
  type ScheduledFollowupListResult,
  type OrchestrationThreadShell,
  type ThreadId,
  type TurnId,
  ThreadTurnStartCommand,
  ModelSelection,
  isProviderAvailable,
} from "@cafecode/contracts";
import {
  nextScheduleOccurrences,
  coalesceScheduledFollowupDue,
} from "@cafecode/shared/scheduledFollowups";
import { parseScheduledFollowupResult } from "@cafecode/shared/scheduledFollowupResult";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import {
  requireSchedulingSessionAuthority,
  type SchedulingSessionAuthority,
} from "./sessionRuntime.ts";

type Operation<A> = Effect.Effect<A, ScheduledFollowupError>;
export interface ScheduledFollowupsShape {
  readonly list: (
    input: ScheduledFollowupListInput,
    authority?: SchedulingSessionAuthority,
  ) => Operation<ScheduledFollowupListResult>;
  readonly save: (
    input: ScheduledFollowupSaveInput,
    source?: "owner" | "agent",
    authority?: SchedulingSessionAuthority,
  ) => Operation<ScheduledFollowupRecord>;
  readonly setStatus: (
    input: ScheduledFollowupSetStatusInput,
    authority?: SchedulingSessionAuthority,
  ) => Operation<ScheduledFollowupRecord>;
  readonly runNow: (input: ScheduledFollowupRunNowInput) => Operation<ScheduledFollowupRun>;
  readonly history: (
    input: ScheduledFollowupHistoryInput,
  ) => Operation<ScheduledFollowupHistoryResult>;
  readonly notification: (
    threadId: ThreadId,
    turnId: TurnId | null,
  ) => Operation<{ notify: boolean }>;
  readonly tick: Operation<void>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}
export class ScheduledFollowups extends Context.Service<
  ScheduledFollowups,
  ScheduledFollowupsShape
>()("cafecode/ScheduledFollowups") {}

interface ScheduleRow {
  id: string;
  thread_id: string;
  revision: number;
  state: ScheduledFollowupRecord["state"];
  definition_json: string;
  authorized_instance_id: string;
  permission_ceiling: string;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  run_count: number;
}
interface RunRow {
  id: string;
  schedule_id: string;
  revision: number;
  thread_id: string;
  due_at: string;
  state: ScheduledFollowupRun["state"];
  command_id: string;
  message_id: string;
  intent_sequence: number | null;
  turn_id: string | null;
  model_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  result: "no-change" | "changed" | null;
  summary: string | null;
  error_code: string | null;
  attempt_at: string | null;
  reported_finish: number;
  command_json: string | null;
  inspected_at: string;
}
const failure = (message: string) => new ScheduledFollowupError({ message });
const nowIso = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()));
const publicBoundary = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof ScheduledFollowupError
        ? error
        : failure("Scheduled follow-up could not be updated. Refresh and try again."),
    ),
  );
const decodeDraft = Schema.decodeUnknownEffect(Schema.fromJsonString(ScheduledFollowupDraft));
const decodeRun = (row: RunRow) =>
  Effect.gen(function* () {
    const modelSelection =
      row.model_json === null
        ? null
        : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection))(row.model_json);
    return yield* Schema.decodeUnknownEffect(ScheduledFollowupRun)({
      id: row.id,
      scheduleId: row.schedule_id,
      revision: row.revision,
      dueAt: row.due_at,
      state: row.state,
      commandId: row.command_id,
      messageId: row.message_id,
      intentSequence: row.intent_sequence,
      turnId: row.turn_id,
      modelSelection,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      result: row.result,
      summary: row.summary,
      errorCode: row.error_code,
    });
  });

/**
 * All clocks and SQL/provider dependencies are injected Effect services. Tests
 * use a private migrated SQLite database and synthetic provider registry; this
 * never owns provider binaries, sessions, credentials or renderer lifetime.
 */
export const makeScheduledFollowups = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderRegistry;
  const mutex = yield* Semaphore.make(1);

  /** The transport proves session possession; this writer-locked guard proves
   * that session still owns the exact selected chat/profile at commit time.
   * Never trust a token admitted before an account switch or session teardown.
   * This helper must run inside the same SQL transaction as the operation. */
  const requireSession = (threadId: ThreadId, authority: SchedulingSessionAuthority) =>
    Effect.gen(function* () {
      if (authority.threadId !== threadId)
        return yield* failure("The scheduling connection does not own this chat.");
      yield* requireSchedulingSessionAuthority(sql, authority);
      const [current] = yield* sql<{ thread_id: string }>`SELECT thread_id FROM projection_threads
        WHERE thread_id = ${threadId} AND deleted_at IS NULL AND archived_at IS NULL
          AND json_extract(model_selection_json,'$.instanceId') = ${authority.providerInstanceId}`;
      if (!current)
        return yield* failure("This chat's account changed. Reconnect before scheduling.");
    });

  const getThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const value = yield* projections.getThreadShellById(threadId);
      if (Option.isNone(value) || value.value.deletedAt || value.value.archivedAt) {
        return yield* failure("This chat is unavailable. Restore it before scheduling follow-ups.");
      }
      return value.value;
    });
  const getRow = (id: ScheduledFollowupId, threadId: ThreadId) =>
    Effect.gen(function* () {
      const [row] =
        yield* sql<ScheduleRow>`SELECT * FROM scheduled_followups WHERE id = ${id} AND thread_id = ${threadId} AND state <> 'deleted'`;
      if (!row) return yield* failure("This schedule no longer exists.");
      return row;
    });
  const record = (row: ScheduleRow) =>
    Effect.gen(function* () {
      const draft = yield* decodeDraft(row.definition_json);
      const [last] =
        yield* sql<RunRow>`SELECT * FROM scheduled_followup_runs WHERE schedule_id = ${row.id} ORDER BY created_at DESC,id DESC LIMIT 1`;
      return yield* Schema.decodeUnknownEffect(ScheduledFollowupRecord)({
        ...draft,
        id: row.id,
        threadId: row.thread_id,
        revision: row.revision,
        state: row.state,
        authorizedInstanceId: row.authorized_instance_id,
        permissionCeiling: row.permission_ceiling,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        nextRunAt: row.next_run_at,
        runCount: row.run_count,
        lastRun: last ? yield* decodeRun(last) : null,
      });
    });
  const validateProvider = (thread: OrchestrationThreadShell, draft: ScheduledFollowupDraft) =>
    Effect.gen(function* () {
      const selection = draft.modelSelection ?? thread.modelSelection;
      if (selection.instanceId !== thread.modelSelection.instanceId)
        return yield* failure("A schedule cannot switch this chat to another account.");
      const registry = yield* providers.getProviders;
      const provider = registry.find((entry) => entry.instanceId === selection.instanceId);
      if (
        !provider ||
        !provider.enabled ||
        !["codex", "claudeAgent", "grok"].includes(provider.driver)
      ) {
        return yield* failure("Choose an enabled Codex, Claude or Grok account for this chat.");
      }
      if (!provider.models.some((model) => model.slug === selection.model)) {
        return yield* failure(
          "The selected model is unavailable for this account. Review the schedule.",
        );
      }
      // Availability is tested at dispatch too, but creation may intentionally
      // configure a currently offline account. Never probe or replace it here.
      return provider;
    });
  const nextAt = (draft: ScheduledFollowupDraft, after: string) =>
    Effect.try({
      try: () => nextScheduleOccurrences(draft.recurrence, after, 1, draft.endAt)[0] ?? null,
      catch: () =>
        failure("This recurrence has no valid upcoming date. Review its calendar settings."),
    });
  const invalidateUnattempted = (
    id: string,
    timestamp: string,
  ) => sql`UPDATE scheduled_followup_runs
    SET state = 'skipped', completed_at = ${timestamp}, error_code = 'schedule-changed'
    WHERE schedule_id = ${id} AND state IN ('waiting','dispatching') AND attempt_at IS NULL`;

  const list: ScheduledFollowupsShape["list"] = (input, authority) =>
    publicBoundary(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* Schema.decodeUnknownEffect(ScheduledFollowupListInput)(input);
          if (authority) yield* requireSession(input.threadId, authority);
          const rows =
            yield* sql<ScheduleRow>`SELECT * FROM scheduled_followups WHERE thread_id = ${input.threadId} AND state <> 'deleted' ORDER BY created_at,id LIMIT ${SCHEDULED_FOLLOWUP_MAX_SCHEDULES_PER_THREAD}`;
          return { schedules: yield* Effect.forEach(rows, record), backendOnline: true as const };
        }),
      ),
    );

  const save: ScheduledFollowupsShape["save"] = (raw, source = "owner", authority) =>
    publicBoundary(
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const input = yield* Schema.decodeUnknownEffect(ScheduledFollowupSaveInput)(raw);
          const { threadId, id, expectedRevision, expectedInstanceId, ...draft } = input;
          if (authority && source !== "agent")
            return yield* failure("Agent scheduling requires owner approval in Tasks.");
          const timestamp = yield* nowIso;
          const next = yield* nextAt(draft, timestamp);
          if (!next)
            return yield* failure("Choose a future run time before the schedule's end date.");
          const state = source === "owner" ? "active" : "pending_confirmation";
          const selectedId = id ?? ScheduledFollowupId.make(Crypto.randomUUID());
          yield* sql.withTransaction(
            Effect.gen(function* () {
              // The no-op write takes the database writer before checking bounds and
              // revisions. A second backend cannot bypass either by racing a read.
              yield* sql`UPDATE projection_threads SET thread_id = thread_id WHERE thread_id = ${threadId}`;
              if (authority) yield* requireSession(threadId, authority);
              // Read current settings after taking the writer. A proposal or
              // owner approval must not bind a profile observed before another
              // connection changed this chat's account or permission mode.
              const thread = yield* getThread(threadId);
              if (expectedInstanceId && expectedInstanceId !== thread.modelSelection.instanceId)
                return yield* failure(
                  "This chat's account changed. Review the executing account before enabling.",
                );
              yield* validateProvider(thread, draft);
              if (id) {
                if (source === "owner") {
                  // Saving an edit enables the rule, so it must obey Resume's
                  // uncertainty fence rather than label blocked work active.
                  const [ambiguous] = yield* sql<{
                    id: string;
                  }>`SELECT id FROM scheduled_followup_runs
                  WHERE schedule_id = ${id} AND thread_id = ${threadId} AND state = 'unknown' LIMIT 1`;
                  if (ambiguous)
                    return yield* failure(
                      "A previous run has an uncertain outcome. Wait for reconciliation before enabling it.",
                    );
                }
                const rows = yield* sql<{
                  id: string;
                }>`UPDATE scheduled_followups SET definition_json = ${JSON.stringify(draft)},
          revision = revision + 1,state = ${state},next_run_at = ${source === "owner" ? next : null},
          authorized_instance_id = ${thread.modelSelection.instanceId},permission_ceiling = ${thread.runtimeMode},updated_at = ${timestamp}
          WHERE id = ${id} AND thread_id = ${threadId} AND revision = ${expectedRevision ?? -1} AND state <> 'deleted' RETURNING id`;
                if (rows.length !== 1)
                  return yield* failure("This schedule changed elsewhere. Refresh before saving.");
                yield* invalidateUnattempted(id, timestamp);
              } else {
                const [count] = yield* sql<{
                  total: number;
                }>`SELECT COUNT(*) AS total FROM scheduled_followups WHERE thread_id = ${threadId} AND state <> 'deleted'`;
                if ((count?.total ?? 0) >= SCHEDULED_FOLLOWUP_MAX_SCHEDULES_PER_THREAD)
                  return yield* failure(
                    "This chat has reached its schedule limit. Remove an old schedule first.",
                  );
                yield* sql`INSERT INTO scheduled_followups (id,thread_id,revision,state,definition_json,authorized_instance_id,permission_ceiling,next_run_at,created_at,updated_at,run_count)
          VALUES (${selectedId},${threadId},1,${state},${JSON.stringify(draft)},${thread.modelSelection.instanceId},${thread.runtimeMode},${source === "owner" ? next : null},${timestamp},${timestamp},0)`;
              }
            }),
          );
          return yield* record(yield* getRow(selectedId, threadId));
        }),
      ),
    );

  const setStatus: ScheduledFollowupsShape["setStatus"] = (raw, authority) =>
    publicBoundary(
      mutex.withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            const input = yield* Schema.decodeUnknownEffect(ScheduledFollowupSetStatusInput)(raw);
            yield* sql`UPDATE projection_threads SET thread_id = thread_id WHERE thread_id = ${input.threadId}`;
            if (authority) {
              yield* requireSession(input.threadId, authority);
              if (input.state !== "paused")
                return yield* failure("Agent scheduling can only pause an existing schedule.");
            }
            const row = yield* getRow(input.id, input.threadId);
            const draft = yield* decodeDraft(row.definition_json);
            const timestamp = yield* nowIso;
            let next: string | null = null;
            let instanceId = row.authorized_instance_id;
            let ceiling = row.permission_ceiling;
            if (input.state === "active") {
              const thread = yield* getThread(input.threadId);
              if (
                input.expectedInstanceId &&
                input.expectedInstanceId !== thread.modelSelection.instanceId
              )
                return yield* failure(
                  "This chat's account changed. Review the executing account before enabling.",
                );
              yield* validateProvider(thread, draft);
              instanceId = thread.modelSelection.instanceId;
              ceiling = thread.runtimeMode;
              if (draft.maxRuns !== null && row.run_count >= draft.maxRuns)
                return yield* failure(
                  "This schedule reached its run limit. Edit the limit before resuming.",
                );
              const [ambiguous] = yield* sql<{
                id: string;
              }>`SELECT id FROM scheduled_followup_runs WHERE schedule_id = ${input.id} AND state = 'unknown' LIMIT 1`;
              if (ambiguous)
                return yield* failure(
                  "A previous run has an uncertain outcome. Wait for reconciliation before resuming.",
                );
              next = yield* nextAt(draft, timestamp);
              if (!next)
                return yield* failure("No future run remains. Edit the schedule before resuming.");
            }
            const updated = yield* sql.withTransaction(
              Effect.gen(function* () {
                const rows =
                  yield* sql<ScheduleRow>`UPDATE scheduled_followups SET state = ${input.state}, revision = revision + 1,
        authorized_instance_id = ${instanceId},permission_ceiling = ${ceiling},next_run_at = ${next},updated_at = ${timestamp}
        WHERE id = ${input.id} AND thread_id = ${input.threadId} AND revision = ${input.expectedRevision} AND state <> 'deleted' RETURNING *`;
                if (!rows[0])
                  return yield* failure(
                    "This schedule changed elsewhere. Refresh before updating it.",
                  );
                yield* invalidateUnattempted(input.id, timestamp);
                return rows[0];
              }),
            );
            return yield* record(updated);
          }),
        ),
      ),
    );

  const claim = (row: ScheduleRow, timestamp: string, manual: boolean) =>
    Effect.gen(function* () {
      const draft = yield* decodeDraft(row.definition_json);
      const due = manual
        ? timestamp
        : coalesceScheduledFollowupDue(draft.recurrence, row.next_run_at, timestamp, draft.endAt)
            .dueAt;
      if (due === null) return null;
      const next = yield* nextAt(draft, timestamp);
      const runId = ScheduledFollowupRunId.make(Crypto.randomUUID());
      const commandId = CommandId.make(`server:schedule:${runId}`);
      const messageId = MessageId.make(`schedule:${runId}`);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const updated = yield* sql<{
            id: string;
          }>`UPDATE scheduled_followups SET next_run_at = ${next},updated_at = ${timestamp}
        WHERE id = ${row.id} AND revision = ${row.revision} AND state = 'active'
          AND (${manual ? 1 : 0} = 1 OR next_run_at <= ${timestamp})
          AND (${draft.maxRuns} IS NULL OR run_count < ${draft.maxRuns})
          AND (${draft.endAt} IS NULL OR ${timestamp} <= ${draft.endAt})
          AND NOT EXISTS (SELECT 1 FROM scheduled_followup_runs WHERE schedule_id = ${row.id} AND state IN ('waiting','dispatching','running','unknown'))
        RETURNING id`;
          if (updated.length !== 1) return null;
          const rows = yield* sql<RunRow>`INSERT INTO scheduled_followup_runs
        (id,schedule_id,revision,thread_id,due_at,state,command_id,message_id,created_at,reported_finish)
        VALUES (${runId},${row.id},${row.revision},${row.thread_id},${due},'waiting',${commandId},${messageId},${timestamp},0)
        ON CONFLICT(schedule_id,revision,due_at) DO NOTHING RETURNING *`;
          return rows[0] ?? null;
        }),
      );
    });
  const runNow: ScheduledFollowupsShape["runNow"] = (raw) =>
    publicBoundary(
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const input = yield* Schema.decodeUnknownEffect(ScheduledFollowupRunNowInput)(raw);
          const row = yield* getRow(input.id, input.threadId);
          if (row.revision !== input.expectedRevision || row.state !== "active")
            return yield* failure("Approve or resume this schedule before running it.");
          const run = yield* claim(row, yield* nowIso, true);
          if (!run)
            return yield* failure("A run is already pending, or this schedule reached its limit.");
          return yield* decodeRun(run);
        }),
      ),
    );
  const history: ScheduledFollowupsShape["history"] = (raw) =>
    publicBoundary(
      Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(ScheduledFollowupHistoryInput)(raw);
        yield* getRow(input.id, input.threadId);
        let beforeTime = "9999-12-31T23:59:59.999Z";
        let beforeId = "~";
        if (input.before) {
          const split = input.before.split("|");
          if (
            split.length !== 2 ||
            !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(split[0]!) ||
            !/^[a-f0-9-]{36}$/.test(split[1]!)
          )
            return yield* failure("Invalid schedule history cursor.");
          beforeTime = split[0]!;
          beforeId = split[1]!;
        }
        const limit = input.limit ?? 10;
        const rows =
          yield* sql<RunRow>`SELECT * FROM scheduled_followup_runs WHERE schedule_id = ${input.id}
      AND (created_at < ${beforeTime} OR (created_at = ${beforeTime} AND id < ${beforeId}))
      ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`;
        const visible = rows.slice(0, limit);
        const last = visible.at(-1);
        return {
          runs: yield* Effect.forEach(visible, decodeRun),
          nextCursor: rows.length > limit && last ? `${last.created_at}|${last.id}` : null,
        };
      }),
    );

  const attention = (row: ScheduleRow, run: RunRow, timestamp: string, reason: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE scheduled_followup_runs SET state = 'failed',completed_at = ${timestamp},error_code = ${reason}
      WHERE id = ${run.id} AND state = 'waiting'`;
        yield* sql`UPDATE scheduled_followups SET state = 'needs_attention',next_run_at = NULL,updated_at = ${timestamp}
      WHERE id = ${row.id} AND revision = ${row.revision} AND state = 'active'`;
      }),
    );
  const submit = (run: RunRow, timestamp: string) =>
    Effect.gen(function* () {
      const [row] =
        yield* sql<ScheduleRow>`SELECT * FROM scheduled_followups WHERE id = ${run.schedule_id}`;
      if (!row || row.state !== "active" || row.revision !== run.revision) return;
      const draft = yield* decodeDraft(row.definition_json);
      if (
        (draft.endAt !== null && timestamp > draft.endAt) ||
        (draft.maxRuns !== null && row.run_count >= draft.maxRuns)
      ) {
        // A busy chat can outlive the owner's execution window. Queuing before
        // the deadline does not authorize sending after it finally becomes idle.
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE scheduled_followup_runs SET state = 'skipped',completed_at = ${timestamp},error_code = 'limit-reached'
          WHERE id = ${run.id} AND state = 'waiting' AND attempt_at IS NULL`;
            yield* sql`UPDATE scheduled_followups SET state = 'completed',next_run_at = NULL,updated_at = ${timestamp}
          WHERE id = ${row.id} AND revision = ${run.revision} AND state = 'active'`;
          }),
        );
        return;
      }
      const threadOption = yield* projections.getThreadShellById(row.thread_id as ThreadId);
      if (
        Option.isNone(threadOption) ||
        threadOption.value.deletedAt ||
        threadOption.value.archivedAt
      ) {
        yield* attention(row, run, timestamp, "chat-unavailable");
        return;
      }
      const thread = threadOption.value;
      if (
        thread.modelSelection.instanceId !== row.authorized_instance_id ||
        thread.runtimeMode !== row.permission_ceiling
      ) {
        yield* attention(row, run, timestamp, "settings-changed");
        return;
      }
      // A cheap shell gate avoids filling the durable rejection ledger during a
      // 16-hour turn. The serialized engine remains the actual race-proof gate.
      if (
        thread.session?.activeTurnId ||
        ["starting", "running"].includes(thread.session?.status ?? "") ||
        thread.hasPendingApprovals ||
        thread.hasPendingUserInput
      )
        return;
      const providerResult = yield* Effect.exit(validateProvider(thread, draft));
      if (
        Exit.isFailure(providerResult) ||
        !providerResult.value.installed ||
        // Live provider snapshots may omit this optional compatibility field.
        // The shared contract treats omission as available; only an explicit
        // unavailable shadow is a refusal. Installation, configured account,
        // model and enabled-state checks remain independently authoritative.
        !isProviderAvailable(providerResult.value)
      ) {
        yield* attention(row, run, timestamp, "provider-unavailable");
        return;
      }
      const text = `Scheduled follow-up: ${draft.name}\nRun ID: ${run.id}\nSchedule ID: ${row.id}\nCurrent time: ${timestamp}\n\n${draft.prompt}\n\nThis is an owner-approved scheduled run in this chat. Do not create another schedule. Append this exact final HTML comment format after your answer, replacing result and summary appropriately: <!-- cafe-scheduled-followup: {"runId":"${run.id}","result":"no-change","summary":"A short result","finish":false} -->. Use result "changed" for meaningful updates, otherwise "no-change". ${draft.allowAutoFinish ? "Set finish to true only if the requested goal is fully met." : "Keep finish false; automatic finish was not authorized."}`;
      const command = {
        type: "thread.turn.start",
        commandId: CommandId.make(run.command_id),
        threadId: thread.id,
        message: { messageId: MessageId.make(run.message_id), role: "user", text, attachments: [] },
        modelSelection: draft.modelSelection ?? thread.modelSelection,
        ...(thread.subagentLimits ? { subagentLimits: thread.subagentLimits } : {}),
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: timestamp,
        scheduledFollowUp: {
          scheduleId: row.id,
          runId: run.id,
          revision: row.revision,
          expectedModelSelection: thread.modelSelection,
          expectedRuntimeMode: thread.runtimeMode,
          expectedInteractionMode: thread.interactionMode,
        },
      } as const;
      // Save the complete command before enqueueing. After a lost local ACK,
      // retry only these exact bytes/identity, never a reconstruction using new
      // timestamps, changed model defaults, or a replacement user instruction.
      yield* sql`UPDATE scheduled_followup_runs SET command_json = ${JSON.stringify(command)} WHERE id = ${run.id} AND command_json IS NULL AND state = 'waiting'`;
      const [persisted] = yield* sql<{
        command_json: string | null;
      }>`SELECT command_json FROM scheduled_followup_runs WHERE id = ${run.id}`;
      if (!persisted?.command_json) return;
      const exactCommand = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ThreadTurnStartCommand),
      )(persisted.command_json);
      const result = yield* Effect.exit(engine.dispatch(exactCommand));
      if (Exit.isFailure(result)) {
        // A committed receipt is authoritative even if the local waiting fiber
        // failed. Only a known rejected busy admission may mint a new command.
        const [receipt] = yield* sql<{
          status: string;
          error: string | null;
        }>`SELECT status,error FROM orchestration_command_receipts WHERE command_id = ${run.command_id}`;
        if (
          receipt?.status === "rejected" &&
          receipt.error?.includes("Scheduled follow-up is waiting for an idle chat")
        ) {
          const attempt = Crypto.randomUUID();
          yield* sql`UPDATE scheduled_followup_runs SET command_id = ${`server:schedule:${run.id}:${attempt}`},message_id = ${`schedule:${run.id}:${attempt}`},command_json = NULL
          WHERE id = ${run.id} AND state = 'waiting' AND attempt_at IS NULL`;
        } else if (receipt?.status === "rejected") {
          yield* attention(row, run, timestamp, "admission-rejected");
        }
        // No receipt is uncertain, not permission to generate a new ID. A later
        // tick retries this exact command identity and the engine deduplicates it.
      }
    });

  const readOutcome = (run: RunRow) =>
    Effect.gen(function* () {
      const [turn] = yield* sql<{
        turn_id: string | null;
        state: string;
        started_at: string | null;
        completed_at: string | null;
        text: string | null;
        changed_control: number;
      }>`SELECT t.turn_id,t.state,t.started_at,t.completed_at,
        (SELECT substr(m.text,-8192) FROM projection_thread_messages m
          WHERE m.thread_id = t.thread_id AND m.turn_id = t.turn_id
            AND m.message_id = t.assistant_message_id AND m.role = 'assistant' AND m.is_streaming = 0 LIMIT 1) AS text,
        EXISTS(SELECT 1 FROM orchestration_runtime_recovery_controls c
          WHERE c.thread_id = t.thread_id AND c.sequence > ${run.intent_sequence ?? -1}) AS changed_control
      FROM projection_turns t WHERE t.thread_id = ${run.thread_id} AND t.pending_message_id = ${run.message_id} LIMIT 1`;
      // Only a canonical final assistant response for this exact occurrence may
      // influence quiet notifications or automatic finish. MCP callers cannot
      // report by a public run ID, and later human steering revokes this policy.
      const report =
        turn?.state === "completed" && turn.changed_control === 0 && turn.text !== null
          ? parseScheduledFollowupResult(turn.text, run.id)
          : null;
      return { turn, report };
    });
  const reconcile = (run: RunRow, timestamp: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        // Settlement and schedule completion are one commit. A crash must not
        // retire the occurrence before recording its once/max-run/finish outcome.
        yield* sql`UPDATE scheduled_followup_runs SET id = id WHERE id = ${run.id}`;
        const { turn, report } = yield* readOutcome(run);
        if (turn?.turn_id) {
          const terminal = ["completed", "error", "interrupted"].includes(turn.state);
          const state = turn.state === "error" ? "failed" : terminal ? turn.state : "running";
          yield* sql`UPDATE scheduled_followup_runs SET turn_id = ${turn.turn_id},state = ${state},
        started_at = COALESCE(started_at,${turn.started_at}),completed_at = ${terminal ? (turn.completed_at ?? timestamp) : null},
        result = ${report?.result ?? null},summary = ${report?.summary ?? null},reported_finish = ${report?.finish ? 1 : 0},
        error_code = ${terminal && state !== "completed" ? `turn-${state}` : null}
        WHERE id = ${run.id} AND state IN ('dispatching','running','unknown')`;
          if (terminal) {
            const [row] =
              yield* sql<ScheduleRow>`SELECT * FROM scheduled_followups WHERE id = ${run.schedule_id}`;
            if (!row) return;
            const draft = yield* decodeDraft(row.definition_json);
            // The immutable pre-I/O attempt CAS increments this counter in the
            // same transaction; settlement never scans years of historical runs.
            const exhausted = draft.maxRuns !== null && row.run_count >= draft.maxRuns;
            const finished = report?.finish === true && draft.allowAutoFinish;
            yield* sql`UPDATE scheduled_followups SET state = CASE WHEN ${state !== "completed" ? 1 : 0} = 1 THEN 'needs_attention'
            WHEN ${finished || exhausted ? 1 : 0} = 1 OR next_run_at IS NULL THEN 'completed' ELSE state END,
          next_run_at = CASE WHEN ${state !== "completed" || finished || exhausted ? 1 : 0} = 1 THEN NULL ELSE next_run_at END,
          updated_at = ${timestamp} WHERE id = ${row.id} AND revision = ${run.revision} AND state = 'active'`;
          }
        } else if (
          run.attempt_at !== null &&
          Date.parse(timestamp) - Date.parse(run.attempt_at) > 300_000
        ) {
          // This is a missing dispatch acknowledgement, never a silence deadline
          // on a live generation. Leave all provider processes untouched and keep
          // reconciling the same exact identity; never replay an unknown attempt.
          // An old admission with no attempt is positively unsent, not unknown:
          // startup may be preparing that exact occurrence after days offline.
          // Its bounded reactor preparation owns failure/timeout settlement.
          yield* sql`UPDATE scheduled_followup_runs SET state = 'unknown',error_code = 'acceptance-unknown' WHERE id = ${run.id} AND state = 'dispatching'`;
          yield* sql`UPDATE scheduled_followups SET state = 'needs_attention',next_run_at = NULL WHERE id = ${run.schedule_id} AND state = 'active' AND revision = ${run.revision}`;
        }
      }),
    );
  const tick = publicBoundary(
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const timestamp = yield* nowIso;
        // Every scan is indexed and bounded. No work is proportional to transcript
        // length, generated tokens, or the number of historic schedule runs.
        const unsettled =
          yield* sql<RunRow>`SELECT * FROM scheduled_followup_runs WHERE state IN ('dispatching','running','unknown') ORDER BY inspected_at,created_at LIMIT 100`;
        yield* Effect.forEach(
          unsettled,
          (run) =>
            Effect.gen(function* () {
              yield* sql`UPDATE scheduled_followup_runs SET inspected_at = ${timestamp} WHERE id = ${run.id}`;
              yield* reconcile(run, timestamp);
            }),
          { discard: true },
        );
        yield* sql`UPDATE scheduled_followups SET state = 'completed', next_run_at = NULL,updated_at = ${timestamp}
      WHERE id IN (SELECT s.id FROM scheduled_followups s WHERE s.state = 'active'
        AND NOT EXISTS (SELECT 1 FROM scheduled_followup_runs r WHERE r.schedule_id = s.id AND r.state IN ('waiting','dispatching','running','unknown'))
        AND (next_run_at IS NULL OR (json_extract(definition_json,'$.endAt') IS NOT NULL AND json_extract(definition_json,'$.endAt') < ${timestamp})
          OR (json_extract(definition_json,'$.maxRuns') IS NOT NULL AND run_count >= json_extract(definition_json,'$.maxRuns')))
        ORDER BY next_run_at LIMIT 100)`;
        const due =
          yield* sql<ScheduleRow>`SELECT * FROM scheduled_followups WHERE state = 'active' AND next_run_at <= ${timestamp}
      AND NOT EXISTS (SELECT 1 FROM scheduled_followup_runs r WHERE r.schedule_id = scheduled_followups.id AND r.state IN ('waiting','dispatching','running','unknown'))
      ORDER BY next_run_at LIMIT 20`;
        yield* Effect.forEach(
          due,
          (row) =>
            claim(row, timestamp, false).pipe(
              Effect.catch(
                () =>
                  // A corrupt or obsolete rule must not starve every later due schedule.
                  // Keep its definition for owner review without logging private contents.
                  sql`UPDATE scheduled_followups SET state = 'needs_attention',next_run_at = NULL,updated_at = ${timestamp}
        WHERE id = ${row.id} AND revision = ${row.revision} AND state = 'active'`,
              ),
            ),
          { discard: true },
        );
        const waiting =
          yield* sql<RunRow>`SELECT * FROM scheduled_followup_runs WHERE state = 'waiting' ORDER BY inspected_at,created_at LIMIT 20`;
        yield* Effect.forEach(
          waiting,
          (run) =>
            Effect.gen(function* () {
              yield* sql`UPDATE scheduled_followup_runs SET inspected_at = ${timestamp} WHERE id = ${run.id}`;
              yield* submit(run, timestamp);
            }),
          { discard: true },
        );
      }),
    ),
  );
  const notification: ScheduledFollowupsShape["notification"] = (threadId, turnId) =>
    publicBoundary(
      Effect.gen(function* () {
        if (!turnId) return { notify: true };
        // The turn can complete before the poll records its native id. Bind using
        // the durable pending-message projection as well, not only r.turn_id.
        const lookup = sql<
          RunRow & { policy: string }
        >`SELECT r.*,json_extract(s.definition_json,'$.notificationPolicy') AS policy
      FROM scheduled_followup_runs r JOIN scheduled_followups s ON s.id = r.schedule_id
      WHERE r.thread_id = ${threadId} AND (r.turn_id = ${turnId} OR r.message_id = (
        SELECT pending_message_id FROM projection_turns WHERE thread_id = ${threadId} AND turn_id = ${turnId} LIMIT 1)) LIMIT 1`;
        let [row] = yield* lookup;
        let attempts = 0;
        if (!row) {
          // Even the native-turn binding can lag the completion event. Wait
          // only when this chat actually owns unfinished scheduled work; an
          // ordinary human turn does not pay this synchronization delay.
          const [pending] = yield* sql<{ id: string }>`SELECT id FROM scheduled_followup_runs
            WHERE thread_id = ${threadId} AND state IN ('dispatching','running','unknown') LIMIT 1`;
          while (pending && !row && attempts < 20) {
            attempts++;
            yield* Effect.sleep("100 millis");
            [row] = yield* lookup;
          }
        }
        if (!row) return { notify: true };
        // Native completion can reach Web Push just before its projection. Allow
        // a short, bounded catch-up without delaying unrelated renderer requests
        // indefinitely. Missing canonical evidence always notifies conservatively.
        let outcome = yield* readOutcome(row);
        for (
          ;
          attempts < 20 &&
          !["completed", "error", "interrupted"].includes(outcome.turn?.state ?? "");
          attempts++
        ) {
          yield* Effect.sleep("100 millis");
          outcome = yield* readOutcome(row);
        }
        if (
          !outcome.turn ||
          outcome.turn.state !== "completed" ||
          outcome.turn.changed_control !== 0
        )
          return { notify: true };
        const failed = ["failed", "interrupted", "unknown"].includes(row.state);
        // Absence of an explicit no-change report is conservatively a change, not
        // evidence to conceal useful output. Quiet mode never hides failures.
        return {
          notify:
            failed ||
            row.policy === "all-runs" ||
            (row.policy === "changes-and-errors" &&
              (outcome.report?.result !== "no-change" || outcome.report?.finish === true)),
        };
      }),
    );
  return {
    list,
    save,
    setStatus,
    runNow,
    history,
    notification,
    tick,
    start: () =>
      tick.pipe(
        Effect.catch(() =>
          Effect.logWarning("Scheduled follow-up sweep deferred; durable state retained."),
        ),
        Effect.repeat(Schedule.spaced("15 seconds")),
        Effect.forkScoped,
        Effect.asVoid,
      ),
  } satisfies ScheduledFollowupsShape;
});

export const ScheduledFollowupsLive = Layer.effect(ScheduledFollowups, makeScheduledFollowups);
