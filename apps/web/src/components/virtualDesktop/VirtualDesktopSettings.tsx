import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerSettingsPatch } from "@cafecode/contracts";
import { useWorkspaceEnvironmentId } from "~/environments/workspace";
import { requireEnvironmentConnection } from "~/environments/runtime";
import { applySettingsUpdated, useServerSettings } from "~/rpc/serverState";
import { patchWorkspaceServerConfig } from "~/environments/workspaceApi";
import { readPrimaryEnvironmentDescriptor } from "~/environments/primary";
import { useDelayedFlag } from "~/hooks/useDelayedFlag";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Switch } from "../ui/switch";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { InfoTip } from "../ui/info-tip";
import { Skeleton } from "../ui/skeleton";
import { VirtualDesktopManager } from "./VirtualDesktops";
import { useVirtualDesktops } from "./useVirtualDesktops";
import { DesktopSetup } from "./DesktopSetup";
import {
  DesktopResolutionFields,
  draftResolution,
  readResolutionDraft,
  type ResolutionDraft,
} from "./DesktopResolutionFields";

export function VirtualDesktopSettings() {
  const environmentId = useWorkspaceEnvironmentId();
  const status = useVirtualDesktops(environmentId);
  const settings = useServerSettings();
  const cache = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [retentionDraft, setRetentionDraft] = useState<string | null>(null);
  const [resolutionDraft, setResolutionDraft] = useState<ResolutionDraft | null>(null);
  const displayDraft = resolutionDraft ?? draftResolution(settings.desktopDefaultResolution);
  const defaultResolution = readResolutionDraft(displayDraft);
  const retentionText = retentionDraft ?? String(settings.desktopObservationRetention);
  const retentionCount = Number(retentionText);
  const validRetention =
    /^\d+$/.test(retentionText) && Number.isSafeInteger(retentionCount) && retentionCount >= 0;
  // Slow first loads get a page-shaped skeleton; fast ones render nothing until
  // support is known, so unsupported hosts never flash this page.
  const showInitialLoading = useDelayedFlag(environmentId !== null && status.isPending);
  if (showInitialLoading) return <DesktopControlSkeleton />;
  if (!status.data?.supported) return null;
  const runningCount = status.data.desktops.filter((d) => d.state === "ready").length;
  const inUseCount = status.data.desktops.filter((d) => d.controllingThreadId !== null).length;
  const title = "Enable desktop control";
  async function save(patch: ServerSettingsPatch) {
    if (!environmentId || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const next =
        await requireEnvironmentConnection(environmentId).client.server.updateSettings(patch);
      if (environmentId === readPrimaryEnvironmentDescriptor()?.environmentId)
        applySettingsUpdated(next);
      else patchWorkspaceServerConfig(environmentId, { settings: next });
      await cache.invalidateQueries({ queryKey: ["virtual-desktops", environmentId] });
      if (patch.desktopObservationRetention !== undefined) setRetentionDraft(null);
      if (patch.desktopDefaultResolution !== undefined) setResolutionDraft(null);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsPageContainer title="Desktop control">
      <SettingsSection>
        <SettingsRow
          title={title}
          description="Let Codex use apps in a desktop you attach to a chat."
          status={
            <>
              {status.data.available ? null : (
                <span className="block text-warning-foreground">Finish desktop setup below.</span>
              )}
              {/* Required disclosure (AGENTS.md): the private display is not a
                  security sandbox and desktop tools add no approval prompts. */}
              <span className="block">
                Not a sandbox: agents use your real files and apps, with no approval prompts.{" "}
                <InfoTip label="About desktop control security">
                  Each desktop is a private display, not a security sandbox. Apps use your real home
                  folder, profiles and network, and agents act with your full desktop permissions,
                  including running any command. Turning this off disconnects agents right away;
                  apps keep running until you end their desktop.
                </InfoTip>
              </span>
            </>
          }
          control={
            <Switch
              aria-label={title}
              checked={settings.virtualDesktopsEnabled && settings.desktopControlMcpEnabled}
              disabled={busy}
              // Keep legacy flags atomic: viewing partial state never grants access.
              onCheckedChange={(enabled) =>
                void save({ virtualDesktopsEnabled: enabled, desktopControlMcpEnabled: enabled })
              }
            />
          }
        />
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              Saved screenshots
              <InfoTip label="About saved screenshots">
                Recent agent screenshots you can expand in a chat. Default 50; lowering the limit
                deletes the oldest.
              </InfoTip>
            </span>
          }
          description="Kept per environment. 0 deletes saved screenshots and stops saving."
          control={
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (validRetention) void save({ desktopObservationRetention: retentionCount });
              }}
            >
              <Input
                type="number"
                min={0}
                step={1}
                max={Number.MAX_SAFE_INTEGER}
                aria-label="Saved screenshots"
                aria-invalid={!validRetention}
                className="w-28"
                value={retentionText}
                disabled={busy}
                onChange={(event) => setRetentionDraft(event.target.value)}
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={
                  busy || !validRetention || retentionCount === settings.desktopObservationRetention
                }
              >
                Save
              </Button>
            </form>
          }
        />
        {/* Stays available while the feature is off so running desktops can
            still be ended. */}
        <SettingsRow
          title="Desktops"
          description={
            <span className="tabular-nums">
              {runningCount} running · {inUseCount} in use
            </span>
          }
          control={
            <Button size="sm" variant="outline" onClick={() => setManagerOpen(true)}>
              Manage desktops
            </Button>
          }
        />
        {failed && (
          <p
            role="alert"
            className="border-t border-border-subtle px-4 py-3 text-xs text-destructive sm:px-5"
          >
            Could not save desktop settings. Reconnect with owner access and try again.
          </p>
        )}
      </SettingsSection>
      <VirtualDesktopManager
        environmentId={environmentId}
        open={managerOpen}
        onOpenChange={setManagerOpen}
      />
      <SettingsSection title="Defaults for new desktops">
        <form
          className="space-y-4 px-4 py-4 sm:px-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (defaultResolution) void save({ desktopDefaultResolution: defaultResolution });
          }}
        >
          <DesktopResolutionFields
            value={displayDraft}
            onChange={setResolutionDraft}
            disabled={busy}
          />
          <p className="text-xs text-muted-foreground">
            Changes to a running desktop last only for that session.
          </p>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={
              busy ||
              !defaultResolution ||
              (defaultResolution.width === settings.desktopDefaultResolution.width &&
                defaultResolution.height === settings.desktopDefaultResolution.height)
            }
          >
            Save default resolution
          </Button>
        </form>
      </SettingsSection>
      <SettingsSection title="Desktop setup">
        <div className="px-4 py-4 sm:px-5">
          <DesktopSetup
            prerequisites={status.data.prerequisites}
            available={status.data.available}
            reason={status.data.reason}
            busy={status.busy}
            onRecheck={() => void status.change({ operation: "recheck" })}
          />
          {status.error && (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {status.error}
            </p>
          )}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/** Matches the first section's three rows so the page doesn't jump on load. */
function DesktopControlSkeleton() {
  return (
    <SettingsPageContainer title="Desktop control">
      <SettingsSection aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <div
            key={row}
            className="flex items-center justify-between gap-3 border-t border-border-subtle px-4 py-3.5 first:border-t-0 sm:px-5"
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-full max-w-72" />
            </div>
            <Skeleton className="h-8 w-24 rounded-lg sm:h-7" />
          </div>
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
