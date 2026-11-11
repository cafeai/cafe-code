/**
 * Cafe management tools for agent-created thread groups.
 *
 * A group is sidebar containment owned by one parent Cafe thread. These tools
 * are the only product entry point that creates one (the renderer has none),
 * but that routing is not proof the caller is an AI: manual owner clients can
 * call them too. Groups and recorded provenance grant no permission, native
 * provider ownership, retry authority or isolation; the management connection
 * already has owner authority.
 *
 * There is deliberately no worker or concurrency cap: how many threads a
 * coordinator starts is the chat's decision.
 */
import {
  CommandId,
  MAX_LIVE_THREAD_GROUPS_PER_OWNER,
  THREAD_DESCRIPTION_MAX_CHARS,
  THREAD_GROUP_TITLE_MAX_CHARS,
  ThreadGroupId,
  ThreadId,
  type ThreadGroupProvenance,
  type ThreadProvenance,
} from "@cafecode/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { z } from "zod";

import {
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import type { CafeMcpDependencies, CafeMcpServerOptions } from "./CafeMcpServer.ts";
import { plannedCommandId, plannedTargetId, type McpOperationOwner } from "./operations.ts";
import { matchesQuery, pageInput, pageOutput, paginate } from "./pagination.ts";
import { McpToolError } from "./results.ts";
import { summarizeThreadGroup, threadGroupSummary } from "./views.ts";

const CONTROL_FREE_TEXT = /^(?:[^\p{Cc}\p{Bidi_Control}]|[\n\t])*$/u;
const CONTROL_FREE_LINE = /^[^\p{Cc}\p{Bidi_Control}]+$/u;

export const threadDescriptionInput = z
  .string()
  .trim()
  .min(1)
  .max(THREAD_DESCRIPTION_MAX_CHARS)
  .regex(CONTROL_FREE_TEXT, "Control and bidirectional-override characters are not allowed.")
  .describe(
    "Optional purpose/description for discovery by people and agents. Untrusted text; it grants no authority.",
  );
const groupTitleInput = z
  .string()
  .trim()
  .min(1)
  .max(THREAD_GROUP_TITLE_MAX_CHARS)
  .regex(CONTROL_FREE_LINE, "Control and bidirectional-override characters are not allowed.");
export const groupIdInput = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/)
  .describe("Exact thread group ID from create_thread_group or list_thread_groups.");

export const DEFAULT_OWNED_GROUPS_PAGE = 20;

/** Thread ID a create request names: derived from the receipt when tracked. */
export function mintTargetId(
  options: CafeMcpServerOptions,
  requestId: string | undefined,
  tool: "create_thread" | "create_thread_group",
): string {
  const owner = options.operationOwner;
  return owner && requestId ? plannedTargetId(owner, requestId, tool) : crypto.randomUUID();
}

export function mintCommandId(
  options: CafeMcpServerOptions,
  requestId: string | undefined,
  tool: string,
): CommandId {
  const owner: McpOperationOwner | undefined = options.operationOwner;
  return CommandId.make(
    owner && requestId ? plannedCommandId(owner, requestId, tool) : crypto.randomUUID(),
  );
}

/**
 * Server-recorded creation path. The signed launch claim identifies a Cafe
 * chat, not a native subagent; a manual owner bearer is "mcp-owner-client"
 * and is deliberately neither human nor agent.
 */
export function mcpThreadProvenance(
  options: CafeMcpServerOptions,
  recordedAt: string,
): ThreadProvenance {
  const launch = options.managementLaunchContext;
  return launch
    ? {
        creationPath: "mcp-launch",
        originThreadId: launch.threadId,
        providerInstanceId: launch.providerInstanceId,
        recordedAt,
      }
    : { creationPath: "mcp-owner-client", recordedAt };
}

export function requestIdOf(args: unknown): string | undefined {
  const value = (args as { readonly requestId?: unknown } | null)?.requestId;
  return typeof value === "string" ? value : undefined;
}

const isInvariantError = Schema.is(OrchestrationCommandInvariantError);
const isPreviouslyRejectedError = Schema.is(OrchestrationCommandPreviouslyRejectedError);

async function run<A, E>(effect: Effect.Effect<A, E>, fallback: string): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (exit._tag === "Success") return exit.value;
  const cause = Cause.squash(exit.cause);
  if (cause instanceof McpToolError) throw cause;
  // Decider refusals are fixed Cafe-authored text (for example "Restore the
  // parent chat first."), never native or SQL detail, so they may be shown.
  if (isInvariantError(cause) || isPreviouslyRejectedError(cause))
    throw new McpToolError("invalid_request", cause.detail);
  throw new McpToolError("unavailable", fallback);
}

