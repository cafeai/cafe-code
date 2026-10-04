import { ThreadId, ScheduledFollowupSaveInput, ScheduledFollowupId } from "@cafecode/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { z } from "zod";
import type { ScheduledFollowupsShape } from "./service.ts";

const id = z.string().min(1).max(200);
const timezone = z.string().min(1).max(100);
const calendarNumbers = (min: number, max: number) =>
  z
    .array(z.number().int().min(min).max(max))
    .min(1)
    .max(max - min + 1);
const recurrence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("once"), at: z.string().max(24), timeZone: timezone }).strict(),
  z
    .object({
      kind: z.literal("interval"),
      anchorAt: z.string().max(24),
      everyMinutes: z.number().int().min(5).max(525600),
      timeZone: timezone,
    })
    .strict(),
  z
    .object({
      kind: z.literal("calendar"),
      timeZone: timezone,
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      weekdays: calendarNumbers(0, 6).optional(),
      monthDays: calendarNumbers(1, 31).optional(),
      months: calendarNumbers(1, 12).optional(),
    })
    .strict(),
]);
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
const run = async <A>(effect: Effect.Effect<A, unknown>) => {
  // Schema failures can include complete prompt values. Never forward decode
  // causes, provider exceptions or raw SQL errors to MCP clients or logging.
  try {
    return await Effect.runPromise(effect);
  } catch {
    throw new Error("Scheduled follow-up request failed. Review the schedule in Tasks.");
  }
};

/**
 * The existing MCP bridge authenticates an owner, NOT a particular conversation
 * or human instruction. Creation/editing therefore produces a review proposal;
 * only the authenticated owner UI can enable/resume paid recurring execution.
 * Tool descriptions are helpful UX, never the actual authorization boundary.
 */
export function registerScheduledFollowupTools(
  server: McpServer,
  service: ScheduledFollowupsShape,
) {
  server.registerTool(
    "request_scheduled_followup",
    {
      title: "Propose a scheduled follow-up",
      description:
        "Use only when the user asks to schedule or repeatedly check something. Creates or replaces a proposal in the exact Cafe chat; the owner must Approve & enable it in Tasks. Never claim it is running before approval. Updating an existing schedule pauses future runs pending review. Does not alter permissions or accounts.",
      inputSchema: {
        threadId: id,
        id: z.uuid().optional(),
        expectedRevision: z.number().int().positive().optional(),
        name: z.string().min(1).max(120),
        prompt: z.string().min(1).max(16000),
        recurrence,
        notificationPolicy: z
          .enum(["changes-and-errors", "all-runs", "errors-only"])
          .default("changes-and-errors"),
        endAt: z.string().max(24).nullable().default(null),
        maxRuns: z.number().int().min(1).max(10000).nullable().default(null),
        allowAutoFinish: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) =>
      result(
        await run(
          Schema.decodeUnknownEffect(ScheduledFollowupSaveInput)({
            ...input,
            modelSelection: null,
          }).pipe(Effect.flatMap((value) => service.save(value, "agent"))),
        ),
      ),
  );
  server.registerTool(
    "list_scheduled_followups",
    {
      title: "List this chat's scheduled follow-ups",
      description:
        "Read schedules for an exact Cafe chat, including proposals awaiting owner approval and recent run outcomes.",
      inputSchema: { threadId: id },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (input) => result(await run(service.list({ threadId: ThreadId.make(input.threadId) }))),
  );
  server.registerTool(
    "pause_scheduled_followup",
    {
      title: "Pause a scheduled follow-up",
      description:
        "Pause future runs without interrupting an already running turn. Resuming requires the owner in Tasks; this tool cannot enable recurring work.",
      inputSchema: { threadId: id, id: z.uuid(), expectedRevision: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) =>
      result(
        await run(
          service.setStatus({
            threadId: ThreadId.make(input.threadId),
            id: ScheduledFollowupId.make(input.id),
            expectedRevision: input.expectedRevision,
            state: "paused",
          }),
        ),
      ),
  );
}
