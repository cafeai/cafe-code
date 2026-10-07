import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarClockIcon,
  CheckIcon,
  DownloadIcon,
  PlugIcon,
  RefreshCwIcon,
  RotateCwIcon,
  UnplugIcon,
} from "lucide-react";
import type { CafeMcpClientUpdate } from "@cafecode/contracts";

import { useWorkspaceEnvironmentId, useIsSavedRemoteEnvironment } from "~/environments/workspace";
import { getEnvironmentHttpBaseUrl, requireEnvironmentConnection } from "~/environments/runtime";
import { applySettingsUpdated, useServerSettings } from "~/rpc/serverState";
import { patchWorkspaceServerConfig } from "~/environments/workspaceApi";
import { readPrimaryEnvironmentDescriptor } from "~/environments/primary";
import { useDelayedFlag } from "~/hooks/useDelayedFlag";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { InfoTip } from "../ui/info-tip";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
  const environmentId = useWorkspaceEnvironmentId();
  const remote = useIsSavedRemoteEnvironment(environmentId);
  const queryClient = useQueryClient();
  const settings = useServerSettings();
  const [pending, setPending] = useState<string | null>(null);
  // Toggle failures belong next to the switch; install results next to the
  // agent list, so each message appears at the control that caused it.
  const [feedback, setFeedback] = useState<{
    scope: "toggle" | "client";
    error: boolean;
    text: string;
  } | null>(null);
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
  const canInstall = (local || remote) && status.data?.canInstall === true;
  const showInitialLoading = useDelayedFlag(environmentId !== null && status.isPending);
  // Background refetches keep the current list and only spin the header icon.
  const showRefreshing = useDelayedFlag(status.isFetching && !status.isPending);

  async function updateEnabled(enabled: boolean) {
    if (!environmentId || pending || !status.data?.canManage) return;
    setPending("toggle");
    setFeedback(null);
    try {
      const next = await requireEnvironmentConnection(environmentId).client.server.updateSettings({
        mcpEnabled: enabled,
      });
      // Do not display a successful security toggle until the backend persisted it.
      if (environmentId === readPrimaryEnvironmentDescriptor()?.environmentId)
        applySettingsUpdated(next);
      else patchWorkspaceServerConfig(environmentId, { settings: next });
      await queryClient.invalidateQueries({ queryKey });
    } catch {
      setFeedback({
        scope: "toggle",
        error: true,
        text: "Could not change Cafe Code MCP access. Refresh and try again.",
      });
    } finally {
      setPending(null);
    }
  }

  async function updateClient(input: CafeMcpClientUpdate) {
    if (!environmentId || !canInstall || pending) return;
    setPending(`${input.client}:${input.operation}`);
    setFeedback(null);
    try {
      const next =
        await requireEnvironmentConnection(environmentId).client.server.updateMcpClient(input);
      queryClient.setQueryData(queryKey, next);
      setFeedback({
        scope: "client",
        error: false,
        text:
          input.operation === "install"
            ? "Installed. Restart the agent to apply."
            : "Removed. Restart the agent to apply.",
      });
    } catch (error) {
      // Provider config content and native errors must never reach the page.
      setFeedback({
        scope: "client",
        error: true,
        text:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "bridge_missing"
            ? "Cafe Code is missing a required file. Update or rebuild it, then install again."
            : "Could not update this agent. Refresh to check for a conflict or file permission issue.",
      });
      await queryClient.invalidateQueries({ queryKey });
    } finally {
      setPending(null);
    }
  }

  const clientFeedback = feedback?.scope === "client" ? feedback : null;
  const toggleFeedback = feedback?.scope === "toggle" ? feedback : null;

  return (
    <SettingsPageContainer title="MCP">
      <SettingsSection>
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              Chat scheduling
              <InfoTip label="About chat scheduling">
                Codex, Claude and Grok get scheduling tools automatically in each chat and account,
                including separate account profiles. Agents can only propose, list and pause
                follow-ups: nothing runs until you review the proposal and the account that runs and
                pays for it in Tasks, then choose Approve &amp; enable. Changing accounts needs
                another review. These tools are separate from Cafe Code MCP below.
              </InfoTip>
            </span>
          }
          description="Agents can propose follow-ups in any chat; you approve them in Tasks."
          control={
            <Badge variant="secondary">
              <CalendarClockIcon />
              Built in
            </Badge>
          }
        />
      </SettingsSection>
      <SettingsSection title="Cafe Code MCP" icon={<PlugIcon className="size-3.5" />}>
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              Enable Cafe Code MCP
              <InfoTip label="About Cafe Code MCP">
                Only authenticated connections can use these tools. Turning it off blocks new
                requests, including from agents running in Cafe, but doesn't undo work already
                started. Chat scheduling stays available, and follow-ups still need your approval in
                Tasks.
              </InfoTip>
            </span>
          }
          description="Lets agents manage projects, chats, providers and settings without Cafe approval prompts."
          status={
            toggleFeedback ? (
              <span role="alert" className="text-destructive">
                {toggleFeedback.text}
              </span>
            ) : null
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
      </SettingsSection>
      <SettingsSection
        title="Install in agents"
        headerAction={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Refresh MCP status"
                  disabled={pending !== null || status.isFetching}
                  onClick={() => void status.refetch()}
                >
                  {showRefreshing ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <RefreshCwIcon className="size-3.5" />
                  )}
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh</TooltipPopup>
          </Tooltip>
        }
      >
        <p className="px-4 py-3.5 text-xs text-muted-foreground sm:px-5">
          Install Cafe's tools into each agent's default profile. Cafe must be running.{" "}
          <InfoTip label="About installing Cafe's tools">
            Adds Cafe's project, chat, provider and settings tools. Each agent keeps its own
            permission settings. Custom provider homes need their own MCP setup. Not needed for chat
            scheduling.
          </InfoTip>
        </p>
        {/* Slow first loads show rows shaped like the agent list; fast ones show
            nothing until the real rows arrive (docs/style-guide.md §9). */}
        {showInitialLoading && (local || remote)
          ? ["codex", "claude", "grok", "opencode"].map((id) => (
              <div
                key={id}
                aria-hidden="true"
                className="flex items-center justify-between gap-3 border-t border-border-subtle px-4 py-3.5 sm:px-5"
              >
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-8 w-24 rounded-lg sm:h-7" />
              </div>
            ))
          : null}
        {status.isError && !showInitialLoading ? (
          <p role="alert" className="px-4 pb-3.5 text-xs text-destructive sm:px-5">
            Could not load MCP status. Try refreshing.
          </p>
        ) : null}
        {status.data && !canInstall && !showInitialLoading ? (
          <p className="px-4 pb-3.5 text-xs text-muted-foreground sm:px-5">
            {remote
              ? "To install, connect as an owner over HTTPS to a server running the Cafe desktop app."
              : "Open this page in the local Cafe Code desktop app to install."}
          </p>
        ) : null}
        {canInstall && !showInitialLoading
          ? status.data?.clients.map((client) => {
              const installed = client.status === "installed";
              const installing = pending === `${client.id}:install`;
              const removing = pending === `${client.id}:remove`;
              return (
                <SettingsRow
                  key={client.id}
                  title={
                    <span className="inline-flex items-center gap-2">
                      {client.name}
                      {installed ? (
                        <Badge variant="secondary">
                          <CheckIcon />
                          Installed
                        </Badge>
                      ) : client.status === "needs-repair" ? (
                        <Badge variant="warning">Needs repair</Badge>
                      ) : null}
                    </span>
                  }
                  // The Install button already says a fresh registration is
                  // available, so only installed/problem states get a line.
                  description={client.status === "not-installed" ? undefined : client.detail}
                  control={
                    <>
                      {installed ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending !== null}
                          aria-label={`Remove Cafe MCP from ${client.name}`}
                          onClick={() =>
                            void updateClient({ client: client.id, operation: "remove" })
                          }
                        >
                          {/* Spinners replace the icon so labels and widths stay put. */}
                          {removing ? <Spinner className="size-3.5" /> : <UnplugIcon />}
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
                        aria-label={`${installed ? "Reinstall" : "Install"} Cafe MCP for ${client.name}`}
                        onClick={() =>
                          void updateClient({ client: client.id, operation: "install" })
                        }
                      >
                        {installing ? (
                          <Spinner className="size-3.5" />
                        ) : installed ? (
                          <RotateCwIcon />
                        ) : (
                          <DownloadIcon />
                        )}
                        {installed ? "Reinstall" : "Install"}
                      </Button>
                    </>
                  }
                />
              );
            })
          : null}
        {canInstall &&
        status.data?.clients.some((client) => client.status === "installed") &&
        !status.data.bridgeReady ? (
          <p
            role="alert"
            className="border-t border-border-subtle px-4 py-3 text-xs text-destructive sm:px-5"
          >
            {remote
              ? "This server's connection needs repair. Reinstall in any agent."
              : "The connection needs repair. Reinstall in any agent."}
          </p>
        ) : null}
        {clientFeedback ? (
          <p
            role={clientFeedback.error ? "alert" : "status"}
            className={cn(
              "border-t border-border-subtle px-4 py-3 text-xs sm:px-5",
              clientFeedback.error ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {clientFeedback.text}
          </p>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
