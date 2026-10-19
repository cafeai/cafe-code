import { useEffect, useId, useState } from "react";
import {
  CircleCheckIcon,
  CircleIcon,
  CopyIcon,
  ExternalLinkIcon,
  FolderSearchIcon,
} from "lucide-react";
import type { GlideControlResult } from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { copyTextToClipboard } from "~/lib/copyToClipboard";
import { cn } from "~/lib/utils";
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
import {
  glideAccessibilityPaneKind,
  glidePermissionRequirements,
  glidePermissionsGranted,
  GLIDE_SETUP_ERROR,
  glideScreenRecordingPaneKind,
  type GlidePermissionRequirement,
  type GlideSetupError,
} from "./glideSetup";

/**
 * First-use setup for Computer use. Each row reflects the latest native TCC
 * status only; the owner component keeps polling while this dialog is open.
 * Enabling remains an explicit action for the exact chat that opened it.
 */
type GlideSetupProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: GlideControlResult | undefined;
  enabled: boolean;
  enabling: boolean;
  error: GlideSetupError | undefined;
  pollingStopped: boolean;
  canReveal: boolean;
  onOpenSettings: (action: GlidePermissionRequirement["settingsAction"]) => void;
  onReveal: () => void;
  onCheckAgain: () => void;
  onEnable: () => void;
};

export function GlideSetupDialog(props: GlideSetupProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md" data-testid="glide-setup-dialog">
        {/* Content mounts with the popup, so copy feedback resets on close. */}
        <GlideSetupContent {...props} />
      </DialogPopup>
    </Dialog>
  );
}

