import {
  ApprovalRequestId,
  CommandId,
  EventId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import { normalizeCodexAsyncQuestions } from "@cafecode/shared/codexAsyncQuestions";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { z } from "zod";

import {
  derivePendingQuestionRequests,
  validatePendingQuestionResponse,
  type PendingQuestionRequest,
} from "../orchestration/pendingQuestions.ts";
import type { CafeMcpDependencies } from "./CafeMcpServer.ts";
import type { ProjectionThreadQuestionContext } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const entityId = z.string().trim().min(1).max(4_096);
const callbackTarget = z.object({
  kind: z.literal("callback"),
  // Native request identifiers are opaque. Preserve bytes returned by list,
  // including surrounding whitespace, rather than normalize another owner.
  requestId: z.string().min(1).max(4_096),
  createdAt: z.string().min(1).max(128),
});
const asyncTarget = z.object({
  kind: z.literal("async"),
  activityId: z.string().regex(/^codex-async-questions:[a-f0-9]{64}$/u),
  questionIndex: z.number().int().min(0).max(15),
});
const targetSchema = z.discriminatedUnion("kind", [callbackTarget, asyncTarget]);
const cursorSchema = z.object({
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  createdAt: z.string().min(1).max(128),
  activityId: entityId,
});
const questionSchema = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string() })),
  multiSelect: z.boolean().optional(),
});
const summarySchema = z.object({
  target: targetSchema,
  questionCount: z.number().int().nonnegative(),
  isBlocking: z.boolean(),
  canAnswer: z.boolean(),
  canSkip: z.boolean(),
  canClear: z.boolean(),
  unsupportedReason: z.string().nullable(),
});
const receiptSchema = z.object({
  threadId: entityId,
  target: targetSchema,
  accepted: z.literal(true),
  resolution: z.enum(["provider-confirmation-required", "recorded"]),
  sequence: z.number().int().nonnegative(),
  noticeMessageId: entityId,
  messageId: entityId.optional(),
});
const encodeDetailJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

function boundedDetail<A>(detail: A): A {
  // JSON escaping can enlarge a valid provider questionnaire. Refuse the
  // complete detail rather than truncate actionable wording or option labels.
  if (Buffer.byteLength(encodeDetailJson(detail), "utf8") > 1_048_576)
    throw new Error(
      "The complete question details exceed the MCP size limit. Use the Cafe interface.",
    );
  return detail;
}

/** The endpoint is owner-authenticated; provider callback ownership remains
 * independent and is rechecked by the serialized engine and native adapter. */
async function execute<A, E>(effect: Effect.Effect<A, E>, failure: string): Promise<A> {
  try {
    return await Effect.runPromise(effect);
  } catch {
    // Database/provider failures can include credentials, paths or question
    // contents. Only our closed preflight failures are suitable tool errors.
    throw new Error(failure);
  }
}

function result<T extends Record<string, unknown>>(value: T, text: string) {
  return { structuredContent: value, content: [{ type: "text" as const, text }] };
}

function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/** Reconstruct only inert, bounded data before the shared normalizer reads it.
 * A genuine DB projection is JSON; this also refuses accessors in legacy or
 * synthetic records without running them while inspecting a question. */
function readAsyncActivity(activity: OrchestrationThreadActivity) {
  if (
    activity.kind !== "provider.async-questions" ||
    !/^codex-async-questions:[a-f0-9]{64}$/u.test(activity.id)
  )
    return null;
  const raw = own(activity.payload, "questions");
  if (!Array.isArray(raw)) return null;
  const rawLength = own(raw, "length");
  if (!Number.isSafeInteger(rawLength) || (rawLength as number) < 0) return null;
  const candidates: unknown[] = [];
  for (let index = 0; index < Math.min(rawLength as number, 16); index += 1) {
    const row = own(raw, String(index));
    const options = own(row, "options");
    const safeOptions: unknown[] = [];
    if (Array.isArray(options)) {
      const optionLength = own(options, "length");
      if (!Number.isSafeInteger(optionLength) || (optionLength as number) < 0) return null;
      for (let option = 0; option < Math.min(optionLength as number, 32); option += 1)
        safeOptions.push(own(options, String(option)));
    }
    candidates.push({
      title: own(row, "title"),
      ...(options !== undefined ? { options: Array.isArray(options) ? safeOptions : options } : {}),
    });
  }
  const questions = normalizeCodexAsyncQuestions(candidates);
  if (questions.length === 0) return null;
  const rawHandled = own(activity.payload, "handledQuestionIndexes");
  const handled = new Set<number>();
  if (rawHandled !== undefined) {
    if (!Array.isArray(rawHandled)) return null;
    const handledLength = own(rawHandled, "length");
    if (
      !Number.isSafeInteger(handledLength) ||
      (handledLength as number) < 0 ||
      (handledLength as number) > 16
    )
      return null;
    for (let index = 0; index < (handledLength as number); index += 1) {
      const value = own(rawHandled, String(index));
      if (
        !Number.isSafeInteger(value) ||
        (value as number) < 0 ||
        (value as number) >= questions.length
      )
        return null;
      handled.add(value as number);
    }
  }
  return { questions, handled };
}

