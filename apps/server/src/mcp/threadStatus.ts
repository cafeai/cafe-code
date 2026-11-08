import { summarizeProject, summarizeThread, threadSummary } from "./views.ts";
// Native content-free observation digest, never an execution capability.
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProjectId, ThreadId } from "@cafecode/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { z } from "zod";
import { type CafeMcpDependencies, type CafeMcpServerOptions } from "./CafeMcpServer.ts";
import { jsonToolResult, McpToolError } from "./results.ts";
import { operationScopeId } from "./operations.ts";
import { withStatusWait } from "./statusWait.ts";

const explicitThreadId = z.string().trim().min(1).max(4096);
const observationSchema = () =>
  z.object({
    thread: threadSummary,
    observationToken: z.string(),
    observedAt: z.string(),
    waitingFor: z.enum(["approval", "user-input", "provider", "live-agents", "none"]),
    rootComplete: z.boolean().nullable(),
    wholeChatIdle: z.boolean(),
    pendingTurnStart: z.object({ messageId: z.string(), requestedAt: z.string() }).nullable(),
  });
const encodeObservation = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

function readStatus(dependencies: CafeMcpDependencies, threadId: string) {
  return Effect.gen(function* () {
    const snapshot = yield* dependencies.projectionSnapshotQuery
      .getThreadWorkStatusById(ThreadId.make(threadId))
      .pipe(
        Effect.mapError(() => new McpToolError("unavailable", "Thread status is unavailable.")),
      );
    if (Option.isNone(snapshot))
      return yield* Effect.fail(
        new McpToolError("not_found", "The requested active Cafe chat does not exist."),
      );
    const shell = snapshot.value.thread;
    const pendingTurnStart = snapshot.value.pendingTurnStart;
    const thread = summarizeThread(shell);
    const live =
      (thread.liveWork?.agentCount ?? 0) > 0 ||
      (thread.liveWork?.taskCount ?? 0) > 0 ||
      (thread.liveWork?.unconfirmedAgentCount ?? 0) > 0 ||
      thread.liveWork?.unconfirmedAgentCountTruncated === true;
    const rootRunning =
      thread.activeTurnId !== null ||
      thread.latestTurn?.state === "running" ||
      thread.status === "starting" ||
      thread.status === "running";
    const waitingFor = thread.hasPendingApprovals
      ? ("approval" as const)
      : thread.hasPendingUserInput
        ? ("user-input" as const)
        : rootRunning || pendingTurnStart !== null
          ? ("provider" as const)
          : live
            ? ("live-agents" as const)
            : ("none" as const);
    // Include exact projected runtime/session changes even if public counters
    // are equal. The token observes state only and never attests native adoption.
    const token = createHash("sha256")
      .update(
        encodeObservation({
          thread,
          pendingTurnStart,
          session: {
            providerInstanceId: shell.session?.providerInstanceId,
            updatedAt: shell.session?.updatedAt,
          },
        }),
      )
      .digest("hex");
    return {
      thread,
      observationToken: token,
      observedAt: DateTime.formatIso(yield* DateTime.now),
      waitingFor,
      rootComplete: thread.latestTurn === null ? null : thread.latestTurn.state !== "running",
      wholeChatIdle:
        !rootRunning &&
        !live &&
        pendingTurnStart === null &&
        !thread.hasPendingApprovals &&
        !thread.hasPendingUserInput,
      pendingTurnStart,
    };
  });
}

