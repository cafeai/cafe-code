import {
  type EnvironmentId,
  type DesktopSourceUpdateState,
  type EditorId,
  type ResolvedKeybindingsConfig,
  type TerminalAvailability,
} from "@cafecode/contracts";
import { memo } from "react";
import { DiffIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Toggle } from "../ui/toggle";
import { SidebarTriggerWithUnreadDot } from "../sidebar/unseenCompletions";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useDesktopSourceUpdateState } from "../../lib/desktopSourceUpdateReactQuery";
import { getLocalShellCapabilities } from "../../localCapabilities";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminal: TerminalAvailability;
  diffToggleShortcutLabel: string | null;
  diffOpen: boolean;
  onToggleDiff: () => void;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly canOpenLocalEditor: boolean;
}): boolean {
  return (
    input.canOpenLocalEditor &&
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

function shouldShowSourceRebuildBadge(state: DesktopSourceUpdateState | null): boolean {
  return Boolean(
    state?.trackedBranch &&
    state.localHash &&
    state.runtimeHash &&
    state.localHash !== state.runtimeHash &&
    state.status !== "behind",
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadTitle,
  activeProjectName,
  isGitRepo,
  openInCwd,
  keybindings,
  availableEditors,
  terminal,
  diffToggleShortcutLabel,
  diffOpen,
  onToggleDiff,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const localShellCapabilities = getLocalShellCapabilities();
  const sourceUpdateState = useDesktopSourceUpdateState().data ?? null;
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
    canOpenLocalEditor: localShellCapabilities.canOpenLocalEditor,
  });
  const shouldShowSourceUpdateBadge =
    sourceUpdateState?.status === "behind" && sourceUpdateState.trackedBranch !== null;
  const shouldShowSourceRebuildBadgeValue = shouldShowSourceRebuildBadge(sourceUpdateState);
  const sourceUpdateTooltip =
    shouldShowSourceRebuildBadgeValue && sourceUpdateState?.trackedBranch
      ? `Current checkout differs from the running Cafe Code build. Rebuild and restart to apply ${sourceUpdateState.trackedBranch}.`
      : shouldShowSourceUpdateBadge && sourceUpdateState.remoteHash
        ? `Newer origin/${sourceUpdateState.trackedBranch} commit available: ${sourceUpdateState.remoteHash.slice(0, 12)}`
        : shouldShowSourceUpdateBadge
          ? `Newer origin/${sourceUpdateState.trackedBranch} commit available.`
          : null;

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTriggerWithUnreadDot className="md:hidden" />
        <h2
          // Desktop keeps a single truncated line; on mobile (max-md) allow up to
          // two lines so the thread title is not cut off as aggressively.
          className="min-w-0 shrink truncate text-sm font-medium text-foreground max-md:line-clamp-2 max-md:whitespace-normal"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && (
          <Badge variant="outline" className="min-w-0 shrink overflow-hidden">
            <span className="min-w-0 truncate">{activeProjectName}</span>
          </Badge>
        )}
        {activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        {(shouldShowSourceUpdateBadge || shouldShowSourceRebuildBadgeValue) && (
          <Badge
            variant="outline"
            size="sm"
            className="hidden border-muted-foreground/20 bg-muted/20 text-[10px] font-medium text-muted-foreground sm:inline-flex"
            title={sourceUpdateTooltip ?? undefined}
          >
            {shouldShowSourceRebuildBadgeValue
              ? `Rebuild to apply (${sourceUpdateState?.trackedBranch})`
              : `Newer ${sourceUpdateState?.trackedBranch}`}
          </Badge>
        )}
        <ConnectionStatusIndicator />
        {showOpenInPicker && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            terminal={terminal}
            openInCwd={openInCwd}
          />
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={diffOpen}
                onPressedChange={onToggleDiff}
                aria-label="Toggle diff panel"
                variant="outline"
                size="xs"
                disabled={!isGitRepo && !diffOpen}
              >
                <DiffIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!isGitRepo && !diffOpen
              ? "Diff panel is unavailable because this project is not a git repository."
              : diffToggleShortcutLabel
                ? `Toggle diff panel (${diffToggleShortcutLabel})`
                : "Toggle diff panel"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
