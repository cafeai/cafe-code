import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { memo } from "react";
import { useDesktopSourceUpdateState } from "../../lib/desktopSourceUpdateReactQuery";
import { Badge } from "../ui/badge";

/** Source-build status belongs beside Settings, independently of the selected chat. */
export const SidebarSourceUpdateBadge = memo(function SidebarSourceUpdateBadge() {
  const uiLocale = useUiLocale();

  const state = useDesktopSourceUpdateState().data;
  if (!state?.trackedBranch) return null;
  const behind = state.status === "behind";
  const rebuild = Boolean(
    !behind && state.localHash && state.runtimeHash && state.localHash !== state.runtimeHash,
  );
  if (!behind && !rebuild) return null;
  const title = rebuild
    ? uiText(
        "Current checkout differs from the running Cafe Code build. Rebuild and restart to apply {branch}.",
        { branch: state.trackedBranch },
        undefined,
        uiLocale,
      )
    : state.remoteHash
      ? uiText(
          "Newer origin/{branch} commit available: {hash}",
          {
            branch: state.trackedBranch,
            hash: state.remoteHash.slice(0, 12),
          },
          undefined,
          uiLocale,
        )
      : uiText(
          "Newer origin/{branch} commit available.",
          { branch: state.trackedBranch },
          undefined,
          uiLocale,
        );
  return (
    <Badge
      variant="secondary"
      data-cafe-source-update-badge
      className="mr-2 min-w-0 shrink truncate text-2xs font-medium text-muted-foreground"
      title={title}
    >
      {rebuild
        ? uiText(
            "Rebuild to apply ({value0})",
            { value0: state.trackedBranch },
            undefined,
            uiLocale,
          )
        : uiText("Newer {value0}", { value0: state.trackedBranch }, undefined, uiLocale)}
    </Badge>
  );
});
