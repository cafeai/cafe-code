import { memo } from "react";
import { useDesktopSourceUpdateState } from "../../lib/desktopSourceUpdateReactQuery";
import { Badge } from "../ui/badge";

/** Source-build status belongs beside Settings, independently of the selected chat. */
export const SidebarSourceUpdateBadge = memo(function SidebarSourceUpdateBadge() {
  const state = useDesktopSourceUpdateState().data;
  if (!state?.trackedBranch) return null;
  const behind = state.status === "behind";
  const rebuild = Boolean(
    !behind && state.localHash && state.runtimeHash && state.localHash !== state.runtimeHash,
  );
  if (!behind && !rebuild) return null;
  const title = rebuild
    ? `Current checkout differs from the running Cafe Code build. Rebuild and restart to apply ${state.trackedBranch}.`
    : `Newer origin/${state.trackedBranch} commit available${state.remoteHash ? `: ${state.remoteHash.slice(0, 12)}` : "."}`;
  return (
    <Badge
      variant="secondary"
      data-cafe-source-update-badge
      className="mr-2 min-w-0 shrink truncate text-2xs font-medium text-muted-foreground"
      title={title}
    >
      {rebuild ? `Rebuild to apply (${state.trackedBranch})` : `Newer ${state.trackedBranch}`}
    </Badge>
  );
});
