import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { usePrimaryEnvironmentId, readPrimaryEnvironmentDescriptor } from "../environments/primary";
import { useWorkspaceEnvironmentId, selectWorkspaceEnvironment } from "../environments/workspace";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime/catalog";
import { EnvironmentId } from "@cafecode/contracts";
import { reconnectSavedEnvironment } from "../environments/runtime/service";
import { Button } from "./ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { toastManager } from "./ui/toast";
import { ChevronUpIcon, ChevronDownIcon } from "lucide-react";

export function WorkspaceEnvironmentSelector() {
  const uiLocale = useUiLocale();

  const selected = useWorkspaceEnvironmentId();
  const primary = usePrimaryEnvironmentId();
  const records = useSavedEnvironmentRegistryStore((s) => s.byId);
  const runtime = useSavedEnvironmentRuntimeStore((s) => s.byId);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (s) => s.pathname });
  const savedRemotes = Object.values(records).filter((r) => r.environmentId !== primary);
  if (!primary || savedRemotes.length === 0) return null;
  const serverItems = [
    {
      value: primary,
      label:
        readPrimaryEnvironmentDescriptor()?.label ??
        uiText("Local server", undefined, undefined, uiLocale),
    },
    ...savedRemotes.map((r) => ({
      value: r.environmentId,
      label: `${r.label}${runtime[r.environmentId]?.connectionState === "connected" ? "" : uiText(" (offline)", undefined, undefined, uiLocale)}`,
    })),
  ];
  const disconnected =
    selected !== primary && selected && runtime[selected]?.connectionState !== "connected";
  const selectServer = (value: string | null) => {
    if (!value) return;
    selectWorkspaceEnvironment(EnvironmentId.make(value));
    if (!pathname.startsWith("/settings")) void navigate({ to: "/" });
  };
  const currentIndex = serverItems.findIndex((item) => item.value === (selected ?? primary));
  return (
    <div className="no-drag flex min-w-0 flex-col gap-2 px-3 py-2">
      <label className="text-xs text-muted-foreground" htmlFor="workspace-server">
        {uiText("Server", undefined, undefined, uiLocale)}
      </label>
      <div className="flex min-w-0 items-center gap-1">
        <Select items={serverItems} value={selected ?? primary} onValueChange={selectServer}>
          <SelectTrigger
            id="workspace-server"
            aria-label={uiText("Workspace server", undefined, undefined, uiLocale)}
            className="min-w-0 flex-1 rounded-md border-border px-2 py-1.5 [&_[data-slot=select-icon]]:flex [&_[data-slot=select-icon]]:shrink-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false} popupClassName="no-drag w-(--anchor-width)">
            {serverItems.map((item) => (
              <SelectItem
                key={item.value}
                value={item.value}
                className="[&_[data-slot=select-item-text]]:truncate"
              >
                {item.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <div className="flex shrink-0 flex-col justify-center">
          <Button
            size="icon-xs"
            variant="ghost"
            className="h-4 sm:h-4"
            aria-label={uiText("Previous server", undefined, undefined, uiLocale)}
            disabled={currentIndex <= 0}
            onClick={() => selectServer(serverItems[currentIndex - 1]?.value ?? null)}
          >
            <ChevronUpIcon className="size-3" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            className="h-4 sm:h-4"
            aria-label={uiText("Next server", undefined, undefined, uiLocale)}
            disabled={currentIndex < 0 || currentIndex >= serverItems.length - 1}
            onClick={() => selectServer(serverItems[currentIndex + 1]?.value ?? null)}
          >
            <ChevronDownIcon className="size-3" />
          </Button>
        </div>
      </div>
      {disconnected ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void reconnectSavedEnvironment(selected).catch(() =>
              toastManager.add({
                type: "error",
                title: uiText("Could not reconnect", undefined, undefined, uiLocale),
                description: uiText(
                  "Check this server''s address and saved login in Connections.",
                  undefined,
                  undefined,
                  uiLocale,
                ),
              }),
            )
          }
        >
          {uiText("Reconnect selected server", undefined, undefined, uiLocale)}
        </Button>
      ) : null}
    </div>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
