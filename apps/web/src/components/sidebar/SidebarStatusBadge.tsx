import { useWorkspaceEnvironmentId } from "../../environments/workspace";
import { ConnectionStatusIndicator } from "../chat/ConnectionStatusIndicator";
import { SidebarSourceUpdateBadge } from "./SidebarSourceUpdateBadge";

/** One footer slot: selected-server connection issues take priority over build status. */
export function SidebarStatusBadge() {
  const environmentId = useWorkspaceEnvironmentId();
  const sourceUpdate = <SidebarSourceUpdateBadge />;
  if (environmentId === null) return sourceUpdate;

  return (
    <ConnectionStatusIndicator
      // A server switch must not retain the previous server's delayed/fading
      // warning or retry action while the new server is already connected.
      key={environmentId}
      environmentId={environmentId}
      fallback={sourceUpdate}
      side="top"
      className="mr-2 min-w-0 max-w-3/5 shrink"
    />
  );
}
