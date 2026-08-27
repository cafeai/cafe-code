import {
  CheckCircle2Icon,
  KeyRoundIcon,
  MicIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { DICTATION_API_KEY_MAX_CHARS, type DictationCredentialStatus } from "@cafecode/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useCallback, useState } from "react";

import { usePrimaryEnvironmentId } from "~/environments/primary";
import { requireEnvironmentConnection } from "~/environments/runtime";
import { readDictationRpcErrorCode } from "~/dictation/errors";
import { dictationQueryKeys, dictationStatusQueryOptions } from "~/lib/dictationReactQuery";
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
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type CredentialOperation = "saving" | "removing" | null;

type OperationFeedback = {
  readonly kind: "success" | "error";
  readonly message: string;
};

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
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  const statusQuery = useQuery(dictationStatusQueryOptions(primaryEnvironmentId));
  const [newApiKey, setNewApiKey] = useState("");
  const [operation, setOperation] = useState<CredentialOperation>(null);
  const [feedback, setFeedback] = useState<OperationFeedback | null>(null);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

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
