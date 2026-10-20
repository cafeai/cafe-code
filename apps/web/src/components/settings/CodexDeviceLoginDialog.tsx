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

// Render only Cafe-authored reasons. Schema failures and transport exceptions
// can quote received payloads, including private auth material.
const loginReasons = [
  "Codex sign-in is already in progress.",
  "Close this account's Cafe chats before changing its native sign-in.",
  "Could not verify Codex's account status. Refresh this provider before trying sign-in again.",
  "Could not start Codex sign-in. Try again or run codex login in a terminal.",
  "Codex returned an invalid sign-in link. Update Codex before trying again.",
  "Update Codex to use device-code sign-in on this server.",
  "Codex sign-in did not complete. Start again and approve the code in your browser.",
  "Codex sign-in timed out. Start again to get a new code.",
  "Provider sign-in requires the enabled account and a current owner connection over HTTPS or the same machine.",
  "Provider sign-in requires the enabled Codex account and a current authenticated connection over HTTPS or the same machine.",
  "Update the Cafe server to use Codex device-code sign-in.",
];
const isLoginError = Schema.is(ServerProviderLoginError);

export function CodexDeviceLoginDialog({
  api,
  instanceId,
  displayName,
  onClose,
}: {
  readonly api: LocalApi;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly onClose: () => void;
}) {
  const uiLocale = useUiLocale();
  const [event, setEvent] = useState<ServerProviderDeviceLoginEvent | null>(null);
  const [failure, setFailure] = useState<number | null>(null);
  const [actionFailure, setActionFailure] = useState<"copy" | "browser" | null>(null);
  const [copied, setCopied] = useState(false);
  const failureMessages = [
    uiText("Codex sign-in is already in progress.", undefined, undefined, uiLocale),
    uiText(
      "Close this account's Cafe chats before changing its native sign-in.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Could not verify Codex's account status. Refresh this provider before trying sign-in again.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Could not start Codex sign-in. Try again or run codex login in a terminal.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Codex returned an invalid sign-in link. Update Codex before trying again.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Update Codex to use device-code sign-in on this server.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Codex sign-in did not complete. Start again and approve the code in your browser.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Codex sign-in timed out. Start again to get a new code.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Provider sign-in requires the enabled account and a current owner connection over HTTPS or the same machine.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Provider sign-in requires the enabled Codex account and a current authenticated connection over HTTPS or the same machine.",
      undefined,
      undefined,
      uiLocale,
    ),
    uiText(
      "Update the Cafe server to use Codex device-code sign-in.",
      undefined,
      undefined,
      uiLocale,
    ),
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
      setEvent(null);
      const index =
        isLoginError(error) && error.instanceId === instanceId
          ? loginReasons.indexOf(error.reason)
          : -1;
      setFailure(index < 0 ? loginReasons.length : index);
    };
    let cancel: (() => void) | undefined;
    try {
      cancel = api.server.subscribeProviderDeviceLogin(
        { instanceId },
        (next) => {
          if (!active || terminal) return;
          terminal = next.type === "authenticated";
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
  }, [api, instanceId]);
  const instructions = event?.type === "device-code" ? event : null;
  const authenticated = event?.type === "authenticated";
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
            {uiText("Sign in to {value0}", { value0: displayName }, undefined, uiLocale)}
          </DialogTitle>
          <DialogDescription>
            {uiText(
              "Sign in to Codex on this server using a browser on your device.",
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
          ) : instructions ? (
            <>
              <p>
                {uiText(
                  "Open the verification page and enter this code. Only approve a code you requested here.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
              </p>
              <p
                className="select-text rounded-lg border p-4 text-center font-mono text-2xl tracking-widest"
                aria-label={uiText("Sign-in code", undefined, undefined, uiLocale)}
              >
                {instructions.userCode}
              </p>
              <p className="break-all text-sm text-muted-foreground">
                {instructions.verificationUrl}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setActionFailure(null);
                    void copyTextToClipboard(instructions.userCode).then(
                      () => setCopied(true),
                      () => setActionFailure("copy"),
                    );
                  }}
                >
                  {copied
                    ? uiText("Copied", undefined, undefined, uiLocale)
                    : uiText("Copy code", undefined, undefined, uiLocale)}
                </Button>
                <Button
                  onClick={() => {
                    setActionFailure(null);
                    void api.shell
                      .openExternal(instructions.verificationUrl)
                      .catch(() => setActionFailure("browser"));
                  }}
                >
                  {uiText("Open verification page", undefined, undefined, uiLocale)}
                </Button>
              </div>
              <p role="status">
                {uiText("Waiting for Codex to confirm sign-in…", undefined, undefined, uiLocale)}
              </p>
            </>
          ) : (
            <p role="status">
              {uiText("Requesting a sign-in code…", undefined, undefined, uiLocale)}
            </p>
          )}
          {actionFailure && (
            <p role="alert">
              {actionFailure === "copy"
                ? uiText(
                    "Could not copy the code. Select and copy it manually.",
                    undefined,
                    undefined,
                    uiLocale,
                  )
                : uiText(
                    "Could not open the browser. Open the verification address above manually.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
            </p>
          )}
          {!authenticated && failure === null && (
            <p className="text-sm text-muted-foreground">
              {uiText(
                "If your account disables device-code sign-in, enable it in ChatGPT security settings or ask your workspace administrator.",
                undefined,
                undefined,
                uiLocale,
              )}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {authenticated || failure !== null
              ? uiText("Close", undefined, undefined, uiLocale)
              : uiText("Cancel", undefined, undefined, uiLocale)}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