async function readThread(dependencies: CafeMcpDependencies, requestedId: string) {
  const thread = await execute(
    dependencies.projectionSnapshotQuery.getThreadQuestionContextById(ThreadId.make(requestedId)),
    "Unable to read pending questions.",
  );
  if (Option.isNone(thread) || thread.value.deletedAt !== null)
    throw new Error("This chat is unavailable.");
  return thread.value;
}

function findCallback(
  thread: ProjectionThreadQuestionContext,
  target: z.infer<typeof callbackTarget>,
) {
  const request = derivePendingQuestionRequests(thread.activities).find(
    (entry) => entry.requestId === target.requestId && entry.createdAt === target.createdAt,
  );
  if (!request)
    throw new Error("This question request is no longer pending. Read its current details first.");
  return request;
}

async function findAsync(
  dependencies: CafeMcpDependencies,
  threadId: string,
  target: z.infer<typeof asyncTarget>,
) {
  const row = await execute(
    dependencies.projectionSnapshotQuery.getThreadAsyncQuestionActivity({
      threadId: ThreadId.make(threadId),
      activityId: EventId.make(target.activityId),
    }),
    "Unable to read this question.",
  );
  const parsed = Option.isSome(row) ? readAsyncActivity(row.value) : null;
  const question = parsed?.questions[target.questionIndex];
  if (!parsed || !question || parsed.handled.has(target.questionIndex))
    throw new Error("This question is unavailable or has already been handled.");
  return question;
}

function callbackSummary(request: PendingQuestionRequest) {
  const supported = request.unsupportedReason === null;
  return {
    target: {
      kind: "callback" as const,
      requestId: request.requestId,
      createdAt: request.createdAt,
    },
    questionCount: request.questions.length,
    isBlocking: request.isBlocking,
    canAnswer: supported,
    canSkip: supported && request.supportsUnanswered,
    canClear: supported && request.supportsUnanswered,
    unsupportedReason: request.unsupportedReason,
  };
}

function requireValidCallback(
  request: PendingQuestionRequest,
  target: z.infer<typeof callbackTarget>,
  answers: unknown,
  unanswered: unknown,
) {
  const checked = validatePendingQuestionResponse(request, {
    expectedRequestCreatedAt: target.createdAt,
    answers,
    ...(unanswered !== undefined ? { unanswered } : {}),
  });
  if (!checked.ok) throw new Error(checked.reason);
  return checked;
}

async function dispatch(dependencies: CafeMcpDependencies, command: OrchestrationCommand) {
  return execute(
    dependencies.startup.enqueueCommand(dependencies.orchestrationEngine.dispatch(command)),
    "Unable to submit this question action. Read its current state before trying again.",
  );
}

/** Enumerations are bounded keyset reads. Every page repeats the current native
 * callback view; a cursor/omission can never prove that the whole chat is empty. */
