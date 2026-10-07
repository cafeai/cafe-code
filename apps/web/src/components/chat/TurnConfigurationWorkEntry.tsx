import type { ProviderTurnConfiguration } from "@cafecode/contracts";
import { BotIcon } from "lucide-react";
import { memo } from "react";
import { presentTurnConfigurationSummary } from "../../turnConfiguration";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Unlike command previews, the turn's sanity-check settings must remain visible
 * without hover: model, effort, Fast state, the exact configured account label
 * and both modes share one line. Wrapping rather than ellipsis keeps them
 * readable in narrow Desk panes, at increased interface scale, and on mobile.
 * The settings source, exact service tier and billing caveat live in the
 * tooltip. All upstream/configured labels are rendered as escaped text nodes,
 * and the tooltip trigger is the paragraph itself so no labels become controls.
 */
export const TurnConfigurationWorkEntry = memo(function TurnConfigurationWorkEntry(props: {
  readonly configuration: ProviderTurnConfiguration;
}) {
  const presentation = presentTurnConfigurationSummary(props.configuration);
  return (
    <div className="flex min-w-0 items-start gap-2 py-0.5" data-turn-configuration-row="true">
      <span className="flex size-5 shrink-0 items-center justify-center text-subtle-foreground">
        <BotIcon aria-hidden="true" className="size-3" />
      </span>
      <Tooltip>
        <TooltipTrigger
          delay={150}
          render={
            <p
              // Keyboard users reach the source/caveat tooltip without the row
              // becoming a button or link.
              tabIndex={0}
              className="focus-ring min-w-0 flex-1 rounded-sm text-2xs leading-5 text-muted-foreground [overflow-wrap:anywhere]"
              data-turn-configuration-settings="true"
            />
          }
        >
          {presentation.summary}
        </TooltipTrigger>
        <TooltipPopup className="max-w-80 text-pretty" data-turn-configuration-source="true">
          {presentation.detail}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});
