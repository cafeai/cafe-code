import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ThreadId,
  type ModelSelection,
  type OrchestrationProject,
  type OrchestrationProjectShell,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProviderInstanceConfig,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerSettings,
} from "@cafecode/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { z } from "zod";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BUILT_IN_DRIVERS } from "../provider/builtInDrivers.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import {
  DEFAULT_PROVIDER_RESTART_RESUME_MESSAGE,
  restartProviderRuntimeWithPolicy,
  type ProviderRuntimeControlDependencies,
} from "../provider/providerRuntimeControl.ts";
import type { ProviderRegistryShape } from "../provider/Services/ProviderRegistry.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { ServerRuntimeStartupShape } from "../serverRuntimeStartup.ts";
import { redactServerSettingsForClient, type ServerSettingsShape } from "../serverSettings.ts";
import type { WorkspacePathsShape } from "../workspace/Services/WorkspacePaths.ts";

const CAFE_MCP_SERVER_NAME = "cafe-code";
const CAFE_MCP_SERVER_VERSION = "1.0.0";
export const CAFE_MCP_RESTART_DELAY_MS = 750;
const BUILT_IN_CONFIG_DECODERS = new Map(
  BUILT_IN_DRIVERS.map((driver) => [
    driver.driverKind,
    Schema.decodeUnknownEffect(driver.configSchema),
  ]),
);

const nonEmptyString = z.string().trim().min(1);
const entityId = nonEmptyString.describe("Stable Cafe Code entity identifier.");
const providerInstanceId = nonEmptyString.regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const runtimeMode = z.enum(["approval-required", "auto-accept-edits", "full-access"]);
const interactionMode = z.enum(["default", "plan", "auto"]);
const providerOption = z.object({
  id: nonEmptyString,
  value: z.union([nonEmptyString, z.boolean()]),
});
const modelSelection = z.object({
  instanceId: providerInstanceId,
  model: nonEmptyString,
  options: z.array(providerOption).optional(),
});
const projectSummary = z.object({
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
const threadSummary = z.object({
  id: entityId,
  projectId: entityId,
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
});
const providerSummary = z.object({
  instanceId: providerInstanceId,
  driver: nonEmptyString,
  displayName: z.string().optional(),
  enabled: z.boolean(),
  installed: z.boolean(),
  availability: z.enum(["available", "unavailable"]),
  status: z.string(),
  authStatus: z.string(),
  models: z.array(
    z.object({
      slug: nonEmptyString,
      name: nonEmptyString,
      capabilities: z.unknown().nullable(),
    }),
  ),
});

export interface CafeMcpDependencies extends ProviderRuntimeControlDependencies {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly projectionSnapshotQuery: Pick<
    ProjectionSnapshotQueryShape,
    | "getSnapshot"
    | "getShellSnapshot"
    | "getArchivedShellSnapshot"
    | "getDeletedShellSnapshot"
    | "getActiveProjectByWorkspaceRoot"
    | "getProjectShellById"
    | "getThreadDetailById"
    | "getThreadShellById"
  >;
  readonly providerRegistry: Pick<ProviderRegistryShape, "getProviders" | "refreshInstance">;
  readonly providerService: Pick<
    ProviderServiceShape,
    "getInstanceInfo" | "listSessions" | "restartProviderRuntime"
  >;
  readonly serverSettings: Pick<ServerSettingsShape, "getSettings" | "updateSettings">;
  readonly startup: Pick<ServerRuntimeStartupShape, "enqueueCommand">;
  readonly workspacePaths: Pick<WorkspacePathsShape, "normalizeWorkspaceRoot">;
}

export interface CafeMcpServerOptions {
  /**
   * Schedule a provider restart after its tool acknowledgement is returned.
   * Tests inject a deterministic scheduler; production uses an unref'd timer.
   */
  readonly scheduleRestart?: (job: Effect.Effect<void, never, unknown>) => void;
}

function defaultScheduleRestart(job: Effect.Effect<void, never, unknown>): void {
  const timer = setTimeout(() => {
    Effect.runFork(job as Effect.Effect<void, never>);
  }, CAFE_MCP_RESTART_DELAY_MS);
  timer.unref();
}

function toolResult<T extends Record<string, unknown>>(structuredContent: T, text: string) {
  return {
    structuredContent,
    content: [{ type: "text" as const, text }],
  };
}

function publicErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

async function runEffect<A, E>(effect: Effect.Effect<A, E>, fallback: string): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (exit._tag === "Success") return exit.value;
  throw new Error(publicErrorMessage(Cause.squash(exit.cause), fallback));
}

function nowIso(): string {
  return new Date().toISOString();
}

function decodeModelSelection(input: z.infer<typeof modelSelection>): ModelSelection {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    model: input.model,
    ...(input.options !== undefined ? { options: input.options } : {}),
  };
}

function commandId(): CommandId {
  return CommandId.make(crypto.randomUUID());
}

