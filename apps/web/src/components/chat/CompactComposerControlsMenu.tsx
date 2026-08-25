import {
  type ProviderDriverKind,
  ProviderInteractionMode,
  type ProviderThreadGoalStatus,
  RuntimeMode,
} from "@cafecode/contracts";
import { memo, type ReactNode } from "react";
import {
  BotIcon,
  ChevronDownIcon,
  EllipsisIcon,
  ListTodoIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  ShieldCheckIcon,
  TargetIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import {
  CLAUDE_PERMISSION_MODE_OPTIONS,
  GROK_PERMISSION_MODE_OPTIONS,
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
import { threadGoalStatusLabel } from "./ThreadGoalControl";

const RUNTIME_MODE_OPTIONS: ReadonlyArray<{
  id: RuntimeMode;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    id: "approval-required",
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  {
    id: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  {
    id: "full-access",
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
];

const NATIVE_PERMISSION_MODE_ICONS: Record<ClaudePermissionMode, LucideIcon> = {
  default: LockIcon,
  acceptEdits: PenLineIcon,
  plan: BotIcon,
  auto: ShieldCheckIcon,
  bypassPermissions: LockOpenIcon,
};

function ComposerModeOption(props: { icon: LucideIcon; label: string; description: string }) {
  const Icon = props.icon;
  return (
    <span className="grid min-w-0 gap-0.5 py-0.5">
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        {props.label}
      </span>
      <span className="text-muted-foreground text-xs leading-4">{props.description}</span>
    </span>
  );
}

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  showPlanSidebar: boolean;
  provider: ProviderDriverKind;
  interactionMode: ProviderInteractionMode;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  showGoalControl?: boolean;
  goalStatus?: ProviderThreadGoalStatus | null;
  traitsMenuContent?: ReactNode;
  traitsTriggerLabel?: string | null;
  onToggleInteractionMode: () => void;
  onNativePermissionModeChange: (mode: ClaudePermissionMode) => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onOpenGoal?: () => void;
}) {
  const isClaude = props.provider === "claudeAgent";
  const usesNativePermissionModes = isClaude || props.provider === "grok";
  const permissionModeOptions = isClaude
    ? CLAUDE_PERMISSION_MODE_OPTIONS
    : GROK_PERMISSION_MODE_OPTIONS;
  const hasTraits = props.traitsMenuContent !== null && props.traitsMenuContent !== undefined;
  const showAccessControls = !usesNativePermissionModes;
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
            className="max-w-40 shrink-0 justify-start gap-1.5 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
            title={props.traitsTriggerLabel ?? undefined}
          />
        }
      >
        {props.traitsTriggerLabel ? (
          <>
            <span data-compact-composer-controls-label="true" className="min-w-0 truncate">
              {props.traitsTriggerLabel}
            </span>
            <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
          </>
        ) : (
          <EllipsisIcon aria-hidden="true" className="size-4" />
        )}
      </MenuTrigger>
      <MenuPopup align="start" className="w-[min(18rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)]">
        {props.traitsMenuContent}
        {props.showInteractionModeToggle ? (
          <>
            {hasTraits ? <MenuDivider /> : null}
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={usesNativePermissionModes ? claudePermissionMode : props.interactionMode}
              onValueChange={(value) => {
                if (!value) return;
                if (usesNativePermissionModes) {
                  if (isClaudePermissionMode(value) && value !== claudePermissionMode) {
                    props.onNativePermissionModeChange(value);
                  }
                  return;
                }
                if (value !== props.interactionMode) {
                  props.onToggleInteractionMode();
                }
              }}
            >
              {usesNativePermissionModes ? (
                permissionModeOptions.map((option) => {
                  const icon = NATIVE_PERMISSION_MODE_ICONS[option.id];
                  return (
                    <MenuRadioItem key={option.id} value={option.id} className="min-w-0 py-1.5">
                      <ComposerModeOption
                        icon={icon}
                        label={option.label}
                        description={option.description}
                      />
                    </MenuRadioItem>
                  );
                })
              ) : (
                <>
                  <MenuRadioItem value="default">Chat</MenuRadioItem>
                  <MenuRadioItem value="plan">Plan</MenuRadioItem>
                </>
              )}
            </MenuRadioGroup>
          </>
        ) : null}
        {showAccessControls ? (
          <>
            {hasTraits || props.showInteractionModeToggle ? <MenuDivider /> : null}
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
            <MenuRadioGroup
              value={props.runtimeMode}
              onValueChange={(value) => {
                if (!value || value === props.runtimeMode) return;
                props.onRuntimeModeChange(value as RuntimeMode);
              }}
            >
              {RUNTIME_MODE_OPTIONS.map((option) => (
                <MenuRadioItem key={option.id} value={option.id} className="min-w-0 py-1.5">
                  <ComposerModeOption
                    icon={option.icon}
                    label={option.label}
                    description={option.description}
                  />
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </>
        ) : null}
        {props.showGoalControl ? (
          <>
            {hasTraits || props.showInteractionModeToggle || showAccessControls ? (
              <MenuDivider />
            ) : null}
            <MenuItem onClick={props.onOpenGoal}>
              <TargetIcon className="size-4 shrink-0" />
              {props.goalStatus == null
                ? "Goal"
                : `Goal: ${threadGoalStatusLabel(props.goalStatus)}`}
            </MenuItem>
          </>
        ) : null}
        {props.showPlanSidebar ? (
          <>
            {hasTraits ||
            props.showInteractionModeToggle ||
            showAccessControls ||
            props.showGoalControl ? (
              <MenuDivider />
            ) : null}
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
