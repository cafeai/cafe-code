import { useEffect, useState } from "react";
import type {
  LocalApi,
  ProviderInstanceId,
  ServerProviderDeviceLoginEvent,
} from "@cafecode/contracts";
import { ServerProviderLoginError } from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { copyTextToClipboard } from "../../lib/copyToClipboard";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

// Render only Cafe-authored reasons. Schema failures and transport exceptions
// can quote received payloads, including private auth material.
const geminiLoginReasons = [
  "Gemini sign-in is already in progress.",
  "Close this account's Cafe chats before changing its native sign-in.",
  "Could not verify Gemini's account status. Refresh this provider before trying sign-in again.",
  "Could not start Gemini sign-in. Try again or run agy acp --login in a terminal.",
  "Antigravity CLI returned an invalid sign-in link. Update the CLI before trying again.",
  "Enter the authorization code or callback URL from the browser.",
  "This Gemini sign-in attempt is no longer active. Close this dialog and try again.",
  "Gemini sign-in did not complete. Check the authorization code or callback URL and try again.",
  "Gemini sign-in timed out. Start again to get a new sign-in link.",
  "Provider sign-in requires the enabled Gemini account and a current authenticated connection over HTTPS or the same machine.",
  "Update the Cafe server to use remote Gemini sign-in.",
] as const;

const INVALID_CODE_REASON_INDEX = 5;
const isLoginError = Schema.is(ServerProviderLoginError);

