import { z } from "zod";
import type {
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadShell,
  ServerProvider,
} from "@cafecode/contracts";

export const nonEmptyString = z.string().trim().min(1);
export const entityId = nonEmptyString.describe("Stable Cafe Code entity identifier.");
export const providerInstanceId = nonEmptyString.regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
export const runtimeMode = z.enum(["approval-required", "auto-accept-edits", "full-access"]);
export const interactionMode = z.enum(["default", "plan", "auto"]);
export const providerOption = z.object({
  id: nonEmptyString,
  value: z.union([nonEmptyString, z.boolean()]),
});
export const modelSelection = z.object({
  instanceId: providerInstanceId,
  model: nonEmptyString,
  options: z.array(providerOption).optional(),
});
export const projectSummary = z.object({
  id: entityId,
  title: nonEmptyString,
  workspaceRoot: nonEmptyString,
  additionalWorkspaceRoots: z.array(nonEmptyString),
  defaultModelSelection: modelSelection.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});
const latestTurnSummary = z
  .object({
    turnId: entityId,
    state: z.enum(["running", "interrupted", "completed", "error"]),
    requestedAt: z.string(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  })
  .nullable();
export const threadSummary = z.object({
  id: entityId,
  projectId: entityId.nullable(),
  title: nonEmptyString,
  modelSelection,
  runtimeMode,
  interactionMode,
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  status: z.enum(["idle", "starting", "running", "ready", "interrupted", "stopped", "error"]),
  activeTurnId: z.string().nullable(),
  latestTurn: latestTurnSummary,
  archivedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  hasPendingApprovals: z.boolean().nullable(),
  hasPendingUserInput: z.boolean().nullable(),
  hasActionableProposedPlan: z.boolean().nullable(),
  hasFailure: z.boolean(),
  liveWork: z
    .object({
      runtimeId: z.string(),
      taskCount: z.number().int().nonnegative(),
      agentCount: z.number().int().nonnegative(),
      unconfirmedAgentCount: z.number().int().nonnegative(),
      unconfirmedAgentCountTruncated: z.boolean(),
    })
    .nullable(),
});
export const providerSummary = z.object({
  instanceId: providerInstanceId,
  driver: nonEmptyString,
  displayName: z.string().optional(),
  enabled: z.boolean(),
  installed: z.boolean(),
  availability: z.enum(["available", "unavailable"]),
  status: z.string(),
  authStatus: z.string(),
  modelCount: z.number().int().nonnegative(),
  modelsIncluded: z.boolean(),
  modelsTruncated: z.boolean(),
  models: z
    .array(
      z.object({
        slug: nonEmptyString,
        name: nonEmptyString,
        capabilities: z.unknown().nullable(),
      }),
    )
    .optional(),
});

export function summarizeProject(project: OrchestrationProject | OrchestrationProjectShell) {
  return {
    id: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    additionalWorkspaceRoots: project.additionalWorkspaceRoots ?? [],
    defaultModelSelection: project.defaultModelSelection,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    deletedAt: "deletedAt" in project ? project.deletedAt : null,
  };
}

export function summarizeThread(thread: OrchestrationThread | OrchestrationThreadShell) {
  const live = "liveWork" in thread ? thread.liveWork : undefined;
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    status: thread.session?.status ?? "idle",
    activeTurnId: thread.session?.activeTurnId ?? null,
    latestTurn:
      thread.latestTurn === null
        ? null
        : {
            turnId: thread.latestTurn.turnId,
            state: thread.latestTurn.state,
            requestedAt: thread.latestTurn.requestedAt,
            startedAt: thread.latestTurn.startedAt,
            completedAt: thread.latestTurn.completedAt,
          },
    archivedAt: thread.archivedAt,
    deletedAt: thread.deletedAt,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    hasPendingApprovals: "hasPendingApprovals" in thread ? thread.hasPendingApprovals : null,
    hasPendingUserInput: "hasPendingUserInput" in thread ? thread.hasPendingUserInput : null,
    hasActionableProposedPlan:
      "hasActionableProposedPlan" in thread ? thread.hasActionableProposedPlan : null,
    hasFailure: thread.session?.lastError != null || thread.latestTurn?.state === "error",
    liveWork: live
      ? {
          runtimeId: live.runtimeId,
          taskCount: live.taskCount,
          agentCount: live.agentCount,
          unconfirmedAgentCount: live.unconfirmedAgentIds?.length ?? 0,
          unconfirmedAgentCountTruncated: live.unconfirmedAgentIdsTruncated ?? false,
        }
      : null,
  };
}

export function summarizeProvider(provider: ServerProvider, includeModels = false) {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    ...(provider.displayName ? { displayName: provider.displayName } : {}),
    enabled: provider.enabled,
    installed: provider.installed,
    availability: provider.availability ?? "available",
    status: provider.status,
    authStatus: provider.auth.status,
    modelCount: provider.models.length,
    modelsIncluded: includeModels,
    modelsTruncated: includeModels && provider.models.length > 100,
    ...(includeModels
      ? {
          models: provider.models.slice(0, 100).map((model) => ({
            slug: model.slug,
            name: model.name,
            capabilities: model.capabilities,
          })),
        }
      : {}),
  };
}
