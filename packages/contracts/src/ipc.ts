import type {
  VcsSwitchRefInput,
  VcsSwitchRefResult,
  VcsCreateRefInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsPullInput,
  VcsPullResult,
  VcsRemoveWorktreeInput,
  GitResolvePullRequestResult,
  VcsStatusInput,
  VcsStatusResult,
  VcsWorkingTreeDiffInput,
  VcsWorkingTreeDiffResult,
  VcsCreateRefResult,
} from "./git.ts";
import type { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem.ts";
import type {
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import type { ProviderInstanceId } from "./providerInstance.ts";
import type {
  ServerConfig,
  ServerOpenSystemPromptFileResult,
  ServerProcessDiagnosticsResult,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerProviderLoginInput,
  ServerProviderLoginResult,
  ServerProviderUpdateInput,
  ServerProviderRuntimeRestartInput,
  ServerProviderRuntimeRestartResult,
  ServerProviderUpdatedPayload,
  ServerRemoveKeybindingResult,
  ServerRuntimeLayerDiagnosticsInput,
  ServerRuntimeLayerDiagnosticsResult,
  ServerSignalProcessInput,
  ServerSignalProcessResult,
  ServerTraceDiagnosticsResult,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import type { ServerRemoveKeybindingInput, ServerUpsertKeybindingInput } from "./server.ts";
import * as Schema from "effect/Schema";
import type {
  ClientOrchestrationCommand,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationThreadTurnActivityPage,
  OrchestrationThreadTurnActivityPageInput,
  OrchestrationThreadTurnWorkLogPresenceInput,
  OrchestrationThreadTurnWorkLogPresenceResult,
  ProviderJournalMessageRepairInput,
  ProviderJournalMessageRepairResult,
  ProviderThreadAssistantMessagesRepairInput,
  ProviderThreadAssistantMessagesRepairResult,
  ThreadHardDeleteInput,
  ThreadHardDeleteResult,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadStreamItem,
} from "./orchestration.ts";
import { AdvertisedEndpoint } from "./remoteAccess.ts";
import { EditorId } from "./editor.ts";
import type {
  ClientSettings,
  ClientSettingsPatch,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";
import { PowerSaveBlockerMode } from "./settings.ts";
import type {
  SourceControlCloneRepositoryInput,
  SourceControlCloneRepositoryResult,
  SourceControlDiscoveryResult,
  SourceControlRepositoryInfo,
  SourceControlRepositoryLookupInput,
} from "./sourceControl.ts";
import { EnvironmentId } from "./baseSchemas.ts";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  children?: readonly ContextMenuItem<T>[];
}

export interface ContextMenuItemSchemaType {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  readonly children?: readonly ContextMenuItemSchemaType[];
}

export const ContextMenuItemSchema: Schema.Codec<ContextMenuItemSchemaType> = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  destructive: Schema.optionalKey(Schema.Boolean),
  disabled: Schema.optionalKey(Schema.Boolean),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.suspend((): Schema.Codec<ContextMenuItemSchemaType> => ContextMenuItemSchema),
    ),
  ),
});

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";
export type DesktopUpdateChannel = "latest" | "nightly";
export type DesktopAppStageLabel = "Alpha" | "Dev" | "Nightly";

export const DesktopUpdateStatusSchema = Schema.Literals([
  "disabled",
  "idle",
  "checking",
  "up-to-date",
  "available",
  "downloading",
  "downloaded",
  "error",
]);
export const DesktopRuntimeArchSchema = Schema.Literals(["arm64", "x64", "other"]);
export const DesktopThemeSchema = Schema.Literals(["light", "dark", "system"]);
export const DesktopUpdateChannelSchema = Schema.Literals(["latest", "nightly"]);
export const DesktopAppStageLabelSchema = Schema.Literals(["Alpha", "Dev", "Nightly"]);

export interface DesktopAppBranding {
  baseName: string;
  stageLabel: DesktopAppStageLabel;
  displayName: string;
}