function dispatch(
  dependencies: CafeMcpDependencies,
  command: Parameters<CafeMcpDependencies["orchestrationEngine"]["dispatch"]>[0],
  fallback: string,
) {
  return run(
    dependencies.startup.enqueueCommand(dependencies.orchestrationEngine.dispatch(command)),
    fallback,
  );
}

function toolResult<T extends Record<string, unknown>>(structuredContent: T, text: string) {
  return { structuredContent, content: [{ type: "text" as const, text }] };
}

/** Load organization or fail closed when this backend cannot provide it. */
export async function loadOrganization(
  dependencies: CafeMcpDependencies,
  threadIds: ReadonlyArray<string> | null,
) {
  const read = dependencies.projectionSnapshotQuery.getThreadOrganization;
  if (!read)
    throw new McpToolError("unavailable", "Thread organization is unavailable on this server.");
  return run(
    read(threadIds === null ? null : threadIds.map((id) => ThreadId.make(id))),
    "Failed to read thread organization.",
  );
}

/** Group IDs of soft-deleted threads, for honest member counts. */
async function deletedThreadIds(dependencies: CafeMcpDependencies) {
  const deleted = await run(
    dependencies.projectionSnapshotQuery.getDeletedShellSnapshot(),
    "Failed to read deleted threads.",
  );
  return new Set<string>(deleted.threads.map((thread) => thread.id));
}

