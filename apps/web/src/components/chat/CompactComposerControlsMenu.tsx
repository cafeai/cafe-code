import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import type { ProviderThreadGoalStatus } from "@cafecode/contracts";
import { memo, type ReactNode } from "react";
import { ChevronDownIcon, EllipsisIcon, ListTodoIcon, TargetIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator as MenuDivider, MenuTrigger } from "../ui/menu";
import { threadGoalStatusLabel } from "./ThreadGoalControl";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  showPlanSidebar: boolean;
  planSidebarOpen: boolean;
  showGoalControl?: boolean;
  goalStatus?: ProviderThreadGoalStatus | null;
  traitsMenuContent?: ReactNode;
  daybreakMenuContent?: ReactNode;
  subagentConcurrencyControl?: ReactNode;
  codexContextWindowControl?: ReactNode;
  /** Provider-specific actions stay inside this menu in every footer layout. */
  providerActions?: ReactNode;
  traitsTriggerLabel?: string | null;
  onTogglePlanSidebar: () => void;
  onOpenGoal?: () => void;
  /** Optional controlled state so explicit shortcuts can open this menu. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const hasTraits = props.traitsMenuContent !== null && props.traitsMenuContent !== undefined;
  const hasDaybreak = props.daybreakMenuContent !== null && props.daybreakMenuContent !== undefined;
  const hasSecondaryControls = Boolean(
    props.subagentConcurrencyControl || props.codexContextWindowControl || props.providerActions,
  );
  if (
    !hasTraits &&
    !hasDaybreak &&
    !hasSecondaryControls &&
    !props.showGoalControl &&
    !props.showPlanSidebar
  )
    return null;

  return (
    <Menu
      {...(props.open !== undefined ? { open: props.open } : {})}
      {...(props.onOpenChange ? { onOpenChange: props.onOpenChange } : {})}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="max-w-40 shrink-0 justify-start gap-1.5 px-2 text-muted-foreground hover:text-foreground"
            aria-label={uiText("More composer controls", undefined, undefined, uiLocale)}
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
        {props.codexContextWindowControl ? (
          <>
            {hasTraits && !props.subagentConcurrencyControl ? <MenuDivider /> : null}
            {props.codexContextWindowControl}
          </>
        ) : null}
        {props.providerActions ? (
          <>
            {hasTraits || props.subagentConcurrencyControl || props.codexContextWindowControl ? (
              <MenuDivider />
            ) : null}
            {props.providerActions}
          </>
        ) : null}
        {hasDaybreak ? (
          <>
            {hasTraits || hasSecondaryControls ? <MenuDivider /> : null}
            {props.daybreakMenuContent}
          </>
        ) : null}
        {props.showGoalControl ? (
          <>
            {hasTraits || hasSecondaryControls || hasDaybreak ? <MenuDivider /> : null}
            <MenuItem className="[&>svg]:mx-0" onClick={props.onOpenGoal}>
              <TargetIcon className="size-4 shrink-0" />
              {props.goalStatus == null
                ? uiText("Goal", undefined, undefined, uiLocale)
                : uiText(
                    "Goal: {value0}",
                    { value0: uiPresentation.threadGoalStatusLabel(props.goalStatus) },
                    undefined,
                    uiLocale,
                  )}
            </MenuItem>
          </>
        ) : null}
        {props.showPlanSidebar ? (
          <>
            {hasTraits || hasSecondaryControls || props.showGoalControl || hasDaybreak ? (
              <MenuDivider />
            ) : null}
            <MenuItem className="[&>svg]:mx-0" onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen
                ? uiText("Hide plan sidebar", undefined, undefined, uiLocale)
                : uiText("Show plan sidebar", undefined, undefined, uiLocale)}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = {
  threadGoalStatusLabel,
};