export const DesktopAppBrandingSchema = Schema.Struct({
  baseName: Schema.String,
  stageLabel: DesktopAppStageLabelSchema,
  displayName: Schema.String,
});

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export const DesktopRuntimeInfoSchema = Schema.Struct({
  hostArch: DesktopRuntimeArchSchema,
  appArch: DesktopRuntimeArchSchema,
  runningUnderArm64Translation: Schema.Boolean,
});

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  channel: DesktopUpdateChannel;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export const DesktopUpdateStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  status: DesktopUpdateStatusSchema,
  channel: DesktopUpdateChannelSchema,
  currentVersion: Schema.String,
  hostArch: DesktopRuntimeArchSchema,
  appArch: DesktopRuntimeArchSchema,
  runningUnderArm64Translation: Schema.Boolean,
  availableVersion: Schema.NullOr(Schema.String),
  downloadedVersion: Schema.NullOr(Schema.String),
  downloadPercent: Schema.NullOr(Schema.Number),
  checkedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  errorContext: Schema.NullOr(Schema.Literals(["check", "download", "install"])),
  canRetry: Schema.Boolean,
});

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export const DesktopUpdateActionResultSchema = Schema.Struct({
  accepted: Schema.Boolean,
  completed: Schema.Boolean,
  state: DesktopUpdateStateSchema,
});

export interface DesktopUpdateCheckResult {
  checked: boolean;
  state: DesktopUpdateState;
}

export const DesktopUpdateCheckResultSchema = Schema.Struct({
  checked: Schema.Boolean,
  state: DesktopUpdateStateSchema,
});

export type DesktopSourceUpdateStatus =
  | "idle"
  | "checking"
  | "current"
  | "behind"
  | "ahead"
  | "diverged"
  | "ignored"
  | "unavailable"
  | "error";

export type DesktopSourceUpdateTrackedBranch = "main" | "dev";

export const DesktopSourceUpdateStatusSchema = Schema.Literals([
  "idle",
  "checking",
  "current",
  "behind",
  "ahead",
  "diverged",
  "ignored",
  "unavailable",
  "error",
]);
export const DesktopSourceUpdateTrackedBranchSchema = Schema.Literals(["main", "dev"]);

export interface DesktopSourceUpdateState {
  status: DesktopSourceUpdateStatus;
  branch: string | null;
  trackedBranch: DesktopSourceUpdateTrackedBranch | null;
  runtimeHash: string | null;
  localHash: string | null;
  remoteHash: string | null;
  mergeBaseHash: string | null;
  dirty: boolean | null;
  checkedAt: string | null;
  message: string | null;
}

export const DesktopSourceUpdateStateSchema = Schema.Struct({
  status: DesktopSourceUpdateStatusSchema,
  branch: Schema.NullOr(Schema.String),
  trackedBranch: Schema.NullOr(DesktopSourceUpdateTrackedBranchSchema),
  runtimeHash: Schema.NullOr(Schema.String),
  localHash: Schema.NullOr(Schema.String),
  remoteHash: Schema.NullOr(Schema.String),
  mergeBaseHash: Schema.NullOr(Schema.String),
  dirty: Schema.NullOr(Schema.Boolean),
  checkedAt: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
});

export interface DesktopEnvironmentBootstrap {
  label: string;
  httpBaseUrl: string | null;
  wsBaseUrl: string | null;
  bootstrapToken?: string;
}

export const DesktopEnvironmentBootstrapSchema = Schema.Struct({
  label: Schema.String,
  httpBaseUrl: Schema.NullOr(Schema.String),
  wsBaseUrl: Schema.NullOr(Schema.String),
  bootstrapToken: Schema.optionalKey(Schema.String),
});

export type DesktopServerExposureMode = "local-only" | "network-accessible";

export const DesktopServerExposureModeSchema = Schema.Literals([
  "local-only",
  "network-accessible",
]);

export interface DesktopServerExposureState {
  mode: DesktopServerExposureMode;
  httpsEnabled: boolean;
  endpointUrl: string | null;
  advertisedHost: string | null;
}

export const DesktopServerExposureStateSchema = Schema.Struct({
  mode: DesktopServerExposureModeSchema,
  httpsEnabled: Schema.Boolean,
  endpointUrl: Schema.NullOr(Schema.String),
  advertisedHost: Schema.NullOr(Schema.String),
});

export interface PickFolderOptions {
  initialPath?: string | null;
}

export const PickFolderOptionsSchema = Schema.Struct({
  initialPath: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const DesktopPowerSaveBlockerStateSchema = Schema.Struct({
  mode: PowerSaveBlockerMode,
  chatsRunning: Schema.Boolean,
});
export type DesktopPowerSaveBlockerState = typeof DesktopPowerSaveBlockerStateSchema.Type;

export const PersistedSavedEnvironmentRecordSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  wsBaseUrl: Schema.String,
  httpBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
});
export type PersistedSavedEnvironmentRecord = typeof PersistedSavedEnvironmentRecordSchema.Type;

