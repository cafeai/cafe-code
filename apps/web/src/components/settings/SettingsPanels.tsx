import { getSettingsPageReset } from "./settingsReset";
import { AmbianceSettingsSections } from "./AmbianceSettings";
import { DataProfileSettings } from "./DataProfileSettings";
import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiFormatList, uiText } from "@cafecode/shared/i18n";
import {
  useWorkspaceEnvironmentId,
  useIsSavedRemoteEnvironment,
} from "../../environments/workspace";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../../environments/runtime";
import { useWsConnectionStatus } from "../../rpc/wsConnectionState";
import { providerSkillsScopeRevision } from "../chat/useProviderSkills";
import {
  ArchiveIcon,
  ArchiveX,
  CopyIcon,
  FileTextIcon,
  MessageSquareIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  defaultInstanceIdForDriver,
  DEFAULT_PROVIDER_INSTANCES,
  type DesktopSourceUpdateState,
  isRetiredProviderDriverKind,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ScopedThreadRef,
} from "@cafecode/contracts";
import { scopeThreadRef } from "@cafecode/client-runtime";
import { copyTextToClipboard } from "../../lib/copyToClipboard";
import {
  DEFAULT_UNIFIED_SETTINGS,
  DEFAULT_APP_ACCENT_COLOR,
  DEFAULT_BRAND_WORDMARK_PREFIX,
  DEFAULT_CONTINUE_BACKGROUND_ANIMATIONS,
  DEFAULT_INTERFACE_SCALE_PERCENT,
  DEFAULT_SHOW_SIDEBAR_ATTRIBUTION,
  DEFAULT_SIDEBAR_BRAND_IMAGE,
  DEFAULT_SIDEBAR_STAR_SPEED,
  DEFAULT_SHOW_SIDEBAR_MASCOT,
  DEFAULT_SHOW_SIDEBAR_SEARCH,
  DEFAULT_THEME_ACCENT_COLOR,
  MAX_BRAND_WORDMARK_PREFIX_LENGTH,
  MAX_INTERFACE_SCALE_PERCENT,
  MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES,
  MAX_SIDEBAR_STAR_SPEED,
  MIN_SIDEBAR_STAR_SPEED,
  MIN_INTERFACE_SCALE_PERCENT,
  type ChatCopyFormat,
  type DefaultEditorSelection,
  type PowerSaveBlockerMode,
} from "@cafecode/contracts/settings";
import { createModelSelection } from "@cafecode/shared/model";
import * as Equal from "effect/Equal";
import { APP_VERSION } from "../../branding";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { useTheme } from "../../hooks/useTheme";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import {
  setDesktopSourceUpdateStateQueryData,
  useDesktopSourceUpdateState,
} from "../../lib/desktopSourceUpdateReactQuery";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ensureWorkspaceApi, readWorkspaceApi } from "../../environments/workspaceApi";
import { getLocalShellCapabilities } from "../../localCapabilities";
import { groupThreadHistory } from "../sidebar/standaloneNavigation.logic";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { useDeletedThreadSnapshots } from "../../lib/deletedThreadsState";
import { formatRelativeTime, formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Slider } from "../ui/slider";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { InfoTip } from "../ui/info-tip";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AddProviderInstanceDialog } from "./AddProviderInstanceDialog";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  hasOneClickUpdateProviderCandidate,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
} from "../ProviderUpdateLaunchNotification.logic";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta";
import {
  buildEmptyRecycleBinConfirmationMessage,
  buildProviderInstanceUpdatePatch,
  collectRecentlyDeletedThreadRefs,
  formatDiagnosticsDescription,
} from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  useServerAvailableEditors,
  useServerObservability,
  useServerProviders,
} from "../../rpc/serverState";
import { resolveEditorOpenOptions, type EditorOpenOption } from "../../editorOpenOptions";
import { snapInterfaceScalePercent } from "../../interfaceScale";
import { openInPreferredEditor } from "../../editorPreferences";
import {
  DEFAULT_SIDEBAR_BRAND_IMAGE_SIZES,
  DEFAULT_SIDEBAR_BRAND_IMAGE_SRC_SET,
  useSidebarBrandImageSrc,
  uploadSidebarBrandImage,
} from "../../brandingImages";
import { ColorWheelPicker } from "./ColorWheelPicker";

const THEME_OPTIONS = [
  {
    value: "system",
    get label() {
      return uiText("System");
    },
  },
  {
    value: "light",
    get label() {
      return uiText("Light");
    },
  },
  {
    value: "dark",
    get label() {
      return uiText("Dark");
    },
  },
] as const;

function canRestartProviderRuntime(driver: ProviderDriverKind): boolean {
  return driver === "codex" || driver === "claudeAgent";
}
const DEFAULT_APP_ACCENT_PICKER_COLOR = "#2563eb";
const DEFAULT_SIDEBAR_ACCENT_PICKER_COLOR = "#48cfff";
const SIDEBAR_IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
const SIDEBAR_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function clampSidebarStarSpeed(value: number | null): number {
  if (value === null || !Number.isFinite(value)) {
    return DEFAULT_SIDEBAR_STAR_SPEED;
  }
  return Math.min(MAX_SIDEBAR_STAR_SPEED, Math.max(MIN_SIDEBAR_STAR_SPEED, value));
}

const TIMESTAMP_FORMAT_LABELS = {
  get locale() {
    return uiText("System default");
  },
  get "12-hour"() {
    return uiText("12-hour");
  },
  get "24-hour"() {
    return uiText("24-hour");
  },
} as const;

const CHAT_COPY_FORMAT_LABELS = {
  get markdown() {
    return uiText("Markdown");
  },
  get plainText() {
    return uiText("Plain text");
  },
} as const satisfies Record<ChatCopyFormat, string>;

const DEFAULT_EDITOR_SYSTEM_VALUE = "system-default" satisfies DefaultEditorSelection;

const POWER_SAVE_BLOCKER_LABELS = {
  get off() {
    return uiText("Off");
  },
  get "during-chats"() {
    return uiText("During chats");
  },
  get always() {
    return uiText("Always");
  },
} as const satisfies Record<PowerSaveBlockerMode, string>;

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");

function DefaultEditorOptionLabel({
  Icon,
  label,
  testId,
}: {
  readonly Icon?: EditorOpenOption["Icon"] | undefined;
  readonly label: string;
  readonly testId?: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2" data-testid={testId}>
      {Icon ? (
        <Icon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground sm:size-3.5"
          data-testid={testId ? `${testId}-icon` : undefined}
        />
      ) : null}
      <span className="truncate">{label}</span>
    </span>
  );
}

function withoutProviderInstanceKey<V>(
  record: Readonly<Record<ProviderInstanceId, V>> | undefined,
  key: ProviderInstanceId,
): Record<ProviderInstanceId, V> {
  const next = { ...record } as Record<ProviderInstanceId, V>;
  delete next[key];
  return next;
}

function withoutProviderInstanceFavorites(
  favorites: ReadonlyArray<{ readonly provider: ProviderInstanceId; readonly model: string }>,
  instanceId: ProviderInstanceId,
) {
  return favorites.filter((favorite) => favorite.provider !== instanceId);
}

// Legacy defaults remain in providers; newer built-in accounts (Axiom) live
// entirely in providerInstances and join the rows below without a mirror.
const PROVIDER_SETTINGS = DRIVER_OPTIONS.filter((definition) =>
  Object.hasOwn(DEFAULT_UNIFIED_SETTINGS.providers, definition.value),
).map((definition) => ({ provider: definition.value }));

function ProviderLastChecked({ lastCheckedAt }: { lastCheckedAt: string | null }) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  useRelativeTimeTick();
  const lastCheckedRelative = lastCheckedAt
    ? uiPresentation.formatRelativeTime(lastCheckedAt)
    : null;

  if (!lastCheckedRelative) {
    return null;
  }

  return (
    <span className="text-2xs text-subtle-foreground">
      {lastCheckedRelative.suffix ? (
        <>
          {uiText("Checked ", undefined, undefined, uiLocale)}
          <span className="font-mono tabular-nums">{lastCheckedRelative.value}</span>{" "}
          {lastCheckedRelative.suffix}
        </>
      ) : (
        <>
          {uiText("Checked ", undefined, undefined, uiLocale)}
          {lastCheckedRelative.value}
        </>
      )}
    </span>
  );
}

function getSourceUpdateBranchLabel(state: DesktopSourceUpdateState | null) {
  if (state?.trackedBranch) {
    return uiText("{branch} branch", { branch: state.trackedBranch });
  }
  if (state?.status === "ignored") {
    return uiText("ignored - not main or dev");
  }
  return uiText("source unavailable");
}

function formatSourceHash(hash: string | null) {
  return hash ? hash.slice(0, 12) : uiText("unknown");
}

function sourceUpdateRequiresRebuild(state: DesktopSourceUpdateState | null) {
  return Boolean(
    state?.trackedBranch &&
    state.localHash &&
    state.runtimeHash &&
    state.localHash !== state.runtimeHash &&
    state.status !== "behind",
  );
}

/** One short status line for the Version row; hashes live in its info tooltip. */
function getSourceUpdateStatus(state: DesktopSourceUpdateState | null, hasDesktopBridge: boolean) {
  if (!hasDesktopBridge) {
    return uiText("Update checks need the desktop app.");
  }
  if (!state || state.status === "idle") {
    return uiText("Not checked yet.");
  }
  if (state.status === "checking") {
    return uiText("Checking…");
  }
  if (!state.trackedBranch) {
    return state.message ?? uiText("Only main and dev are tracked.");
  }
  if (sourceUpdateRequiresRebuild(state)) {
    return uiText("Rebuild to apply ({branch})", { branch: state.trackedBranch });
  }
  if (state.status === "behind") {
    return uiText("Newer {branch} commit available", { branch: state.trackedBranch });
  }
  if (state.status === "current") {
    return uiText("Up to date.");
  }
  return state.message;
}

/** Commit details for the Version row tooltip, or null before a check has run. */
function getSourceUpdateHashLines(state: DesktopSourceUpdateState | null): string[] | null {
  if (!state || state.status === "idle" || state.status === "checking") {
    return null;
  }
  const dirtyLabel =
    state.dirty === null
      ? uiText("dirty state unknown")
      : state.dirty
        ? uiText("dirty")
        : uiText("clean");
  return [
    uiText("Current: {hash} ({dirty})", {
      hash: formatSourceHash(state.localHash),
      dirty: dirtyLabel,
    }),
    uiText("Running build: {hash}", { hash: formatSourceHash(state.runtimeHash) }),
    ...(state.trackedBranch
      ? [
          uiText("Latest origin/{branch}: {hash}", {
            branch: state.trackedBranch,
            hash: formatSourceHash(state.remoteHash),
          }),
        ]
      : []),
  ];
}