function summarizeProject(project: OrchestrationProject | OrchestrationProjectShell) {
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

function summarizeThread(thread: OrchestrationThread | OrchestrationThreadShell) {
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
  };
}

function summarizeProvider(provider: ServerProvider) {
  return {
    instanceId: provider.instanceId,
    driver: provider.driver,
    ...(provider.displayName ? { displayName: provider.displayName } : {}),
    enabled: provider.enabled,
    installed: provider.installed,
    availability: provider.availability ?? "available",
    status: provider.status,
    authStatus: provider.auth.status,
    models: provider.models.map((model) => ({
      slug: model.slug,
      name: model.name,
      capabilities: model.capabilities,
    })),
  };
}

function requireProject(snapshot: OrchestrationReadModel, projectId: string) {
  const project = snapshot.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new Error(`Project '${projectId}' does not exist.`);
  return project;
}

function effectiveProviderSettings(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): ProviderInstanceConfig | undefined {
  return deriveProviderInstanceConfigMap(settings)[instanceId];
}

function withNullableField<T extends object, K extends keyof T>(
  value: T,
  key: K,
  next: T[K] | null | undefined,
): T {
  if (next === undefined) return value;
  if (next === null) {
    const clone = { ...value };
    delete clone[key];
    return clone;
  }
  return { ...value, [key]: next };
}

function resolveModelSelection(
  dependencies: CafeMcpDependencies,
  input: {
    readonly instanceId?: string;
    readonly model?: string;
    readonly options?: ReadonlyArray<ProviderOptionSelection>;
  },
  fallback?: ModelSelection | null,
) {
  return Effect.gen(function* () {
    const [settings, providers] = yield* Effect.all([
      dependencies.serverSettings.getSettings,
      dependencies.providerRegistry.getProviders,
    ]);
    const firstUsableProvider = providers.find(
      (provider) =>
        provider.enabled &&
        provider.installed &&
        provider.availability !== "unavailable" &&
        provider.models.length > 0,
    );
    const selectedInstanceId = ProviderInstanceId.make(
      input.instanceId ??
        fallback?.instanceId ??
        settings.defaultProviderInstanceId ??
        firstUsableProvider?.instanceId ??
        "",
    );
    if (selectedInstanceId.length === 0) {
      return yield* Effect.fail(new Error("No usable provider instance is configured."));
    }
    const provider = providers.find((candidate) => candidate.instanceId === selectedInstanceId);
    if (!provider) {
      return yield* Effect.fail(
        new Error(`Provider instance '${selectedInstanceId}' is not configured.`),
      );
    }
    if (!provider.enabled || provider.availability === "unavailable") {
      return yield* Effect.fail(
        new Error(`Provider instance '${selectedInstanceId}' is unavailable or disabled.`),
      );
    }

    const instanceSettings = effectiveProviderSettings(settings, selectedInstanceId);
    const preservesFallback =
      fallback?.instanceId === selectedInstanceId &&
      (input.model === undefined || input.model === fallback.model);
    const selectedModel =
      input.model ??
      (preservesFallback ? fallback.model : undefined) ??
      instanceSettings?.defaultModel ??
      provider.models[0]?.slug;
    if (!selectedModel) {
      return yield* Effect.fail(
        new Error(`Provider instance '${selectedInstanceId}' has no selectable model.`),
      );
    }
    const options =
      input.options ??
      (preservesFallback ? fallback.options : undefined) ??
      instanceSettings?.defaultModelOptions;

    return {
      instanceId: selectedInstanceId,
      model: selectedModel,
      ...(options !== undefined ? { options } : {}),
    } satisfies ModelSelection;
  });
}

function dispatch(
  dependencies: CafeMcpDependencies,
  command: Parameters<OrchestrationEngineShape["dispatch"]>[0],
) {
  return dependencies.startup.enqueueCommand(dependencies.orchestrationEngine.dispatch(command));
}

function providerSettingsView(settings: ServerSettings, instanceId: ProviderInstanceId) {
  const redacted = redactServerSettingsForClient(settings);
  const effective = effectiveProviderSettings(redacted, instanceId);
  if (!effective) throw new Error(`Provider instance '${instanceId}' is not configured.`);
  return {
    instanceId,
    source: instanceId in redacted.providerInstances ? ("explicit" as const) : ("legacy" as const),
    settings: effective,
  };
}

