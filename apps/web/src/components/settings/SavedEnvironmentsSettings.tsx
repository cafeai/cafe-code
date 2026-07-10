import {
  PlusIcon,
  RefreshCcwIcon,
  ServerIcon,
  TrashIcon,
  TriangleAlertIcon,
  UnplugIcon,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";

import {
  addSavedEnvironment,
  disconnectSavedEnvironment,
  reconnectSavedEnvironment,
  removeSavedEnvironment,
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";
import { resolveServerConfigVersionMismatch } from "~/versionSkew";
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
import { Group } from "../ui/group";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const ITEM_ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";

function safeSavedEnvironmentHost(httpBaseUrl: string): string {
  try {
    return new URL(httpBaseUrl).host || "Invalid server address";
  } catch {
    return "Invalid server address";
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
}: {
  record: SavedEnvironmentRecord;
  runtime: SavedEnvironmentRuntimeState | undefined;
}) {
  const [pendingAction, setPendingAction] = useState<"reconnect" | "disconnect" | "remove" | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [isRemoveDialogOpen, setIsRemoveDialogOpen] = useState(false);

  const isConnecting = runtime?.connectionState === "connecting";
  const isConnected = runtime?.connectionState === "connected";
  const isError = runtime?.connectionState === "error";
  const requiresAuth = runtime?.authState === "requires-auth";
  const versionMismatch = resolveServerConfigVersionMismatch(runtime?.serverConfig);
  const actionsDisabled = isConnecting || pendingAction !== null;
  const displayLabel = record.label.trim() || "Unnamed environment";

  let statusText = "Disconnected";
  let dotColor = "bg-muted-foreground";
  if (requiresAuth) {
    statusText = "Pairing required";
    dotColor = "bg-destructive";
  } else if (isConnecting) {
    statusText = "Connecting";
    dotColor = "bg-warning";
  } else if (isConnected) {
    statusText = "Connected";
    dotColor = "bg-success";
  } else if (isError) {
    statusText = "Connection failed";
    dotColor = "bg-destructive";
  }

  const runAction = async (action: "reconnect" | "disconnect" | "remove") => {
    if (actionsDisabled) return;

    setPendingAction(action);
    setActionError(null);
    try {
      if (action === "reconnect") {
        await reconnectSavedEnvironment(record.environmentId);
      } else if (action === "disconnect") {
        await disconnectSavedEnvironment(record.environmentId);
      } else {
        await removeSavedEnvironment(record.environmentId);
        setIsRemoveDialogOpen(false);
      }
    } catch {
      setActionError(
        action === "remove"
          ? "Could not remove this saved environment. Try again."
          : "Could not update this connection. Check that the server is reachable and try again.",
      );
    } finally {
      setPendingAction(null);
    }
  };

  const runtimeError = requiresAuth
    ? "The saved credential is missing or expired. Pair this server again."
    : isError
      ? "The server could not be reached or rejected the saved session."
      : null;

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/50 bg-muted/50 text-muted-foreground">
            <ServerIcon className="size-4" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 break-words font-medium leading-tight">{displayLabel}</span>
              <SavedEnvironmentStatus
                label={statusText}
                dotClassName={dotColor}
                connecting={isConnecting}
              />
            </div>
            <span className="break-all text-sm text-muted-foreground">
              {safeSavedEnvironmentHost(record.httpBaseUrl)}
            </span>
            {versionMismatch ? (
              <span className="flex items-start gap-1.5 text-xs text-warning-foreground">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                <span className="break-all">
                  Client {versionMismatch.clientVersion}, server {versionMismatch.serverVersion}
                </span>
              </span>
            ) : null}
            {runtimeError ? <span className="text-sm text-destructive">{runtimeError}</span> : null}
            {actionError ? <span className="text-sm text-destructive">{actionError}</span> : null}
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
                    isConnected ? `Disconnect ${displayLabel}` : `Reconnect ${displayLabel}`
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
            <TooltipPopup>{isConnected ? "Disconnect" : "Reconnect"}</TooltipPopup>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={actionsDisabled}
                  aria-label={`Remove ${displayLabel}`}
                  onClick={() => {
                    setActionError(null);
                    setIsRemoveDialogOpen(true);
                  }}
                />
              }
            >
              <TrashIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup>Remove saved environment</TooltipPopup>
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
            <AlertDialogTitle>Remove saved environment?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes {displayLabel} and its saved credential from this client.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button variant="outline" disabled={pendingAction !== null} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={pendingAction !== null}
              onClick={() => void runAction("remove")}
            >
              {pendingAction === "remove" ? <Spinner className="size-4" /> : null}
              {pendingAction === "remove" ? "Removing" : "Remove"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

function AddSavedEnvironmentDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const [tab, setTab] = useState<"url" | "code">("url");
  const [label, setLabel] = useState("");
  const [pairingUrl, setPairingUrl] = useState("");
  const [host, setHost] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setTab("url");
    setLabel("");
    setPairingUrl("");
    setHost("");
    setPairingCode("");
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
    const submittedTab = tab;

    setPairingUrl("");
    setPairingCode("");
    try {
      if (submittedTab === "url") {
        await addSavedEnvironment({ label: submittedLabel, pairingUrl: submittedUrl });
      } else {
        await addSavedEnvironment({
          label: submittedLabel,
          host: submittedHost,
          pairingCode: submittedCode,
        });
      }
      resetForm();
      setIsOpen(false);
    } catch {
      setError(
        "Could not add this environment. Check the server address and pairing credential, then try again.",
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
              aria-label="Add environment"
              onClick={() => setIsOpen(true)}
            />
          }
        >
          <PlusIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup>Add environment</TooltipPopup>
      </Tooltip>
      <DialogPopup showCloseButton={!isSubmitting}>
        <DialogHeader>
          <DialogTitle>Add saved environment</DialogTitle>
          <DialogDescription>Remote Cafe Code server</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <DialogPanel className="flex flex-col gap-4">
            <Group className="w-full" aria-label="Pairing method">
              <Button
                type="button"
                variant={tab === "url" ? "secondary" : "outline"}
                className="flex-1"
                aria-pressed={tab === "url"}
                onClick={() => {
                  setTab("url");
                  setError(null);
                }}
                disabled={isSubmitting}
              >
                Pairing URL
              </Button>
              <Button
                type="button"
                variant={tab === "code" ? "secondary" : "outline"}
                className="flex-1"
                aria-pressed={tab === "code"}
                onClick={() => {
                  setTab("code");
                  setError(null);
                }}
                disabled={isSubmitting}
              >
                Host + Code
              </Button>
            </Group>

            <div className="flex flex-col gap-2">
              <label htmlFor="env-label" className="text-sm font-medium">
                Label (optional)
              </label>
              <Input
                id="env-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Production server"
                disabled={isSubmitting}
              />
            </div>

            {tab === "url" ? (
              <div className="flex flex-col gap-2">
                <label htmlFor="env-url" className="text-sm font-medium">
                  Pairing URL
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
                    Host
                  </label>
                  <Input
                    id="env-host"
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                    placeholder="server.example:3000"
                    required
                    disabled={isSubmitting}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label htmlFor="env-code" className="text-sm font-medium">
                    Pairing code
                  </label>
                  <Input
                    id="env-code"
                    value={pairingCode}
                    onChange={(event) => setPairingCode(event.target.value)}
                    placeholder="Pairing code"
                    required
                    disabled={isSubmitting}
                    autoComplete="off"
                  />
                </div>
              </>
            )}

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </DialogPanel>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Spinner className="mr-2 size-4" />
                  Adding
                </>
              ) : (
                "Add environment"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

export function SavedEnvironmentsSettings() {
  const registryById = useSavedEnvironmentRegistryStore((state) => state.byId);
  const runtimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const records = useMemo(
    () => Object.values(registryById).sort((left, right) => left.label.localeCompare(right.label)),
    [registryById],
  );

  return (
    <SettingsSection title="Saved environments" headerAction={<AddSavedEnvironmentDialog />}>
      {records.length === 0 ? (
        <SettingsRow title="No remote servers paired" description={null} />
      ) : (
        records.map((record) => (
          <SavedEnvironmentRow
            key={record.environmentId}
            record={record}
            runtime={runtimeById[record.environmentId]}
          />
        ))
      )}
    </SettingsSection>
  );
}
