import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, PlugIcon, RefreshCwIcon } from "lucide-react";
import type { CafeMcpClientUpdate } from "@cafecode/contracts";

import { usePrimaryEnvironmentId } from "~/environments/primary";
import { getEnvironmentHttpBaseUrl, requireEnvironmentConnection } from "~/environments/runtime";
import { applySettingsUpdated, useServerSettings } from "~/rpc/serverState";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function isLocalMcpEnvironment(backendUrl: string | null | undefined): boolean {
  const bootstrap = window.desktopBridge?.getLocalEnvironmentBootstrap();
  if (!bootstrap?.httpBaseUrl || !backendUrl) return false;
  try {
    return new URL(bootstrap.httpBaseUrl).origin === new URL(backendUrl).origin;
  } catch {
    return false;
  }
}

export function McpSettings() {
  const environmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  const settings = useServerSettings();
  const [pending, setPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const queryKey = ["cafe-mcp", environmentId] as const;
  const status = useQuery({
    queryKey,
    queryFn: () => {
      if (!environmentId) throw new Error("No Cafe environment.");
      return requireEnvironmentConnection(environmentId).client.server.getMcpStatus();
    },
    enabled: environmentId !== null,
    staleTime: 0,
    retry: false,
  });
  const local = isLocalMcpEnvironment(
    environmentId ? getEnvironmentHttpBaseUrl(environmentId) : null,
  );
  const canInstall = local && status.data?.canInstall === true;

  async function updateEnabled(enabled: boolean) {
    if (!environmentId || pending || !status.data?.canManage) return;
    setPending("toggle");
    setFeedback(null);
    try {
      const next = await requireEnvironmentConnection(environmentId).client.server.updateSettings({
        mcpEnabled: enabled,
      });
      // Do not display a successful security toggle until the backend persisted it.
      applySettingsUpdated(next);
      await queryClient.invalidateQueries({ queryKey });
    } catch {
      setFeedback({
        error: true,
        text: "Could not change Cafe Code MCP access. Refresh and try again.",
      });
    } finally {
      setPending(null);
    }
  }

  async function updateClient(input: CafeMcpClientUpdate) {
    if (!environmentId || !canInstall || pending) return;
    setPending(input.client);
    setFeedback(null);
    try {
      const next =
        await requireEnvironmentConnection(environmentId).client.server.updateMcpClient(input);
      queryClient.setQueryData(queryKey, next);
      setFeedback({
        error: false,
        text:
          input.operation === "install"
            ? "Installed. Reload MCP or restart the provider to make Cafe's tools available."
            : "Removed from this provider's user configuration.",
      });
    } catch (error) {
      // Provider config content and native errors must never reach the page.
      setFeedback({
        error: true,
        text:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "bridge_missing"
            ? "The MCP bridge is missing. Rebuild or update Cafe Code, then install again."
            : "Could not update this registration. Refresh to check for a configuration conflict or file permission issue.",
      });
      await queryClient.invalidateQueries({ queryKey });
    } finally {
      setPending(null);
    }
  }

  return (
    <SettingsPageContainer>
      <div className="space-y-2">
        <h1 className="text-lg font-semibold tracking-tight">MCP</h1>
        <p className="text-sm text-muted-foreground">Connect your agents to Cafe Code's tools.</p>
      </div>
      <SettingsSection title="Cafe Code MCP" icon={<PlugIcon className="size-3.5" />}>
        <SettingsRow
          title="Enable Cafe Code MCP"
          description="Let connected agents manage Cafe projects, conversations, providers, and settings. Cafe adds no approval prompts."
          status={
            settings.mcpEnabled
              ? "On · authenticated connections only"
              : "Off · new Cafe Code MCP requests are blocked"
          }
          control={
            <Switch
              aria-label="Enable Cafe Code MCP"
              checked={settings.mcpEnabled}
              disabled={!status.data?.canManage || pending !== null}
              onCheckedChange={(enabled) => void updateEnabled(enabled)}
            />
          }
        />
        <div className="border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
          Turning Cafe Code MCP off stops new requests to its management tools, including from
          providers running inside Cafe. Work already started can finish.
        </div>
      </SettingsSection>
      <SettingsSection
        title="Install Cafe Code MCP for your agents"
        headerAction={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh MCP status"
            disabled={pending !== null || status.isFetching}
            onClick={() => void status.refetch()}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        }
      >
        <div className="px-5 py-3.5 text-xs text-muted-foreground">
          Install Cafe's project, conversation, provider, and settings tools for your default user
          profile. Cafe Code must be running to use them. Custom provider homes keep their separate
          MCP setup. Each agent keeps its own permission settings.
        </div>
        {status.isPending ? (
          <p role="status" className="px-5 pb-4 text-sm text-muted-foreground">
            Loading MCP status…
          </p>
        ) : null}
        {status.isError ? (
          <p role="alert" className="px-5 pb-4 text-sm text-destructive">
            Could not load MCP status. Try refreshing.
          </p>
        ) : null}
        {status.data && !canInstall ? (
          <p className="px-5 pb-4 text-sm text-muted-foreground">
            Open this page in the local Cafe Code desktop app to install provider connections.
          </p>
        ) : null}
        {canInstall
          ? status.data?.clients.map((client) => (
              <SettingsRow
                key={client.id}
                title={
                  <span className="inline-flex items-center gap-2">
                    {client.name}
                    {client.status === "installed" || client.status === "needs-repair" ? (
                      <Badge variant="secondary">
                        <CheckIcon className="size-3" />
                        Installed
                      </Badge>
                    ) : null}
                  </span>
                }
                description={client.detail}
                control={
                  <>
                    {client.status === "installed" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending !== null}
                        aria-label={`Remove Cafe MCP from ${client.name}`}
                        onClick={() =>
                          void updateClient({ client: client.id, operation: "remove" })
                        }
                      >
                        Remove
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        pending !== null ||
                        client.status === "conflict" ||
                        client.status === "unavailable"
                      }
                      aria-label={`${client.status === "installed" ? "Reinstall" : "Install"} Cafe MCP for ${client.name}`}
                      onClick={() => void updateClient({ client: client.id, operation: "install" })}
                    >
                      {pending === client.id
                        ? "Updating…"
                        : client.status === "installed"
                          ? "Reinstall"
                          : "Install"}
                    </Button>
                  </>
                }
              />
            ))
          : null}
        {canInstall &&
        status.data?.clients.some((client) => client.status === "installed") &&
        !status.data.bridgeReady ? (
          <p role="alert" className="px-5 py-3 text-sm text-destructive">
            The local connection needs repair. Reinstall one of the provider connections.
          </p>
        ) : null}
      </SettingsSection>
      {feedback ? (
        <p
          role={feedback.error ? "alert" : "status"}
          className={feedback.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
        >
          {feedback.text}
        </p>
      ) : null}
    </SettingsPageContainer>
  );
}
