import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  CheckCircle2Icon,
  KeyRoundIcon,
  KeyboardIcon,
  MicIcon,
  ShieldCheckIcon,
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
import { Input } from "../ui/input";
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
  readonly isError: boolean;
  readonly status: DictationCredentialStatus | undefined;
}) {
  if (!input.environmentReady || input.isError) {
    return (
      <Badge variant="error" size="sm">
        <TriangleAlertIcon />
        Unavailable
      </Badge>
    );
  }

  if (input.isPending || !input.status) {
    return (
      <Badge variant="secondary" size="sm">
        <Spinner />
        Checking
      </Badge>
    );
  }

  if (input.status.configured) {
    return (
      <Badge variant="success" size="sm">
        <CheckCircle2Icon />
        Configured
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" size="sm">
      Not configured
    </Badge>
  );
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
            ? "OpenAI API key replaced. Cafe will verify access when dictation starts."
            : "OpenAI API key saved. Cafe will verify access when dictation starts.",
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
      setFeedback({ kind: "success", message: "OpenAI API key removed." });
    } catch (error) {
      setRemoveError(formatCredentialManagementError(error));
    } finally {
      setOperation(null);
    }
  }, [canManage, isBusy, primaryEnvironmentId, writeAuthoritativeStatus]);

  const statusDescription = !primaryEnvironmentId
    ? "Waiting for the primary Cafe Code environment."
    : statusQuery.isError
      ? formatStatusError(statusQuery.error)
      : statusQuery.isPending || !status
        ? "Checking the server-side credential status."
        : configured
          ? "The key is stored. Cafe verifies OpenAI access when you explicitly start Dictation."
          : "No key is stored, so Dictation does not access the microphone or OpenAI.";

  return (
    <SettingsPageContainer>
      <div className="space-y-1 px-1">
        <h1 className="text-lg font-semibold tracking-[-0.02em] text-foreground">Dictation</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Opt in to OpenAI live transcription for the composer. Dictation remains off until an API
          key is configured and you explicitly start it from the microphone control.
        </p>
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          GPT Live Transcribe requires a paid OpenAI API project with Realtime model access; the
          OpenAI API Free tier does not support this model.
        </p>
      </div>

      <SettingsSection title="OpenAI live transcription" icon={<MicIcon className="size-3.5" />}>
        <SettingsRow
          title="Dictation status"
          description="Microphone audio is sent to OpenAI only during a dictation session you start."
          status={
            <span aria-live="polite">
              {statusDescription}
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
          }
          control={statusBadge({
            environmentReady: primaryEnvironmentId !== null,
            isPending: statusQuery.isPending,
            isError: statusQuery.isError,
            status,
          })}
        />

        <SettingsRow
          title="OpenAI API key"
          description={
            configured
              ? "A key is stored. Enter a new key only when you want to replace it."
              : "Enter a key to enable Dictation. The stored value is never returned to this page."
          }
          status={
            status && !status.canManage ? (
              <span className="text-warning-foreground">
                Only an owner session can add, replace, or remove this credential.
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
        >
          <form className="mt-3 space-y-3 border-t border-border/60 py-4" onSubmit={handleSave}>
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
            <p
              id="dictation-api-key-help"
              className="text-[11px] leading-relaxed text-muted-foreground"
            >
              Cafe Code sends this permanent key only from its server when minting a short-lived
              transcription credential. It is not added to browser settings or returned after
              saving.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={!canManage || isBusy || newApiKey.trim().length === 0}
              >
                {operation === "saving" ? (
                  <>
                    <Spinner className="size-3.5" />
                    Saving…
                  </>
                ) : (
                  <>
                    <KeyRoundIcon className="size-3.5" />
                    {configured ? "Replace key" : "Save key"}
                  </>
                )}
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
        <SettingsSection
          title="Dictate anywhere on Mac"
          icon={<KeyboardIcon className="size-3.5" />}
        >
          <SettingsRow
            title="Global dictation shortcut"
            description={
              remote
                ? "This Mac uses its local Cafe dictation credential for the floating recorder. The credential above belongs to the selected workspace and is used for chat dictation there. Review recorded text before Copy, Save, or Insert; insertion needs macOS Accessibility permission."
                : "Open a floating recorder from another Mac app. Review and edit the text before choosing Copy, Save, or Insert. Insertion needs macOS Accessibility permission."
            }
            status={
              <span
                aria-live="polite"
                role={globalSettingsError || globalSettings?.error ? "alert" : undefined}
              >
                {globalSettingsError ||
                  globalSettings?.error ||
                  (globalSettings?.enabled
                    ? globalSettings.registered
                      ? "Ready. Press the shortcut to start, then press it again to stop."
                      : "The shortcut is not registered. Choose another combination."
                    : "Off until you enable it. Microphone audio is sent only while recording.")}
              </span>
            }
            control={
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
            }
          />
          <SettingsRow
            title="Keyboard shortcut"
            description="Hold Command and Shift, then press one letter, number, or punctuation key. Escape cancels shortcut capture."
            status={
              shortcutCaptureHint ? (
                <span className="text-destructive" role="alert">
                  {shortcutCaptureHint}
                </span>
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <kbd className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs font-medium text-foreground">
                  {globalSettings ? macShortcutLabel(globalSettings.shortcut) : "⌘ ⇧ ,"}
                </kbd>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
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
          <p className="border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
            This Mac-only shortcut is stored locally. Cafe Code never inserts dictated text into
            another app until you click Insert. If insertion cannot be verified, your editable draft
            stays in the floating window for Copy or Save.
          </p>
        </SettingsSection>
      ) : null}

      <SettingsSection title="Security & access" icon={<ShieldCheckIcon className="size-3.5" />}>
        <SettingsRow
          title="Server-side credential"
          description="The permanent API key stays in Cafe Code's private server-side secret store. Browser and desktop renderers receive only configuration status and short-lived transcription credentials."
        />
        <SettingsRow
          title="Owner-managed"
          description="Only an authenticated owner session can save, replace, or remove the permanent key. Client sessions cannot read or change it."
        />
      </SettingsSection>

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
                <>
                  <Spinner className="size-3.5" />
                  Removing…
                </>
              ) : (
                "Remove key"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
