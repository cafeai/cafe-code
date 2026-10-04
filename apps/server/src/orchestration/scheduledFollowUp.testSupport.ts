import {
  CommandId,
  MessageId,
  type ModelSelection,
  type RuntimeMode,
  type ThreadId,
  type ThreadTurnStartCommand,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** In-memory synthetic authority shared by engine/reactor integration tests. */
export const seedScheduledFollowUp = (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: ThreadId;
    readonly modelSelection: ModelSelection;
    readonly overrideModelSelection?: ModelSelection;
    readonly runtimeMode?: RuntimeMode;
    readonly createdAt?: string;
  },
) =>
  Effect.gen(function* () {
    const now = input.createdAt ?? "2026-10-04T10:00:00.000Z";
    const scheduleId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const modelSelection = input.overrideModelSelection ?? input.modelSelection;
    const runtimeMode = input.runtimeMode ?? "approval-required";
    const command: typeof ThreadTurnStartCommand.Type = {
      type: "thread.turn.start",
      commandId: CommandId.make(`server:scheduled:${runId}`),
      threadId: input.threadId,
      message: {
        messageId: MessageId.make(`scheduled:${runId}`),
        role: "user",
        text: "Check the synthetic build result once.",
        attachments: [],
      },
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      scheduledFollowUp: {
        scheduleId,
        runId,
        revision: 1,
        expectedModelSelection: input.modelSelection,
        expectedRuntimeMode: runtimeMode,
        expectedInteractionMode: "default",
      },
      createdAt: now,
    };
    const definition = {
      name: "Synthetic build check",
      prompt: command.message.text,
      recurrence: { kind: "interval", anchorAt: now, everyMinutes: 5, timeZone: "UTC" },
      modelSelection: input.overrideModelSelection ?? null,
      notificationPolicy: "changes-and-errors",
      endAt: null,
      maxRuns: null,
      allowAutoFinish: false,
    };
    yield* sql`INSERT INTO scheduled_followups
      (id, thread_id, revision, state, definition_json, authorized_instance_id,
        permission_ceiling, next_run_at, created_at, updated_at, run_count)
      VALUES (${scheduleId}, ${input.threadId}, 1, 'active', ${JSON.stringify(definition)},
        ${modelSelection.instanceId}, ${runtimeMode}, ${now}, ${now}, ${now}, 0)`;
    yield* sql`INSERT INTO scheduled_followup_runs
      (id, schedule_id, revision, thread_id, due_at, state, command_id, message_id,
        intent_sequence, turn_id, model_json, created_at, started_at, completed_at,
        result, summary, error_code, attempt_at)
      VALUES (${runId}, ${scheduleId}, 1, ${input.threadId}, ${now}, 'waiting',
        ${command.commandId}, ${command.message.messageId}, NULL, NULL,
        ${JSON.stringify(modelSelection)}, ${now}, NULL, NULL, NULL, NULL, NULL, NULL)`;
    return command;
  });