export function registerThreadQuestionTools(
  server: McpServer,
  dependencies: CafeMcpDependencies,
): void {
  server.registerTool(
    "list_thread_questions",
    {
      title: "List pending chat questions",
      description:
        "List current native question requests and one bounded page of inline async questions for an explicit Cafe chat. Summaries omit question text; use get_thread_question for full details. Native requests repeat on each page. Follow nextCursor while hasMore is true; an empty incomplete view reports hasPendingQuestions=null, never false. Permission approvals are separate and cannot be approved by these tools.",
      inputSchema: {
        threadId: entityId,
        limit: z.number().int().min(1).max(64).default(20),
        before: cursorSchema.optional(),
      },
      outputSchema: z.object({
        threadId: entityId,
        questions: z.array(summarySchema),
        nativePendingRequestCount: z.number().int().nonnegative(),
        asyncPendingQuestionCount: z.number().int().nonnegative(),
        hasPendingQuestions: z.boolean().nullable(),
        hasMore: z.boolean(),
        nextCursor: cursorSchema.nullable(),
        omissions: z.object({
          nativeRequests: z.boolean().nullable(),
          asyncActivities: z.number().int().nonnegative(),
          unavailableAsyncActivities: z.number().int().nonnegative(),
        }),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ threadId, limit, before }) => {
      const thread = await readThread(dependencies, threadId);
      const callbacks = derivePendingQuestionRequests(thread.activities);
      const page = await execute(
        dependencies.projectionSnapshotQuery.getThreadAsyncQuestionActivitiesPage({
          threadId: thread.id,
          limit,
          ...(before !== undefined
            ? { before: { ...before, activityId: EventId.make(before.activityId) } }
            : {}),
        }),
        "Unable to read pending questions.",
      );
      const questions: z.infer<typeof summarySchema>[] = callbacks.map(callbackSummary);
      let unavailableAsyncActivities = 0;
      let asyncPendingQuestionCount = 0;
      for (const activity of page.activities) {
        const parsed = readAsyncActivity(activity);
        if (!parsed) {
          unavailableAsyncActivities += 1;
          continue;
        }
        parsed.questions.forEach((_question, questionIndex) => {
          if (parsed.handled.has(questionIndex)) return;
          asyncPendingQuestionCount += 1;
          questions.push({
            target: { kind: "async", activityId: activity.id, questionIndex },
            questionCount: 1,
            isBlocking: false,
            canAnswer: true,
            canSkip: true,
            canClear: true,
            unsupportedReason: null,
          });
        });
      }
      const nativeRequests = thread.pendingRequestRetentionTruncated ?? null;
      const complete =
        before === undefined &&
        !page.hasMore &&
        nativeRequests === false &&
        page.omittedCount === 0 &&
        unavailableAsyncActivities === 0;
      return result(
        {
          threadId,
          questions,
          nativePendingRequestCount: callbacks.length,
          asyncPendingQuestionCount,
          hasPendingQuestions: questions.length > 0 ? true : complete ? false : null,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
          omissions: {
            nativeRequests,
            asyncActivities: page.omittedCount,
            unavailableAsyncActivities,
          },
        },
        `Read ${questions.length} pending question summaries. Follow pagination and omission metadata before concluding this chat has no questions.`,
      );
    },
  );

  server.registerTool(
    "get_thread_question",
    {
      title: "Read a pending question",
      description:
        "Read the complete exact native questionnaire or one inline async question. Copy the target from list_thread_questions. Unsupported native interactions are reported without exposing approval payloads. This read never answers, clears, refreshes or cancels a request.",
      inputSchema: { threadId: entityId, target: targetSchema },
      outputSchema: z.object({
        threadId: entityId,
        target: targetSchema,
        detail: z.discriminatedUnion("kind", [
          z.object({
            kind: z.literal("callback"),
            questions: z.array(questionSchema),
            isBlocking: z.boolean(),
            supportsUnanswered: z.boolean(),
            supported: z.boolean(),
            unsupportedReason: z.string().nullable(),
          }),
          z.object({ kind: z.literal("async"), title: z.string(), options: z.array(z.string()) }),
        ]),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ threadId, target }) => {
      const thread = await readThread(dependencies, threadId);
      if (target.kind === "callback") {
        const request = findCallback(thread, target);
        return result(
          {
            threadId,
            target,
            detail: boundedDetail({
              kind: "callback" as const,
              questions: request.questions,
              isBlocking: request.isBlocking,
              supportsUnanswered: request.supportsUnanswered,
              supported: request.unsupportedReason === null,
              unsupportedReason: request.unsupportedReason,
            }),
          },
          "Read the complete pending questionnaire.",
        );
      }
      const question = await findAsync(dependencies, threadId, target);
      return result(
        {
          threadId,
          target,
          detail: boundedDetail({
            kind: "async" as const,
            title: question.title,
            options: [...question.options],
          }),
        },
        "Read the complete pending inline question.",
      );
    },
  );

  server.registerTool(
    "answer_thread_question",
    {
      title: "Answer a pending question",
      description:
        "Answer an exact pending request. For a native callback, supply a complete answers map keyed by question ID, with optional explicit skipped/dismissed unanswered dispositions only when supported. Inline async questions use answer text. The backend records an MCP-origin notice. A callback acknowledgement is accepted work, not proof of native resolution; reread pending questions after provider confirmation. Never automatically retry an uncertain mutation response.",
      // Zod records strip the valid opaque key __proto__. Leave these two maps
      // intact for the shared own-data parser, which enforces their complete
      // bounded key/value/disposition contract before any command is admitted.
      inputSchema: {
        threadId: entityId,
        target: targetSchema,
        answers: z
          .unknown()
          .optional()
          .describe(
            "Complete native question-ID map of nonempty text or selected text arrays; at most 64 entries and 64 KiB encoded.",
          ),
        unanswered: z
          .unknown()
          .optional()
          .describe(
            "Optional native question-ID map of explicit skipped or dismissed dispositions; only supported callbacks permit it, and every question must appear exactly once across both maps.",
          ),
        answer: z.string().min(1).max(PROVIDER_SEND_TURN_MAX_INPUT_CHARS).optional(),
      },
      outputSchema: receiptSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ threadId, target, answers, unanswered, answer }) => {
      const thread = await readThread(dependencies, threadId);
      const noticeMessageId = MessageId.make(crypto.randomUUID());
      const base = {
        commandId: CommandId.make(crypto.randomUUID()),
        threadId: thread.id,
        noticeMessageId,
        createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
      };
      if (target.kind === "callback") {
        if (answer !== undefined || answers === undefined)
          throw new Error("Use the complete answers map for a native questionnaire.");
        const checked = requireValidCallback(
          findCallback(thread, target),
          target,
          answers,
          unanswered,
        );
        const receipt = await dispatch(dependencies, {
          ...base,
          type: "thread.mcp-user-input.respond",
          requestId: ApprovalRequestId.make(target.requestId),
          expectedRequestCreatedAt: target.createdAt,
          answers: checked.answers,
          ...(checked.unanswered !== undefined ? { unanswered: checked.unanswered } : {}),
          action: "answered",
        });
        return result(
          {
            threadId,
            target,
            accepted: true as const,
            resolution: "provider-confirmation-required" as const,
            sequence: receipt.sequence,
            noticeMessageId,
          },
          "The response was accepted for provider delivery. Native resolution has not been confirmed by this acknowledgement.",
        );
      }
      if (
        answers !== undefined ||
        unanswered !== undefined ||
        answer === undefined ||
        answer.trim().length === 0
      )
        throw new Error("Use nonempty answer text for an inline question.");
      await findAsync(dependencies, threadId, target);
      const messageId = MessageId.make(crypto.randomUUID());
      const receipt = await dispatch(dependencies, {
        ...base,
        type: "thread.async-question.answer",
        activityId: EventId.make(target.activityId),
        questionIndex: target.questionIndex,
        answer,
        messageId,
      });
      return result(
        {
          threadId,
          target,
          accepted: true as const,
          resolution: "recorded" as const,
          sequence: receipt.sequence,
          messageId,
          noticeMessageId,
        },
        "The inline answer and handled state were recorded durably. This is not proof of paid provider submission or completion.",
      );
    },
  );

  for (const [name, action, disposition] of [
    ["skip_thread_question", "skipped", "skipped"],
    ["clear_thread_question", "cleared", "dismissed"],
  ] as const) {
    server.registerTool(
      name,
      {
        title: action === "skipped" ? "Skip a pending question" : "Clear a pending question",
        description:
          "Explicitly skip or dismiss this exact question. A native target acts on every question in that callback and requires its explicit unanswered capability. An inline target records handling only. This does not delete chat messages, approve permissions or pretend an answer was supplied. The backend records an MCP-origin notice; never automatically retry an uncertain mutation response.",
        inputSchema: { threadId: entityId, target: targetSchema },
        outputSchema: receiptSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async ({ threadId, target }) => {
        const thread = await readThread(dependencies, threadId);
        const noticeMessageId = MessageId.make(crypto.randomUUID());
        const base = {
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: thread.id,
          noticeMessageId,
          createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
        };
        if (target.kind === "callback") {
          const request = findCallback(thread, target);
          const unanswered = Object.fromEntries(
            request.questions.map((question) => [question.id, disposition]),
          );
          const checked = requireValidCallback(request, target, {}, unanswered);
          const receipt = await dispatch(dependencies, {
            ...base,
            type: "thread.mcp-user-input.respond",
            requestId: ApprovalRequestId.make(target.requestId),
            expectedRequestCreatedAt: target.createdAt,
            answers: checked.answers,
            ...(checked.unanswered !== undefined ? { unanswered: checked.unanswered } : {}),
            action,
          });
          return result(
            {
              threadId,
              target,
              accepted: true as const,
              resolution: "provider-confirmation-required" as const,
              sequence: receipt.sequence,
              noticeMessageId,
            },
            "The unanswered response was accepted for provider delivery. Native resolution still requires provider confirmation.",
          );
        }
        await findAsync(dependencies, threadId, target);
        const receipt = await dispatch(dependencies, {
          ...base,
          type: "thread.mcp-async-questions.resolve",
          activityId: EventId.make(target.activityId),
          questionIndexes: [target.questionIndex],
          action,
        });
        return result(
          {
            threadId,
            target,
            accepted: true as const,
            resolution: "recorded" as const,
            sequence: receipt.sequence,
            noticeMessageId,
          },
          "The selected inline question was explicitly marked handled without supplying an answer.",
        );
      },
    );
  }
}