function AboutVersionTitle({ state }: { readonly state: DesktopSourceUpdateState | null }) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  return (
    <span className="inline-flex items-center gap-2">
      <span>{uiText("Version", undefined, undefined, uiLocale)}</span>
      <code className="text-2xs font-medium text-muted-foreground">
        {APP_VERSION} ({uiPresentation.getSourceUpdateBranchLabel(state)})
      </code>
    </span>
  );
}

function AboutVersionSection() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const queryClient = useQueryClient();
  const sourceUpdateStateQuery = useDesktopSourceUpdateState();

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const sourceUpdateState = sourceUpdateStateQuery.data ?? null;

  const handleButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.checkSourceUpdate !== "function") return;
    void bridge
      .checkSourceUpdate()
      .then((state) => {
        setDesktopSourceUpdateStateQueryData(queryClient, state);
      })
      .catch((error: unknown) => {
        console.warn("Source update check failed", error);
      });
  }, [queryClient]);

  const isChecking = sourceUpdateState?.status === "checking";
  const buttonDisabled = !hasDesktopBridge || isChecking;
  const status = uiPresentation.getSourceUpdateStatus(sourceUpdateState, hasDesktopBridge);
  const hashLines = uiPresentation.getSourceUpdateHashLines(sourceUpdateState);

  return (
    <SettingsRow
      title={<AboutVersionTitle state={sourceUpdateState} />}
      description={
        <span className="inline-flex items-center gap-1.5">
          <span>{status}</span>
          {hashLines ? (
            <InfoTip label={uiText("Version details", undefined, undefined, uiLocale)}>
              <span className="block font-mono whitespace-pre-line">{hashLines.join("\n")}</span>
            </InfoTip>
          ) : null}
        </span>
      }
      control={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                disabled={buttonDisabled}
                onClick={handleButtonClick}
              >
                {isChecking ? <Spinner aria-hidden="true" className="size-3.5" /> : null}
                {uiText("Check for updates", undefined, undefined, uiLocale)}
              </Button>
            }
          />
          {!hasDesktopBridge ? (
            <TooltipPopup>
              {uiText("Update checks need the desktop app.", undefined, undefined, uiLocale)}
            </TooltipPopup>
          ) : null}
        </Tooltip>
      }
    />
  );
}

export function useSettingsRestore(onRestored?: () => void, pathname = "/settings/appearance") {
  const uiLocale = useUiLocale();
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const languagePreference = useSettings((current) => current.languagePreference, {
    environmentId: null,
  });
  const { updateSettings: updateLanguageSettings } = useUpdateSettings({ environmentId: null });
  const reset = getSettingsPageReset(
    pathname,
    settings,
    {
      desktop: typeof window.desktopBridge?.setPowerSaveBlockerState === "function",
    },
    uiLocale,
  );
  const general = pathname === "/settings/general";
  const appearance = pathname === "/settings/appearance";
  const changedSettingLabels = [
    ...(appearance && theme !== "system" ? [uiText("Theme", undefined, undefined, uiLocale)] : []),
    ...(general && languagePreference !== "system"
      ? [uiText("Language", undefined, undefined, uiLocale)]
      : []),
    ...reset.labels,
  ];
  const restoreDefaults = async () => {
    if (!changedSettingLabels.length) return;
    const confirmed = await (readWorkspaceApi() ?? ensureWorkspaceApi()).dialogs.confirm(
      uiText(
        "Reset this page to defaults?\nThis will reset: {settings}.",
        { settings: uiFormatList(changedSettingLabels, { style: "long", type: "unit" }) },
        undefined,
        uiLocale,
      ),
    );
    if (!confirmed) return;
    if (appearance) setTheme("system");
    if (general)
      updateLanguageSettings({ languagePreference: DEFAULT_UNIFIED_SETTINGS.languagePreference });
    updateSettings(reset.patch);
    onRestored?.();
  };
  return { changedSettingLabels, restoreDefaults };
}

export function TextGenerationModelSettingsRow() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();
  const textGenerationModelSelection = uiPresentation.resolveAppModelSelectionState(
    settings,
    serverProviders,
  );
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const gitModelInstanceEntries = sortProviderInstanceEntries(
    deriveProviderInstanceEntries(serverProviders),
  );
  const textGenInstanceEntry = gitModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const gitModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isGitWritingModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  return (
    <SettingsRow
      title={uiText("Automatic naming model", undefined, undefined, uiLocale)}
      description={uiText("Writes chat titles and branch names.", undefined, undefined, uiLocale)}
      resetAction={
        isGitWritingModelDirty ? (
          <SettingResetButton
            label={uiText("automatic naming model", undefined, undefined, uiLocale)}
            onClick={() =>
              updateSettings({
                textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
              })
            }
          />
        ) : null
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <ProviderModelPicker
            activeInstanceId={textGenInstanceId}
            model={textGenModel}
            lockedProvider={null}
            instanceEntries={gitModelInstanceEntries}
            modelOptionsByInstance={gitModelOptionsByInstance}
            triggerVariant="outline"
            triggerClassName="min-w-0 max-w-none shrink-0 text-foreground"
            onInstanceModelChange={(instanceId, model) => {
              updateSettings({
                textGenerationModelSelection: uiPresentation.resolveAppModelSelectionState(
                  {
                    ...settings,
                    textGenerationModelSelection: createModelSelection(instanceId, model),
                  },
                  serverProviders,
                ),
              });
            }}
          />
          <TraitsPicker
            provider={textGenProvider}
            models={
              // Use the exact instance's models so custom text-generation instances
              // keep their own model list instead of falling back to the default kind.
              (textGenInstanceEntry?.models ?? []).map((model) => ({
                ...model,
                ...(textGenProvider === "codex" && model.capabilities
                  ? {
                      capabilities: {
                        ...model.capabilities,
                        optionDescriptors: model.capabilities.optionDescriptors?.filter(
                          (option) => option.id !== "cyberAccessProgram",
                        ),
                      },
                    }
                  : {}),
              }))
            }
            model={textGenModel}
            prompt=""
            onPromptChange={() => {}}
            modelOptions={textGenModelOptions}
            allowPromptInjectedEffort={false}
            triggerVariant="outline"
            triggerClassName="min-w-0 max-w-none shrink-0 text-foreground"
            onModelOptionsChange={(nextOptions) => {
              updateSettings({
                textGenerationModelSelection: uiPresentation.resolveAppModelSelectionState(
                  {
                    ...settings,
                    textGenerationModelSelection: createModelSelection(
                      textGenInstanceId,
                      textGenModel,
                      nextOptions,
                    ),
                  },
                  serverProviders,
                ),
              });
            }}
          />
        </div>
      }
    />
  );
}

