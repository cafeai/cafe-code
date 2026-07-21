import { type ProviderDriverKind, ProviderInteractionMode, RuntimeMode } from "@cafecode/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon, ListTodoIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  CLAUDE_PERMISSION_MODE_OPTIONS,
  type ClaudePermissionMode,
  deriveClaudePermissionMode,
  isClaudePermissionMode,
} from "./claudePermissionMode";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  provider: ProviderDriverKind;
  interactionMode: ProviderInteractionMode;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
  onClaudePermissionModeChange: (mode: ClaudePermissionMode) => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const isClaude = props.provider === "claudeAgent";
  const claudePermissionMode = deriveClaudePermissionMode({
    interactionMode: props.interactionMode,
    runtimeMode: props.runtimeMode,
  });

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={isClaude ? claudePermissionMode : props.interactionMode}
              onValueChange={(value) => {
                if (!value) return;
                if (isClaude) {
                  if (isClaudePermissionMode(value) && value !== claudePermissionMode) {
                    props.onClaudePermissionModeChange(value);
                  }
                  return;
                }
                if (value !== props.interactionMode) {
                  props.onToggleInteractionMode();
                }
              }}
            >
              {isClaude ? (
                CLAUDE_PERMISSION_MODE_OPTIONS.map((option) => (
                  <MenuRadioItem key={option.id} value={option.id}>
                    {option.label}
                  </MenuRadioItem>
                ))
              ) : (
                <>
                  <MenuRadioItem value="default">Chat</MenuRadioItem>
                  <MenuRadioItem value="plan">Plan</MenuRadioItem>
                </>
              )}
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        {!isClaude ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
            <MenuRadioGroup
              value={props.runtimeMode}
              onValueChange={(value) => {
                if (!value || value === props.runtimeMode) return;
                props.onRuntimeModeChange(value as RuntimeMode);
              }}
            >
              <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
              <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
              <MenuRadioItem value="full-access">Full access</MenuRadioItem>
            </MenuRadioGroup>
          </>
        ) : null}
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen
                ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