function GlideSetupContent(props: GlideSetupProps) {
  const locale = useUiLocale();
  const status = props.status;
  const ready = glidePermissionsGranted(status);
  const requirements = status ? glidePermissionRequirements(status) : [];
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const requirementLabel = (id: GlidePermissionRequirement["id"]) =>
    id === "accessibility"
      ? glideAccessibilityPaneKind(status?.osMajorVersion) === "device-control"
        ? uiText("Device Control and Data Access", undefined, undefined, locale)
        : uiText("Accessibility", undefined, undefined, locale)
      : glideScreenRecordingPaneKind(status?.osMajorVersion) === "screen-and-audio"
        ? uiText("Screen & System Audio Recording", undefined, undefined, locale)
        : uiText("Screen Recording", undefined, undefined, locale);
  const requirementSettingsLabel = (id: GlidePermissionRequirement["id"]) =>
    id === "accessibility"
      ? glideAccessibilityPaneKind(status?.osMajorVersion) === "device-control"
        ? uiText("Open Device Control and Data Access settings", undefined, undefined, locale)
        : uiText("Open Accessibility settings", undefined, undefined, locale)
      : glideScreenRecordingPaneKind(status?.osMajorVersion) === "screen-and-audio"
        ? uiText("Open Screen & System Audio Recording settings", undefined, undefined, locale)
        : uiText("Open Screen Recording settings", undefined, undefined, locale);
  const requirementHint = (id: GlidePermissionRequirement["id"]) =>
    id === "accessibility"
      ? uiText("Lets Cafe Code read and operate app controls.", undefined, undefined, locale)
      : uiText("Lets Cafe Code take screenshots of app windows.", undefined, undefined, locale);
  const host = status?.hostApp;
  const appHeadingId = useId();

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {ready
            ? uiText("Computer use is ready", undefined, undefined, locale)
            : uiText("Set up computer use", undefined, undefined, locale)}
        </DialogTitle>
        <DialogDescription>
          {ready
            ? uiText("All required macOS permissions are on.", undefined, undefined, locale)
            : uiText(
                "Turn on these permissions for Cafe Code in System Settings.",
                undefined,
                undefined,
                locale,
              )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-4">
        <ul
          className="grid gap-2"
          aria-label={uiText("Required permissions", undefined, undefined, locale)}
        >
          {requirements.map((requirement) => (
            <li
              key={requirement.id}
              data-permission={requirement.id}
              data-state={requirement.granted ? "granted" : "missing"}
              className={cn(
                "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors duration-(--duration-base)",
                requirement.granted && "border-success/32 bg-success/4",
              )}
            >
              {requirement.granted ? (
                <CircleCheckIcon aria-hidden="true" className="size-4.5 shrink-0 text-success" />
              ) : (
                <CircleIcon
                  aria-hidden="true"
                  className="size-4.5 shrink-0 text-muted-foreground"
                />
              )}
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className="text-sm font-medium">{requirementLabel(requirement.id)}</span>
                <span className="text-xs text-muted-foreground">
                  {requirement.granted
                    ? uiText("Allowed", undefined, undefined, locale)
                    : requirementHint(requirement.id)}
                </span>
              </div>
              {requirement.granted ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  aria-label={requirementSettingsLabel(requirement.id)}
                  onClick={() => props.onOpenSettings(requirement.settingsAction)}
                >
                  {uiText("Open Settings", undefined, undefined, locale)}
                  <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
        {/* Announce native transitions without moving focus. */}
        <p className="sr-only" role="status" aria-live="polite">
          {status
            ? requirements
                .map(
                  (requirement) =>
                    `${requirementLabel(requirement.id)}: ${
                      requirement.granted
                        ? uiText("Allowed", undefined, undefined, locale)
                        : uiText("Not allowed yet", undefined, undefined, locale)
                    }`,
                )
                .join(". ")
            : uiText("Checking permissions…", undefined, undefined, locale)}
        </p>
        {!status ? (
          <p className="text-sm text-muted-foreground">
            {uiText("Checking permissions…", undefined, undefined, locale)}
          </p>
        ) : null}
        {ready ? null : (
          <section className="grid gap-2" aria-labelledby={appHeadingId}>
            <h3 id={appHeadingId} className="text-sm font-medium">
              {uiText("App to allow", undefined, undefined, locale)}
            </h3>
            {host ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {uiText(
                    "If {app} isn’t in the list, click + in that Settings pane and choose this app.",
                    { app: host.name },
                    undefined,
                    locale,
                  )}
                </p>
                <div className="grid gap-2 rounded-lg bg-muted/50 px-3 py-2">
                  <code
                    className="select-text break-all font-mono text-xs"
                    data-testid="glide-host-app-path"
                  >
                    {host.path}
                  </code>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        setCopyFailed(false);
                        copyTextToClipboard(host.path).then(
                          () => setCopied(true),
                          () => setCopyFailed(true),
                        );
                      }}
                    >
                      <CopyIcon aria-hidden="true" className="size-3" />
                      {copied
                        ? uiText("Copied", undefined, undefined, locale)
                        : uiText("Copy path", undefined, undefined, locale)}
                    </Button>
                    {props.canReveal ? (
                      <Button type="button" size="xs" variant="outline" onClick={props.onReveal}>
                        <FolderSearchIcon aria-hidden="true" className="size-3" />
                        {uiText("Show in Finder", undefined, undefined, locale)}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </>
            ) : status ? (
              <p className="text-xs text-muted-foreground">
                {uiText(
                  "The app couldn’t be identified. Allow the app you used to open Cafe Code.",
                  undefined,
                  undefined,
                  locale,
                )}
              </p>
            ) : null}
          </section>
        )}
        {props.error || copyFailed ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {copyFailed
              ? uiText("Couldn’t copy the path.", undefined, undefined, locale)
              : props.error === GLIDE_SETUP_ERROR.settings
                ? uiText("Couldn’t open System Settings.", undefined, undefined, locale)
                : props.error === GLIDE_SETUP_ERROR.reveal
                  ? uiText("Couldn’t show the app in Finder.", undefined, undefined, locale)
                  : uiText(
                      "Couldn’t turn on computer use. Try again.",
                      undefined,
                      undefined,
                      locale,
                    )}
          </p>
        ) : null}
        {!ready && props.pollingStopped ? (
          <p className="text-xs text-muted-foreground">
            {uiText("Stopped checking automatically.", undefined, undefined, locale)}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        {ready ? (
          props.enabled ? (
            <Button type="button" onClick={() => props.onOpenChange(false)}>
              {uiText("Done", undefined, undefined, locale)}
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
                {uiText("Not now", undefined, undefined, locale)}
              </Button>
              <Button type="button" disabled={props.enabling} onClick={props.onEnable}>
                {uiText("Turn on for this chat", undefined, undefined, locale)}
              </Button>
            </>
          )
        ) : (
          <>
            {props.pollingStopped ? (
              <Button type="button" variant="outline" onClick={props.onCheckAgain}>
                {uiText("Check again", undefined, undefined, locale)}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
              {uiText("Close", undefined, undefined, locale)}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}
