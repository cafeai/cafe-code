"use client";

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
import { readProviderConfigBoolean } from "./ProviderSettingsForm";

interface GrokSandboxSettingsProps {
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
  instance,
  displayName,
  sandbox,
  onUpdate,
}: GrokSandboxSettingsProps) {
  const [confirmation, setConfirmation] = useState<"unprotected" | "protected" | null>(null);
  const allowUnsandboxedProbe = readProviderConfigBoolean(instance.config, "allowUnsandboxedProbe");

  // Guard the actual write surface as well as its caller. A foreign provider
  // must never gain this Grok-specific permission merely by carrying a config
  // field with the same name or a generic sandbox diagnostic.
  if (instance.driver !== "grok") return null;

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

  const sandboxDetail =
    sandbox?.status === "unavailable"
      ? sandbox.reason === "container-socket-symlink"
        ? "Grok's sandbox cannot start with a symlinked container-runtime socket."
        : "Grok's sandbox could not start on this machine."
      : sandbox?.status === "available"
        ? "The last protected connection check verified sandbox startup."
        : "Sandbox availability has not been checked.";

  return (
    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-foreground">
            {allowUnsandboxedProbe
              ? "Unsandboxed connection checks enabled"
              : "Protected connection checks"}
          </p>
          <p className="text-xs text-muted-foreground">{sandboxDetail}</p>
          {allowUnsandboxedProbe ? (
            <p className="text-xs text-muted-foreground">
              Checks run outside the OS sandbox. To chat without a sandbox, select Full access; this
              also bypasses ordinary approval prompts. Plan and protected modes may still fail.
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0"
          onClick={() => setConfirmation(allowUnsandboxedProbe ? "protected" : "unprotected")}
        >
          {allowUnsandboxedProbe ? "Use protected checks" : "Use without sandbox"}
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
                ? "Restore protected connection checks?"
                : "Use Grok without sandbox?"}
            </DialogTitle>
            <DialogDescription>
              {confirmation === "protected"
                ? `${displayName} will require sandboxed connection checks again.`
                : `${displayName} will run connection checks outside the operating system sandbox. These checks use Ask permissions and do not submit a chat prompt.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3 text-sm text-muted-foreground">
            {confirmation === "protected" ? (
              <p>
                If Grok cannot start its sandbox on this machine, the provider will fail its
                connection checks again. Existing chat access modes stay unchanged.
              </p>
            ) : (
              <>
                <p>
                  To chat without a sandbox, select Full access in the composer. Full access also
                  bypasses ordinary approval prompts.
                </p>
                <p>
                  Plan and protected modes keep their existing sandbox requirements and may still
                  fail on this machine. This setting does not change any chat&apos;s access mode.
                </p>
              </>
            )}
            <p>
              Saving this setting reloads this provider instance and may interrupt active sessions.
              Change it between sessions.
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmation(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={confirmChange}>
              {confirmation === "protected" ? "Use protected checks" : "Use without sandbox"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