export function GeneralSettingsPanel() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsPageContainer title={uiText("General", undefined, undefined, uiLocale)}>
      <SettingsSection title={uiText("Language & time", undefined, undefined, uiLocale)}>
        <LanguageSettingsRow />
        <SettingsRow
          title={uiText("Time format", undefined, undefined, uiLocale)}
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label={uiText("time format", undefined, undefined, uiLocale)}
                onClick={() =>
                  updateSettings({ timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger
                className="w-full sm:w-40"
                aria-label={uiText("Timestamp format", undefined, undefined, uiLocale)}
              >
                <SelectValue>
                  {uiPresentation.TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {uiPresentation.TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {uiPresentation.TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {uiPresentation.TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
      <SettingsSection title={uiText("Projects & workspaces", undefined, undefined, uiLocale)}>
        <SettingsRow
          title={uiText("Default project folder", undefined, undefined, uiLocale)}
          resetAction={
            settings.addProjectBaseDirectory !==
            DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory ? (
              <SettingResetButton
                label={uiText("add project base directory", undefined, undefined, uiLocale)}
                onClick={() =>
                  updateSettings({
                    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
                  })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              className="w-full sm:w-72"
              value={settings.addProjectBaseDirectory}
              onCommit={(next) => updateSettings({ addProjectBaseDirectory: next })}
              placeholder="~/"
              spellCheck={false}
              aria-label={uiText("Add project base directory", undefined, undefined, uiLocale)}
            />
          }
        />
        <SettingsRow
          title={uiText("New chats", undefined, undefined, uiLocale)}
          description={uiText("Default workspace for new chats.", undefined, undefined, uiLocale)}
          resetAction={
            settings.defaultThreadEnvMode !== DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode ? (
              <SettingResetButton
                label={uiText("new chats", undefined, undefined, uiLocale)}
                onClick={() =>
                  updateSettings({
                    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.defaultThreadEnvMode}
              onValueChange={(value) => {
                if (value === "local" || value === "worktree") {
                  updateSettings({ defaultThreadEnvMode: value });
                }
              }}
            >
              <SelectTrigger
                className="w-full sm:w-44"
                aria-label={uiText("Default chat workspace", undefined, undefined, uiLocale)}
              >
                <SelectValue>
                  {settings.defaultThreadEnvMode === "worktree"
                    ? uiText("New worktree", undefined, undefined, uiLocale)
                    : uiText("Local", undefined, undefined, uiLocale)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="local">
                  {uiText("Local", undefined, undefined, uiLocale)}
                </SelectItem>
                <SelectItem hideIndicator value="worktree">
                  {uiText("New worktree", undefined, undefined, uiLocale)}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
      <DataProfileSettings />
      <FilesSettingsSection />
      <SystemSettingsSections />
    </SettingsPageContainer>
  );
}

/** Interface language belongs to the current client, even while a remote
 * workspace is selected. Native/server persistence retains the exact enum;
 * choosing English is never normalized to System default. */
export function LanguageSettingsRow() {
  const uiLocale = useUiLocale();
  const settings = useSettings((current) => ({ languagePreference: current.languagePreference }), {
    environmentId: null,
  });
  const { updateSettings } = useUpdateSettings({ environmentId: null });
  return (
    <SettingsRow
      title={uiText("Language", undefined, undefined, uiLocale)}
      resetAction={
        settings.languagePreference !== "system" ? (
          <SettingResetButton
            label={uiText("language", undefined, undefined, uiLocale)}
            onClick={() => updateSettings({ languagePreference: "system" })}
          />
        ) : null
      }
      control={
        <Select
          value={settings.languagePreference}
          onValueChange={(value) => {
            if (value === "system" || value === "en" || value === "ja" || value === "ko") {
              updateSettings({ languagePreference: value });
            }
          }}
        >
          <SelectTrigger
            className="w-full sm:w-40"
            aria-label={uiText("Interface language", undefined, undefined, uiLocale)}
          >
            <SelectValue>
              {settings.languagePreference === "system"
                ? uiText("System default", undefined, undefined, uiLocale)
                : settings.languagePreference === "ja"
                  ? uiText("日本語", undefined, "language-self-name", uiLocale)
                  : settings.languagePreference === "ko"
                    ? uiText("한국어", undefined, "language-self-name", uiLocale)
                    : uiText("English", undefined, "language-self-name", uiLocale)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="system">
              {uiText("System default", undefined, undefined, uiLocale)}
            </SelectItem>
            <SelectItem hideIndicator value="en">
              {uiText("English", undefined, "language-self-name", uiLocale)}
            </SelectItem>
            <SelectItem hideIndicator value="ja">
              {uiText("日本語", undefined, "language-self-name", uiLocale)}
            </SelectItem>
            <SelectItem hideIndicator value="ko">
              {uiText("한국어", undefined, "language-self-name", uiLocale)}
            </SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

export function AppearanceSettingsPanel() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const environmentId = useWorkspaceEnvironmentId();
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const sidebarImageInputRef = useRef<HTMLInputElement | null>(null);
  const sidebarImagePreviewUrlRef = useRef<string | null>(null);
  const [sidebarImageError, setSidebarImageError] = useState<string | null>(null);
  const [sidebarImagePreviewUrl, setSidebarImagePreviewUrl] = useState<string | null>(null);
  const [sidebarImageUploading, setSidebarImageUploading] = useState(false);
  const savedSidebarImageSrc = useSidebarBrandImageSrc(settings.sidebarBrandImage);
  const sidebarImageSrc = sidebarImagePreviewUrl ?? savedSidebarImageSrc;
  const sidebarImageUsesDefault =
    sidebarImagePreviewUrl === null && settings.sidebarBrandImage === DEFAULT_SIDEBAR_BRAND_IMAGE;
  const sidebarImageSrcSet = sidebarImageUsesDefault
    ? DEFAULT_SIDEBAR_BRAND_IMAGE_SRC_SET
    : undefined;

  const clearSidebarImagePreviewUrl = useCallback(() => {
    if (sidebarImagePreviewUrlRef.current) {
      if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(sidebarImagePreviewUrlRef.current);
      }
      sidebarImagePreviewUrlRef.current = null;
    }
    setSidebarImagePreviewUrl(null);
  }, []);

  const setTemporarySidebarImagePreviewUrl = useCallback(
    (file: File) => {
      clearSidebarImagePreviewUrl();
      if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
        return;
      }
      const previewUrl = URL.createObjectURL(file);
      sidebarImagePreviewUrlRef.current = previewUrl;
      setSidebarImagePreviewUrl(previewUrl);
    },
    [clearSidebarImagePreviewUrl],
  );

  useEffect(() => clearSidebarImagePreviewUrl, [clearSidebarImagePreviewUrl]);

  const handleSidebarImageChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file) {
        return;
      }

      if (!SIDEBAR_IMAGE_MIME_TYPES.has(file.type)) {
        setSidebarImageError(
          uiText("Choose a PNG, JPEG, GIF, or WebP image.", undefined, undefined, uiLocale),
        );
        return;
      }

      if (file.size > MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES) {
        setSidebarImageError(uiText("Choose an image under 1 MB.", undefined, undefined, uiLocale));
        return;
      }

      setTemporarySidebarImagePreviewUrl(file);
      setSidebarImageUploading(true);
      try {
        const sidebarBrandImage = await uploadSidebarBrandImage(file, environmentId);
        setSidebarImageError(null);
        updateSettings({ sidebarBrandImage, sidebarBrandImageDataUrl: "" });
        clearSidebarImagePreviewUrl();
      } catch (error) {
        clearSidebarImagePreviewUrl();
        setSidebarImageError(
          error instanceof Error
            ? error.message
            : uiText("Could not upload that image.", undefined, undefined, uiLocale),
        );
      } finally {
        setSidebarImageUploading(false);
      }
    },
    [
      clearSidebarImagePreviewUrl,
      environmentId,
      setTemporarySidebarImagePreviewUrl,
      updateSettings,
      uiLocale,
    ],
  );

  return (
    <SettingsPageContainer title={uiText("Appearance", undefined, undefined, uiLocale)}>
      <SettingsSection title={uiText("Interface", undefined, undefined, uiLocale)}>
        <SettingsRow
          title={uiText("Theme", undefined, undefined, uiLocale)}
          resetAction={
            theme !== "system" ? (
              <SettingResetButton
                label={uiText("theme", undefined, undefined, uiLocale)}
                onClick={() => setTheme("system")}
              />
            ) : null
          }
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setTheme(value);
                }
              }}
            >
              <SelectTrigger
                className="w-full sm:w-40"
                aria-label={uiText("Theme preference", undefined, undefined, uiLocale)}
              >
                <SelectValue>
                  {uiPresentation.THEME_OPTIONS.find((option) => option.value === theme)?.label ??
                    uiText("System", undefined, undefined, uiLocale)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {uiPresentation.THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title={uiText("Interface size", undefined, undefined, uiLocale)}
          resetAction={
            settings.interfaceScalePercent !== DEFAULT_INTERFACE_SCALE_PERCENT ? (
              <SettingResetButton
                label={uiText("interface size", undefined, undefined, uiLocale)}
                onClick={() =>
                  updateSettings({ interfaceScalePercent: DEFAULT_INTERFACE_SCALE_PERCENT })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-56">
              <Slider
                value={settings.interfaceScalePercent}
                min={MIN_INTERFACE_SCALE_PERCENT}
                max={MAX_INTERFACE_SCALE_PERCENT}
                step={5}
                aria-label={uiText("Interface size", undefined, undefined, uiLocale)}
                onValueChange={(value) =>
                  updateSettings({ interfaceScalePercent: snapInterfaceScalePercent(value) })
                }
              />
              <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {settings.interfaceScalePercent}%
              </span>
            </div>
          }
        />

        <SettingsRow
          title={uiText("Accent color", undefined, undefined, uiLocale)}
          description={uiText(
            "Used for buttons, selection and focus.",
            undefined,
            undefined,
            uiLocale,
          )}
          resetAction={
            settings.appAccentColor !== DEFAULT_UNIFIED_SETTINGS.appAccentColor ? (
              <SettingResetButton
                label={uiText("accent color", undefined, undefined, uiLocale)}
                onClick={() => updateSettings({ appAccentColor: DEFAULT_APP_ACCENT_COLOR })}
              />
            ) : null
          }
          control={
            <ColorWheelPicker
              value={settings.appAccentColor}
              defaultPickerColor={DEFAULT_APP_ACCENT_PICKER_COLOR}
              emptyValue={DEFAULT_APP_ACCENT_COLOR}
              ariaLabel="App accent color"
              onCommit={(value) => updateSettings({ appAccentColor: value })}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title={uiText("Sidebar", undefined, undefined, uiLocale)}>
        <SettingsRow
          title={uiText("Branding prefix", undefined, undefined, uiLocale)}
          description={uiText("Replaces ''Cafe'' in the wordmark.", undefined, undefined, uiLocale)}
          resetAction={
            settings.brandWordmarkPrefix !== DEFAULT_UNIFIED_SETTINGS.brandWordmarkPrefix ? (
              <SettingResetButton
                label={uiText("branding prefix", undefined, undefined, uiLocale)}
                onClick={() =>
                  updateSettings({ brandWordmarkPrefix: DEFAULT_BRAND_WORDMARK_PREFIX })
                }
              />
            ) : null
          }
          control={
            <DraftInput
              aria-label={uiText("Branding prefix", undefined, undefined, uiLocale)}
              className="w-full sm:w-48"
              maxLength={MAX_BRAND_WORDMARK_PREFIX_LENGTH}
              placeholder={DEFAULT_BRAND_WORDMARK_PREFIX}
              value={settings.brandWordmarkPrefix}
              onCommit={(value) =>
                updateSettings({
                  brandWordmarkPrefix: value.trim().slice(0, MAX_BRAND_WORDMARK_PREFIX_LENGTH),
                })
              }
            />
          }
        />

        <SettingsRow
          title={uiText("Sidebar effects color", undefined, undefined, uiLocale)}
          description={uiText("Colors the sidebar stars and glow.", undefined, undefined, uiLocale)}
          resetAction={
            settings.themeAccentColor !== DEFAULT_UNIFIED_SETTINGS.themeAccentColor ? (
              <SettingResetButton
                label={uiText("sidebar effects color", undefined, undefined, uiLocale)}
                onClick={() => updateSettings({ themeAccentColor: DEFAULT_THEME_ACCENT_COLOR })}
              />
            ) : null
          }
          control={
            <ColorWheelPicker
              value={settings.themeAccentColor}
              defaultPickerColor={DEFAULT_SIDEBAR_ACCENT_PICKER_COLOR}
              emptyValue={DEFAULT_THEME_ACCENT_COLOR}
              ariaLabel="Animated sidebar color"
              onCommit={(value) => updateSettings({ themeAccentColor: value })}
            />
          }
        />

        <SettingsRow
          title={uiText("Sidebar search", undefined, undefined, uiLocale)}
          resetAction={
            settings.showSidebarSearch !== DEFAULT_UNIFIED_SETTINGS.showSidebarSearch ? (
              <SettingResetButton
                label={uiText("sidebar search", undefined, undefined, uiLocale)}
                onClick={() => updateSettings({ showSidebarSearch: DEFAULT_SHOW_SIDEBAR_SEARCH })}
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.showSidebarSearch}
              onCheckedChange={(checked) => updateSettings({ showSidebarSearch: Boolean(checked) })}
              aria-label={uiText("Show sidebar search", undefined, undefined, uiLocale)}
            />
          }
        />

        <SettingsRow
          title={uiText("Enable sidebar image", undefined, undefined, uiLocale)}
          resetAction={
            settings.showSidebarMascot !== DEFAULT_UNIFIED_SETTINGS.showSidebarMascot ? (
              <SettingResetButton
                label={uiText("sidebar image visibility", undefined, undefined, uiLocale)}
                onClick={() => updateSettings({ showSidebarMascot: DEFAULT_SHOW_SIDEBAR_MASCOT })}
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.showSidebarMascot}
              onCheckedChange={(checked) => updateSettings({ showSidebarMascot: Boolean(checked) })}
              aria-label={uiText("Enable sidebar image", undefined, undefined, uiLocale)}
            />
          }
        />

        <SettingsRow
          className={settings.showSidebarMascot ? undefined : "opacity-50"}
          title={uiText("Sidebar image", undefined, undefined, uiLocale)}
          description={uiText(
            "PNG, JPEG, GIF or WebP, under 1 MB.",
            undefined,
            undefined,
            uiLocale,
          )}
          resetAction={
            settings.showSidebarMascot &&
            !sidebarImageUploading &&
            settings.sidebarBrandImage !== DEFAULT_UNIFIED_SETTINGS.sidebarBrandImage ? (
              <SettingResetButton
                label={uiText("sidebar image", undefined, undefined, uiLocale)}
                onClick={() => {
                  setSidebarImageError(null);
                  clearSidebarImagePreviewUrl();
                  updateSettings({
                    sidebarBrandImage: DEFAULT_SIDEBAR_BRAND_IMAGE,
                    sidebarBrandImageDataUrl: "",
                  });
                }}
              />
            ) : null
          }
          status={
            sidebarImageError ? (
              <span className="text-destructive-foreground">{sidebarImageError}</span>
            ) : null
          }
          control={
            <div className="flex w-full flex-col items-start gap-2 sm:w-72">
              <div className="flex w-full items-center gap-3">
                <img
                  alt=""
                  aria-hidden="true"
                  className="h-14 w-11 shrink-0 rounded-lg object-cover ring-1 ring-border"
                  draggable={false}
                  sizes={DEFAULT_SIDEBAR_BRAND_IMAGE_SIZES}
                  src={sidebarImageSrc}
                  srcSet={sidebarImageSrcSet}
                />
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Button
                    disabled={!settings.showSidebarMascot || sidebarImageUploading}
                    size="xs"
                    variant="outline"
                    onClick={() => sidebarImageInputRef.current?.click()}
                  >
                    {sidebarImageUploading ? (
                      <Spinner aria-hidden="true" className="size-3.5" />
                    ) : null}
                    {uiText("Choose image", undefined, undefined, uiLocale)}
                  </Button>
                  {settings.sidebarBrandImage ? (
                    <Button
                      disabled={!settings.showSidebarMascot || sidebarImageUploading}
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        setSidebarImageError(null);
                        clearSidebarImagePreviewUrl();
                        updateSettings({
                          sidebarBrandImage: DEFAULT_SIDEBAR_BRAND_IMAGE,
                          sidebarBrandImageDataUrl: "",
                        });
                      }}
                    >
                      {uiText("Use default", undefined, undefined, uiLocale)}
                    </Button>
                  ) : null}
                </div>
              </div>
              <input
                ref={sidebarImageInputRef}
                type="file"
                disabled={!settings.showSidebarMascot || sidebarImageUploading}
                accept={SIDEBAR_IMAGE_ACCEPT}
                aria-label={uiText("Sidebar image file", undefined, undefined, uiLocale)}
                className="sr-only"
                tabIndex={-1}
                onChange={(event) => void handleSidebarImageChange(event)}
              />
            </div>
          }
        />

        <SettingsRow
          title={uiText("Sidebar attribution", undefined, undefined, uiLocale)}
          resetAction={
            settings.showSidebarAttribution !== DEFAULT_UNIFIED_SETTINGS.showSidebarAttribution ? (
              <SettingResetButton
                label={uiText("sidebar attribution", undefined, undefined, uiLocale)}
                onClick={() =>
                  updateSettings({ showSidebarAttribution: DEFAULT_SHOW_SIDEBAR_ATTRIBUTION })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.showSidebarAttribution}
              onCheckedChange={(checked) =>
                updateSettings({ showSidebarAttribution: Boolean(checked) })
              }
              aria-label={uiText("Show sidebar attribution", undefined, undefined, uiLocale)}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title={uiText("Motion", undefined, undefined, uiLocale)}>
        <SettingsRow
          title={uiText("Animate while unfocused", undefined, undefined, uiLocale)}
          description={uiText(
            "Keep decorations moving while Cafe is hidden or unfocused.",
            undefined,
            undefined,
            uiLocale,
          )}
          resetAction={
            settings.continueBackgroundAnimations !==
            DEFAULT_UNIFIED_SETTINGS.continueBackgroundAnimations ? (
              <SettingResetButton
                label={uiText("animations while unfocused", undefined, undefined, uiLocale)}
                onClick={() =>
                  updateSettings({
                    continueBackgroundAnimations: DEFAULT_CONTINUE_BACKGROUND_ANIMATIONS,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.continueBackgroundAnimations}
              onCheckedChange={(checked) =>
                updateSettings({ continueBackgroundAnimations: Boolean(checked) })
              }
              aria-label={uiText(
                "Keep animations running in background",
                undefined,
                undefined,
                uiLocale,
              )}
            />
          }
        />

        <SettingsRow
          title={uiText("Sidebar star speed", undefined, undefined, uiLocale)}
          resetAction={
            settings.sidebarStarSpeed !== DEFAULT_UNIFIED_SETTINGS.sidebarStarSpeed ? (
              <SettingResetButton
                label={uiText("sidebar star speed", undefined, undefined, uiLocale)}
                onClick={() => updateSettings({ sidebarStarSpeed: DEFAULT_SIDEBAR_STAR_SPEED })}
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-2">
              <NumberField
                value={settings.sidebarStarSpeed}
                min={MIN_SIDEBAR_STAR_SPEED}
                max={MAX_SIDEBAR_STAR_SPEED}
                step={0.25}
                size="sm"
                className="w-28"
                onValueChange={(value) =>
                  updateSettings({ sidebarStarSpeed: clampSidebarStarSpeed(value) })
                }
              >
                <NumberFieldGroup>
                  <NumberFieldDecrement
                    aria-label={uiText(
                      "Decrease sidebar star speed",
                      undefined,
                      undefined,
                      uiLocale,
                    )}
                  />
                  <NumberFieldInput
                    aria-label={uiText(
                      "Sidebar star speed multiplier",
                      undefined,
                      undefined,
                      uiLocale,
                    )}
                  />
                  <NumberFieldIncrement
                    aria-label={uiText(
                      "Increase sidebar star speed",
                      undefined,
                      undefined,
                      uiLocale,
                    )}
                  />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-xs text-muted-foreground">
                {uiText("x", undefined, undefined, uiLocale)}
              </span>
            </div>
          }
        />
      </SettingsSection>
      <AmbianceSettingsSections />
    </SettingsPageContainer>
  );
}

export function ChatSettingsPanel() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [isOpeningSystemPromptFile, setIsOpeningSystemPromptFile] = useState(false);
  const nativeEnvironmentId = useWorkspaceEnvironmentId();
  const canOpenLocalEditor = getLocalShellCapabilities(nativeEnvironmentId).canOpenLocalEditor;

  const openSystemPromptFile = useCallback(() => {
    setIsOpeningSystemPromptFile(true);
    void Promise.resolve()
      .then(() => {
        const api = ensureWorkspaceApi();
        return api.server.openSystemPromptFile().then(async ({ path }) => {
          if (!canOpenLocalEditor) {
            await copyTextToClipboard(path);
            toastManager.add({
              title: uiText("Path copied", undefined, undefined, uiLocale),
              description: path,
              type: "success",
            });
            return;
          }
          return openInPreferredEditor(api, path);
        });
      })
      .catch((error: unknown) => {
        toastManager.add({
          title: canOpenLocalEditor
            ? uiText("Unable to open system prompt file", undefined, undefined, uiLocale)
            : uiText("Unable to copy system prompt path", undefined, undefined, uiLocale),
          description:
            error instanceof Error
              ? error.message
              : canOpenLocalEditor
                ? uiText("The system prompt file was not opened.", undefined, undefined, uiLocale)
                : uiText("The system prompt path was not copied.", undefined, undefined, uiLocale),
          type: "error",
        });
      })
      .finally(() => {
        setIsOpeningSystemPromptFile(false);
      });
  }, [canOpenLocalEditor, uiLocale]);

  return (
    <SettingsPageContainer title={uiText("Chats", undefined, undefined, uiLocale)}>
      <SettingsSection title={uiText("Navigation", undefined, undefined, uiLocale)}>
        <SettingsRow
          title={uiText("Task Atrium", undefined, undefined, uiLocale)}
          description={uiText(
            "Adds an Atrium button above Settings: a read-only overview of chats and subagents.",
            undefined,
            undefined,
            uiLocale,
          )}
          resetAction={
            settings.ambianceAtriumEnabled !== DEFAULT_UNIFIED_SETTINGS.ambianceAtriumEnabled ? (
              <SettingResetButton
                label={uiText("task atrium", undefined, undefined, uiLocale)}
                onClick={() =>
                  updateSettings({
                    ambianceAtriumEnabled: DEFAULT_UNIFIED_SETTINGS.ambianceAtriumEnabled,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.ambianceAtriumEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ ambianceAtriumEnabled: Boolean(checked) })
              }
              aria-label={uiText("Enable Task Atrium", undefined, undefined, uiLocale)}
            />
          }
        />

        <SettingsRow
          title={uiText("Clicking a chat", undefined, undefined, uiLocale)}
          description={uiText(
            "Preview temporarily, or keep each chat open as a tab.",
            undefined,
            undefined,
            uiLocale,
          )}
          resetAction={
            settings.chatClickBehavior !== DEFAULT_UNIFIED_SETTINGS.chatClickBehavior ? (
              <SettingResetButton
                label={uiText("clicking a chat", undefined, undefined, uiLocale)}
                onClick={() =>
                  updateSettings({ chatClickBehavior: DEFAULT_UNIFIED_SETTINGS.chatClickBehavior })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.chatClickBehavior}
              onValueChange={(value) => {
                if (value === "preview" || value === "open")
                  updateSettings({ chatClickBehavior: value });
              }}
            >
              <SelectTrigger
                className="w-full sm:w-44"
                aria-label={uiText("Chat click behavior", undefined, undefined, uiLocale)}
              >
                <SelectValue>
                  {settings.chatClickBehavior === "open"
                    ? uiText("Open", undefined, undefined, uiLocale)
                    : uiText("Preview", undefined, undefined, uiLocale)}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="preview">
                  {uiText("Preview", undefined, undefined, uiLocale)}
                </SelectItem>
                <SelectItem hideIndicator value="open">
                  {uiText("Open", undefined, undefined, uiLocale)}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>
      <SettingsSection title={uiText("Replies", undefined, undefined, uiLocale)}>
        <SettingsRow
          title={uiText("Assistant output", undefined, undefined, uiLocale)}
          description={uiText(
            "Show replies while they are being written.",
            undefined,
            undefined,
            uiLocale,
          )}
          resetAction={
            settings.enableAssistantStreaming !==
            DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming ? (
              <SettingResetButton
                label={uiText("assistant output", undefined, undefined, uiLocale)}
                onClick={() =>
                  updateSettings({
                    enableAssistantStreaming: DEFAULT_UNIFIED_SETTINGS.enableAssistantStreaming,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableAssistantStreaming}
              onCheckedChange={(checked) =>
                updateSettings({ enableAssistantStreaming: Boolean(checked) })
              }
              aria-label={uiText("Stream assistant messages", undefined, undefined, uiLocale)}
            />
          }
        />

        <SettingsRow
          title={uiText("Auto-open plan panel", undefined, undefined, uiLocale)}
          description={uiText(
            "Open the side panel when a provider finishes a plan.",
            undefined,
            undefined,
            uiLocale,
          )}
          resetAction={
            settings.autoOpenPlanSidebar !== DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar ? (
              <SettingResetButton
                label={uiText("auto-open plan panel", undefined, undefined, uiLocale)}
                onClick={() =>
                  updateSettings({
                    autoOpenPlanSidebar: DEFAULT_UNIFIED_SETTINGS.autoOpenPlanSidebar,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.autoOpenPlanSidebar}
              onCheckedChange={(checked) =>
                updateSettings({ autoOpenPlanSidebar: Boolean(checked) })
              }
              aria-label={uiText(
                "Open the plan panel automatically",
                undefined,
                undefined,
                uiLocale,
              )}
            />
          }
        />

        <SettingsRow
          title={uiText("Chat selection copy", undefined, undefined, uiLocale)}
          description={uiText(
            "What Copy puts on the clipboard for selected message text.",
            undefined,
            undefined,
            uiLocale,
          )}
          resetAction={
            settings.chatCopyFormat !== DEFAULT_UNIFIED_SETTINGS.chatCopyFormat ? (
              <SettingResetButton
                label={uiText("chat selection copy", undefined, undefined, uiLocale)}
                onClick={() =>
                  updateSettings({
                    chatCopyFormat: DEFAULT_UNIFIED_SETTINGS.chatCopyFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.chatCopyFormat}
              onValueChange={(value) => {
                if (value === "markdown" || value === "plainText") {
                  updateSettings({ chatCopyFormat: value });
                }
              }}
            >
              <SelectTrigger
                className="w-full sm:w-44"
                aria-label={uiText("Chat selection copy format", undefined, undefined, uiLocale)}
              >
                <SelectValue>
                  {uiPresentation.CHAT_COPY_FORMAT_LABELS[settings.chatCopyFormat]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="markdown">
                  {uiText("Markdown", undefined, undefined, uiLocale)}
                </SelectItem>
                <SelectItem hideIndicator value="plainText">
                  {uiText("Plain text", undefined, undefined, uiLocale)}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              {uiText("Custom instructions", undefined, undefined, uiLocale)}
              <InfoTip
                label={uiText("When custom instructions apply", undefined, undefined, uiLocale)}
              >
                {uiText(
                  "Codex applies edits at the next session start or resume. Claude may keep its recorded instructions until compaction or a new session. Other providers add them before the first message.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
              </InfoTip>
            </span>
          }
          description={uiText(
            "Applied as session instructions in Codex and Claude.",
            undefined,
            undefined,
            uiLocale,
          )}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isOpeningSystemPromptFile}
              onClick={openSystemPromptFile}
            >
              {isOpeningSystemPromptFile ? (
                <Spinner className="size-4" aria-hidden="true" />
              ) : canOpenLocalEditor ? (
                <FileTextIcon className="size-4" aria-hidden />
              ) : (
                <CopyIcon className="size-4" aria-hidden />
              )}
              {canOpenLocalEditor
                ? uiText("Open file", undefined, undefined, uiLocale)
                : uiText("Copy path", undefined, undefined, uiLocale)}
            </Button>
          }
        />
      </SettingsSection>
      <SettingsSection title={uiText("Confirmations", undefined, undefined, uiLocale)}>
        <SettingsRow
          title={uiText("Archive confirmation", undefined, undefined, uiLocale)}
          description={uiText("Click archive twice to confirm.", undefined, undefined, uiLocale)}
          resetAction={
            settings.confirmThreadArchive !== DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive ? (
              <SettingResetButton
                label={uiText("archive confirmation", undefined, undefined, uiLocale)}
                onClick={() =>
                  updateSettings({
                    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadArchive}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadArchive: Boolean(checked) })
              }
              aria-label={uiText("Confirm chat archiving", undefined, undefined, uiLocale)}
            />
          }
        />

        <SettingsRow
          title={uiText("Delete confirmation", undefined, undefined, uiLocale)}
          resetAction={
            settings.confirmThreadDelete !== DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete ? (
              <SettingResetButton
                label={uiText("delete confirmation", undefined, undefined, uiLocale)}
                onClick={() =>
                  updateSettings({
                    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.confirmThreadDelete}
              onCheckedChange={(checked) =>
                updateSettings({ confirmThreadDelete: Boolean(checked) })
              }
              aria-label={uiText("Confirm chat deletion", undefined, undefined, uiLocale)}
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function FilesSettingsPanel() {
  return <GeneralSettingsPanel />;
}

function FilesSettingsSection() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const availableEditors = useServerAvailableEditors();
  const editorOptions = useMemo(
    () => uiPresentation.resolveEditorOpenOptions(navigator.platform, availableEditors),
    [availableEditors, uiPresentation],
  );
  const defaultEditorOption =
    settings.defaultEditor === DEFAULT_EDITOR_SYSTEM_VALUE
      ? null
      : (editorOptions.find((option) => option.value === settings.defaultEditor) ?? null);
  const defaultEditorLabel =
    settings.defaultEditor === DEFAULT_EDITOR_SYSTEM_VALUE
      ? uiText("System default", undefined, undefined, uiLocale)
      : (defaultEditorOption?.label ?? uiText("System default", undefined, undefined, uiLocale));

  return (
    <SettingsSection title={uiText("Files", undefined, undefined, uiLocale)}>
      <SettingsRow
        title={uiText("Default editor", undefined, undefined, uiLocale)}
        description={uiText("Opens file links from chats.", undefined, undefined, uiLocale)}
        resetAction={
          settings.defaultEditor !== DEFAULT_UNIFIED_SETTINGS.defaultEditor ? (
            <SettingResetButton
              label={uiText("default editor", undefined, undefined, uiLocale)}
              onClick={() =>
                updateSettings({ defaultEditor: DEFAULT_UNIFIED_SETTINGS.defaultEditor })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.defaultEditor}
            onValueChange={(value) => {
              if (
                value === DEFAULT_EDITOR_SYSTEM_VALUE ||
                editorOptions.some((option) => option.value === value)
              ) {
                updateSettings({ defaultEditor: value as DefaultEditorSelection });
              }
            }}
          >
            <SelectTrigger
              className="w-full sm:w-48"
              aria-label={uiText("Default editor", undefined, undefined, uiLocale)}
            >
              <SelectValue>
                <DefaultEditorOptionLabel
                  Icon={defaultEditorOption?.Icon}
                  label={defaultEditorLabel}
                  testId="default-editor-selected-option"
                />
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={DEFAULT_EDITOR_SYSTEM_VALUE}>
                <DefaultEditorOptionLabel
                  label={uiText("System default", undefined, undefined, uiLocale)}
                  testId="default-editor-option-system-default"
                />
              </SelectItem>
              {editorOptions.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  <DefaultEditorOptionLabel
                    Icon={option.Icon}
                    label={option.label}
                    testId={`default-editor-option-${option.value}`}
                  />
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

export function SystemSettingsPanel() {
  return <GeneralSettingsPanel />;
}

function SystemSettingsSections() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const observability = useServerObservability();
  const diagnosticsDescription = uiPresentation.formatDiagnosticsDescription({
    localTracingEnabled: observability?.localTracingEnabled ?? false,
    otlpTracesEnabled: observability?.otlpTracesEnabled ?? false,
    otlpTracesUrl: observability?.otlpTracesUrl,
    otlpMetricsEnabled: observability?.otlpMetricsEnabled ?? false,
    otlpMetricsUrl: observability?.otlpMetricsUrl,
  });

  return (
    <>
      {typeof window.desktopBridge?.setPowerSaveBlockerState === "function" ? (
        <SettingsSection title={uiText("Desktop", undefined, undefined, uiLocale)}>
          <SettingsRow
            title={uiText("Keep awake", undefined, undefined, uiLocale)}
            description={uiText(
              "Stop your computer and screen sleeping while Cafe works.",
              undefined,
              undefined,
              uiLocale,
            )}
            resetAction={
              settings.powerSaveBlockerMode !== DEFAULT_UNIFIED_SETTINGS.powerSaveBlockerMode ? (
                <SettingResetButton
                  label={uiText("keep awake", undefined, undefined, uiLocale)}
                  onClick={() =>
                    updateSettings({
                      powerSaveBlockerMode: DEFAULT_UNIFIED_SETTINGS.powerSaveBlockerMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.powerSaveBlockerMode}
                onValueChange={(value) => {
                  if (value === "off" || value === "during-chats" || value === "always") {
                    updateSettings({ powerSaveBlockerMode: value });
                  }
                }}
              >
                <SelectTrigger
                  className="w-full sm:w-44"
                  aria-label={uiText("Keep awake", undefined, undefined, uiLocale)}
                >
                  <SelectValue>
                    {uiPresentation.POWER_SAVE_BLOCKER_LABELS[settings.powerSaveBlockerMode]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="off">
                    {uiPresentation.POWER_SAVE_BLOCKER_LABELS.off}
                  </SelectItem>
                  <SelectItem hideIndicator value="during-chats">
                    {uiPresentation.POWER_SAVE_BLOCKER_LABELS["during-chats"]}
                  </SelectItem>
                  <SelectItem hideIndicator value="always">
                    {uiPresentation.POWER_SAVE_BLOCKER_LABELS.always}
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title={uiText("About", undefined, undefined, uiLocale)}>
        <AboutVersionSection />
        <SettingsRow
          title={uiText("Diagnostics", undefined, undefined, uiLocale)}
          description={diagnosticsDescription}
          control={
            <Button render={<Link to="/settings/diagnostics" />} size="xs" variant="outline">
              {uiText("View diagnostics", undefined, undefined, uiLocale)}
            </Button>
          }
        />
      </SettingsSection>
    </>
  );
}

export function ProviderSettingsPanel() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const environmentId = useWorkspaceEnvironmentId();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const quotaConnectionStatus = useWsConnectionStatus();
  const quotaSavedConnectionState = useSavedEnvironmentRuntimeStore((state) =>
    environmentId ? state.byId[environmentId]?.connectionState : undefined,
  );
  const remote = useIsSavedRemoteEnvironment(environmentId);
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverProviders = useServerProviders();
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [isAddInstanceDialogOpen, setIsAddInstanceDialogOpen] = useState(false);
  const [updatingProviderDrivers, setUpdatingProviderDrivers] = useState<
    ReadonlySet<ProviderDriverKind>
  >(() => new Set());
  const [restartingProviderRuntimeInstanceIds, setRestartingProviderRuntimeInstanceIds] = useState<
    ReadonlySet<ProviderInstanceId>
  >(() => new Set());
  const [loggingInProviderInstanceIds, setLoggingInProviderInstanceIds] = useState<
    ReadonlySet<ProviderInstanceId>
  >(() => new Set());
  const [openInstanceDetails, setOpenInstanceDetails] = useState<Record<string, boolean>>({});
  const refreshingRef = useRef(false);

  const providerUpdateCandidates = useMemo(
    () => collectProviderUpdateCandidates(serverProviders),
    [serverProviders],
  );
  const providerUpdateCandidateByInstanceId = useMemo(
    () => new Map(providerUpdateCandidates.map((candidate) => [candidate.instanceId, candidate])),
    [providerUpdateCandidates],
  );
  const visibleProviderSettings = PROVIDER_SETTINGS;
  const textGenerationModelSelection = uiPresentation.resolveAppModelSelectionState(
    settings,
    serverProviders,
  );
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const lastCheckedAt =
    serverProviders.length > 0
      ? serverProviders.reduce(
          (latest, provider) => (provider.checkedAt > latest ? provider.checkedAt : latest),
          serverProviders[0]!.checkedAt,
        )
      : null;

  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void ensureWorkspaceApi()
      .server.refreshProviders()
      .catch((error: unknown) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        refreshingRef.current = false;
        setIsRefreshingProviders(false);
      });
  }, []);

  const runProviderUpdate = useCallback(
    async (candidate: ProviderUpdateCandidate) => {
      let started = false;
      setUpdatingProviderDrivers((previous) => {
        if (previous.has(candidate.driver)) {
          return previous;
        }
        started = true;
        const next = new Set(previous);
        next.add(candidate.driver);
        return next;
      });
      if (!started) {
        return;
      }

      try {
        await ensureWorkspaceApi().server.updateProvider({
          provider: candidate.driver,
          instanceId: candidate.instanceId,
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText(
              "Could not update {value0}",
              {
                value0: PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver,
              },
              undefined,
              uiLocale,
            ),
            description:
              error instanceof Error
                ? error.message
                : uiText(
                    "The provider update command could not be started.",
                    undefined,
                    undefined,
                    uiLocale,
                  ),
          }),
        );
      } finally {
        setUpdatingProviderDrivers((previous) => {
          if (!previous.has(candidate.driver)) {
            return previous;
          }
          const next = new Set(previous);
          next.delete(candidate.driver);
          return next;
        });
      }
    },
    [uiLocale],
  );

  const restartProviderRuntime = useCallback(
    async (input: { readonly instanceId: ProviderInstanceId; readonly displayName: string }) => {
      let started = false;
      setRestartingProviderRuntimeInstanceIds((previous) => {
        if (previous.has(input.instanceId)) {
          return previous;
        }
        started = true;
        const next = new Set(previous);
        next.add(input.instanceId);
        return next;
      });
      if (!started) {
        return;
      }

      try {
        const api = ensureWorkspaceApi();
        const confirmed = await api.dialogs.confirm(
          uiText(
            "Restart {value0}? Running turns may be interrupted.",
            {
              value0: input.displayName,
            },
            undefined,
            uiLocale,
          ),
        );
        if (!confirmed) {
          return;
        }

        const result = await api.server.restartProviderRuntime({
          instanceId: input.instanceId,
        });
        toastManager.add({
          type: "success",
          title: uiText("{value0} restarted", { value0: input.displayName }, undefined, uiLocale),
          description: uiText(
            "Stopped {count} active {count, plural, one {session} other {sessions}}.",
            { count: result.stoppedSessionCount },
            undefined,
            uiLocale,
          ),
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText(
              "Could not restart {value0}",
              { value0: input.displayName },
              undefined,
              uiLocale,
            ),
            description:
              error instanceof Error
                ? error.message
                : uiText(
                    "The provider runtime restart could not be started.",
                    undefined,
                    undefined,
                    uiLocale,
                  ),
          }),
        );
      } finally {
        setRestartingProviderRuntimeInstanceIds((previous) => {
          if (!previous.has(input.instanceId)) {
            return previous;
          }
          const next = new Set(previous);
          next.delete(input.instanceId);
          return next;
        });
      }
    },
    [uiLocale],
  );

  const logInProvider = useCallback(
    async (input: { readonly instanceId: ProviderInstanceId; readonly displayName: string }) => {
      let started = false;
      setLoggingInProviderInstanceIds((previous) => {
        if (previous.has(input.instanceId)) {
          return previous;
        }
        started = true;
        const next = new Set(previous);
        next.add(input.instanceId);
        return next;
      });
      if (!started) {
        return;
      }

      try {
        await ensureWorkspaceApi().server.loginProvider({
          instanceId: input.instanceId,
        });
        toastManager.add({
          type: "success",
          title: uiText(
            "{value0} login opened",
            { value0: input.displayName },
            undefined,
            uiLocale,
          ),
          description: remote
            ? uiText(
                "Complete provider sign-in in the PowerShell window on the server PC, then refresh status.",
                undefined,
                undefined,
                uiLocale,
              )
            : uiText(
                "Complete the provider login in the PowerShell window, then refresh status.",
                undefined,
                undefined,
                uiLocale,
              ),
        });
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText(
              "Could not open {value0} login",
              { value0: input.displayName },
              undefined,
              uiLocale,
            ),
            description:
              error instanceof Error
                ? error.message
                : uiText(
                    "The provider login command could not be started.",
                    undefined,
                    undefined,
                    uiLocale,
                  ),
          }),
        );
      } finally {
        setLoggingInProviderInstanceIds((previous) => {
          if (!previous.has(input.instanceId)) {
            return previous;
          }
          const next = new Set(previous);
          next.delete(input.instanceId);
          return next;
        });
      }
    },
    [remote, uiLocale],
  );

  interface InstanceRow {
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
    readonly driver: ProviderDriverKind;
    readonly isDefault: boolean;
    readonly isDirty?: boolean;
  }

  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(settings.providerInstances ?? {})) {
    if (isRetiredProviderDriverKind(instance.driver)) continue;
    const driver = instance.driver;
    const list = instancesByDriver.get(driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(driver, list);
  }

  const defaultSlotIdsBySource = new Set<string>([
    ...visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
    ...Object.keys(DEFAULT_PROVIDER_INSTANCES),
  ]);

  const rows: InstanceRow[] = [];
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  );

  for (const providerSettings of visibleProviderSettings) {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const legacyProviders = settings.providers as Record<string, LegacyProviderSettings>;
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings
    >;
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = settings.providerInstances?.[defaultInstanceId];
    const legacyConfig = legacyProviders[providerSettings.provider]!;
    const defaultLegacyConfig = defaultLegacyProviders[providerSettings.provider]!;
    const effectiveInstance: ProviderInstanceConfig =
      explicitInstance ??
      ({
        driver,
        enabled: legacyConfig.enabled,
        config: legacyConfig,
      } satisfies ProviderInstanceConfig);
    const isDirty =
      explicitInstance !== undefined || !Equal.equals(legacyConfig, defaultLegacyConfig);
    rows.push({
      instanceId: defaultInstanceId,
      instance: effectiveInstance,
      driver,
      isDefault: true,
      isDirty,
    });
    for (const [id, instance] of instancesByDriver.get(providerSettings.provider) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({ instanceId: id, instance, driver: instance.driver, isDefault: false });
    }
  }
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      const builtInDefault = DEFAULT_PROVIDER_INSTANCES[id];
      const matchesBuiltInDefault = builtInDefault?.driver === instance.driver;
      rows.push({
        instanceId: id,
        instance,
        driver: instance.driver,
        isDefault:
          defaultSlotIdsBySource.has(String(id)) &&
          (builtInDefault === undefined || matchesBuiltInDefault),
        isDirty: matchesBuiltInDefault && !Equal.equals(instance, builtInDefault),
      });
    }
  }

  const updateProviderInstance = (
    row: InstanceRow,
    next: ProviderInstanceConfig,
    options?: {
      readonly textGenerationModelSelection?: Parameters<
        typeof buildProviderInstanceUpdatePatch
      >[0]["textGenerationModelSelection"];
    },
  ) => {
    updateSettings(
      buildProviderInstanceUpdatePatch({
        settings,
        instanceId: row.instanceId,
        instance: next,
        driver: row.driver,
        isDefault: row.isDefault,
        textGenerationModelSelection: options?.textGenerationModelSelection,
      }),
    );
  };

  const deleteProviderInstance = (id: ProviderInstanceId) => {
    updateSettings({
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, id),
      providerModelPreferences: withoutProviderInstanceKey(settings.providerModelPreferences, id),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], id),
      ...(settings.defaultProviderInstanceId === id ? { defaultProviderInstanceId: null } : {}),
    });
  };

  const updateProviderModelPreferences = (
    instanceId: ProviderInstanceId,
    next: {
      readonly hiddenModels: ReadonlyArray<string>;
      readonly modelOrder: ReadonlyArray<string>;
    },
  ) => {
    const hiddenModels = [...new Set(next.hiddenModels.filter((slug) => slug.trim().length > 0))];
    const modelOrder = [...new Set(next.modelOrder.filter((slug) => slug.trim().length > 0))];
    const rest = withoutProviderInstanceKey(settings.providerModelPreferences, instanceId);
    updateSettings({
      providerModelPreferences:
        hiddenModels.length === 0 && modelOrder.length === 0
          ? rest
          : {
              ...rest,
              [instanceId]: {
                hiddenModels,
                modelOrder,
              },
            },
    });
  };

  const updateProviderFavoriteModels = (
    instanceId: ProviderInstanceId,
    nextFavoriteModels: ReadonlyArray<string>,
  ) => {
    const favoriteModels = [
      ...new Set(nextFavoriteModels.map((slug) => slug.trim()).filter((slug) => slug.length > 0)),
    ];
    updateSettings({
      favorites: [
        ...withoutProviderInstanceFavorites(settings.favorites ?? [], instanceId),
        ...favoriteModels.map((model) => ({ provider: instanceId, model })),
      ],
    });
  };

  const resetDefaultInstance = (driverKind: ProviderDriverKind) => {
    type LegacyProviderSettings = (typeof settings.providers)[keyof typeof settings.providers];
    const defaultLegacyProviders = DEFAULT_UNIFIED_SETTINGS.providers as Record<
      string,
      LegacyProviderSettings | undefined
    >;
    const defaultInstanceId = defaultInstanceIdForDriver(driverKind);
    const defaultLegacyProvider = defaultLegacyProviders[driverKind];
    if (
      defaultLegacyProvider === undefined &&
      DEFAULT_PROVIDER_INSTANCES[defaultInstanceId] === undefined
    )
      return;
    updateSettings({
      ...(defaultLegacyProvider !== undefined
        ? {
            providers: {
              ...settings.providers,
              [driverKind]: defaultLegacyProvider,
            } as typeof settings.providers,
          }
        : {}),
      providerInstances: withoutProviderInstanceKey(settings.providerInstances, defaultInstanceId),
      providerModelPreferences: withoutProviderInstanceKey(
        settings.providerModelPreferences,
        defaultInstanceId,
      ),
      favorites: withoutProviderInstanceFavorites(settings.favorites ?? [], defaultInstanceId),
    });
  };

  return (
    <SettingsPageContainer title={uiText("Providers", undefined, undefined, uiLocale)}>
      <SettingsSection title={uiText("AI defaults", undefined, undefined, uiLocale)}>
        <TextGenerationModelSettingsRow />
      </SettingsSection>
      <SettingsSection
        headerAction={
          <div className="flex items-center gap-1.5">
            <ProviderLastChecked lastCheckedAt={lastCheckedAt} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setIsAddInstanceDialogOpen(true)}
                    aria-label={uiText("Add provider instance", undefined, undefined, uiLocale)}
                  >
                    <PlusIcon className="size-3" />
                  </Button>
                }
              />
              <TooltipPopup side="top">
                {uiText("Add provider instance", undefined, undefined, uiLocale)}
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={isRefreshingProviders}
                    onClick={() => void refreshProviders()}
                    aria-label={uiText("Refresh provider status", undefined, undefined, uiLocale)}
                  >
                    {isRefreshingProviders ? (
                      <Spinner aria-hidden="true" className="size-3" />
                    ) : (
                      <RefreshCwIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">
                {uiText("Refresh provider status", undefined, undefined, uiLocale)}
              </TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {rows.map((row) => {
          const driverOption = uiPresentation.getDriverOption(row.driver);
          const liveProvider = serverProviders.find(
            (candidate) => candidate.instanceId === row.instanceId,
          );
          const updateCandidate = liveProvider
            ? providerUpdateCandidateByInstanceId.get(liveProvider.instanceId)
            : undefined;
          const isDriverUpdateRunning =
            updateCandidate !== undefined &&
            (updatingProviderDrivers.has(updateCandidate.driver) ||
              serverProviders.some(
                (provider) =>
                  provider.driver === updateCandidate.driver && isProviderUpdateActive(provider),
              ));
          const showInlineUpdateButton =
            updateCandidate !== undefined &&
            hasOneClickUpdateProviderCandidate(updateCandidate, serverProviders);
          const canRunInlineUpdate =
            updateCandidate !== undefined &&
            canOneClickUpdateProviderCandidate(updateCandidate, serverProviders) &&
            !updatingProviderDrivers.has(updateCandidate.driver);
          const modelPreferences = settings.providerModelPreferences?.[row.instanceId] ?? {
            hiddenModels: [],
            modelOrder: [],
          };
          const favoriteModels = (settings.favorites ?? [])
            .filter((favorite) => favorite.provider === row.instanceId)
            .map((favorite) => favorite.model);
          const resetLabel = driverOption?.label ?? String(row.driver);
          const providerDisplayName =
            row.instance.displayName?.trim() || driverOption?.label || String(row.driver);
          const canLogInProvider =
            liveProvider?.authActions?.login === true &&
            liveProvider.installed &&
            liveProvider.auth.status !== "authenticated" &&
            (row.instance.enabled ?? true);
          const headerAction =
            row.isDefault && row.isDirty ? (
              <SettingResetButton
                label={uiText(
                  "{value0} provider settings",
                  { value0: resetLabel },
                  undefined,
                  uiLocale,
                )}
                onClick={() => resetDefaultInstance(row.driver)}
              />
            ) : null;
          return (
            <ProviderInstanceCard
              key={row.instanceId}
              instanceId={row.instanceId}
              instance={row.instance}
              driverOption={driverOption}
              liveProvider={liveProvider}
              quotaContext={
                environmentId && row.driver === "claudeAgent"
                  ? {
                      environmentId,
                      input: { instanceId: row.instanceId },
                      scopeRevision: providerSkillsScopeRevision({
                        cwd: null,
                        instanceId: row.instanceId,
                        settings,
                        snapshot: liveProvider ?? null,
                      }),
                      connected:
                        environmentId === primaryEnvironmentId
                          ? quotaConnectionStatus.phase === "connected"
                          : quotaSavedConnectionState === "connected",
                    }
                  : undefined
              }
              isSettingsOpen={openInstanceDetails[row.instanceId] ?? false}
              onSettingsOpenChange={(open) =>
                setOpenInstanceDetails((existing) => ({
                  ...existing,
                  [row.instanceId]: open,
                }))
              }
              isDefaultProvider={settings.defaultProviderInstanceId === row.instanceId}
              onSetDefaultProvider={(next) =>
                updateSettings({ defaultProviderInstanceId: next ? row.instanceId : null })
              }
              onUpdate={(next) => {
                const wasEnabled = row.instance.enabled ?? true;
                const isDisabling = next.enabled === false && wasEnabled;
                const shouldClearTextGen = isDisabling && textGenInstanceId === row.instanceId;
                if (shouldClearTextGen) {
                  updateProviderInstance(row, next, {
                    textGenerationModelSelection:
                      DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                  });
                } else {
                  updateProviderInstance(row, next);
                }
              }}
              onDelete={row.isDefault ? undefined : () => deleteProviderInstance(row.instanceId)}
              headerAction={headerAction}
              hiddenModels={modelPreferences.hiddenModels}
              favoriteModels={favoriteModels}
              modelOrder={modelPreferences.modelOrder}
              onHiddenModelsChange={(hiddenModels) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  hiddenModels,
                })
              }
              onFavoriteModelsChange={(favoriteModels) =>
                updateProviderFavoriteModels(row.instanceId, favoriteModels)
              }
              onModelOrderChange={(modelOrder) =>
                updateProviderModelPreferences(row.instanceId, {
                  ...modelPreferences,
                  modelOrder,
                })
              }
              onRunUpdate={
                showInlineUpdateButton && updateCandidate
                  ? () => {
                      if (!canRunInlineUpdate) {
                        return;
                      }
                      void runProviderUpdate(updateCandidate);
                    }
                  : undefined
              }
              isUpdating={showInlineUpdateButton ? isDriverUpdateRunning : undefined}
              onLogIn={
                canLogInProvider
                  ? () =>
                      void logInProvider({
                        instanceId: row.instanceId,
                        displayName: providerDisplayName,
                      })
                  : undefined
              }
              isLoggingIn={loggingInProviderInstanceIds.has(row.instanceId)}
              onRestartRuntime={
                canRestartProviderRuntime(row.driver)
                  ? () =>
                      void restartProviderRuntime({
                        instanceId: row.instanceId,
                        displayName: providerDisplayName,
                      })
                  : undefined
              }
              isRestartingRuntime={restartingProviderRuntimeInstanceIds.has(row.instanceId)}
            />
          );
        })}
      </SettingsSection>

      <AddProviderInstanceDialog
        open={isAddInstanceDialogOpen}
        onOpenChange={setIsAddInstanceDialogOpen}
      />
    </SettingsPageContainer>
  );
}

/** History includes the selected server even when it has no projects. */
function useThreadHistoryEnvironmentIds() {
  const environmentId = useWorkspaceEnvironmentId();
  return useMemo(() => (environmentId ? [environmentId] : []), [environmentId]);
}

/** Layout-matching first-load placeholder for the Archive and Recycle Bin lists. */
function ThreadHistorySkeleton() {
  const uiLocale = useUiLocale();

  return (
    <SettingsSection
      aria-busy="true"
      aria-label={uiText("Loading chats", undefined, undefined, uiLocale)}
    >
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="flex items-center justify-between gap-3 border-t border-border-subtle px-4 py-3.5 first:border-t-0 sm:px-5"
        >
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-48 max-w-full rounded-full" />
            <Skeleton className="h-3 w-64 max-w-full rounded-full" />
          </div>
          <Skeleton className="h-7 w-24 rounded-lg" />
        </div>
      ))}
    </SettingsSection>
  );
}

/** Shown only after the first load finishes with nothing to list (or an error). */
function ThreadHistoryEmpty({
  icon,
  title,
  description,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description?: string | null;
}) {
  return (
    <SettingsSection>
      <Empty className="min-h-56 animate-enter-fade">
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyHeader>
          <EmptyTitle className="text-base">{title}</EmptyTitle>
          {description ? (
            <EmptyDescription className="text-xs">{description}</EmptyDescription>
          ) : null}
        </EmptyHeader>
      </Empty>
    </SettingsSection>
  );
}

function HistorySettingsNavigation({ deleted }: { deleted: boolean }) {
  const uiLocale = useUiLocale();
  return (
    <nav aria-label={uiText("Chat history", undefined, undefined, uiLocale)} className="flex gap-2">
      <Button
        render={<Link to="/settings/archived" />}
        size="sm"
        variant={deleted ? "ghost" : "secondary"}
        aria-current={deleted ? undefined : "page"}
      >
        {uiText("Archive", undefined, undefined, uiLocale)}
      </Button>
      <Button
        render={<Link to="/settings/recently-deleted" />}
        size="sm"
        variant={deleted ? "secondary" : "ghost"}
        aria-current={deleted ? "page" : undefined}
      >
        {uiText("Recently deleted", undefined, undefined, uiLocale)}
      </Button>
    </nav>
  );
}

export function ArchivedThreadsPanel() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const environmentIds = useThreadHistoryEnvironmentIds();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(environmentIds);

  const archivedGroups = useMemo(
    () => groupThreadHistory(archivedSnapshots, "archived"),
    [archivedSnapshots],
  );
  const showArchiveSkeleton = useDelayedFlag(isLoadingArchive && archivedGroups.length === 0);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readWorkspaceApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: uiText("Unarchive", undefined, undefined, uiLocale) },
          {
            id: "delete",
            label: uiText("Move to Recycle Bin", undefined, undefined, uiLocale),
            destructive: true,
          },
        ],
        position,
      );

      if (clicked === "unarchive") {
        try {
          await unarchiveThread(threadRef);
          refreshArchivedThreads();
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: uiText("Could not unarchive chat", undefined, undefined, uiLocale),
              description:
                error instanceof Error
                  ? error.message
                  : uiText("An error occurred.", undefined, undefined, uiLocale),
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        await confirmAndDeleteThread(threadRef);
        refreshArchivedThreads();
      }
    },
    [confirmAndDeleteThread, refreshArchivedThreads, unarchiveThread, uiLocale],
  );

  return (
    <SettingsPageContainer title={uiText("History", undefined, undefined, uiLocale)}>
      <HistorySettingsNavigation deleted={false} />
      {archivedGroups.length === 0 ? (
        isLoadingArchive || showArchiveSkeleton ? (
          showArchiveSkeleton ? (
            <ThreadHistorySkeleton />
          ) : null
        ) : (
          <ThreadHistoryEmpty
            icon={<ArchiveIcon />}
            title={
              archiveError
                ? uiText("Could not load archived chats", undefined, undefined, uiLocale)
                : uiText("No archived chats", undefined, undefined, uiLocale)
            }
            description={archiveError}
          />
        )
      ) : (
        archivedGroups.map(({ groupKey, project, threads: projectThreads }) => (
          <SettingsSection
            key={groupKey}
            title={project?.name ?? uiText("Chats", undefined, undefined, uiLocale)}
            icon={
              project ? (
                <ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />
              ) : (
                <MessageSquareIcon className="size-3.5" />
              )
            }
          >
            {projectThreads.map((thread) => (
              <SettingsRow
                key={thread.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void handleArchivedThreadContextMenu(
                    scopeThreadRef(thread.environmentId, thread.id),
                    {
                      x: event.clientX,
                      y: event.clientY,
                    },
                  );
                }}
                title={thread.title}
                description={uiText(
                  "Archived {archived} · Created {created}",
                  {
                    archived: uiPresentation.formatRelativeTimeLabel(
                      thread.archivedAt ?? thread.createdAt,
                    ),
                    created: uiPresentation.formatRelativeTimeLabel(thread.createdAt),
                  },
                  undefined,
                  uiLocale,
                )}
                control={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 cursor-pointer gap-1.5 px-2.5"
                    onClick={() =>
                      void unarchiveThread(scopeThreadRef(thread.environmentId, thread.id))
                        .then(() => refreshArchivedThreads())
                        .catch((error) => {
                          toastManager.add(
                            stackedThreadToast({
                              type: "error",
                              title: uiText(
                                "Could not unarchive chat",
                                undefined,
                                undefined,
                                uiLocale,
                              ),
                              description:
                                error instanceof Error
                                  ? error.message
                                  : uiText("An error occurred.", undefined, undefined, uiLocale),
                            }),
                          );
                        })
                    }
                  >
                    <ArchiveX className="size-3.5" />
                    <span>{uiText("Unarchive", undefined, undefined, uiLocale)}</span>
                  </Button>
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}

export function RecentlyDeletedThreadsPanel() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const environmentIds = useThreadHistoryEnvironmentIds();
  const { restoreThread, hardDeleteThread } = useThreadActions();
  const [isEmptyingRecycleBin, setIsEmptyingRecycleBin] = useState(false);
  const {
    snapshots: deletedSnapshots,
    error: deletedError,
    isLoading: isLoadingDeleted,
    refresh: refreshDeletedThreads,
  } = useDeletedThreadSnapshots(environmentIds);

  const deletedGroups = useMemo(
    () => groupThreadHistory(deletedSnapshots, "deleted"),
    [deletedSnapshots],
  );
  const deletedThreadRefs = useMemo(
    () => collectRecentlyDeletedThreadRefs(deletedGroups),
    [deletedGroups],
  );
  const showDeletedSkeleton = useDelayedFlag(isLoadingDeleted && deletedGroups.length === 0);

  const handleDeletedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readWorkspaceApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "restore", label: uiText("Restore", undefined, undefined, uiLocale) },
          {
            id: "delete-forever",
            label: uiText("Delete forever", undefined, undefined, uiLocale),
            destructive: true,
          },
        ],
        position,
      );

      if (clicked === "restore") {
        try {
          await restoreThread(threadRef);
          refreshDeletedThreads();
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: uiText("Could not restore chat", undefined, undefined, uiLocale),
              description:
                error instanceof Error
                  ? error.message
                  : uiText("An error occurred.", undefined, undefined, uiLocale),
            }),
          );
        }
        return;
      }

      if (clicked === "delete-forever") {
        try {
          await hardDeleteThread(threadRef);
          refreshDeletedThreads();
        } catch (error) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: uiText("Could not delete chat", undefined, undefined, uiLocale),
              description:
                error instanceof Error
                  ? error.message
                  : uiText("An error occurred.", undefined, undefined, uiLocale),
            }),
          );
        }
      }
    },
    [hardDeleteThread, refreshDeletedThreads, restoreThread, uiLocale],
  );
  const handleEmptyRecycleBin = useCallback(async () => {
    if (deletedThreadRefs.length === 0 || isEmptyingRecycleBin) {
      return;
    }

    const api = readWorkspaceApi();
    if (!api) return;

    const confirmed = await api.dialogs.confirm(
      uiPresentation.buildEmptyRecycleBinConfirmationMessage(deletedThreadRefs.length),
    );
    if (!confirmed) {
      return;
    }

    setIsEmptyingRecycleBin(true);
    const failures: string[] = [];
    let deletedCount = 0;
    try {
      for (const threadRef of deletedThreadRefs) {
        try {
          await hardDeleteThread(threadRef, { confirm: false, refresh: false });
          deletedCount += 1;
        } catch (error) {
          failures.push(
            error instanceof Error
              ? error.message
              : uiText("Unknown deletion error.", undefined, undefined, uiLocale),
          );
        }
      }
      refreshDeletedThreads();
      if (failures.length > 0) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not empty Recycle Bin", undefined, undefined, uiLocale),
            description: uiText(
              "Deleted {deleted} of {count} {count, plural, one {chat} other {chats}}. {detail}",
              {
                deleted: deletedCount,
                count: deletedThreadRefs.length,
                detail: failures[0],
              },
              undefined,
              uiLocale,
            ),
          }),
        );
        return;
      }
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: uiText("Recycle Bin emptied", undefined, undefined, uiLocale),
          description: uiText(
            "Deleted {count} {count, plural, one {chat} other {chats}} forever.",
            {
              count: deletedCount,
            },
            undefined,
            uiLocale,
          ),
        }),
      );
    } finally {
      setIsEmptyingRecycleBin(false);
    }
  }, [
    deletedThreadRefs,
    hardDeleteThread,
    isEmptyingRecycleBin,
    refreshDeletedThreads,
    uiLocale,
    uiPresentation,
  ]);
  const emptyRecycleBinAction =
    deletedThreadRefs.length > 0 ? (
      <Button
        type="button"
        variant="destructive-outline"
        size="xs"
        className="gap-1.5"
        disabled={isLoadingDeleted || isEmptyingRecycleBin}
        onClick={() => void handleEmptyRecycleBin()}
      >
        {isEmptyingRecycleBin ? (
          <Spinner aria-hidden="true" className="size-3.5" />
        ) : (
          <Trash2Icon className="size-3.5" />
        )}
        <span>{uiText("Empty Recycle Bin", undefined, undefined, uiLocale)}</span>
      </Button>
    ) : null;

  return (
    <SettingsPageContainer title={uiText("History", undefined, undefined, uiLocale)}>
      <HistorySettingsNavigation deleted />
      {deletedGroups.length === 0 ? (
        isLoadingDeleted || showDeletedSkeleton ? (
          showDeletedSkeleton ? (
            <ThreadHistorySkeleton />
          ) : null
        ) : (
          <ThreadHistoryEmpty
            icon={<Trash2Icon />}
            title={
              deletedError
                ? uiText("Could not load deleted chats", undefined, undefined, uiLocale)
                : uiText("Recycle Bin is empty", undefined, undefined, uiLocale)
            }
            description={deletedError}
          />
        )
      ) : (
        deletedGroups.map(({ groupKey, project, threads: projectThreads }, index) => (
          <SettingsSection
            key={groupKey}
            title={project?.name ?? uiText("Chats", undefined, undefined, uiLocale)}
            icon={
              project ? (
                <ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />
              ) : (
                <MessageSquareIcon className="size-3.5" />
              )
            }
            headerAction={index === 0 ? emptyRecycleBinAction : null}
          >
            {projectThreads.map((thread) => (
              <SettingsRow
                key={thread.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void handleDeletedThreadContextMenu(
                    scopeThreadRef(thread.environmentId, thread.id),
                    {
                      x: event.clientX,
                      y: event.clientY,
                    },
                  );
                }}
                title={thread.title}
                description={
                  <>
                    {uiText("Moved to Recycle Bin", undefined, undefined, uiLocale)}{" "}
                    {uiPresentation.formatRelativeTimeLabel(thread.deletedAt ?? thread.updatedAt)}
                    {uiText(" · Created ", undefined, undefined, uiLocale)}
                    {uiPresentation.formatRelativeTimeLabel(thread.createdAt)}
                  </>
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = {
  CHAT_COPY_FORMAT_LABELS,
  POWER_SAVE_BLOCKER_LABELS,
  THEME_OPTIONS,
  TIMESTAMP_FORMAT_LABELS,
  buildEmptyRecycleBinConfirmationMessage,
  formatDiagnosticsDescription,
  formatRelativeTime,
  formatRelativeTimeLabel,
  getDriverOption,
  getSourceUpdateBranchLabel,
  getSourceUpdateHashLines,
  getSourceUpdateStatus,
  resolveAppModelSelectionState,
  resolveEditorOpenOptions,
};
