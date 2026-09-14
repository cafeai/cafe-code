import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MonitorIcon } from "lucide-react";
import type { ServerSettingsPatch } from "@cafecode/contracts";
import { usePrimaryEnvironmentId } from "~/environments/primary";
import { requireEnvironmentConnection } from "~/environments/runtime";
import { applySettingsUpdated, useServerSettings } from "~/rpc/serverState";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Switch } from "../ui/switch";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
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
  const environmentId = usePrimaryEnvironmentId();
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
  if (!status.data?.supported) return null;
  const title = "Enable desktop control";
  async function save(patch: ServerSettingsPatch) {
    if (!environmentId || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const next =
        await requireEnvironmentConnection(environmentId).client.server.updateSettings(patch);
      applySettingsUpdated(next);
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
    <SettingsPageContainer>
      <div className="space-y-2">
        <h1 className="text-lg font-semibold tracking-tight">Desktop control</h1>
        <p className="text-sm text-muted-foreground">
          Let Codex use apps in a virtual desktop on Linux.
        </p>
      </div>
      <SettingsSection title="Desktop control" icon={<MonitorIcon className="size-3.5" />}>
        <SettingsRow
          title={title}
          description="Let Codex open and control apps in the desktop you attach to a conversation."
          status={
            status.data.reason ??
            (status.data.available
              ? "Supported by Codex on Linux"
              : "Desktop setup needs attention")
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
          title="Saved screenshots"
          description="Keep recent agent screenshots so you can expand them in the conversation. This limit applies across this environment."
          status="Default: 50. Lowering the limit removes older screenshots; 0 clears them and stops saving."
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
        <div className="space-y-3 border-t border-border/60 px-5 py-3">
          {failed && (
            <p role="alert" className="text-xs text-destructive">
              Could not save desktop settings. Reconnect with owner access and try again.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Desktops use your real files and app profiles. Cafe adds no approval prompts. Turning
            this off disconnects desktop access; apps keep running until you end their desktop.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {status.data.desktops.filter((d) => d.state === "ready").length} running ·{" "}
              {status.data.desktops.filter((d) => d.controllingThreadId !== null).length}{" "}
              conversations using desktops
            </p>
            <Button size="sm" variant="outline" onClick={() => setManagerOpen(true)}>
              Manage desktops
            </Button>
          </div>
          <VirtualDesktopManager
            environmentId={environmentId}
            open={managerOpen}
            onOpenChange={setManagerOpen}
          />
        </div>
      </SettingsSection>
      <SettingsSection title="Defaults for new desktops">
        <form
          className="space-y-4 px-5 py-4"
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
            New desktops start with this resolution. Changes made by you or an agent to a running
            desktop last for that session.
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
        <div className="px-5 py-4">
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
