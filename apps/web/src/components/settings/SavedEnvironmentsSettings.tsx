import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import {
  PlusIcon,
  RefreshCcwIcon,
  ServerIcon,
  TrashIcon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { SecondFactorInput } from "../auth/SecondFactorInput";

import {
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime/catalog";
import { resolveServerConfigVersionMismatch } from "~/versionSkew";
import { remoteEnvironmentErrorMessage } from "~/environments/remote/api";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
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
import { SegmentedControl } from "../ui/segmented-control";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BusyButtonLabel, SettingsSection } from "./settingsLayout";

const ITEM_ROW_CLASSNAME = "border-t border-border-subtle px-4 py-4 first:border-t-0 sm:px-5";

export interface SavedEnvironmentActions {
  readonly add: typeof import("~/environments/runtime/service").addSavedEnvironment;
  readonly disconnect: typeof import("~/environments/runtime/service").disconnectSavedEnvironment;
  readonly reconnect: typeof import("~/environments/runtime/service").reconnectSavedEnvironment;
  readonly remove: typeof import("~/environments/runtime/service").removeSavedEnvironment;
}

const DEFAULT_SAVED_ENVIRONMENT_ACTIONS: SavedEnvironmentActions = {
  add: async (input) => (await import("~/environments/runtime/service")).addSavedEnvironment(input),
  disconnect: async (environmentId) =>
    (await import("~/environments/runtime/service")).disconnectSavedEnvironment(environmentId),
  reconnect: async (environmentId) =>
    (await import("~/environments/runtime/service")).reconnectSavedEnvironment(environmentId),
  remove: async (environmentId) =>
    (await import("~/environments/runtime/service")).removeSavedEnvironment(environmentId),
};

function safeSavedEnvironmentHost(httpBaseUrl: string): string {
  try {
    return new URL(httpBaseUrl).host || uiText("Invalid server address");
  } catch {
    return uiText("Invalid server address");
  }
}

function SavedEnvironmentStatus({
  label,
  dotClassName,
  connecting,
}: {
  label: string;
  dotClassName: string;
  connecting: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={label}
              className="relative flex size-3 cursor-help items-center justify-center rounded-full outline-hidden"
            />
          }
        >
          {connecting ? (
            <span
              className={`absolute inline-flex size-2 animate-ping rounded-full ${dotClassName}`}
            />
          ) : null}
          <span className={`relative inline-flex size-2 rounded-full ${dotClassName}`} />
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      {label}
    </span>
  );
}

