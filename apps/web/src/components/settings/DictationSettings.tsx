import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  CheckCircle2Icon,
  KeyRoundIcon,
  KeyboardIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  DICTATION_API_KEY_MAX_CHARS,
  type DictationCredentialStatus,
  type GlobalDictationSettingsState,
} from "@cafecode/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { useWorkspaceEnvironmentId, useIsSavedRemoteEnvironment } from "~/environments/workspace";
import { requireEnvironmentConnection } from "~/environments/runtime";
import { readDictationRpcErrorCode } from "~/dictation/errors";
import { useDelayedFlag } from "~/hooks/useDelayedFlag";
import { dictationQueryKeys, dictationStatusQueryOptions } from "~/lib/dictationReactQuery";
import { isMacPlatform } from "~/lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { InfoTip } from "../ui/info-tip";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type CredentialOperation = "saving" | "removing" | null;

type OperationFeedback = {
  readonly kind: "success" | "error";
  readonly message: string;
};

/** The physical key matters here: a shifted comma reports "<" on US keyboards. */
function macShortcutFromKeyEvent(event: KeyboardEvent): string | null {
  if (!event.metaKey || !event.shiftKey || event.altKey || event.ctrlKey) return null;
  if (/^Key[A-Z]$/.test(event.code)) {
    return `CommandOrControl+Shift+${event.code.slice(3)}`;
  }
  if (/^Digit[0-9]$/.test(event.code)) {
    return `CommandOrControl+Shift+${event.code.slice(5)}`;
  }
  const punctuation: Readonly<Record<string, string>> = {
    Comma: ",",
    Period: ".",
    Slash: "/",
    Semicolon: ";",
    Minus: "-",
    Equal: "=",
  };
  const key = punctuation[event.code];
  return key ? `CommandOrControl+Shift+${key}` : null;
}

function macShortcutLabel(shortcut: string): string {
  return shortcut.replace(/^CommandOrControl\+Shift\+/, "⌘ ⇧ ");
}

function containsApiKeyControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function formatCredentialManagementError(error: unknown): string {
  switch (readDictationRpcErrorCode(error)) {
    case "not_authorized":
      return "Only an owner session can manage the OpenAI API key.";
    case "insecure_transport":
      return "Use Cafe Code on localhost or over HTTPS to manage this credential.";
    case "rate_limited":
      return "Too many credential requests. Wait a moment and try again.";
    case "secret_store_failed":
      return "Cafe Code could not update its private credential store.";
    default:
      return "Cafe Code could not update the dictation credential. Try again.";
  }
}

function formatStatusError(error: unknown): string {
  switch (readDictationRpcErrorCode(error)) {
    case "not_authorized":
      return "This session is not authorized to view dictation status.";
    case "insecure_transport":
      return "Dictation status is unavailable over this insecure connection.";
    case "rate_limited":
      return "Dictation status is temporarily rate limited.";
    default:
      return "Cafe Code could not load dictation status.";
  }
}

function statusBadge(input: {
  readonly environmentReady: boolean;
  readonly isPending: boolean;
  readonly showPending: boolean;
  readonly isError: boolean;
  readonly status: DictationCredentialStatus | undefined;
}) {
  if (!input.environmentReady || input.isError) {
    return (
      <Badge variant="error">
        <TriangleAlertIcon />
        Unavailable
      </Badge>
    );
  }

  if (input.showPending || input.isPending || !input.status) {
    // Fast status reads show nothing; slower ones get a badge-shaped skeleton
    // that stays up long enough not to flash (docs/style-guide.md §9).
    return input.showPending ? (
      <Skeleton aria-hidden="true" className="h-5.5 w-20 rounded-sm sm:h-4.5" />
    ) : null;
  }

  if (input.status.configured) {
    return (
      <Badge variant="success">
        <CheckCircle2Icon />
        Configured
      </Badge>
    );
  }

  return <Badge variant="secondary">Not configured</Badge>;
}

