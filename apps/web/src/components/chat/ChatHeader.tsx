import {
  type EnvironmentId,
  type EditorId,
  type ResolvedKeybindingsConfig,
  type TerminalAvailability,
} from "@cafecode/contracts";
import { memo } from "react";
import { Badge } from "../ui/badge";
import { ContentSidebarTriggerWithUnreadDot } from "../sidebar/unseenCompletions";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";
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
  compact?: boolean;
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

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadTitle,
  activeProjectName,
  isGitRepo,
  openInCwd,
  keybindings,
  availableEditors,
  terminal,
  compact = false,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const localShellCapabilities = getLocalShellCapabilities();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
    canOpenLocalEditor: localShellCapabilities.canOpenLocalEditor,
  });

  if (compact)
    return (
      <>
        <ContentSidebarTriggerWithUnreadDot />
        <h2 data-chat-header-title className="sr-only">
          {activeThreadTitle}
        </h2>
        <ConnectionStatusIndicator environmentId={activeThreadEnvironmentId} />
        {showOpenInPicker && (
          <OpenInPicker
            environmentId={activeThreadEnvironmentId}
            keybindings={keybindings}
            availableEditors={availableEditors}
            terminal={terminal}
            openInCwd={openInCwd}
            shortcutOnly
          />
        )}
      </>
    );
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <ContentSidebarTriggerWithUnreadDot />
        <h2
          // Desktop keeps a single truncated line; on mobile (max-md) allow up to
          // two lines so the chat title is not cut off as aggressively. Inside a
          // Desk pane the tab already shows the title, so desk.css keeps this
          // heading for assistive technology only (one title per view).
          data-chat-header-title
          className="min-w-0 shrink truncate text-sm font-medium text-foreground max-md:line-clamp-2 max-md:whitespace-normal"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && (
          // Context, not a control: a quiet chip rather than an outlined badge.
          <Badge
            variant="secondary"
            data-chat-header-project
            className="min-w-0 shrink overflow-hidden font-normal text-muted-foreground"
          >
            <span className="min-w-0 truncate">{activeProjectName}</span>
          </Badge>
        )}
        {activeProjectName && !isGitRepo && (
          <Badge
            variant="outline"
            className="shrink-0 text-2xs text-status-attention-foreground sm:text-2xs"
          >
            No Git
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        <ConnectionStatusIndicator environmentId={activeThreadEnvironmentId} />
        {showOpenInPicker && (
          <OpenInPicker
            environmentId={activeThreadEnvironmentId}
            keybindings={keybindings}
            availableEditors={availableEditors}
            terminal={terminal}
            openInCwd={openInCwd}
          />
        )}
      </div>
    </div>
  );
});