function registerDiscoveryTools(server: McpServer, dependencies: CafeMcpDependencies): void {
  server.registerTool(
    "list_projects",
    {
      title: "List Cafe Code projects",
      description: "List Cafe Code projects and their stable IDs before taking project actions.",
      inputSchema: {
        includeDeleted: z.boolean().default(false),
      },
      outputSchema: z.object({ projects: z.array(projectSummary) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ includeDeleted }) => {
      // The normal discovery path deliberately avoids hydrating every thread
      // transcript. The full snapshot is used only for the explicit request
      // to include soft-deleted projects, which shell snapshots omit.
      const projects = includeDeleted
        ? (
            await runEffect(
              dependencies.projectionSnapshotQuery.getSnapshot(),
              "Failed to list projects.",
            )
          ).projects.map(summarizeProject)
        : (
            await runEffect(
              dependencies.projectionSnapshotQuery.getShellSnapshot(),
              "Failed to list projects.",
            )
          ).projects.map(summarizeProject);
      return toolResult({ projects }, `Found ${projects.length} project(s).`);
    },
  );

  server.registerTool(
    "get_project",
    {
      title: "Get a Cafe Code project",
      description: "Get one project and its threads by stable project ID.",
      inputSchema: { projectId: entityId },
      outputSchema: z.object({ project: projectSummary, threads: z.array(threadSummary) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectId }) => {
      const id = ProjectId.make(projectId);
      const activeProject = await runEffect(
        dependencies.projectionSnapshotQuery.getProjectShellById(id),
        "Failed to load the project.",
      );
      const project = Option.isSome(activeProject)
        ? activeProject.value
        : requireProject(
            await runEffect(
              dependencies.projectionSnapshotQuery.getSnapshot(),
              "Failed to load the project.",
            ),
            projectId,
          );
      const snapshots = await runEffect(
        Effect.all([
          dependencies.projectionSnapshotQuery.getShellSnapshot(),
          dependencies.projectionSnapshotQuery.getArchivedShellSnapshot(),
          dependencies.projectionSnapshotQuery.getDeletedShellSnapshot(),
        ]),
        "Failed to load the project's threads.",
      );
      const threads = snapshots
        .flatMap((snapshot) => snapshot.threads)
        .filter((thread) => thread.projectId === project.id)
        .map(summarizeThread);
      return toolResult(
        { project: summarizeProject(project), threads },
        `Loaded project '${project.title}' with ${threads.length} thread(s).`,
      );
    },
  );

  server.registerTool(
    "list_threads",
    {
      title: "List Cafe Code threads",
      description: "List threads, optionally scoped to one project and lifecycle state.",
      inputSchema: {
        projectId: entityId.optional(),
        state: z.enum(["active", "archived", "deleted", "all"]).default("active"),
      },
      outputSchema: z.object({ threads: z.array(threadSummary) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ projectId, state }) => {
      const snapshots = await runEffect(
        state === "active"
          ? Effect.map(dependencies.projectionSnapshotQuery.getShellSnapshot(), (value) => [value])
          : state === "archived"
            ? Effect.map(
                dependencies.projectionSnapshotQuery.getArchivedShellSnapshot(),
                (value) => [value],
              )
            : state === "deleted"
              ? Effect.map(
                  dependencies.projectionSnapshotQuery.getDeletedShellSnapshot(),
                  (value) => [value],
                )
              : Effect.all([
                  dependencies.projectionSnapshotQuery.getShellSnapshot(),
                  dependencies.projectionSnapshotQuery.getArchivedShellSnapshot(),
                  dependencies.projectionSnapshotQuery.getDeletedShellSnapshot(),
                ]),
        "Failed to list threads.",
      );
      const threads = snapshots
        .flatMap((snapshot) => snapshot.threads)
        .filter((thread) => projectId === undefined || thread.projectId === projectId)
        .map(summarizeThread);
      return toolResult({ threads }, `Found ${threads.length} thread(s).`);
    },
  );

  server.registerTool(
    "get_thread",
    {
      title: "Get a Cafe Code thread",
      description:
        "Get thread state and a bounded tail of messages. Use this to inspect status after sending or interrupting work.",
      inputSchema: {
        threadId: entityId,
        messageLimit: z.number().int().min(0).max(100).default(20),
      },
      outputSchema: z.object({
        thread: threadSummary,
        messages: z.array(
          z.object({
            id: entityId,
            role: z.enum(["user", "assistant", "system"]),
            text: z.string(),
            turnId: z.string().nullable(),
            streaming: z.boolean(),
            createdAt: z.string(),
            updatedAt: z.string(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ threadId, messageLimit }) => {
      const detail = await runEffect(
        dependencies.projectionSnapshotQuery.getThreadDetailById(ThreadId.make(threadId)),
        "Failed to load the thread.",
      );
      if (Option.isNone(detail)) throw new Error(`Thread '${threadId}' does not exist.`);
      const messages = detail.value.messages.slice(-messageLimit).map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        turnId: message.turnId,
        streaming: message.streaming,
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      }));
      return toolResult(
        { thread: summarizeThread(detail.value), messages },
        `Loaded thread '${detail.value.title}' with ${messages.length} recent message(s).`,
      );
    },
  );

  server.registerTool(
    "list_providers",
    {
      title: "List Cafe Code providers",
      description:
        "List configured provider instances, authentication state, models, and model option descriptors.",
      inputSchema: {},
      outputSchema: z.object({ providers: z.array(providerSummary) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const providerValues = await runEffect(
        dependencies.providerRegistry.getProviders,
        "Failed to list providers.",
      );
      const providers = providerValues.map(summarizeProvider);
      return toolResult({ providers }, `Found ${providers.length} provider instance(s).`);
    },
  );

  server.registerTool(
    "get_provider_settings",
    {
      title: "Get provider settings",
      description:
        "Get redacted settings for one provider instance. Secrets are never returned; use this before replacing provider settings.",
      inputSchema: { instanceId: providerInstanceId },
      outputSchema: z.object({
        instanceId: providerInstanceId,
        source: z.enum(["explicit", "legacy"]),
        settings: z.unknown(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ instanceId }) => {
      const settings = await runEffect(
        dependencies.serverSettings.getSettings,
        "Failed to load provider settings.",
      );
      const view = providerSettingsView(settings, ProviderInstanceId.make(instanceId));
      return toolResult(view, `Loaded redacted settings for provider '${instanceId}'.`);
    },
  );
}

function registerProjectTools(server: McpServer, dependencies: CafeMcpDependencies): void {
  server.registerTool(
    "create_project",
    {
      title: "Create a Cafe Code project",
      description: "Create a project for an existing workspace directory, or create the directory.",
      inputSchema: {
        workspaceRoot: nonEmptyString,
        title: nonEmptyString.optional(),
        createWorkspaceRootIfMissing: z.boolean().default(false),
        additionalWorkspaceRoots: z.array(nonEmptyString).default([]),
        defaultModelSelection: modelSelection.nullable().optional(),
      },
      outputSchema: z.object({ projectId: entityId, sequence: z.number().int().nonnegative() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({
      workspaceRoot,
      title,
      createWorkspaceRootIfMissing,
      additionalWorkspaceRoots,
      defaultModelSelection,
    }) => {
      const normalizedRoot = await runEffect(
        dependencies.workspacePaths.normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createWorkspaceRootIfMissing,
        }),
        "Failed to normalize the project workspace.",
      );
      const normalizedAdditionalRoots = await Promise.all(
        additionalWorkspaceRoots.map((root) =>
          runEffect(
            dependencies.workspacePaths.normalizeWorkspaceRoot(root),
            "Failed to normalize an additional workspace directory.",
          ),
        ),
      );
      const existing = await runEffect(
        dependencies.projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(normalizedRoot),
        "Failed to inspect existing projects.",
      );
      if (Option.isSome(existing)) {
        throw new Error(
          `Project '${existing.value.id}' already uses workspace root '${normalizedRoot}'.`,
        );
      }

      const projectId = ProjectId.make(crypto.randomUUID());
      const result = await runEffect(
        dispatch(dependencies, {
          type: "project.create",
          commandId: commandId(),
          projectId,
          title: title ?? (NodePath.basename(normalizedRoot) || "project"),
          workspaceRoot: normalizedRoot,
          additionalWorkspaceRoots: [
            ...new Set(normalizedAdditionalRoots.filter((root) => root !== normalizedRoot)),
          ],
          defaultModelSelection:
            defaultModelSelection === undefined
              ? null
              : defaultModelSelection === null
                ? null
                : decodeModelSelection(defaultModelSelection),
          createdAt: nowIso(),
        }),
        "Failed to create the project.",
      );
      return toolResult(
        { projectId, sequence: result.sequence },
        `Created project '${projectId}'.`,
      );
    },
  );

  server.registerTool(
    "update_project",
    {
      title: "Update a Cafe Code project",
      description:
        "Update project metadata. Omitted fields remain unchanged; clearDefaultModelSelection removes the project default.",
      inputSchema: {
        projectId: entityId,
        title: nonEmptyString.optional(),
        workspaceRoot: nonEmptyString.optional(),
        additionalWorkspaceRoots: z.array(nonEmptyString).optional(),
        defaultModelSelection: modelSelection.optional(),
        clearDefaultModelSelection: z.boolean().default(false),
      },
      outputSchema: z.object({ projectId: entityId, sequence: z.number().int().nonnegative() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({
      projectId,
      title,
      workspaceRoot,
      additionalWorkspaceRoots,
      defaultModelSelection,
      clearDefaultModelSelection,
    }) => {
      if (defaultModelSelection !== undefined && clearDefaultModelSelection) {
        throw new Error(
          "Choose either defaultModelSelection or clearDefaultModelSelection, not both.",
        );
      }
      const projectOption = await runEffect(
        dependencies.projectionSnapshotQuery.getProjectShellById(ProjectId.make(projectId)),
        "Failed to load the project.",
      );
      if (Option.isNone(projectOption))
        throw new Error(`Active project '${projectId}' does not exist.`);
      const project = projectOption.value;
      const nextWorkspaceRoot = workspaceRoot
        ? await runEffect(
            dependencies.workspacePaths.normalizeWorkspaceRoot(workspaceRoot),
            "Failed to normalize the project workspace.",
          )
        : undefined;
      const nextAdditionalRoots =
        additionalWorkspaceRoots === undefined
          ? undefined
          : await Promise.all(
              additionalWorkspaceRoots.map((root) =>
                runEffect(
                  dependencies.workspacePaths.normalizeWorkspaceRoot(root),
                  "Failed to normalize an additional workspace directory.",
                ),
              ),
            );
      const primaryRoot = nextWorkspaceRoot ?? project.workspaceRoot;
      const result = await runEffect(
        dispatch(dependencies, {
          type: "project.meta.update",
          commandId: commandId(),
          projectId: project.id,
          ...(title !== undefined ? { title } : {}),
          ...(nextWorkspaceRoot !== undefined ? { workspaceRoot: nextWorkspaceRoot } : {}),
          ...(nextAdditionalRoots !== undefined
            ? {
                additionalWorkspaceRoots: [
                  ...new Set(nextAdditionalRoots.filter((root) => root !== primaryRoot)),
                ],
              }
            : {}),
          ...(clearDefaultModelSelection
            ? { defaultModelSelection: null }
            : defaultModelSelection !== undefined
              ? { defaultModelSelection: decodeModelSelection(defaultModelSelection) }
              : {}),
        }),
        "Failed to update the project.",
      );
      return toolResult(
        { projectId: project.id, sequence: result.sequence },
        `Updated project '${project.id}'.`,
      );
    },
  );

  server.registerTool(
    "delete_project",
    {
      title: "Delete a Cafe Code project",
      description: "Soft-delete a project. Set force=true to also soft-delete its active threads.",
      inputSchema: { projectId: entityId, force: z.boolean().default(false) },
      outputSchema: z.object({ projectId: entityId, sequence: z.number().int().nonnegative() }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ projectId, force }) => {
      const result = await runEffect(
        dispatch(dependencies, {
          type: "project.delete",
          commandId: commandId(),
          projectId: ProjectId.make(projectId),
          force,
        }),
        "Failed to delete the project.",
      );
      return toolResult(
        { projectId, sequence: result.sequence },
        `Deleted project '${projectId}'.`,
      );
    },
  );
}

function registerThreadTools(server: McpServer, dependencies: CafeMcpDependencies): void {
  server.registerTool(
    "create_thread",
    {
      title: "Create a Cafe Code thread",
      description:
        "Create a thread in a project. Provider/model defaults resolve from the project and Cafe settings when omitted.",
      inputSchema: {
        projectId: entityId,
        title: nonEmptyString.default("New thread"),
        providerInstanceId: providerInstanceId.optional(),
        model: nonEmptyString.optional(),
        providerOptions: z.array(providerOption).optional(),
        runtimeMode: runtimeMode.default(DEFAULT_RUNTIME_MODE),
        interactionMode: interactionMode.default(DEFAULT_PROVIDER_INTERACTION_MODE),
        branch: nonEmptyString.nullable().default(null),
        worktreePath: nonEmptyString.nullable().default(null),
      },
      outputSchema: z.object({ threadId: entityId, sequence: z.number().int().nonnegative() }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({
      projectId,
      title,
      providerInstanceId: selectedProviderInstanceId,
      model,
      providerOptions,
      runtimeMode: selectedRuntimeMode,
      interactionMode: selectedInteractionMode,
      branch,
      worktreePath,
    }) => {
      const projectOption = await runEffect(
        dependencies.projectionSnapshotQuery.getProjectShellById(ProjectId.make(projectId)),
        "Failed to load the target project.",
      );
      if (Option.isNone(projectOption))
        throw new Error(`Active project '${projectId}' does not exist.`);
      const project = projectOption.value;
      const selection = await runEffect(
        resolveModelSelection(
          dependencies,
          {
            ...(selectedProviderInstanceId ? { instanceId: selectedProviderInstanceId } : {}),
            ...(model ? { model } : {}),
            ...(providerOptions ? { options: providerOptions } : {}),
          },
          project.defaultModelSelection,
        ),
        "Failed to resolve a provider and model for the thread.",
      );
      const threadId = ThreadId.make(crypto.randomUUID());
      const result = await runEffect(
        dispatch(dependencies, {
          type: "thread.create",
          commandId: commandId(),
          threadId,
          projectId: project.id,
          title,
          modelSelection: selection,
          runtimeMode: selectedRuntimeMode,
          interactionMode: selectedInteractionMode,
          branch,
          worktreePath,
          createdAt: nowIso(),
        }),
        "Failed to create the thread.",
      );
      return toolResult({ threadId, sequence: result.sequence }, `Created thread '${threadId}'.`);
    },
  );

  server.registerTool(
    "update_thread",
    {
      title: "Update a Cafe Code thread",
      description:
        "Rename or move a thread, or set its provider, model, provider options, runtime mode, and interaction mode.",
      inputSchema: {
        threadId: entityId,
        projectId: entityId.optional(),
        title: nonEmptyString.optional(),
        providerInstanceId: providerInstanceId.optional(),
        model: nonEmptyString.optional(),
        providerOptions: z.array(providerOption).optional(),
        runtimeMode: runtimeMode.optional(),
        interactionMode: interactionMode.optional(),
        branch: nonEmptyString.nullable().optional(),
        worktreePath: nonEmptyString.nullable().optional(),
      },
      outputSchema: z.object({ threadId: entityId, sequences: z.array(z.number().int()) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({
      threadId,
      projectId,
      title,
      providerInstanceId: selectedProviderInstanceId,
      model,
      providerOptions,
      runtimeMode: selectedRuntimeMode,
      interactionMode: selectedInteractionMode,
      branch,
      worktreePath,
    }) => {
      const threadOption = await runEffect(
        dependencies.projectionSnapshotQuery.getThreadShellById(ThreadId.make(threadId)),
        "Failed to load the thread.",
      );
      if (Option.isNone(threadOption))
        throw new Error(`Active thread '${threadId}' does not exist.`);
      const thread = threadOption.value;
      if (projectId !== undefined) {
        const projectOption = await runEffect(
          dependencies.projectionSnapshotQuery.getProjectShellById(ProjectId.make(projectId)),
          "Failed to load the destination project.",
        );
        if (Option.isNone(projectOption)) {
          throw new Error(`Active project '${projectId}' does not exist.`);
        }
      }
      const selectionRequested =
        selectedProviderInstanceId !== undefined ||
        model !== undefined ||
        providerOptions !== undefined;
      const selection = selectionRequested
        ? await runEffect(
            resolveModelSelection(
              dependencies,
              {
                ...(selectedProviderInstanceId ? { instanceId: selectedProviderInstanceId } : {}),
                ...(model ? { model } : {}),
                ...(providerOptions ? { options: providerOptions } : {}),
              },
              thread.modelSelection,
            ),
            "Failed to resolve the requested provider settings.",
          )
        : undefined;

      const sequences: number[] = [];
      if (
        projectId !== undefined ||
        title !== undefined ||
        selection !== undefined ||
        branch !== undefined ||
        worktreePath !== undefined
      ) {
        const result = await runEffect(
          dispatch(dependencies, {
            type: "thread.meta.update",
            commandId: commandId(),
            threadId: thread.id,
            ...(projectId !== undefined ? { projectId: ProjectId.make(projectId) } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(selection !== undefined ? { modelSelection: selection } : {}),
            ...(branch !== undefined ? { branch } : {}),
            ...(worktreePath !== undefined ? { worktreePath } : {}),
          }),
          "Failed to update thread metadata.",
        );
        sequences.push(result.sequence);
      }
      if (selectedRuntimeMode !== undefined && selectedRuntimeMode !== thread.runtimeMode) {
        const result = await runEffect(
          dispatch(dependencies, {
            type: "thread.runtime-mode.set",
            commandId: commandId(),
            threadId: thread.id,
            runtimeMode: selectedRuntimeMode,
            createdAt: nowIso(),
          }),
          "Failed to update the thread runtime mode.",
        );
        sequences.push(result.sequence);
      }
      if (
        selectedInteractionMode !== undefined &&
        selectedInteractionMode !== thread.interactionMode
      ) {
        const result = await runEffect(
          dispatch(dependencies, {
            type: "thread.interaction-mode.set",
            commandId: commandId(),
            threadId: thread.id,
            interactionMode: selectedInteractionMode,
            createdAt: nowIso(),
          }),
          "Failed to update the thread interaction mode.",
        );
        sequences.push(result.sequence);
      }
      return toolResult({ threadId, sequences }, `Updated thread '${threadId}'.`);
    },
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a message to a Cafe Code thread",
      description:
        "Send a durable user message. Cafe Code starts a new turn or safely steers the active turn according to current runtime state.",
      inputSchema: {
        threadId: entityId,
        message: z.string().trim().min(1).max(PROVIDER_SEND_TURN_MAX_INPUT_CHARS),
      },
      outputSchema: z.object({
        threadId: entityId,
        messageId: entityId,
        sequence: z.number().int().nonnegative(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ threadId, message }) => {
      const threadOption = await runEffect(
        dependencies.projectionSnapshotQuery.getThreadShellById(ThreadId.make(threadId)),
        "Failed to load the thread.",
      );
      if (Option.isNone(threadOption))
        throw new Error(`Active thread '${threadId}' does not exist.`);
      const thread = threadOption.value;
      const messageId = MessageId.make(crypto.randomUUID());
      const result = await runEffect(
        dispatch(dependencies, {
          type: "thread.turn.start",
          commandId: commandId(),
          threadId: thread.id,
          message: { messageId, role: "user", text: message, attachments: [] },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: nowIso(),
        }),
        "Failed to send the message.",
      );
      return toolResult(
        { threadId, messageId, sequence: result.sequence },
        `Accepted message '${messageId}' for thread '${threadId}'.`,
      );
    },
  );

  server.registerTool(
    "interrupt_thread",
    {
      title: "Interrupt a Cafe Code thread",
      description:
        "Interrupt the active provider turn for one thread without deleting its history.",
      inputSchema: { threadId: entityId },
      outputSchema: z.object({ threadId: entityId, sequence: z.number().int().nonnegative() }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ threadId }) => {
      const result = await runEffect(
        dispatch(dependencies, {
          type: "thread.turn.interrupt",
          commandId: commandId(),
          threadId: ThreadId.make(threadId),
          createdAt: nowIso(),
        }),
        "Failed to interrupt the thread.",
      );
      return toolResult(
        { threadId, sequence: result.sequence },
        `Requested interruption for thread '${threadId}'.`,
      );
    },
  );

  const registerThreadLifecycleTool = (
    name: "archive_thread" | "unarchive_thread" | "delete_thread" | "restore_thread",
    config: { readonly title: string; readonly description: string; readonly destructive: boolean },
    commandType: "thread.archive" | "thread.unarchive" | "thread.delete" | "thread.restore",
  ) =>
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: { threadId: entityId },
        outputSchema: z.object({ threadId: entityId, sequence: z.number().int().nonnegative() }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: config.destructive,
          openWorldHint: false,
        },
      },
      async ({ threadId }) => {
        const result = await runEffect(
          dispatch(dependencies, {
            type: commandType,
            commandId: commandId(),
            threadId: ThreadId.make(threadId),
          }),
          `Failed to ${name.replace("_thread", "")} the thread.`,
        );
        return toolResult(
          { threadId, sequence: result.sequence },
          `${config.title} '${threadId}'.`,
        );
      },
    );

  registerThreadLifecycleTool(
    "archive_thread",
    {
      title: "Archive a Cafe Code thread",
      description: "Archive an active thread. Archived threads can be unarchived in the Cafe UI.",
      destructive: false,
    },
    "thread.archive",
  );
  registerThreadLifecycleTool(
    "unarchive_thread",
    {
      title: "Unarchive a Cafe Code thread",
      description: "Return an archived thread to its project's active thread list.",
      destructive: false,
    },
    "thread.unarchive",
  );
  registerThreadLifecycleTool(
    "delete_thread",
    {
      title: "Delete a Cafe Code thread",
      description: "Soft-delete a thread into Cafe Code's recycle bin.",
      destructive: true,
    },
    "thread.delete",
  );
  registerThreadLifecycleTool(
    "restore_thread",
    {
      title: "Restore a Cafe Code thread",
      description: "Restore a soft-deleted thread from Cafe Code's recycle bin.",
      destructive: false,
    },
    "thread.restore",
  );
}

function registerProviderMutationTools(
  server: McpServer,
  dependencies: CafeMcpDependencies,
  options: CafeMcpServerOptions,
): void {
  server.registerTool(
    "set_provider_settings",
    {
      title: "Set provider settings",
      description:
        "Create or replace settings for one provider instance. Read current redacted settings first; omitted fields are preserved.",
      inputSchema: {
        instanceId: providerInstanceId,
        driver: providerInstanceId.optional(),
        displayName: nonEmptyString.nullable().optional(),
        accentColor: nonEmptyString.nullable().optional(),
        enabled: z.boolean().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        environment: z
          .array(
            z.object({
              name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/),
              value: z.string().optional(),
              sensitive: z.boolean().default(false),
            }),
          )
          .optional(),
        defaultModel: nonEmptyString.nullable().optional(),
        defaultModelOptions: z.array(providerOption).nullable().optional(),
      },
      outputSchema: z.object({ instanceId: providerInstanceId, updated: z.literal(true) }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({
      instanceId,
      driver,
      displayName,
      accentColor,
      enabled,
      config,
      environment,
      defaultModel,
      defaultModelOptions,
    }) => {
      const id = ProviderInstanceId.make(instanceId);
      const settings = await runEffect(
        dependencies.serverSettings.getSettings,
        "Failed to load provider settings.",
      );
      const existing = effectiveProviderSettings(settings, id);
      if (!existing && !driver) {
        throw new Error("driver is required when creating a new provider instance.");
      }
      let next: ProviderInstanceConfig = {
        ...(existing ?? { driver: ProviderDriverKind.make(driver!) }),
        ...(driver !== undefined ? { driver: ProviderDriverKind.make(driver) } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(config !== undefined ? { config } : {}),
        ...(environment !== undefined
          ? {
              environment: environment.map((variable) => ({
                name: variable.name,
                value: variable.value ?? "",
                sensitive: variable.sensitive,
              })),
            }
          : {}),
      };
      next = withNullableField(next, "displayName", displayName);
      next = withNullableField(next, "accentColor", accentColor);
      next = withNullableField(next, "defaultModel", defaultModel);
      next = withNullableField(next, "defaultModelOptions", defaultModelOptions);

      const builtInDriver = BUILT_IN_DRIVERS.find(
        (candidate) => candidate.driverKind === next.driver,
      );
      if (builtInDriver) {
        const decodeConfig = BUILT_IN_CONFIG_DECODERS.get(builtInDriver.driverKind);
        if (!decodeConfig) {
          throw new Error(`Provider driver '${next.driver}' is not available.`);
        }
        const validation = await Effect.runPromiseExit(
          decodeConfig(next.config ?? builtInDriver.defaultConfig()),
        );
        if (validation._tag === "Failure") {
          // Schema diagnostics can include submitted secret values. Keep the
          // MCP error deliberately generic and let the provider settings UI
          // expose its normal redacted validation state.
          throw new Error(`Invalid settings for provider driver '${next.driver}'.`);
        }
      }

      await runEffect(
        dependencies.serverSettings.updateSettings({
          providerInstances: { ...settings.providerInstances, [id]: next },
        }),
        "Failed to save provider settings.",
      );
      return toolResult(
        { instanceId: id, updated: true as const },
        `Updated provider settings for '${id}'.`,
      );
    },
  );

  const registerRestartTool = (
    name: "restart_provider" | "restart_provider_and_resume",
    config: {
      readonly title: string;
      readonly description: string;
      readonly resumeActiveSessions: boolean;
    },
  ) =>
    server.registerTool(
      name,
      {
        title: config.title,
        description: config.description,
        inputSchema: {
          instanceId: providerInstanceId,
          ...(config.resumeActiveSessions
            ? {
                resumeMessage: z
                  .string()
                  .trim()
                  .min(1)
                  .max(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)
                  .default(DEFAULT_PROVIDER_RESTART_RESUME_MESSAGE),
              }
            : {}),
        },
        outputSchema: z.object({
          instanceId: providerInstanceId,
          scheduled: z.literal(true),
          resumeActiveSessions: z.boolean(),
          delayMs: z.number().int().nonnegative(),
        }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async (input) => {
        const id = ProviderInstanceId.make(input.instanceId);
        await runEffect(
          dependencies.providerService.getInstanceInfo(id),
          `Provider instance '${id}' is not available.`,
        );

        const backgroundJob = restartProviderRuntimeWithPolicy(dependencies, {
          instanceId: id,
          resumeActiveSessions: config.resumeActiveSessions,
          ...(config.resumeActiveSessions && "resumeMessage" in input
            ? { resumeMessage: input.resumeMessage }
            : {}),
        }).pipe(
          Effect.tap((result) =>
            Effect.logInfo("scheduled MCP provider restart completed", {
              instanceId: result.instanceId,
              stoppedSessionCount: result.stoppedSessionCount,
              activeSessionCount: result.activeSessionCount,
              resumedThreadCount: result.resumedThreadIds.length,
              failedResumeThreadCount: result.failedResumeThreadIds.length,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logError("scheduled MCP provider restart failed", {
              instanceId: id,
              cause,
            }),
          ),
          Effect.asVoid,
        );
        (options.scheduleRestart ?? defaultScheduleRestart)(backgroundJob);

        const result = {
          instanceId: id,
          scheduled: true as const,
          resumeActiveSessions: config.resumeActiveSessions,
          delayMs: CAFE_MCP_RESTART_DELAY_MS,
        };
        return toolResult(
          result,
          config.resumeActiveSessions
            ? `Scheduled restart of '${id}'; Cafe Code will resume threads that are running at the restart boundary.`
            : `Scheduled restart of '${id}' without automatic session resumption.`,
        );
      },
    );

  registerRestartTool("restart_provider", {
    title: "Restart a provider",
    description:
      "Restart one provider instance and interrupt its live sessions without automatically resuming them. The restart begins after this tool returns.",
    resumeActiveSessions: false,
  });
  registerRestartTool("restart_provider_and_resume", {
    title: "Restart and resume a provider",
    description:
      "Restart one provider instance, then send a durable resume message to every thread that was running when shutdown began. The restart begins after this tool returns, so an agent may safely restart its own provider.",
    resumeActiveSessions: true,
  });
}

export function makeCafeMcpServer(
  dependencies: CafeMcpDependencies,
  options: CafeMcpServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: CAFE_MCP_SERVER_NAME, version: CAFE_MCP_SERVER_VERSION },
    {
      instructions:
        "Use list_projects, list_threads, and list_providers before mutations so you operate on stable Cafe Code IDs. Deletions, interrupts, provider configuration, and provider restarts are consequential. restart_provider_and_resume returns before teardown, then Cafe Code restarts the provider and submits a durable resume turn to each thread that was running at the restart boundary.",
    },
  );

  registerDiscoveryTools(server, dependencies);
  registerProjectTools(server, dependencies);
  registerThreadTools(server, dependencies);
  registerProviderMutationTools(server, dependencies, options);
  return server;
}
