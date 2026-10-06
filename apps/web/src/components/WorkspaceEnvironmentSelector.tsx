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

export function WorkspaceEnvironmentSelector() {
  const selected = useWorkspaceEnvironmentId();
  const primary = usePrimaryEnvironmentId();
  const records = useSavedEnvironmentRegistryStore((s) => s.byId);
  const runtime = useSavedEnvironmentRuntimeStore((s) => s.byId);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (s) => s.pathname });
  const savedRemotes = Object.values(records).filter((r) => r.environmentId !== primary);
  if (!primary || savedRemotes.length === 0) return null;
  const serverItems = [
    { value: primary, label: readPrimaryEnvironmentDescriptor()?.label ?? "Local server" },
    ...savedRemotes.map((r) => ({
      value: r.environmentId,
      label: `${r.label}${runtime[r.environmentId]?.connectionState === "connected" ? "" : " (offline)"}`,
    })),
  ];
  const disconnected =
    selected !== primary && selected && runtime[selected]?.connectionState !== "connected";
  return (
    <div className="no-drag flex min-w-0 flex-col gap-2 px-3 py-2">
      <label className="text-xs text-muted-foreground" htmlFor="workspace-server">
        Server
      </label>
      <Select
        items={serverItems}
        value={selected ?? primary}
        onValueChange={(value) => {
          if (!value) return;
          const id = EnvironmentId.make(value);
          selectWorkspaceEnvironment(id);
          // A chat route belongs to one exact server. Clear it when explicitly
          // choosing another; each Desk restores its own durable working set.
          if (!pathname.startsWith("/settings")) void navigate({ to: "/" });
        }}
      >
        <SelectTrigger
          id="workspace-server"
          aria-label="Workspace server"
          className="min-w-0 rounded-md border-border px-2 py-1.5 [&_[data-slot=select-icon]]:flex [&_[data-slot=select-icon]]:shrink-0"
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
      {disconnected ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void reconnectSavedEnvironment(selected).catch(() =>
              toastManager.add({
                type: "error",
                title: "Could not reconnect",
                description: "Check this server's address and saved login in Connections.",
              }),
            )
          }
        >
          Reconnect selected server
        </Button>
      ) : null}
    </div>
  );
}
