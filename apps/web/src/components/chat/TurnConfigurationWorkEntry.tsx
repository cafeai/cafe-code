import type { ProviderTurnConfiguration } from "@cafecode/contracts";
import { BotIcon } from "lucide-react";
import { memo } from "react";
import { presentTurnConfiguration } from "../../turnConfiguration";

/**
 * Unlike command previews, the turn's sanity-check settings must remain visible
 * without hover. Wrapping rather than ellipsis keeps the account and Fast state
 * readable in narrow Desk panes, at increased interface scale, and on mobile.
 * All upstream/configured labels are rendered as escaped React text nodes.
 */
export const TurnConfigurationWorkEntry = memo(function TurnConfigurationWorkEntry(props: {
  readonly configuration: ProviderTurnConfiguration;
}) {
  const presentation = presentTurnConfiguration(props.configuration);
  return (
    <div className="flex min-w-0 items-start gap-2 py-0.5" data-turn-configuration-row="true">
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/55">
        <BotIcon aria-hidden="true" className="size-3" />
      </span>
      <div className="min-w-0 flex-1 text-[11px] leading-5 [overflow-wrap:anywhere]">
        <p className="text-foreground/80" data-turn-configuration-settings="true">
          <span className="text-muted-foreground/70">Turn accepted · </span>
          {presentation.settings}
        </p>
        <p className="text-muted-foreground/65" data-turn-configuration-account="true">
          {presentation.account}
          <span className="text-muted-foreground/50"> · {presentation.modes}</span>
          <span
            className="text-muted-foreground/50"
            data-turn-configuration-source="true"
            title={presentation.sourceDescription}
          >
            {" "}
            · {presentation.source}
          </span>
        </p>
      </div>
    </div>
  );
});
