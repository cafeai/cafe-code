import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthTwoFactorEnrollment,
  AuthTwoFactorStatus,
  EnvironmentId,
} from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import {
  createTwoFactorApi,
  TwoFactorApiError,
  type TwoFactorApi,
} from "~/environments/twoFactorApi";
import { SecondFactorInput } from "../auth/SecondFactorInput";
import { Button } from "../ui/button";
import { BusyButtonLabel, SettingsRow } from "./settingsLayout";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";

export function TwoFactorManagementRow({
  environmentId,
  api: providedApi,
}: {
  environmentId: EnvironmentId | null;
  api?: TwoFactorApi;
}) {
  const locale = useUiLocale();
  const api = useMemo(
    () => providedApi ?? createTwoFactorApi(environmentId),
    [environmentId, providedApi],
  );
  const [status, setStatus] = useState<AuthTwoFactorStatus | null>(null);
  const [mode, setMode] = useState<"enable" | "disable" | null>(null);
  const [enrollment, setEnrollment] = useState<AuthTwoFactorEnrollment | null>(null);
  const [codes, setCodes] = useState<ReadonlyArray<string> | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<TwoFactorApiError["kind"] | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void api.status().then(
      (value) => {
        if (alive.current) setStatus(value);
      },
      () => {
        if (alive.current) setErrorCode("request");
      },
    );
    return () => {
      alive.current = false;
    };
  }, [api]);
  const errorText =
    errorCode === "locked"
      ? uiText(
          "Authenticator codes are locked. Use an unused recovery code.",
          undefined,
          undefined,
          locale,
        )
      : errorCode === "limited"
        ? uiText(
            "Too many authentication attempts. Wait for the cooldown, then try again.",
            undefined,
            undefined,
            locale,
          )
        : errorCode === "code"
          ? uiText(
              "Check your authenticator code or use an unused recovery code.",
              undefined,
              undefined,
              locale,
            )
          : errorCode
            ? uiText(
                "Could not update two-factor authentication. Check your connection and try again.",
                undefined,
                undefined,
                locale,
              )
            : null;
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setErrorCode(null);
    try {
      await action();
    } catch (error) {
      if (alive.current) setErrorCode(error instanceof TwoFactorApiError ? error.kind : "request");
    } finally {
      if (alive.current) {
        setBusy(false);
        setCode("");
      }
    }
  };
  const open = () => {
    setCode("");
    setErrorCode(null);
    setCodes(null);
    setEnrollment(null);
    if (status?.enabled) {
      setMode("disable");
      return;
    }
    void run(async () => {
      const value = await api.begin();
      if (alive.current) {
        setEnrollment(value);
        setMode("enable");
      }
    });
  };
  const submit = () =>
    void run(async () => {
      if (mode === "enable") {
        const result = await api.enable(code);
        if (alive.current) {
          setCodes(result.recoveryCodes);
          setEnrollment(null);
          setStatus({ enabled: true, recoveryCodesRemaining: result.recoveryCodes.length });
        }
      } else {
        const result = await api.disable(code);
        if (alive.current) {
          setStatus(result);
          setMode(null);
        }
      }
    });
  const close = () => {
    setMode(null);
    setCode("");
    setEnrollment(null);
    setCodes(null);
    setErrorCode(null);
  };

  return (
    <>
      <SettingsRow
        title={uiText("Two-factor authentication", undefined, undefined, locale)}
        description={
          status?.enabled
            ? uiText("Enabled for new password and pairing logins.", undefined, undefined, locale)
            : uiText(
                "Require an authenticator code when signing in remotely.",
                undefined,
                undefined,
                locale,
              )
        }
        status={
          !mode && errorText ? (
            <span role="alert" className="text-destructive-foreground">
              {errorText}
            </span>
          ) : null
        }
        control={
          <Button size="xs" variant="outline" disabled={status === null || busy} onClick={open}>
            <BusyButtonLabel busy={busy && mode === null}>
              {status?.enabled
                ? uiText("Disable", undefined, undefined, locale)
                : uiText("Enable", undefined, undefined, locale)}
            </BusyButtonLabel>
          </Button>
        }
      />
      <Dialog
        open={mode !== null}
        onOpenChange={(open) => {
          if (!open && !busy) close();
        }}
      >
        <DialogPopup className="max-h-[calc(100dvh-3rem)] max-w-md" showCloseButton={!busy}>
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {codes
                ? uiText("Save your recovery codes", undefined, undefined, locale)
                : mode === "enable"
                  ? uiText("Enable two-factor authentication", undefined, undefined, locale)
                  : uiText("Disable two-factor authentication", undefined, undefined, locale)}
            </DialogTitle>
            <DialogDescription>
              {codes
                ? uiText(
                    "Each code works once. Store these somewhere safe; they will not be shown again.",
                    undefined,
                    undefined,
                    locale,
                  )
                : mode === "enable"
                  ? uiText(
                      "Scan this QR code with your authenticator app, then enter its six-digit code.",
                      undefined,
                      undefined,
                      locale,
                    )
                  : uiText(
                      "Enter a current authenticator code or an unused recovery code to turn off two-factor authentication.",
                      undefined,
                      undefined,
                      locale,
                    )}
            </DialogDescription>
          </DialogHeader>
          <form
            className="flex min-h-0 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (!busy && !codes) submit();
            }}
          >
            <DialogPanel className="space-y-4">
              {enrollment ? (
                <>
                  <QRCodeSvg
                    value={enrollment.uri}
                    marginSize={4}
                    title={uiText("Authenticator setup QR code", undefined, undefined, locale)}
                    className="mx-auto size-44"
                  />
                  <p className="text-xs text-muted-foreground">
                    {uiText("Manual setup key", undefined, undefined, locale)}
                  </p>
                  <code className="block break-all select-all rounded-lg bg-muted p-3 text-sm">
                    {enrollment.secret}
                  </code>
                </>
              ) : null}
              {codes ? (
                <div className="space-y-1 rounded-lg bg-muted p-3">
                  {codes.map((value) => (
                    <code key={value} className="block select-all break-all text-xs">
                      {value}
                    </code>
                  ))}
                </div>
              ) : (
                <SecondFactorInput
                  id="manage-second-factor"
                  value={code}
                  onChange={setCode}
                  disabled={busy}
                  required
                />
              )}
              {errorText ? (
                <p role="alert" className="text-sm text-destructive-foreground">
                  {errorText}
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter className="shrink-0">
              {codes ? (
                <Button type="button" onClick={close}>
                  {uiText("I saved these codes", undefined, undefined, locale)}
                </Button>
              ) : (
                <>
                  <Button type="button" variant="outline" disabled={busy} onClick={close}>
                    {uiText("Cancel", undefined, undefined, locale)}
                  </Button>
                  <Button type="submit" disabled={busy || !code.trim()}>
                    <BusyButtonLabel busy={busy}>
                      {mode === "enable"
                        ? uiText("Enable", undefined, undefined, locale)
                        : uiText("Disable", undefined, undefined, locale)}
                    </BusyButtonLabel>
                  </Button>
                </>
              )}
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