export const DesktopDebugEndpointStateSchema = Schema.Struct({
  enabled: Schema.Boolean,
  url: Schema.NullOr(Schema.String),
});
export type DesktopDebugEndpointState = typeof DesktopDebugEndpointStateSchema.Type;

export const DesktopRendererDebugSnapshotSchema = Schema.Record(Schema.String, Schema.Unknown);
export type DesktopRendererDebugSnapshot = typeof DesktopRendererDebugSnapshotSchema.Type;

export interface DesktopBridge {
  getAppBranding: () => DesktopAppBranding | null;
  getLocalEnvironmentBootstrap: () => DesktopEnvironmentBootstrap | null;
  getDebugEndpointState: () => Promise<DesktopDebugEndpointState>;
  publishDebugSnapshot: (snapshot: DesktopRendererDebugSnapshot) => Promise<void>;
  getClientSettings: () => Promise<ClientSettings | null>;
  setClientSettings: (settings: ClientSettings) => Promise<void>;
  setPowerSaveBlockerState: (state: DesktopPowerSaveBlockerState) => Promise<void>;
  getSavedEnvironmentRegistry: () => Promise<readonly PersistedSavedEnvironmentRecord[]>;
  setSavedEnvironmentRegistry: (
    records: readonly PersistedSavedEnvironmentRecord[],
  ) => Promise<void>;
  getSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<string | null>;
  setSavedEnvironmentSecret: (environmentId: EnvironmentId, secret: string) => Promise<boolean>;
  removeSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<void>;
  getServerExposureState: () => Promise<DesktopServerExposureState>;
  setServerExposureMode: (mode: DesktopServerExposureMode) => Promise<DesktopServerExposureState>;
  setServerHttpsEnabled: (enabled: boolean) => Promise<DesktopServerExposureState>;
  getAdvertisedEndpoints: () => Promise<readonly AdvertisedEndpoint[]>;
  pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  openPath: (path: string) => Promise<boolean>;
  revealPath: (path: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  setUpdateChannel: (channel: DesktopUpdateChannel) => Promise<DesktopUpdateState>;
  checkForUpdate: () => Promise<DesktopUpdateCheckResult>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  getSourceUpdateState: () => Promise<DesktopSourceUpdateState>;
  checkSourceUpdate: () => Promise<DesktopSourceUpdateState>;
  onSourceUpdateState: (listener: (state: DesktopSourceUpdateState) => void) => () => void;
}

/**
 * APIs bound to the local app shell, not to any particular backend environment.
 *
 * These capabilities describe the desktop/browser host that the user is
 * currently running: dialogs, editor/external-link opening, context menus, and
 * app-level settings/config access. They must not be used as a proxy for
 * "whatever environment the user is targeting", because in a multi-environment
 * world the local shell and a selected backend environment are distinct
 * concepts.
 */
export interface LocalApi {
  dialogs: {
    pickFolder: (options?: PickFolderOptions) => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openTerminal: (cwd: string) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
    openPath: (path: string) => Promise<void>;
    revealPath: (path: string) => Promise<void>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  persistence: {
    getClientSettings: () => Promise<ClientSettings | null>;
    setClientSettings: (settings: ClientSettings) => Promise<void>;
    getSavedEnvironmentRegistry: () => Promise<readonly PersistedSavedEnvironmentRecord[]>;
    setSavedEnvironmentRegistry: (
      records: readonly PersistedSavedEnvironmentRecord[],
    ) => Promise<void>;
    getSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<string | null>;
    setSavedEnvironmentSecret: (environmentId: EnvironmentId, secret: string) => Promise<boolean>;
    removeSavedEnvironmentSecret: (environmentId: EnvironmentId) => Promise<void>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    /**
     * Refresh provider snapshots. When `input.instanceId` is supplied only that
     * configured instance is probed; otherwise every configured instance is
     * refreshed (legacy untargeted refresh).
     */
    refreshProviders: (input?: {
      readonly instanceId?: ProviderInstanceId;
    }) => Promise<ServerProviderUpdatedPayload>;
    loginProvider: (input: ServerProviderLoginInput) => Promise<ServerProviderLoginResult>;
    updateProvider: (input: ServerProviderUpdateInput) => Promise<ServerProviderUpdatedPayload>;
    restartProviderRuntime: (
      input: ServerProviderRuntimeRestartInput,
    ) => Promise<ServerProviderRuntimeRestartResult>;
    openSystemPromptFile: () => Promise<ServerOpenSystemPromptFileResult>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    removeKeybinding: (input: ServerRemoveKeybindingInput) => Promise<ServerRemoveKeybindingResult>;
    getSettings: () => Promise<ServerSettings>;
    updateSettings: (patch: ServerSettingsPatch) => Promise<ServerSettings>;
    getClientSettings: () => Promise<ClientSettings>;
    updateClientSettings: (patch: ClientSettingsPatch) => Promise<ClientSettings>;
    discoverSourceControl: () => Promise<SourceControlDiscoveryResult>;
    getTraceDiagnostics: () => Promise<ServerTraceDiagnosticsResult>;
    getProcessDiagnostics: () => Promise<ServerProcessDiagnosticsResult>;
    getProcessResourceHistory: (
      input: ServerProcessResourceHistoryInput,
    ) => Promise<ServerProcessResourceHistoryResult>;
    getRuntimeLayerDiagnostics: (
      input?: ServerRuntimeLayerDiagnosticsInput,
    ) => Promise<ServerRuntimeLayerDiagnosticsResult>;
    signalProcess: (input: ServerSignalProcessInput) => Promise<ServerSignalProcessResult>;
  };
}

/**
 * APIs bound to a specific backend environment connection.
 *
 * These operations must always be routed with explicit environment context.
 * They represent remote stateful capabilities such as orchestration, project,
 * VCS, and provider operations. In multi-environment mode, each environment gets
 * its own instance of this surface, and callers should resolve it by
 * `environmentId` rather than reaching through the local desktop bridge.
 */
export interface EnvironmentApi {
  projects: {
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  filesystem: {
    browse: (input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>;
  };
  sourceControl: {
    lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Promise<SourceControlRepositoryInfo>;
    cloneRepository: (
      input: SourceControlCloneRepositoryInput,
    ) => Promise<SourceControlCloneRepositoryResult>;
  };
  vcs: {
    listRefs: (input: VcsListRefsInput) => Promise<VcsListRefsResult>;
    createWorktree: (input: VcsCreateWorktreeInput) => Promise<VcsCreateWorktreeResult>;
    removeWorktree: (input: VcsRemoveWorktreeInput) => Promise<void>;
    createRef: (input: VcsCreateRefInput) => Promise<VcsCreateRefResult>;
    switchRef: (input: VcsSwitchRefInput) => Promise<VcsSwitchRefResult>;
    init: (input: VcsInitInput) => Promise<void>;
    pull: (input: VcsPullInput) => Promise<VcsPullResult>;
    refreshStatus: (input: VcsStatusInput) => Promise<VcsStatusResult>;
    workingTreeDiff: (input: VcsWorkingTreeDiffInput) => Promise<VcsWorkingTreeDiffResult>;
    onStatus: (
      input: VcsStatusInput,
      callback: (status: VcsStatusResult) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
  git: {
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
  };
  orchestration: {
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getArchivedShellSnapshot: () => Promise<OrchestrationShellSnapshot>;
    getDeletedShellSnapshot: () => Promise<OrchestrationShellSnapshot>;
    getThreadTurnActivityPage: (
      input: OrchestrationThreadTurnActivityPageInput,
    ) => Promise<OrchestrationThreadTurnActivityPage>;
    getThreadTurnWorkLogPresence: (
      input: OrchestrationThreadTurnWorkLogPresenceInput,
    ) => Promise<OrchestrationThreadTurnWorkLogPresenceResult>;
    hardDeleteThread: (input: ThreadHardDeleteInput) => Promise<ThreadHardDeleteResult>;
    repairAssistantMessageFromProviderJournal: (
      input: ProviderJournalMessageRepairInput,
    ) => Promise<ProviderJournalMessageRepairResult>;
    repairThreadAssistantMessages: (
      input: ProviderThreadAssistantMessagesRepairInput,
    ) => Promise<ProviderThreadAssistantMessagesRepairResult>;
    subscribeShell: (
      callback: (event: OrchestrationShellStreamItem) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
    subscribeThread: (
      input: OrchestrationSubscribeThreadInput,
      callback: (event: OrchestrationThreadStreamItem) => void,
      options?: {
        onResubscribe?: () => void;
      },
    ) => () => void;
  };
}