export function registerThreadStatusTools(
  server: McpServer,
  dependencies: CafeMcpDependencies,
  options: CafeMcpServerOptions,
): void {
  const observation = observationSchema();
  server.registerTool(
    "get_cafe_context",
    {
      title: "Get this Cafe chat's context",
      description:
        "Start here to identify the authenticated launch Cafe chat, project, workspace and saved versus current provider. No inventories, transcripts, provider probes or paid calls. Omit threadId only on a Cafe-issued connection; inherited subagents still target the launch Cafe chat. Manual clients supply an exact ID. This is recorded context, not native ownership proof.",
      inputSchema: { threadId: explicitThreadId.optional() },
      outputSchema: z.object({
        thread: threadSummary,
        target: z.object({
          selection: z.enum(["explicit", "authenticated-launch"]),
          launchMatchesSession: z.boolean().nullable(),
        }),
        project: z
          .object({
            id: z.string(),
            title: z.string(),
            workspaceRoot: z.string(),
            additionalWorkspaceRoots: z.array(z.string()),
          })
          .nullable(),
        provider: z.object({
          configuredInstanceId: z.string(),
          sessionInstanceId: z.string().nullable(),
        }),
        operationScope: z
          .object({
            scope: z.literal("bearer-session"),
            scopeId: z.string(),
            expiresAt: z.string(),
          })
          .nullable(),
        contractVersion: z.literal(2),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ threadId }) => {
      const selected = threadId ?? options.managementLaunchContext?.threadId;
      if (!selected)
        throw new McpToolError(
          "invalid_request",
          "Pass threadId explicitly; this connection has no authenticated Cafe launch chat.",
        );
      return jsonToolResult(
        await Effect.runPromise(
          Effect.gen(function* () {
            const shell = yield* dependencies.projectionSnapshotQuery
              .getThreadShellById(ThreadId.make(selected))
              .pipe(
                Effect.mapError(
                  () => new McpToolError("unavailable", "Cafe chat context is unavailable."),
                ),
              );
            if (Option.isNone(shell))
              return yield* Effect.fail(
                new McpToolError("not_found", "The requested active Cafe chat does not exist."),
              );
            const project =
              shell.value.projectId === null
                ? Option.none()
                : yield* dependencies.projectionSnapshotQuery
                    .getProjectShellById(ProjectId.make(shell.value.projectId))
                    .pipe(
                      Effect.mapError(
                        () =>
                          new McpToolError("unavailable", "Cafe project context is unavailable."),
                      ),
                    );
            const sessionId = shell.value.session?.providerInstanceId ?? null;
            const summary = Option.isSome(project) ? summarizeProject(project.value) : null;
            return {
              thread: summarizeThread(shell.value),
              target: {
                selection: threadId ? ("explicit" as const) : ("authenticated-launch" as const),
                launchMatchesSession:
                  options.managementLaunchContext?.threadId === shell.value.id && sessionId
                    ? options.managementLaunchContext.providerInstanceId === sessionId
                    : null,
              },
              project: summary
                ? {
                    id: summary.id,
                    title: summary.title,
                    workspaceRoot: summary.workspaceRoot,
                    additionalWorkspaceRoots: summary.additionalWorkspaceRoots,
                  }
                : null,
              provider: {
                configuredInstanceId: shell.value.modelSelection.instanceId,
                sessionInstanceId: sessionId,
              },
              operationScope: options.operationOwner
                ? {
                    scope: "bearer-session" as const,
                    scopeId: operationScopeId(options.operationOwner),
                    expiresAt: options.operationOwner.expiresAt,
                  }
                : null,
              contractVersion: 2 as const,
            };
          }),
        ),
      );
    },
  );
  server.registerTool(
    "get_thread_status",
    {
      title: "Read Cafe chat work and attention status",
      description:
        "Read lightweight root-turn state, live child counts, pending approvals/questions and a safe failure flag. No messages or native probes. Root completion can coexist with live agents. Use observationToken with wait_for_thread instead of repeatedly loading transcripts.",
      inputSchema: { threadId: explicitThreadId },
      outputSchema: observation,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ threadId }) =>
      jsonToolResult(await Effect.runPromise(readStatus(dependencies, threadId))),
  );
  server.registerTool(
    "wait_for_thread",
    {
      title: "Wait for a Cafe chat status change",
      description:
        "Wait up to 25 seconds for this exact observation to change or require attention. Optional turnId stops waiting if that turn is replaced. Returns changed, attention, turn-changed or timeout; timeout is not completion. Cancellation releases the wait. No transcript reads, inference, work creation or native ownership renewal.",
      inputSchema: {
        threadId: explicitThreadId,
        observationToken: z.string().regex(/^[a-f0-9]{64}$/),
        turnId: explicitThreadId.optional(),
        timeoutMs: z.number().int().min(0).max(25_000).default(20_000),
      },
      outputSchema: observation.extend({
        reason: z.enum(["changed", "attention", "turn-changed", "timeout"]),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ threadId, observationToken, turnId, timeoutMs }, extra) => {
      const signal = options.requestSignal
        ? AbortSignal.any([extra.signal, options.requestSignal])
        : extra.signal;
      return jsonToolResult(
        await Effect.runPromise(
          withStatusWait(
            Effect.gen(function* () {
              const started = yield* Clock.currentTimeNanos;
              while (true) {
                const status = yield* readStatus(dependencies, threadId);
                if (
                  turnId !== undefined &&
                  (status.thread.activeTurnId ?? status.thread.latestTurn?.turnId) !== turnId
                )
                  return { ...status, reason: "turn-changed" as const };
                if (status.waitingFor === "approval" || status.waitingFor === "user-input")
                  return { ...status, reason: "attention" as const };
                if (status.observationToken !== observationToken)
                  return { ...status, reason: "changed" as const };
                const remaining =
                  timeoutMs - Number((yield* Clock.currentTimeNanos) - started) / 1_000_000;
                if (remaining <= 0) return { ...status, reason: "timeout" as const };
                yield* Effect.sleep(Math.min(remaining, 500));
              }
            }),
          ),
          { signal },
        ).catch((error: unknown) => {
          if (signal.aborted) throw new McpToolError("cancelled", "The status wait was cancelled.");
          throw error;
        }),
      );
    },
  );
}
