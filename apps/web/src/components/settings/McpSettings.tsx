import { useUiLocale } from "~/i18n";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
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

type McpFeedbackCode =
  | "toggle-failed"
  | "installed"
  | "removed"
  | "bridge-missing"
  | "client-failed";

// Feedback stores only Cafe's finite classification, never provider config or
// native error contents. Changing language renders it again without an action.
function formatMcpFeedback(code: McpFeedbackCode, locale: UiLocale): string {
  switch (code) {
    case "toggle-failed":
      return uiText(
        "Could not change Cafe Code MCP access. Refresh and try again.",
        undefined,
        undefined,
        locale,
      );
    case "installed":
      return uiText("Installed. Restart the agent to apply.", undefined, undefined, locale);
    case "removed":
      return uiText("Removed. Restart the agent to apply.", undefined, undefined, locale);
    case "bridge-missing":
      return uiText(
        "Cafe Code is missing a required file. Update or rebuild it, then install again.",
        undefined,
        undefined,
        locale,
      );
    case "client-failed":
      return uiText(
        "Could not update this agent. Refresh to check for a conflict or file permission issue.",
        undefined,
        undefined,
        locale,
      );
  }
}

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
  const uiLocale = useUiLocale();

  const environmentId = useWorkspaceEnvironmentId();
  const remote = useIsSavedRemoteEnvironment(environmentId);
  const queryClient = useQueryClient();
  const settings = useServerSettings();
  const [pending, setPending] = useState<string | null>(null);
  // Toggle failures belong next to the switch; install results next to the
  // agent list, so each message appears at the control that caused it.
  const [feedbackCode, setFeedbackCode] = useState<{
    scope: "toggle" | "client";
    error: boolean;
    code: McpFeedbackCode;
  } | null>(null);
  const queryKey = ["cafe-mcp", environmentId] as const;
  const status = useQuery({
    queryKey,
    queryFn: () => {
      if (!environmentId)
        throw new Error(uiText("No Cafe environment.", undefined, undefined, uiLocale));
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
    setFeedbackCode(null);
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
      setFeedbackCode({
        scope: "toggle",
        error: true,
        code: "toggle-failed",
      });
    } finally {
      setPending(null);
    }
  }

  async function updateClient(input: CafeMcpClientUpdate) {
    if (!environmentId || !canInstall || pending) return;
    setPending(`${input.client}:${input.operation}`);
    setFeedbackCode(null);
    try {
      const next =
        await requireEnvironmentConnection(environmentId).client.server.updateMcpClient(input);
      queryClient.setQueryData(queryKey, next);
      setFeedbackCode({
        scope: "client",
        error: false,
        code: input.operation === "install" ? "installed" : "removed",
      });
    } catch (error) {
      // Provider config content and native errors must never reach the page.
      setFeedbackCode({
        scope: "client",
        error: true,
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "bridge_missing"
            ? "bridge-missing"
            : "client-failed",
      });
      await queryClient.invalidateQueries({ queryKey });
    } finally {
      setPending(null);
    }
  }

  const clientFeedback = feedbackCode?.scope === "client" ? feedbackCode : null;
  const toggleFeedback = feedbackCode?.scope === "toggle" ? feedbackCode : null;

  return (
    <SettingsPageContainer title={uiText("MCP", undefined, undefined, uiLocale)}>
      <SettingsSection>
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <UiMessage
                message="Chat scheduling<slot1></slot1>"
                slots={{
                  slot1: (
                    <InfoTip
                      label={uiText("About chat scheduling", undefined, undefined, uiLocale)}
                    >
                      {uiText(
                        "Codex, Claude and Grok get scheduling tools automatically in each chat and account, including separate account profiles. Agents can only propose, list and pause follow-ups: nothing runs until you review the proposal and the account that runs and pays for it in Tasks, then choose Approve & enable. Changing accounts needs another review. These tools are separate from Cafe Code MCP below.",
                        undefined,
                        undefined,
                        uiLocale,
                      )}
                    </InfoTip>
                  ),
                }}
              />
            </span>
          }
          description={uiText(
            "Agents can propose follow-ups in any chat; you approve them in Tasks.",
            undefined,
            undefined,
            uiLocale,
          )}
          control={
            <Badge variant="secondary">
              <CalendarClockIcon />
              {uiText("Built in", undefined, undefined, uiLocale)}
            </Badge>
          }
        />
      </SettingsSection>
      <SettingsSection
        title={uiText("Cafe Code MCP", undefined, undefined, uiLocale)}
        icon={<PlugIcon className="size-3.5" />}
      >
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              <UiMessage
                message="Enable Cafe Code MCP<slot1></slot1>"
                slots={{
                  slot1: (
                    <InfoTip label={uiText("About Cafe Code MCP", undefined, undefined, uiLocale)}>
                      {uiText(
                        "Only authenticated connections can use these tools. Turning it off blocks new requests, including from agents running in Cafe, but doesn''t undo work already started. Chat scheduling stays available, and follow-ups still need your approval in Tasks.",
                        undefined,
                        undefined,
                        uiLocale,
                      )}
                    </InfoTip>
                  ),
                }}
              />
            </span>
          }
          description={uiText(
            "Lets agents manage projects, chats, providers and settings without Cafe approval prompts.",
            undefined,
            undefined,
            uiLocale,
          )}
          status={
            toggleFeedback ? (
              <span role="alert" className="text-destructive">
                {formatMcpFeedback(toggleFeedback.code, uiLocale)}
              </span>
            ) : null
          }
          control={
            <Switch
              aria-label={uiText("Enable Cafe Code MCP", undefined, undefined, uiLocale)}
              checked={settings.mcpEnabled}
              disabled={!status.data?.canManage || pending !== null}
              onCheckedChange={(enabled) => void updateEnabled(enabled)}
            />
          }
        />
      </SettingsSection>
      <SettingsSection
        title={uiText("Install in agents", undefined, undefined, uiLocale)}
        headerAction={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={uiText("Refresh MCP status", undefined, undefined, uiLocale)}
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
            <TooltipPopup side="top">
              {uiText("Refresh", undefined, undefined, uiLocale)}
            </TooltipPopup>
          </Tooltip>
        }
      >
        <p className="px-4 py-3.5 text-xs text-muted-foreground sm:px-5">
          <UiMessage
            message="Install Cafe''s tools into each agent''s default profile. Cafe must be running.<slot1></slot1><slot3></slot3>"
            slots={{
              slot1: " ",
              slot3: (
                <InfoTip
                  label={uiText("About installing Cafe''s tools", undefined, undefined, uiLocale)}
                >
                  {uiText(
                    "Adds Cafe''s project, chat, provider and settings tools. Each agent keeps its own permission settings. Custom provider homes need their own MCP setup. Not needed for chat scheduling.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
                </InfoTip>
              ),
            }}
          />
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
            {uiText("Could not load MCP status. Try refreshing.", undefined, undefined, uiLocale)}
          </p>
        ) : null}
        {status.data && !canInstall && !showInitialLoading ? (
          <p className="px-4 pb-3.5 text-xs text-muted-foreground sm:px-5">
            {remote
              ? uiText(
                  "To install, connect as an owner over HTTPS to a server running the Cafe desktop app.",
                  undefined,
                  undefined,
                  uiLocale,
                )
              : uiText(
                  "Open this page in the local Cafe Code desktop app to install.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
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
                          {uiText("Installed", undefined, undefined, uiLocale)}
                        </Badge>
                      ) : client.status === "needs-repair" ? (
                        <Badge variant="warning">
                          {uiText("Needs repair", undefined, undefined, uiLocale)}
                        </Badge>
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
                          aria-label={uiText(
                            "Remove Cafe MCP from {value0}",
                            {
                              value0: client.name,
                            },
                            undefined,
                            uiLocale,
                          )}
                          onClick={() =>
                            void updateClient({ client: client.id, operation: "remove" })
                          }
                        >
                          {/* Spinners replace the icon so labels and widths stay put. */}
                          {removing ? <Spinner className="size-3.5" /> : <UnplugIcon />}
                          {uiText("Remove", undefined, undefined, uiLocale)}
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
                        aria-label={uiText(
                          "{installed, select, yes {Reinstall} other {Install}} Cafe MCP for {client}",
                          {
                            installed: installed ? "yes" : "no",
                            client: client.name,
                          },
                          undefined,
                          uiLocale,
                        )}
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
                        {installed
                          ? uiText("Reinstall", undefined, undefined, uiLocale)
                          : uiText("Install", undefined, undefined, uiLocale)}
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
              ? uiText(
                  "This server''s connection needs repair. Reinstall in any agent.",
                  undefined,
                  undefined,
                  uiLocale,
                )
              : uiText(
                  "The connection needs repair. Reinstall in any agent.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
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
            {formatMcpFeedback(clientFeedback.code, uiLocale)}
          </p>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