export function GeminiRemoteLoginDialog({
  api,
  instanceId,
  displayName,
  verificationMode = false,
  onClose,
}: {
  readonly api: LocalApi;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly verificationMode?: boolean | undefined;
  readonly onClose: () => void;
}) {
  const uiLocale = useUiLocale();
  const [forceLogin, setForceLogin] = useState(false);
  const [event, setEvent] = useState<ServerProviderDeviceLoginEvent | null>(null);
  const [failure, setFailure] = useState<number | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkingVerification, setCheckingVerification] = useState(false);
  const [verificationPendingMessage, setVerificationPendingMessage] = useState(false);
  const [actionFailure, setActionFailure] = useState<"copy" | "browser" | "refresh" | null>(null);
  const [copied, setCopied] = useState(false);

  const failureMessages = [
    uiText("Gemini sign-in is already in progress.", undefined, undefined, uiLocale),
    uiText(
      "Close this account's Cafe chats before changing its native sign-in.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Could not verify Gemini's account status. Refresh this provider before trying sign-in again.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Could not start Gemini sign-in. Try again or run agy acp --login in a terminal.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Antigravity CLI returned an invalid sign-in link. Update the CLI before trying again.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Enter the authorization code or callback URL from the browser.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "This Gemini sign-in attempt is no longer active. Close this dialog and try again.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Gemini sign-in did not complete. Check the authorization code or callback URL and try again.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Gemini sign-in timed out. Start again to get a new sign-in link.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Provider sign-in requires the enabled Gemini account and a current authenticated connection over HTTPS or the same machine.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText("Update the Cafe server to use remote Gemini sign-in.", undefined, undefined, uiLocale),
    uiText(
      "The connection or sign-in attempt ended. Close this dialog and try again.",
      undefined,
      undefined,
      uiLocale,
    ),
  ];

  useEffect(() => {
    let active = true;
    let terminal = false;
    const fail = (error: unknown) => {
      if (!active || terminal) return;
      terminal = true;
      setSubmitting(false);
      setEvent(null);
      const index =
        isLoginError(error) && error.instanceId === instanceId
          ? geminiLoginReasons.indexOf(error.reason as (typeof geminiLoginReasons)[number])
          : -1;
      setFailure(index < 0 ? geminiLoginReasons.length : index);
    };
    let cancel: (() => void) | undefined;
    try {
      cancel = api.server.subscribeProviderDeviceLogin(
        forceLogin ? { instanceId, forceLogin: true } : { instanceId },
        (next) => {
          if (!active || terminal) return;
          terminal = next.type === "authenticated" || next.type === "verification-required";
          setSubmitting(false);
          setCopied(false);
          setActionFailure(null);
          setCodeError(null);
          setEvent(next);
        },
        fail,
      );
    } catch (error) {
      fail(error);
    }
    return () => {
      active = false;
      cancel?.();
    };
  }, [api, forceLogin, instanceId]);

  const oauthInstructions = event?.type === "oauth-code" ? event : null;
  const verificationRequired = event?.type === "verification-required" ? event : null;
  const authenticated = event?.type === "authenticated";
  const showingVerification =
    verificationRequired !== null ||
    (verificationMode && !forceLogin && oauthInstructions === null);

  const handleSwitchAccount = () => {
    setEvent(null);
    setFailure(null);
    setCode("");
    setCodeError(null);
    setActionFailure(null);
    setVerificationPendingMessage(false);
    setCopied(false);
    setForceLogin(true);
  };

  const handleSubmitCode = (submitEvent: React.FormEvent<HTMLFormElement>) => {
    submitEvent.preventDefault();
    if (!oauthInstructions || submitting) return;
    const trimmed = code.trim();
    if (!trimmed) {
      setCodeError(failureMessages[INVALID_CODE_REASON_INDEX] ?? null);
      return;
    }
    setSubmitting(true);
    setCodeError(null);
    setActionFailure(null);
    setCode("");
    void api.server
      .submitProviderLoginCode({
        instanceId,
        loginId: oauthInstructions.loginId,
        code: trimmed,
      })
      .catch((error: unknown) => {
        setSubmitting(false);
        const index =
          isLoginError(error) && error.instanceId === instanceId
            ? geminiLoginReasons.indexOf(error.reason as (typeof geminiLoginReasons)[number])
            : -1;
        if (index === INVALID_CODE_REASON_INDEX) {
          setCodeError(failureMessages[INVALID_CODE_REASON_INDEX] ?? null);
          return;
        }
        setEvent(null);
        setFailure(index < 0 ? geminiLoginReasons.length : index);
      });
  };

  const handleCheckVerification = () => {
    if (checkingVerification) return;
    setCheckingVerification(true);
    setActionFailure(null);
    setVerificationPendingMessage(false);
    void api.server
      .refreshProviders({ instanceId })
      .then((payload) => {
        const refreshed = payload.providers.find((provider) => provider.instanceId === instanceId);
        if (refreshed?.auth.status === "authenticated") {
          setEvent({ type: "authenticated" });
          return;
        }
        setVerificationPendingMessage(true);
      })
      .catch(() => {
        setActionFailure("refresh");
      })
      .finally(() => {
        setCheckingVerification(false);
      });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {showingVerification
              ? uiText("Verify {value0}", { value0: displayName }, undefined, uiLocale)
              : uiText("Sign in to {value0}", { value0: displayName }, undefined, uiLocale)}
          </DialogTitle>
          <DialogDescription>
            {showingVerification
              ? uiText(
                  "Complete Google account verification in your browser to use Gemini.",
                  undefined,
                  undefined,
                  uiLocale,
                )
              : uiText(
                  "Sign in to Gemini on this server using a browser on your device.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {failure !== null ? (
            <p role="alert">{failureMessages[failure]}</p>
          ) : authenticated ? (
            <p role="status">
              {uiText(
                "Signed in. Provider status has been refreshed.",
                undefined,
                undefined,
                uiLocale,
              )}
            </p>
          ) : verificationRequired ? (
            <>
              <p role="alert">
                {uiText(
                  "Google requires additional verification for this account before Gemini can be used.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
              </p>
              <p className="text-sm text-muted-foreground">
                {uiText(
                  "Open the verification page in your browser, finish the requested steps, then check status again.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
              </p>
              <p className="max-h-24 overflow-y-auto break-all rounded-lg border p-3 text-xs text-muted-foreground select-text">
                {verificationRequired.verificationUrl}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    setActionFailure(null);
                    void api.shell
                      .openExternal(verificationRequired.verificationUrl)
                      .catch(() => setActionFailure("browser"));
                  }}
                >
                  {uiText("Open verification page", undefined, undefined, uiLocale)}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setActionFailure(null);
                    void copyTextToClipboard(verificationRequired.verificationUrl).then(
                      () => setCopied(true),
                      () => setActionFailure("copy"),
                    );
                  }}
                >
                  {copied
                    ? uiText("Copied", undefined, undefined, uiLocale)
                    : uiText("Copy link", undefined, undefined, uiLocale)}
                </Button>
                <Button
                  variant="outline"
                  disabled={checkingVerification}
                  onClick={handleCheckVerification}
                >
                  {checkingVerification
                    ? uiText("Checking sign-in status…", undefined, undefined, uiLocale)
                    : uiText("Check sign-in status", undefined, undefined, uiLocale)}
                </Button>
                <Button variant="ghost" onClick={handleSwitchAccount}>
                  {uiText("Sign in with a different account", undefined, undefined, uiLocale)}
                </Button>
              </div>
              {verificationPendingMessage && (
                <p role="status" className="text-sm text-muted-foreground">
                  {uiText(
                    "Verification is still pending. Finish the steps in your browser and check again.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
                </p>
              )}
            </>
          ) : oauthInstructions ? (
            <>
              <p>
                {uiText(
                  "Open the Google sign-in page in your browser, approve access, then paste the authorization code or full callback URL below.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
              </p>
              <p className="max-h-20 overflow-y-auto break-all rounded-lg border p-3 text-xs text-muted-foreground select-text">
                {oauthInstructions.authorizationUrl}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => {
                    setActionFailure(null);
                    void api.shell
                      .openExternal(oauthInstructions.authorizationUrl)
                      .catch(() => setActionFailure("browser"));
                  }}
                >
                  {uiText("Open Google sign-in", undefined, undefined, uiLocale)}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setActionFailure(null);
                    void copyTextToClipboard(oauthInstructions.authorizationUrl).then(
                      () => setCopied(true),
                      () => setActionFailure("copy"),
                    );
                  }}
                >
                  {copied
                    ? uiText("Copied", undefined, undefined, uiLocale)
                    : uiText("Copy link", undefined, undefined, uiLocale)}
                </Button>
              </div>
              <form className="space-y-3" onSubmit={handleSubmitCode}>
                <Input
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value);
                    if (codeError) setCodeError(null);
                  }}
                  disabled={submitting}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={uiText(
                    "Authorization code or callback URL",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
                  placeholder={uiText(
                    "Paste authorization code or callback URL",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
                />
                {codeError && (
                  <p role="alert" className="text-sm text-destructive">
                    {codeError}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <Button type="submit" disabled={submitting || code.trim().length === 0}>
                    {submitting
                      ? uiText("Completing Google sign-in…", undefined, undefined, uiLocale)
                      : uiText("Complete sign-in", undefined, undefined, uiLocale)}
                  </Button>
                </div>
              </form>
              {submitting && (
                <p role="status">
                  {uiText(
                    "Waiting for Antigravity CLI to finish sign-in…",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
                </p>
              )}
            </>
          ) : (
            <p role="status">
              {showingVerification
                ? uiText("Checking verification status…", undefined, undefined, uiLocale)
                : uiText("Preparing Google sign-in link…", undefined, undefined, uiLocale)}
            </p>
          )}
          {actionFailure && (
            <p role="alert">
              {actionFailure === "copy"
                ? uiText(
                    "Could not copy the link. Select and copy it manually.",
                    undefined,
                    undefined,
                    uiLocale,
                  )
                : actionFailure === "refresh"
                  ? uiText(
                      "Could not refresh Gemini status. Close this dialog and refresh providers manually.",
                      undefined,
                      undefined,
                      uiLocale,
                    )
                  : uiText(
                      "Could not open the browser. Open the address above manually.",
                      undefined,
                      undefined,
                      uiLocale,
                    )}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant={authenticated ? "default" : "outline"} onClick={onClose}>
            {authenticated || failure !== null || verificationRequired
              ? uiText("Close", undefined, undefined, uiLocale)
              : uiText("Cancel", undefined, undefined, uiLocale)}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
