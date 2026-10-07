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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
    description: "Approve edits automatically; ask before other actions.",
    icon: PenLineIcon,
  },
  {
    id: "full-access",
    label: "Full access",
    description: "Run commands and edits without asking.",
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

const MODE_GROUP_LABEL_CLASS_NAME = "px-2 py-1.5 font-medium text-muted-foreground text-xs";

/**
 * One radio row per mode. Routine explanations live in a hover/focus tooltip;
 * only a dangerous mode (Bypass permissions) keeps its warning visible at the
 * point of choice, as AGENTS.md requires it to be separately labelled.
 */
function ComposerModeRadioItem(props: {
  value: string;
  icon: LucideIcon;
  label: string;
  description: string;
  dangerous?: boolean;
}) {
  const Icon = props.icon;
  const item = (
    <span className="grid min-w-0 gap-0.5">
      <span className="inline-flex items-center gap-1.5 text-foreground">
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        {props.label}
      </span>
      {props.dangerous ? (
        <span className="text-destructive-foreground text-xs leading-4">{props.description}</span>
      ) : null}
    </span>
  );
  if (props.dangerous) {
    return (
      <MenuRadioItem value={props.value} className="min-w-0">
        {item}
      </MenuRadioItem>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        delay={400}
        // Keep the radio item's slot: TooltipTrigger otherwise stamps its own.
        data-slot="menu-radio-item"
        render={<MenuRadioItem value={props.value} className="min-w-0" />}
      >
        {item}
      </TooltipTrigger>
      <TooltipPopup role="tooltip" side="right" className="no-drag pointer-events-none max-w-56">
        {props.description}
      </TooltipPopup>
    </Tooltip>
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
  subagentConcurrencyControl?: ReactNode;
  /** Provider-specific actions stay inside this menu in every footer layout. */
  providerActions?: ReactNode;
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
  const hasSecondaryControls = Boolean(props.subagentConcurrencyControl || props.providerActions);
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
            className="max-w-40 shrink-0 justify-start gap-1.5 px-2 text-muted-foreground hover:text-foreground"
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
          <>
            <EllipsisIcon aria-hidden="true" className="size-4" />
            <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start" className="w-[min(18rem,calc(100vw-1rem))] max-w-[calc(100vw-1rem)]">
        {props.traitsMenuContent}
        {props.subagentConcurrencyControl ? (
          <>
            {hasTraits ? <MenuDivider /> : null}
            {props.subagentConcurrencyControl}
          </>
        ) : null}
        {props.providerActions ? (
          <>
            {hasTraits || props.subagentConcurrencyControl ? <MenuDivider /> : null}
            {props.providerActions}
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            {hasTraits || hasSecondaryControls ? <MenuDivider /> : null}
            <div className={MODE_GROUP_LABEL_CLASS_NAME}>Mode</div>
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
                permissionModeOptions.map((option) => (
                  <ComposerModeRadioItem
                    key={option.id}
                    value={option.id}
                    icon={NATIVE_PERMISSION_MODE_ICONS[option.id]}
                    label={option.label}
                    description={option.description}
                    dangerous={option.id === "bypassPermissions"}
                  />
                ))
              ) : (
                <>
                  <MenuRadioItem value="default">Build</MenuRadioItem>
                  <MenuRadioItem value="plan">Plan</MenuRadioItem>
                </>
              )}
            </MenuRadioGroup>
          </>
        ) : null}
        {showAccessControls ? (
          <>
            {hasTraits || hasSecondaryControls || props.showInteractionModeToggle ? (
              <MenuDivider />
            ) : null}
            <div className={MODE_GROUP_LABEL_CLASS_NAME}>Access</div>
            <MenuRadioGroup
              value={props.runtimeMode}
              onValueChange={(value) => {
                if (!value || value === props.runtimeMode) return;
                props.onRuntimeModeChange(value as RuntimeMode);
              }}
            >
              {RUNTIME_MODE_OPTIONS.map((option) => (
                <ComposerModeRadioItem
                  key={option.id}
                  value={option.id}
                  icon={option.icon}
                  label={option.label}
                  description={option.description}
                />
              ))}
            </MenuRadioGroup>
          </>
        ) : null}
        {props.showGoalControl ? (
          <>
            {hasTraits ||
            hasSecondaryControls ||
            props.showInteractionModeToggle ||
            showAccessControls ? (
              <MenuDivider />
            ) : null}
            <MenuItem className="[&>svg]:mx-0" onClick={props.onOpenGoal}>
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
            hasSecondaryControls ||
            props.showInteractionModeToggle ||
            showAccessControls ||
            props.showGoalControl ? (
              <MenuDivider />
            ) : null}
            <MenuItem className="[&>svg]:mx-0" onClick={props.onTogglePlanSidebar}>
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