export function DictationSettings() {
  const primaryEnvironmentId = useWorkspaceEnvironmentId();
  const remote = useIsSavedRemoteEnvironment(primaryEnvironmentId);
  const localEnvironmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  const statusQuery = useQuery(dictationStatusQueryOptions(primaryEnvironmentId));
  const [newApiKey, setNewApiKey] = useState("");
  const [operation, setOperation] = useState<CredentialOperation>(null);
  const [feedback, setFeedback] = useState<OperationFeedback | null>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [globalSettings, setGlobalSettings] = useState<GlobalDictationSettingsState | null>(null);
  const [globalSettingsPending, setGlobalSettingsPending] = useState(false);
  const [globalSettingsError, setGlobalSettingsError] = useState<string | null>(null);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [shortcutCaptureHint, setShortcutCaptureHint] = useState<string | null>(null);
  const isMacDesktop =
    typeof window !== "undefined" &&
    Boolean(window.desktopBridge) &&
    isMacPlatform(navigator.platform);

  const localStatusQuery = useQuery(
    dictationStatusQueryOptions(isMacDesktop && remote ? localEnvironmentId : null),
  );

  useEffect(() => {
    if (!isMacDesktop) return;
    const bridge = window.desktopBridge;
    if (!bridge) return;
    let mounted = true;
    setGlobalSettingsPending(true);
    void bridge
      .getGlobalDictationSettings()
      .then((settings) => {
        if (mounted) {
          setGlobalSettings(settings);
          setGlobalSettingsError(null);
        }
      })
      .catch(() => {
        if (mounted) setGlobalSettingsError("Could not load the Mac dictation shortcut.");
      })
      .finally(() => {
        if (mounted) setGlobalSettingsPending(false);
      });
    return () => {
      mounted = false;
    };
  }, [isMacDesktop]);

  const updateGlobalEnabled = useCallback(async (enabled: boolean) => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    setGlobalSettingsPending(true);
    setGlobalSettingsError(null);
    try {
      setGlobalSettings(await bridge.setGlobalDictationEnabled(enabled));
    } catch {
      setGlobalSettingsError("Could not update global dictation. Try again.");
    } finally {
      setGlobalSettingsPending(false);
    }
  }, []);

  const updateGlobalShortcut = useCallback(async (shortcut: string) => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    setGlobalSettingsPending(true);
    setGlobalSettingsError(null);
    try {
      setGlobalSettings(await bridge.setGlobalDictationShortcut(shortcut));
      setCapturingShortcut(false);
      setShortcutCaptureHint(null);
    } catch {
      setShortcutCaptureHint("Could not set this shortcut. Choose another combination.");
    } finally {
      setGlobalSettingsPending(false);
    }
  }, []);

  useEffect(() => {
    if (!capturingShortcut) return;
    const capture = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setCapturingShortcut(false);
        setShortcutCaptureHint(null);
        return;
      }
      if (event.repeat || ["Meta", "Shift", "Control", "Alt"].includes(event.key)) return;
      const shortcut = macShortcutFromKeyEvent(event);
      if (shortcut === null) {
        setShortcutCaptureHint("Press ⌘ ⇧ with a letter, number, or punctuation key.");
        return;
      }
      void updateGlobalShortcut(shortcut);
    };
    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, [capturingShortcut, updateGlobalShortcut]);

  const status = statusQuery.data;
  const configured = status?.configured === true;
  const canManage = status?.canManage === true;
  const isBusy = operation !== null;

  const writeAuthoritativeStatus = useCallback(
    (nextStatus: DictationCredentialStatus) => {
      if (primaryEnvironmentId === null) {
        return;
      }
      queryClient.setQueryData(dictationQueryKeys.status(primaryEnvironmentId), nextStatus);
    },
    [primaryEnvironmentId, queryClient],
  );

  const handleSave = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!primaryEnvironmentId || !canManage || isBusy) {
        return;
      }

      const apiKey = newApiKey.trim();
      if (apiKey.length === 0) {
        setFeedback({ kind: "error", message: "Enter a new OpenAI API key." });
        return;
      }
      if (apiKey.length > DICTATION_API_KEY_MAX_CHARS || containsApiKeyControlCharacter(apiKey)) {
        setFeedback({ kind: "error", message: "Enter a valid OpenAI API key." });
        return;
      }

      // Clear the controlled field before crossing the RPC boundary. If the
      // response is lost after the server commits the write, a now-stored key
      // must not remain visible or reachable through renderer component state.
      setNewApiKey("");
      setFeedback(null);
      setOperation("saving");
      try {
        const nextStatus = await requireEnvironmentConnection(
          primaryEnvironmentId,
        ).client.dictation.setApiKey({ apiKey });
        writeAuthoritativeStatus(nextStatus);
        setFeedback({
          kind: "success",
          message: configured
            ? "Key replaced. Access is checked when dictation starts."
            : "Key saved. Access is checked when dictation starts.",
        });
      } catch (error) {
        setFeedback({ kind: "error", message: formatCredentialManagementError(error) });
      } finally {
        setOperation(null);
      }
    },
    [canManage, configured, isBusy, newApiKey, primaryEnvironmentId, writeAuthoritativeStatus],
  );

  const handleRemove = useCallback(async () => {
    if (!primaryEnvironmentId || !canManage || isBusy) {
      return;
    }

    setFeedback(null);
    setRemoveError(null);
    setOperation("removing");
    try {
      const nextStatus =
        await requireEnvironmentConnection(primaryEnvironmentId).client.dictation.clearApiKey();
      writeAuthoritativeStatus(nextStatus);
      setRemoveDialogOpen(false);
      setFeedback({ kind: "success", message: "Key removed." });
    } catch (error) {
      setRemoveError(formatCredentialManagementError(error));
    } finally {
      setOperation(null);
    }
  }, [canManage, isBusy, primaryEnvironmentId, writeAuthoritativeStatus]);

  // Only problems get a status line; the badge already says whether a key is
  // stored, so repeating it in prose adds nothing (docs/style-guide.md §10).
  const statusProblem = !primaryEnvironmentId
    ? "Waiting for Cafe to connect."
    : statusQuery.isError
      ? formatStatusError(statusQuery.error)
      : null;
  const showStatusPending = useDelayedFlag(primaryEnvironmentId !== null && statusQuery.isPending);
  const showGlobalSettingsPending = useDelayedFlag(
    isMacDesktop && globalSettings === null && globalSettingsPending,
  );
  // Global dictation on a remote workspace uses this Mac's local key, not the
  // selected workspace's key shown above.
  const globalKeyStatus = remote ? localStatusQuery.data : status;
  const globalKeyConfigured = globalKeyStatus?.configured === true;
  const globalStatus =
    globalSettingsError ||
    globalSettings?.error ||
    (globalSettings?.enabled
      ? globalSettings.registered
        ? "Press the shortcut to start, and again to stop."
        : "Couldn't register this shortcut. Choose another."
      : globalSettings && globalKeyStatus && !globalKeyConfigured
        ? remote
          ? "Add an OpenAI API key in this Mac's local workspace first."
          : "Add an OpenAI API key first."
        : null);

  return (
    <SettingsPageContainer
      title="Dictation"
      description="OpenAI live transcription for the composer. Needs a paid API project with Realtime access."
    >
      <SettingsSection>
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              OpenAI API key
              <InfoTip label="About the OpenAI API key">
                Only an owner can add, replace or remove the key. It stays in Cafe's private
                server-side secret store; this page only learns whether a key is set, and dictation
                uses short-lived transcription credentials. Audio is sent to OpenAI only while you
                dictate.
              </InfoTip>
            </span>
          }
          description={
            <span id="dictation-api-key-help">Stored only on the server; never shown again.</span>
          }
          status={
            statusProblem ? (
              <span aria-live="polite">
                {statusProblem}
                {statusQuery.isError && primaryEnvironmentId ? (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="ml-1 h-auto p-0 align-baseline"
                    onClick={() => void statusQuery.refetch()}
                  >
                    Retry
                  </Button>
                ) : null}
              </span>
            ) : status && !status.canManage ? (
              <span className="text-warning-foreground">
                Only an owner can add, replace or remove this key.
              </span>
            ) : feedback ? (
              <span
                className={
                  feedback.kind === "success" ? "text-success-foreground" : "text-destructive"
                }
                role={feedback.kind === "error" ? "alert" : "status"}
              >
                {feedback.message}
              </span>
            ) : null
          }
          control={statusBadge({
            environmentReady: primaryEnvironmentId !== null,
            isPending: statusQuery.isPending,
            showPending: showStatusPending,
            isError: statusQuery.isError,
            status,
          })}
        >
          <form className="mt-3 space-y-3 border-t border-border-subtle py-4" onSubmit={handleSave}>
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-foreground">New OpenAI API key</span>
              <Input
                type="password"
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={DICTATION_API_KEY_MAX_CHARS}
                value={newApiKey}
                onChange={(event) => {
                  setNewApiKey(event.target.value);
                  setFeedback(null);
                }}
                placeholder={configured ? "Enter a replacement key" : "Enter an API key"}
                disabled={!canManage || isBusy}
                aria-describedby="dictation-api-key-help"
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={!canManage || isBusy || newApiKey.trim().length === 0}
              >
                {/* The spinner takes the icon's place so the label and width stay put. */}
                {operation === "saving" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <KeyRoundIcon className="size-3.5" />
                )}
                {configured ? "Replace key" : "Save key"}
              </Button>
              {configured ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canManage || isBusy}
                  onClick={() => {
                    setRemoveError(null);
                    setRemoveDialogOpen(true);
                  }}
                >
                  Remove key
                </Button>
              ) : null}
            </div>
          </form>
        </SettingsRow>
      </SettingsSection>

      {isMacDesktop ? (
        <SettingsSection title="Global dictation" icon={<KeyboardIcon className="size-3.5" />}>
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-1.5">
                Enable on this Mac
                <InfoTip label="About global dictation">
                  Opens a floating recorder from any app. Review and edit the text before Copy, Save
                  or Insert; nothing goes into another app until you choose Insert or Paste into
                  app, and if Cafe can't verify it, your draft stays in the recorder. Audio is sent
                  only while recording. The shortcut is stored on this Mac.
                  {remote
                    ? " The recorder uses this Mac's local key; the key above belongs to the selected workspace and is used for chat dictation there."
                    : null}
                </InfoTip>
              </span>
            }
            description="Dictate into any Mac app. Insert needs Accessibility permission."
            status={
              globalStatus ? (
                <span
                  aria-live="polite"
                  role={globalSettingsError || globalSettings?.error ? "alert" : undefined}
                >
                  {globalStatus}
                </span>
              ) : null
            }
            control={
              showGlobalSettingsPending || (globalSettings === null && globalSettingsPending) ? (
                showGlobalSettingsPending ? (
                  <Skeleton
                    aria-hidden="true"
                    className="h-5.5 w-9.5 rounded-full sm:h-4.5 sm:w-7.5"
                  />
                ) : null
              ) : (
                <Switch
                  aria-label="Enable Mac global dictation"
                  checked={globalSettings?.enabled ?? false}
                  disabled={
                    !globalSettings ||
                    globalSettingsPending ||
                    (remote ? localStatusQuery.data?.configured !== true : !configured)
                  }
                  onCheckedChange={(enabled) => void updateGlobalEnabled(enabled)}
                />
              )
            }
          />
          <SettingsRow
            title="Shortcut"
            description={capturingShortcut ? "⌘⇧ + one key · Esc cancels" : "⌘⇧ + one key"}
            status={
              shortcutCaptureHint ? (
                <span className="text-destructive" role="alert">
                  {shortcutCaptureHint}
                </span>
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <Kbd className="h-6 px-2 text-foreground">
                  {globalSettings ? macShortcutLabel(globalSettings.shortcut) : "⌘ ⇧ ,"}
                </Kbd>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-w-18"
                  disabled={!globalSettings || globalSettingsPending}
                  onClick={() => {
                    setShortcutCaptureHint(null);
                    setCapturingShortcut((current) => !current);
                  }}
                >
                  {capturingShortcut ? "Cancel" : "Change"}
                </Button>
              </div>
            }
          />
        </SettingsSection>
      ) : null}

      <AlertDialog
        open={removeDialogOpen}
        onOpenChange={(open) => {
          if (operation === "removing") {
            return;
          }
          setRemoveDialogOpen(open);
          if (!open) {
            setRemoveError(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the OpenAI API key?</AlertDialogTitle>
            <AlertDialogDescription>
              New dictation sessions will no longer start until an owner saves another key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError ? (
            <p className="px-6 pb-2 text-xs text-destructive" role="alert">
              {removeError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={operation === "removing"}
              render={<Button variant="outline" disabled={operation === "removing"} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={operation === "removing"}
              onClick={() => void handleRemove()}
            >
              {operation === "removing" ? (
                <Spinner className="size-3.5" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              Remove key
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
