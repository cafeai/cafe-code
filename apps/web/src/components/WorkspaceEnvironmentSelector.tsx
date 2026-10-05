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
  const disconnected =
    selected !== primary && selected && runtime[selected]?.connectionState !== "connected";
  return (
    <div className="no-drag flex min-w-0 flex-col gap-2 px-3 py-2">
      <label className="text-xs text-muted-foreground" htmlFor="workspace-server">
        Server
      </label>
      <select
        id="workspace-server"
        aria-label="Workspace server"
        value={selected ?? primary}
        className="min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        onChange={(event) => {
          const id = EnvironmentId.make(event.target.value);
          selectWorkspaceEnvironment(id);
          // A chat route belongs to one exact server. Clear it when explicitly
          // choosing another; each Desk restores its own durable working set.
          if (!pathname.startsWith("/settings")) void navigate({ to: "/" });
        }}
      >
        <option value={primary}>
          {readPrimaryEnvironmentDescriptor()?.label ?? "Local server"}
        </option>
        {savedRemotes.map((r) => (
          <option key={r.environmentId} value={r.environmentId}>
            {r.label}
            {runtime[r.environmentId]?.connectionState === "connected" ? "" : " (offline)"}
          </option>
        ))}
      </select>
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
