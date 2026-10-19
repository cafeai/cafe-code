import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
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

type CredentialFeedbackCode =
  | "credential-not-authorized"
  | "credential-insecure-transport"
  | "credential-rate-limited"
  | "credential-secret-store-failed"
  | "credential-update-failed";

type DictationFeedbackCode =
  | CredentialFeedbackCode
  | "empty-key"
  | "invalid-key"
  | "key-replaced"
  | "key-saved"
  | "key-removed"
  | "shortcut-load-failed"
  | "global-update-failed"
  | "shortcut-update-failed"
  | "shortcut-invalid";

// Only finite Cafe-authored codes enter feedback state. Render-time formatting
// observes the current locale without replaying credential or desktop actions,
// and no received error detail or rejected API key is retained for translation.
type OperationFeedback = {
  readonly kind: "success" | "error";
  readonly code: DictationFeedbackCode;
};

function formatDictationFeedback(code: DictationFeedbackCode, locale: UiLocale): string {
  switch (code) {
    case "credential-not-authorized":
      return uiText(
        "Only an owner session can manage the OpenAI API key.",
        undefined,
        undefined,
        locale,
      );
    case "credential-insecure-transport":
      return uiText(
        "Use Cafe Code on localhost or over HTTPS to manage this credential.",
        undefined,
        undefined,
        locale,
      );
    case "credential-rate-limited":
      return uiText(
        "Too many credential requests. Wait a moment and try again.",
        undefined,
        undefined,
        locale,
      );
    case "credential-secret-store-failed":
      return uiText(
        "Cafe Code could not update its private credential store.",
        undefined,
        undefined,
        locale,
      );
    case "credential-update-failed":
      return uiText(
        "Cafe Code could not update the dictation credential. Try again.",
        undefined,
        undefined,
        locale,
      );
    case "empty-key":
      return uiText("Enter a new OpenAI API key.", undefined, undefined, locale);
    case "invalid-key":
      return uiText("Enter a valid OpenAI API key.", undefined, undefined, locale);
    case "key-replaced":
      return uiText(
        "Key replaced. Access is checked when dictation starts.",
        undefined,
        undefined,
        locale,
      );
    case "key-saved":
      return uiText(
        "Key saved. Access is checked when dictation starts.",
        undefined,
        undefined,
        locale,
      );
    case "key-removed":
      return uiText("Key removed.", undefined, undefined, locale);
    case "shortcut-load-failed":
      return uiText("Could not load the Mac dictation shortcut.", undefined, undefined, locale);
    case "global-update-failed":
      return uiText("Could not update global dictation. Try again.", undefined, undefined, locale);
    case "shortcut-update-failed":
      return uiText(
        "Could not set this shortcut. Choose another combination.",
        undefined,
        undefined,
        locale,
      );
    case "shortcut-invalid":
      return uiText(
        "Press ⌘ ⇧ with a letter, number, or punctuation key.",
        undefined,
        undefined,
        locale,
      );
  }
}

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

function credentialFeedbackCode(error: unknown): CredentialFeedbackCode {
  switch (readDictationRpcErrorCode(error)) {
    case "not_authorized":
      return "credential-not-authorized";
    case "insecure_transport":
      return "credential-insecure-transport";
    case "rate_limited":
      return "credential-rate-limited";
    case "secret_store_failed":
      return "credential-secret-store-failed";
    default:
      return "credential-update-failed";
  }
}

function formatStatusError(error: unknown): string {
  switch (readDictationRpcErrorCode(error)) {
    case "not_authorized":
      return uiText("This session is not authorized to view dictation status.");
    case "insecure_transport":
      return uiText("Dictation status is unavailable over this insecure connection.");
    case "rate_limited":
      return uiText("Dictation status is temporarily rate limited.");
    default:
      return uiText("Cafe Code could not load dictation status.");
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
        {uiText("Unavailable")}
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
        {uiText("Configured")}
      </Badge>
    );
  }

  return <Badge variant="secondary">{uiText("Not configured")}</Badge>;
}