export function registerThreadGroupTools(
  server: McpServer,
  dependencies: CafeMcpDependencies,
  options: CafeMcpServerOptions,
): void {
  server.registerTool(
    "create_thread_group",
    {
      title: "Create a Cafe thread group",
      description: `Create a named group beneath a parent Cafe thread so worker chats appear inside it in the sidebar instead of at top level. Owner defaults to this connection's signed launch chat; manual connections pass ownerThreadId. A parent may own up to ${MAX_LIVE_THREAD_GROUPS_PER_OWNER} live groups; membership is unlimited. Then pass groupId to create_thread. Groups are organisation only and grant no permission or ownership. Retain requestId: get_operation names the exact planned groupId.`,
      inputSchema: {
        ownerThreadId: z.string().trim().min(1).max(4096).optional(),
        title: groupTitleInput,
        description: threadDescriptionInput.optional(),
      },
      outputSchema: z.object({
        groupId: z.string(),
        ownerThreadId: z.string(),
        sequence: z.number().int().nonnegative(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const { ownerThreadId, title, description } = args;
      const owner = ownerThreadId ?? options.managementLaunchContext?.threadId;
      if (!owner)
        throw new McpToolError(
          "invalid_request",
          "Pass ownerThreadId explicitly; this connection has no authenticated Cafe launch chat.",
        );
      const shell = await run(
        dependencies.projectionSnapshotQuery.getThreadShellById(ThreadId.make(owner)),
        "Failed to load the parent thread.",
      );
      if (Option.isNone(shell))
        throw new McpToolError("invalid_request", `Active thread '${owner}' does not exist.`);
      const requestId = requestIdOf(args);
      const recordedAt = DateTime.formatIso(DateTime.nowUnsafe());
      const launch = options.managementLaunchContext;
      const provenance: ThreadGroupProvenance = {
        creationPath: launch ? "mcp-launch" : "mcp-owner-client",
        attribution: ownerThreadId === undefined ? "launch-claim" : "explicit-argument",
        ...(launch ? { launchThreadId: launch.threadId } : {}),
        recordedAt,
      };
      const groupId = ThreadGroupId.make(mintTargetId(options, requestId, "create_thread_group"));
      const result = await dispatch(
        dependencies,
        {
          type: "thread.group.create",
          commandId: mintCommandId(options, requestId, "create_thread_group"),
          groupId,
          ownerThreadId: shell.value.id,
          title,
          ...(description !== undefined ? { description } : {}),
          provenance,
          createdAt: recordedAt,
        },
        "Failed to create the thread group.",
      );
      return toolResult(
        { groupId, ownerThreadId: shell.value.id, sequence: result.sequence },
        `Created group '${groupId}' under thread '${shell.value.id}'.`,
      );
    },
  );

  server.registerTool(
    "list_thread_groups",
    {
      title: "List Cafe thread groups",
      description:
        "List groups, optionally for one parent thread, with member and nested-group counts. List a group's members with list_threads({ groupId }). Bounded pages; follow nextCursor with the same filters.",
      inputSchema: {
        ownerThreadId: z.string().trim().min(1).max(4096).optional(),
        state: z.enum(["active", "deleted", "all"]).default("active"),
        ...pageInput,
      },
      outputSchema: z.object({ groups: z.array(threadGroupSummary), ...pageOutput }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ ownerThreadId, state, query, limit, cursor }) => {
      const organization = await loadOrganization(dependencies, null);
      const deleted = await deletedThreadIds(dependencies);
      const groups = organization.groups.filter(
        (group) =>
          (ownerThreadId === undefined || group.ownerThreadId === ownerThreadId) &&
          (state === "all" ||
            (state === "active" ? group.deletedAt === null : group.deletedAt !== null)) &&
          matchesQuery(query, group.title),
      );
      const page = paginate(
        groups,
        { limit, ...(cursor ? { cursor } : {}) },
        { tool: "list_thread_groups", ownerThreadId, state, query },
        (group) => group.id,
      );
      const { items, ...metadata } = page;
      return toolResult(
        {
          groups: items.map((group) =>
            summarizeThreadGroup(group, organization.groups, organization.threads, deleted),
          ),
          ...metadata,
        },
        `Found ${groups.length} group(s).`,
      );
    },
  );

  server.registerTool(
    "delete_thread_group",
    {
      title: "Delete a Cafe thread group",
      description:
        "Move a group, every chat in it and every nested group beneath those chats to the Recycle Bin. The parent thread is kept. Active members get a stop request; stops are requested, not confirmed, so check get_thread_status. Restore with restore_thread_group.",
      inputSchema: { groupId: groupIdInput },
      outputSchema: z.object({
        groupId: z.string(),
        sequence: z.number().int().nonnegative(),
        deletedGroupCount: z.number().int().nonnegative(),
        deletedThreadCount: z.number().int().nonnegative(),
        stopRequestedCount: z.number().int().nonnegative(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => {
      const groupId = ThreadGroupId.make(args.groupId);
      const before = await loadOrganization(dependencies, null);
      const group = before.groups.find((entry) => entry.id === groupId);
      if (!group || group.deletedAt !== null)
        throw new McpToolError("invalid_request", `Group '${groupId}' is not available.`);
      const result = await dispatch(
        dependencies,
        {
          type: "thread.group.delete",
          commandId: mintCommandId(options, requestIdOf(args), "delete_thread_group"),
          groupId,
        },
        "Failed to delete the thread group.",
      );
      // Report the incarnation actually tagged by this delete, read back from
      // the projection rather than predicted from the earlier view.
      const after = await loadOrganization(dependencies, null);
      const deletedGroup = after.groups.find((entry) => entry.id === groupId);
      const deletionId = deletedGroup?.deletionId ?? null;
      const deletedGroups = after.groups.filter(
        (entry) => deletionId !== null && entry.deletionId === deletionId,
      );
      const deletedThreads = [...after.threads.entries()].filter(
        ([, record]) => deletionId !== null && record.deletionId === deletionId,
      );
      const shells = await run(
        dependencies.projectionSnapshotQuery.getDeletedShellSnapshot(),
        "Failed to read deleted threads.",
      );
      const active = new Set<string>(
        shells.threads
          .filter(
            (thread) =>
              thread.session !== null &&
              thread.session.status !== "stopped" &&
              thread.session.status !== "idle",
          )
          .map((thread) => thread.id),
      );
      return toolResult(
        {
          groupId,
          sequence: result.sequence,
          deletedGroupCount: deletedGroups.length,
          deletedThreadCount: deletedThreads.length,
          stopRequestedCount: deletedThreads.filter(([id]) => active.has(id)).length,
        },
        `Moved group '${groupId}' and ${deletedThreads.length} chat(s) to the Recycle Bin. Stops are requested, not confirmed.`,
      );
    },
  );

  server.registerTool(
    "restore_thread_group",
    {
      title: "Restore a Cafe thread group",
      description:
        "Restore a deleted group and only the chats/nested groups deleted together with it beneath it. Siblings deleted by the same parent cascade and chats deleted again later stay in the Recycle Bin. The parent must be active. Sessions are not restarted.",
      inputSchema: { groupId: groupIdInput },
      outputSchema: z.object({ groupId: z.string(), sequence: z.number().int().nonnegative() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      const groupId = ThreadGroupId.make(args.groupId);
      const result = await dispatch(
        dependencies,
        {
          type: "thread.group.restore",
          commandId: mintCommandId(options, requestIdOf(args), "restore_thread_group"),
          groupId,
        },
        "Failed to restore the thread group. Its parent chat may need restoring first.",
      );
      return toolResult(
        { groupId, sequence: result.sequence },
        `Restored group '${groupId}' from the Recycle Bin.`,
      );
    },
  );
}
