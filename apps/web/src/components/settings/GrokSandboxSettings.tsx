import { useUiLocale } from "~/i18n";
("use client");

import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import { useState } from "react";
import type { ProviderInstanceConfig, ServerProvider } from "@cafecode/contracts";

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
import { InfoTip } from "../ui/info-tip";
import { readProviderConfigBoolean } from "./ProviderSettingsForm";

interface GrokSandboxSettingsProps {
  /**
   * The card shows this row only when it needs attention (sandbox unavailable
   * or unsandboxed checks enabled); otherwise it lives in the instance
   * dialog's Advanced section. Exactly one placement renders at a time.
   */
  readonly placement: "card" | "dialog";
  readonly instance: ProviderInstanceConfig;
  readonly displayName: string;
  readonly sandbox: ServerProvider["sandbox"];
  readonly onUpdate: (nextInstance: ProviderInstanceConfig) => void;
}

/**
 * Explicit consent for Grok's connection checks only. Keep this out of the
 * schema-generated settings form: a plain switch cannot explain that the
 * connection check and the chat's access mode are separate permissions.
 *
 * Writes use the card's existing instance-settings callback, so the normal
 * owner-authorized server settings boundary remains responsible for admission.
 * No chat command, runtime mode, default model, or approval policy is changed.
 */
export function GrokSandboxSettings({
  placement,
  instance,
  displayName,
  sandbox,
  onUpdate,
}: GrokSandboxSettingsProps) {
  const uiLocale = useUiLocale();

  const [confirmation, setConfirmation] = useState<"unprotected" | "protected" | null>(null);
  const allowUnsandboxedProbe = readProviderConfigBoolean(instance.config, "allowUnsandboxedProbe");
  const needsAttention = sandbox?.status === "unavailable" || allowUnsandboxedProbe;

  // Guard the actual write surface as well as its caller. A foreign provider
  // must never gain this Grok-specific permission merely by carrying a config
  // field with the same name or a generic sandbox diagnostic.
  if (instance.driver !== "grok") return null;
  if ((placement === "card") !== needsAttention) return null;

  const confirmChange = () => {
    if (confirmation === null) return;
    const config = {
      ...(instance.config !== null && typeof instance.config === "object"
        ? (instance.config as Record<string, unknown>)
        : {}),
      // Persist false explicitly on revocation so the settings merge cannot
      // retain a previously enabled value. Only literal true grants consent.
      allowUnsandboxedProbe: confirmation === "unprotected",
    };
    onUpdate({ ...instance, config });
    setConfirmation(null);
  };

  const sandboxDetail = allowUnsandboxedProbe
    ? uiText(
        "Checks run outside the OS sandbox, so sandbox support isn''t checked.",
        undefined,
        undefined,
        uiLocale,
      )
    : sandbox?.status === "unavailable"
      ? sandbox.reason === "container-socket-symlink"
        ? uiText(
            "Grok''s sandbox cannot start with a symlinked container-runtime socket.",
            undefined,
            undefined,
            uiLocale,
          )
        : uiText("Grok''s sandbox could not start on this machine.", undefined, undefined, uiLocale)
      : sandbox?.status === "available"
        ? uiText("The last check verified that the sandbox starts.", undefined, undefined, uiLocale)
        : uiText("Sandbox support hasn''t been checked yet.", undefined, undefined, uiLocale);

  return (
    <div
      className={
        placement === "card" ? "border-t border-border-subtle px-4 py-3 sm:px-5" : undefined
      }
    >
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="grid min-w-0 gap-0.5">
          <p className="text-xs font-medium text-foreground">
            {allowUnsandboxedProbe
              ? uiText("Unsandboxed connection checks enabled", undefined, undefined, uiLocale)
              : uiText("Protected connection checks", undefined, undefined, uiLocale)}
          </p>
          <div className="flex min-w-0 items-center gap-1">
            <p className="text-xs text-muted-foreground">{sandboxDetail}</p>
            {allowUnsandboxedProbe ? (
              <InfoTip label={uiText("About unsandboxed checks", undefined, undefined, uiLocale)}>
                {uiText(
                  "To chat without a sandbox, select Full access; it also bypasses approval prompts. Plan and protected modes may still fail.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
              </InfoTip>
            ) : null}
          </div>
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0"
          onClick={() => setConfirmation(allowUnsandboxedProbe ? "protected" : "unprotected")}
        >
          {allowUnsandboxedProbe
            ? uiText("Use protected checks", undefined, undefined, uiLocale)
            : uiText("Use without sandbox", undefined, undefined, uiLocale)}
        </Button>
      </div>

      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {confirmation === "protected"
                ? uiText("Restore protected connection checks?", undefined, undefined, uiLocale)
                : uiText("Use Grok without sandbox?", undefined, undefined, uiLocale)}
            </DialogTitle>
            <DialogDescription>
              {/* The missing OS boundary must be disclosed here, and approval
                  prompts must not be presented as a substitute for it
                  (docs/decisions/grok-explicit-full-access-qualification.md). */}
              {confirmation === "protected"
                ? uiText(
                    "{value0} will require sandboxed connection checks again. Chat access modes don''t change.",
                    { value0: displayName },
                    undefined,
                    uiLocale,
                  )
                : uiText(
                    "{value0} will run connection checks outside the OS sandbox. They use Ask permissions, which don''t replace a sandbox, and send no chat prompt.",
                    { value0: displayName },
                    undefined,
                    uiLocale,
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-2 text-sm text-muted-foreground">
            <p>
              {confirmation === "protected"
                ? uiText(
                    "If the sandbox can''t start on this machine, connection checks will fail again.",
                    undefined,
                    undefined,
                    uiLocale,
                  )
                : uiText(
                    "Chat access modes don''t change. To chat without a sandbox, select Full access; it also bypasses approval prompts. Plan and protected modes may still fail.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
            </p>
            <p>
              <UiMessage
                message={
                  "Saving reloads <slot1></slot1> and may interrupt active chats. Change it between sessions."
                }
                slots={{ slot1: displayName }}
              />
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmation(null)}>
              {uiText("Cancel", undefined, undefined, uiLocale)}
            </Button>
            <Button type="button" onClick={confirmChange}>
              {confirmation === "protected"
                ? uiText("Use protected checks", undefined, undefined, uiLocale)
                : uiText("Use without sandbox", undefined, undefined, uiLocale)}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