export function DictationSettings() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const primaryEnvironmentId = useWorkspaceEnvironmentId();
  const remote = useIsSavedRemoteEnvironment(primaryEnvironmentId);
  const localEnvironmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  const statusQuery = useQuery(dictationStatusQueryOptions(primaryEnvironmentId));
  const [newApiKey, setNewApiKey] = useState("");
  const [operation, setOperation] = useState<CredentialOperation>(null);
  const [feedbackCode, setFeedbackCode] = useState<OperationFeedback | null>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [removeErrorCode, setRemoveErrorCode] = useState<CredentialFeedbackCode | null>(null);
  const [globalSettings, setGlobalSettings] = useState<GlobalDictationSettingsState | null>(null);
  const [globalSettingsPending, setGlobalSettingsPending] = useState(false);
  const [globalSettingsErrorCode, setGlobalSettingsErrorCode] =
    useState<DictationFeedbackCode | null>(null);
  const [capturingShortcut, setCapturingShortcut] = useState(false);
  const [shortcutCaptureHintCode, setShortcutCaptureHintCode] =
    useState<DictationFeedbackCode | null>(null);
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
          setGlobalSettingsErrorCode(null);
        }
      })
      .catch(() => {
        if (mounted) setGlobalSettingsErrorCode("shortcut-load-failed");
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
    setGlobalSettingsErrorCode(null);
    try {
      setGlobalSettings(await bridge.setGlobalDictationEnabled(enabled));
    } catch {
      setGlobalSettingsErrorCode("global-update-failed");
    } finally {
      setGlobalSettingsPending(false);
    }
  }, []);

  const updateGlobalShortcut = useCallback(async (shortcut: string) => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    setGlobalSettingsPending(true);
    setGlobalSettingsErrorCode(null);
    try {
      setGlobalSettings(await bridge.setGlobalDictationShortcut(shortcut));
      setCapturingShortcut(false);
      setShortcutCaptureHintCode(null);
    } catch {
      setShortcutCaptureHintCode("shortcut-update-failed");
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
        setShortcutCaptureHintCode(null);
        return;
      }
      if (event.repeat || ["Meta", "Shift", "Control", "Alt"].includes(event.key)) return;
      const shortcut = macShortcutFromKeyEvent(event);
      if (shortcut === null) {
        setShortcutCaptureHintCode("shortcut-invalid");
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
        setFeedbackCode({ kind: "error", code: "empty-key" });
        return;
      }
      if (apiKey.length > DICTATION_API_KEY_MAX_CHARS || containsApiKeyControlCharacter(apiKey)) {
        setFeedbackCode({ kind: "error", code: "invalid-key" });
        return;
      }

      // Clear the controlled field before crossing the RPC boundary. If the
      // response is lost after the server commits the write, a now-stored key
      // must not remain visible or reachable through renderer component state.
      setNewApiKey("");
      setFeedbackCode(null);
      setOperation("saving");
      try {
        const nextStatus = await requireEnvironmentConnection(
          primaryEnvironmentId,
        ).client.dictation.setApiKey({ apiKey });
        writeAuthoritativeStatus(nextStatus);
        setFeedbackCode({
          kind: "success",
          code: configured ? "key-replaced" : "key-saved",
        });
      } catch (error) {
        setFeedbackCode({ kind: "error", code: credentialFeedbackCode(error) });
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

    setFeedbackCode(null);
    setRemoveErrorCode(null);
    setOperation("removing");
    try {
      const nextStatus =
        await requireEnvironmentConnection(primaryEnvironmentId).client.dictation.clearApiKey();
      writeAuthoritativeStatus(nextStatus);
      setRemoveDialogOpen(false);
      setFeedbackCode({ kind: "success", code: "key-removed" });
    } catch (error) {
      setRemoveErrorCode(credentialFeedbackCode(error));
    } finally {
      setOperation(null);
    }
  }, [canManage, isBusy, primaryEnvironmentId, writeAuthoritativeStatus]);

  // Only problems get a status line; the badge already says whether a key is
  // stored, so repeating it in prose adds nothing (docs/style-guide.md §10).
  const statusProblem = !primaryEnvironmentId
    ? uiText("Waiting for Cafe to connect.", undefined, undefined, uiLocale)
    : statusQuery.isError
      ? uiPresentation.formatStatusError(statusQuery.error)
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
    (globalSettingsErrorCode ? formatDictationFeedback(globalSettingsErrorCode, uiLocale) : null) ||
    globalSettings?.error ||
    (globalSettings?.enabled
      ? globalSettings.registered
        ? uiText("Press the shortcut to start, and again to stop.", undefined, undefined, uiLocale)
        : uiText("Couldn't register this shortcut. Choose another.", undefined, undefined, uiLocale)
      : globalSettings && globalKeyStatus && !globalKeyConfigured
        ? remote
          ? uiText(
              "Add an OpenAI API key in this Mac's local workspace first.",
              undefined,
              undefined,
              uiLocale,
            )
          : uiText("Add an OpenAI API key first.", undefined, undefined, uiLocale)
        : null);

  return (
    <SettingsPageContainer
      title={uiText("Dictation", undefined, undefined, uiLocale)}
      description={uiText(
        "OpenAI live transcription for the composer. Needs a paid API project with Realtime access.",
        undefined,
        undefined,
        uiLocale,
      )}
    >
      <SettingsSection>
        <SettingsRow
          searchId="dictation.apiKey"
          title={
            <span className="inline-flex items-center gap-1.5">
              <UiMessage
                message="OpenAI API key<slot1></slot1>"
                slots={{
                  slot1: (
                    <InfoTip
                      label={uiText("About the OpenAI API key", undefined, undefined, uiLocale)}
                    >
                      {uiText(
                        "Only an owner can add, replace or remove the key. It stays in Cafe''s private server-side secret store; this page only learns whether a key is set, and dictation uses short-lived transcription credentials. Audio is sent to OpenAI only while you dictate.",
                        undefined,
                        undefined,
                        uiLocale,
                      )}
                    </InfoTip>
                  ),
                }}
              />
            </span>
          }
          description={
            <span id="dictation-api-key-help">
              {uiText(
                "Stored only on the server; never shown again.",
                undefined,
                undefined,
                uiLocale,
              )}
            </span>
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
                    {uiText("Retry", undefined, undefined, uiLocale)}
                  </Button>
                ) : null}
              </span>
            ) : status && !status.canManage ? (
              <span className="text-warning-foreground">
                {uiText(
                  "Only an owner can add, replace or remove this key.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
              </span>
            ) : feedbackCode ? (
              <span
                className={
                  feedbackCode.kind === "success" ? "text-success-foreground" : "text-destructive"
                }
                role={feedbackCode.kind === "error" ? "alert" : "status"}
              >
                {formatDictationFeedback(feedbackCode.code, uiLocale)}
              </span>
            ) : null
          }
          control={uiPresentation.statusBadge({
            environmentReady: primaryEnvironmentId !== null,
            isPending: statusQuery.isPending,
            showPending: showStatusPending,
            isError: statusQuery.isError,
            status,
          })}
        >
          <form className="mt-3 space-y-3 border-t border-border-subtle py-4" onSubmit={handleSave}>
            <label className="block space-y-1.5">
              <span className="block text-xs font-medium text-foreground">
                {uiText("New OpenAI API key", undefined, undefined, uiLocale)}
              </span>
              <Input
                type="password"
                autoComplete="new-password"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={DICTATION_API_KEY_MAX_CHARS}
                value={newApiKey}
                onChange={(event) => {
                  setNewApiKey(event.target.value);
                  setFeedbackCode(null);
                }}
                placeholder={
                  configured
                    ? uiText("Enter a replacement key", undefined, undefined, uiLocale)
                    : uiText("Enter an API key", undefined, undefined, uiLocale)
                }
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
                {configured
                  ? uiText("Replace key", undefined, undefined, uiLocale)
                  : uiText("Save key", undefined, undefined, uiLocale)}
              </Button>
              {configured ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!canManage || isBusy}
                  onClick={() => {
                    setRemoveErrorCode(null);
                    setRemoveDialogOpen(true);
                  }}
                >
                  {uiText("Remove key", undefined, undefined, uiLocale)}
                </Button>
              ) : null}
            </div>
          </form>
        </SettingsRow>
      </SettingsSection>

      {isMacDesktop ? (
        <SettingsSection
          searchId="dictation.global"
          title={uiText("Global dictation", undefined, undefined, uiLocale)}
          icon={<KeyboardIcon className="size-3.5" />}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-1.5">
                <UiMessage
                  message="Enable on this Mac<slot1></slot1>"
                  slots={{
                    slot1: (
                      <InfoTip
                        label={uiText("About global dictation", undefined, undefined, uiLocale)}
                      >
                        {uiText(
                          "Opens a floating recorder from any app. Review and edit the text before Copy, Save or Insert; nothing goes into another app until you choose Insert or Paste into app, and if Cafe can''t verify it, your draft stays in the recorder. Audio is sent only while recording. The shortcut is stored on this Mac.",
                          undefined,
                          undefined,
                          uiLocale,
                        )}
                        {remote
                          ? uiText(
                              " The recorder uses this Mac''s local key; the key above belongs to the selected workspace and is used for chat dictation there.",
                              undefined,
                              undefined,
                              uiLocale,
                            )
                          : null}
                      </InfoTip>
                    ),
                  }}
                />
              </span>
            }
            description={uiText(
              "Dictate into any Mac app. Insert needs Accessibility permission.",
              undefined,
              undefined,
              uiLocale,
            )}
            status={
              globalStatus ? (
                <span
                  aria-live="polite"
                  role={globalSettingsErrorCode || globalSettings?.error ? "alert" : undefined}
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
                  aria-label={uiText("Enable Mac global dictation", undefined, undefined, uiLocale)}
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
            searchId="dictation.shortcut"
            title={uiText("Shortcut", undefined, undefined, uiLocale)}
            description={
              capturingShortcut
                ? uiText("⌘⇧ + one key · Esc cancels", undefined, undefined, uiLocale)
                : uiText("⌘⇧ + one key", undefined, undefined, uiLocale)
            }
            status={
              shortcutCaptureHintCode ? (
                <span className="text-destructive" role="alert">
                  {formatDictationFeedback(shortcutCaptureHintCode, uiLocale)}
                </span>
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <Kbd className="h-6 px-2 text-foreground">
                  {globalSettings
                    ? macShortcutLabel(globalSettings.shortcut)
                    : uiText("⌘ ⇧ ,", undefined, undefined, uiLocale)}
                </Kbd>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-w-18"
                  disabled={!globalSettings || globalSettingsPending}
                  onClick={() => {
                    setShortcutCaptureHintCode(null);
                    setCapturingShortcut((current) => !current);
                  }}
                >
                  {capturingShortcut
                    ? uiText("Cancel", undefined, undefined, uiLocale)
                    : uiText("Change", undefined, undefined, uiLocale)}
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
            setRemoveErrorCode(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {uiText("Remove the OpenAI API key?", undefined, undefined, uiLocale)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {uiText(
                "New dictation sessions will no longer start until an owner saves another key.",
                undefined,
                undefined,
                uiLocale,
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeErrorCode ? (
            <p className="px-6 pb-2 text-xs text-destructive" role="alert">
              {formatDictationFeedback(removeErrorCode, uiLocale)}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={operation === "removing"}
              render={<Button variant="outline" disabled={operation === "removing"} />}
            >
              {uiText("Cancel", undefined, undefined, uiLocale)}
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
              {uiText("Remove key", undefined, undefined, uiLocale)}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { formatStatusError, statusBadge };