function SavedEnvironmentRow({
  record,
  runtime,
  actions,
}: {
  record: SavedEnvironmentRecord;
  runtime: SavedEnvironmentRuntimeState | undefined;
  actions: SavedEnvironmentActions;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [pendingAction, setPendingAction] = useState<"reconnect" | "disconnect" | "remove" | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [isRemoveDialogOpen, setIsRemoveDialogOpen] = useState(false);

  const isRetrying =
    runtime?.reconnectPhase === "attempting" || runtime?.reconnectPhase === "waiting";
  const isConnecting = runtime?.connectionState === "connecting" || isRetrying;
  const isConnected = runtime?.connectionState === "connected";
  const isError = runtime?.connectionState === "error" || runtime?.reconnectPhase === "exhausted";
  const requiresAuth = runtime?.authState === "requires-auth";
  const versionMismatch = uiPresentation.resolveServerConfigVersionMismatch(runtime?.serverConfig);
  const actionsDisabled = isConnecting || pendingAction !== null;
  const displayLabel =
    record.label.trim() || uiText("Unnamed environment", undefined, undefined, uiLocale);

  let statusText = uiText("Disconnected", undefined, undefined, uiLocale);
  let dotColor = "bg-muted-foreground";
  if (requiresAuth) {
    statusText = uiText("Pairing required", undefined, undefined, uiLocale);
    dotColor = "bg-destructive";
  } else if (isConnecting) {
    statusText = runtime?.connectedAt
      ? uiText("Reconnecting", undefined, undefined, uiLocale)
      : uiText("Connecting", undefined, undefined, uiLocale);
    dotColor = "bg-warning";
  } else if (isConnected) {
    statusText = uiText("Connected", undefined, undefined, uiLocale);
    dotColor = "bg-success";
  } else if (isError) {
    statusText = uiText("Connection failed", undefined, undefined, uiLocale);
    dotColor = "bg-destructive";
  }

  const runAction = async (action: "reconnect" | "disconnect" | "remove") => {
    if (actionsDisabled) return;

    setPendingAction(action);
    setActionError(null);
    try {
      if (action === "reconnect") {
        await actions.reconnect(record.environmentId);
      } else if (action === "disconnect") {
        await actions.disconnect(record.environmentId);
      } else {
        await actions.remove(record.environmentId);
        setIsRemoveDialogOpen(false);
      }
    } catch {
      setActionError(
        action === "remove"
          ? uiText(
              "Could not remove this saved environment. Try again.",
              undefined,
              undefined,
              uiLocale,
            )
          : uiText(
              "Could not update this connection. Check that the server is reachable and try again.",
              undefined,
              undefined,
              uiLocale,
            ),
      );
    } finally {
      setPendingAction(null);
    }
  };

  const runtimeError = requiresAuth
    ? uiText(
        "The saved credential is missing or expired. Pair this server again.",
        undefined,
        undefined,
        uiLocale,
      )
    : isError
      ? uiText(
          "The server could not be reached or rejected the saved session.",
          undefined,
          undefined,
          uiLocale,
        )
      : null;

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border-subtle bg-muted text-muted-foreground">
            <ServerIcon className="size-4" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 break-words text-ui font-medium">{displayLabel}</span>
              <SavedEnvironmentStatus
                label={statusText}
                dotClassName={dotColor}
                connecting={isConnecting}
              />
            </div>
            <span className="break-all text-xs text-muted-foreground">
              {uiPresentation.safeSavedEnvironmentHost(record.httpBaseUrl)}
            </span>
            {versionMismatch ? (
              <span className="flex items-start gap-1.5 text-xs text-warning-foreground">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                <span className="break-all">
                  <UiMessage
                    message="Client <slot1></slot1>, server <slot3></slot3>"
                    slots={{
                      slot1: versionMismatch.clientVersion,
                      slot3: versionMismatch.serverVersion,
                    }}
                  />
                </span>
              </span>
            ) : null}
            {runtimeError ? (
              <span className="text-xs text-destructive-foreground">{runtimeError}</span>
            ) : null}
            {actionError ? (
              <span className="text-xs text-destructive-foreground">{actionError}</span>
            ) : null}
          </div>
        </div>

        <div className="flex h-8 shrink-0 items-center justify-end gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon"
                  disabled={actionsDisabled}
                  aria-label={
                    isConnected
                      ? uiText("Disconnect {value0}", { value0: displayLabel }, undefined, uiLocale)
                      : uiText("Reconnect {value0}", { value0: displayLabel }, undefined, uiLocale)
                  }
                  onClick={() => void runAction(isConnected ? "disconnect" : "reconnect")}
                />
              }
            >
              {pendingAction === "reconnect" || pendingAction === "disconnect" || isConnecting ? (
                <Spinner className="size-4" />
              ) : isConnected ? (
                <UnplugIcon className="size-4" />
              ) : (
                <RefreshCcwIcon className="size-4" />
              )}
            </TooltipTrigger>
            <TooltipPopup>
              {isConnected
                ? uiText("Disconnect", undefined, undefined, uiLocale)
                : uiText("Reconnect", undefined, undefined, uiLocale)}
            </TooltipPopup>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={actionsDisabled}
                  aria-label={uiText(
                    "Remove {value0}",
                    { value0: displayLabel },
                    undefined,
                    uiLocale,
                  )}
                  onClick={() => {
                    setActionError(null);
                    setIsRemoveDialogOpen(true);
                  }}
                />
              }
            >
              <TrashIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup>
              {uiText("Remove saved environment", undefined, undefined, uiLocale)}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>

      <AlertDialog
        open={isRemoveDialogOpen}
        onOpenChange={(open) => {
          if (pendingAction !== "remove") setIsRemoveDialogOpen(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {uiText("Remove saved environment?", undefined, undefined, uiLocale)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <UiMessage
                message="This removes <slot1></slot1> and its saved credential from this client."
                slots={{ slot1: displayLabel }}
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button variant="outline" disabled={pendingAction !== null} />}
            >
              {uiText("Cancel", undefined, undefined, uiLocale)}
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pendingAction !== null}
              aria-busy={pendingAction === "remove" || undefined}
              onClick={() => void runAction("remove")}
            >
              <BusyButtonLabel busy={pendingAction === "remove"}>
                {uiText("Remove", undefined, undefined, uiLocale)}
              </BusyButtonLabel>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function AddSavedEnvironmentDialog({ actions }: { actions: SavedEnvironmentActions }) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<"url" | "code" | "login">("url");
  const [label, setLabel] = useState("");
  const [pairingUrl, setPairingUrl] = useState("");
  const [host, setHost] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [password, setPassword] = useState("");
  const [secondFactor, setSecondFactor] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setTab("url");
    setLabel("");
    setPairingUrl("");
    setHost("");
    setPairingCode("");
    setPassword("");
    setSecondFactor("");
    setError(null);
  };

  const changeTab = (next: typeof tab) => {
    setTab(next);
    // Discard bootstrap secrets when their inputs leave the screen as well as
    // on submission/close. A retry always requires fresh, explicit input.
    setPairingUrl("");
    setPairingCode("");
    setPassword("");
    setSecondFactor("");
    setError(null);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open && isSubmitting) return;
    setIsOpen(open);
    if (!open) resetForm();
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    const submittedLabel = label;
    const submittedUrl = pairingUrl;
    const submittedHost = host;
    const submittedCode = pairingCode;
    const submittedPassword = password;
    const factor = secondFactor.trim() ? { secondFactor: secondFactor.trim() } : {};
    const submittedTab = tab;

    setPairingUrl("");
    setPairingCode("");
    setPassword("");
    setSecondFactor("");
    try {
      if (submittedTab === "url") {
        await actions.add({ label: submittedLabel, pairingUrl: submittedUrl, ...factor });
      } else if (submittedTab === "code") {
        await actions.add({
          label: submittedLabel,
          host: submittedHost,
          pairingCode: submittedCode,
          ...factor,
        });
      } else {
        await actions.add({
          label: submittedLabel,
          host: submittedHost,
          password: submittedPassword,
          ...factor,
        });
      }
      resetForm();
      setIsOpen(false);
    } catch (error) {
      setError(
        uiPresentation.remoteEnvironmentErrorMessage(
          error,
          submittedTab === "login"
            ? uiText(
                "Could not sign in. Check the server address and admin password, then try again.",
                undefined,
                undefined,
                uiLocale,
              )
            : uiText(
                "Could not add this environment. Check the server address and pairing credential, then try again.",
                undefined,
                undefined,
                uiLocale,
              ),
        ),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={uiText("Add environment", undefined, undefined, uiLocale)}
              onClick={() => setIsOpen(true)}
            />
          }
        >
          <PlusIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup>{uiText("Add environment", undefined, undefined, uiLocale)}</TooltipPopup>
      </Tooltip>
      <DialogPopup showCloseButton={!isSubmitting} className="max-h-[calc(100dvh-3rem)]">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {uiText("Add saved environment", undefined, undefined, uiLocale)}
          </DialogTitle>
          <DialogDescription>
            {uiText("Remote Cafe Code server", undefined, undefined, uiLocale)}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
          <DialogPanel className="flex flex-col gap-4">
            <SegmentedControl
              aria-label={uiText("Connection method", undefined, undefined, uiLocale)}
              value={tab}
              onValueChange={changeTab}
              options={[
                {
                  value: "url",
                  label: uiText("Pairing URL", undefined, undefined, uiLocale),
                  disabled: isSubmitting,
                },
                {
                  value: "code",
                  label: uiText("Host + code", undefined, undefined, uiLocale),
                  disabled: isSubmitting,
                },
                {
                  value: "login",
                  label: uiText("Host + password", undefined, undefined, uiLocale),
                  disabled: isSubmitting,
                },
              ]}
            />

            <div className="flex flex-col gap-2">
              <label htmlFor="env-label" className="text-sm font-medium">
                {uiText("Label (optional)", undefined, undefined, uiLocale)}
              </label>
              <Input
                id="env-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={uiText("Production server", undefined, undefined, uiLocale)}
                disabled={isSubmitting}
              />
            </div>

            {tab === "url" ? (
              <div className="flex flex-col gap-2">
                <label htmlFor="env-url" className="text-sm font-medium">
                  {uiText("Pairing URL", undefined, undefined, uiLocale)}
                </label>
                <Input
                  id="env-url"
                  value={pairingUrl}
                  onChange={(event) => setPairingUrl(event.target.value)}
                  placeholder="https://server.example/pair#token=..."
                  required
                  disabled={isSubmitting}
                  autoComplete="off"
                />
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <label htmlFor="env-host" className="text-sm font-medium">
                    {uiText("Host", undefined, undefined, uiLocale)}
                  </label>
                  <Input
                    id="env-host"
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                    placeholder={uiText("server.example:3000", undefined, undefined, uiLocale)}
                    required
                    disabled={isSubmitting}
                  />
                </div>
                {tab === "login" ? (
                  <>
                    <div className="flex flex-col gap-2">
                      <label htmlFor="env-password" className="text-sm font-medium">
                        {uiText("Admin password", undefined, undefined, uiLocale)}
                      </label>
                      <Input
                        id="env-password"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="current-password"
                        required
                        disabled={isSubmitting}
                      />
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col gap-2">
                    <label htmlFor="env-code" className="text-sm font-medium">
                      {uiText("Pairing code", undefined, undefined, uiLocale)}
                    </label>
                    <Input
                      id="env-code"
                      value={pairingCode}
                      onChange={(event) => setPairingCode(event.target.value)}
                      placeholder={uiText("Pairing code", undefined, undefined, uiLocale)}
                      required
                      disabled={isSubmitting}
                      autoComplete="off"
                    />
                  </div>
                )}
              </>
            )}

            <SecondFactorInput
              id="env-second-factor"
              value={secondFactor}
              onChange={setSecondFactor}
              disabled={isSubmitting}
            />
            <p className="text-xs text-muted-foreground">
              {uiText(
                "Leave the authentication code empty if this server has two-factor authentication turned off.",
                undefined,
                undefined,
                uiLocale,
              )}
            </p>
            {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}
          </DialogPanel>

          <DialogFooter className="shrink-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              {uiText("Cancel", undefined, undefined, uiLocale)}
            </Button>
            <Button type="submit" disabled={isSubmitting} aria-busy={isSubmitting || undefined}>
              <BusyButtonLabel busy={isSubmitting}>
                {uiText("Add environment", undefined, undefined, uiLocale)}
              </BusyButtonLabel>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function SavedEnvironmentsSettings({
  actions = DEFAULT_SAVED_ENVIRONMENT_ACTIONS,
}: {
  actions?: SavedEnvironmentActions;
} = {}) {
  const uiLocale = useUiLocale();

  const registryById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const records = useMemo(
    () => Object.values(registryById).sort((left, right) => left.label.localeCompare(right.label)),
    [registryById],
  );

  return (
    <SettingsSection
      title={uiText("Saved environments", undefined, undefined, uiLocale)}
      headerAction={<AddSavedEnvironmentDialog actions={actions} />}
    >
      {records.length === 0 ? (
        <p className="px-4 py-3.5 text-xs text-muted-foreground sm:px-5">
          {uiText("No remote servers paired.", undefined, undefined, uiLocale)}
        </p>
      ) : (
        records.map((record) => (
          <SavedEnvironmentRow
            key={record.environmentId}
            record={record}
            runtime={runtimeById[record.environmentId]}
            actions={actions}
          />
        ))
      )}
    </SettingsSection>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = {
  remoteEnvironmentErrorMessage,
  resolveServerConfigVersionMismatch,
  safeSavedEnvironmentHost,
};
