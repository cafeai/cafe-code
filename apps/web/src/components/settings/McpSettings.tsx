import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlugIcon, RefreshCwIcon } from "lucide-react";
import { useWorkspaceEnvironmentId } from "~/environments/workspace";
import { requireEnvironmentConnection } from "~/environments/runtime";
import { applySettingsUpdated, useServerSettings } from "~/rpc/serverState";
import { patchWorkspaceServerConfig } from "~/environments/workspaceApi";
import { readPrimaryEnvironmentDescriptor } from "~/environments/primary";
import { useDelayedFlag } from "~/hooks/useDelayedFlag";
import { Button } from "../ui/button";
import { InfoTip } from "../ui/info-tip";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function McpSettings() {
  const uiLocale = useUiLocale();
  const environmentId = useWorkspaceEnvironmentId();
  const queryClient = useQueryClient();
  const settings = useServerSettings();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const queryKey = ["cafe-mcp", environmentId] as const;
  const status = useQuery({
    queryKey,
    queryFn: () => {
      if (!environmentId) throw new Error("No Cafe environment.");
      return requireEnvironmentConnection(environmentId).client.server.getMcpStatus();
    },
    enabled: environmentId !== null,
    retry: false,
  });
  const showLoading = useDelayedFlag(status.isPending);
  const updateEnabled = async (enabled: boolean) => {
    if (!environmentId || pending || !status.data?.canManage) return;
    setPending(true);
    setFailed(false);
    try {
      const next = await requireEnvironmentConnection(environmentId).client.server.updateSettings({
        mcpEnabled: enabled,
      });
      if (environmentId === readPrimaryEnvironmentDescriptor()?.environmentId)
        applySettingsUpdated(next);
      else patchWorkspaceServerConfig(environmentId, { settings: next });
      await queryClient.invalidateQueries({ queryKey });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingsPageContainer title={uiText("Cafe tools", undefined, undefined, uiLocale)}>
      <SettingsSection
        icon={<PlugIcon />}
        title={uiText("Cafe management", undefined, undefined, uiLocale)}
        headerAction={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={uiText("Refresh Cafe tools status", undefined, undefined, uiLocale)}
            disabled={status.isFetching || pending}
            onClick={() => void status.refetch()}
          >
            <RefreshCwIcon />
          </Button>
        }
      >
        {status.isPending ? (
          showLoading ? (
            <div className="p-5">
              <Skeleton className="h-8 w-full" />
            </div>
          ) : null
        ) : (
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-1.5">
                {uiText("Enable Cafe management tools", undefined, undefined, uiLocale)}
                <InfoTip
                  label={uiText("About Cafe management tools", undefined, undefined, uiLocale)}
                >
                  {uiText(
                    "These tools have owner access to Cafe. Turning them off blocks new requests; it doesn't undo work already started. Chat scheduling stays available separately and still requires approval in Tasks.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
                </InfoTip>
              </span>
            }
            description={uiText(
              "Let agents manage projects, chats, providers and settings.",
              undefined,
              undefined,
              uiLocale,
            )}
            status={
              failed ? (
                <span role="alert" className="text-destructive-foreground">
                  {uiText(
                    "Could not change Cafe management access. Refresh and try again.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
                </span>
              ) : status.isError ? (
                <span role="alert" className="text-destructive-foreground">
                  {uiText(
                    "Could not load Cafe tools status. Refresh to try again.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
                </span>
              ) : !status.data?.canManage ? (
                uiText(
                  "Only an owner connection can change this setting.",
                  undefined,
                  undefined,
                  uiLocale,
                )
              ) : undefined
            }
            control={
              <Switch
                checked={status.data?.enabled ?? settings?.mcpEnabled ?? false}
                disabled={pending || !status.data?.canManage || status.isError}
                onCheckedChange={(checked) => void updateEnabled(Boolean(checked))}
                aria-label={uiText("Enable Cafe management tools", undefined, undefined, uiLocale)}
              />
            }
          />
        )}
      </SettingsSection>
      <p className="text-xs text-muted-foreground">
        {uiText(
          "Cafe connects these tools automatically when it starts Codex, Claude, Grok or a local OpenCode chat. Agent configuration files stay unchanged. Axiom and external OpenCode servers do not support this connection.",
          undefined,
          undefined,
          uiLocale,
        )}
      </p>
    </SettingsPageContainer>
  );
}
