import { type ProviderDriverKind, type ProviderInstanceId } from "@cafecode/contracts";
import { memo } from "react";
import { StarIcon } from "lucide-react";
import {
  getDisplayModelName,
  getTriggerDisplayModelLabel,
  type ModelEsque,
  PROVIDER_ICON_BY_PROVIDER,
} from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  model: ModelEsque;
  /** Instance the model belongs to — the routing key used in combobox values. */
  instanceId: ProviderInstanceId;
  /** Driver kind of the instance — used for the provider icon glyph. */
  driverKind: ProviderDriverKind;
  /**
   * Display name to show in the secondary line (provider footer). Usually
   * the instance's configured `displayName` so custom instances like
   * "Codex Personal" render with their user-authored label.
   */
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  isFavorite: boolean;
  showProvider: boolean;
  preferShortName?: boolean;
  useTriggerLabel?: boolean;
  showNewBadge?: boolean;
  jumpLabel?: string | null;
  onToggleFavorite: () => void;
}) {
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[props.driverKind] ?? null;
  const providerLabel = props.model.subProvider
    ? `${props.providerDisplayName} · ${props.model.subProvider}`
    : props.providerDisplayName;

  return (
    <ComboboxItem
      hideIndicator
      index={props.index}
      value={`${props.instanceId}:${props.model.slug}`}
      contentClassName="flex w-full items-start gap-2"
      className={cn(
        "group w-full cursor-pointer rounded-sm px-3 py-2 transition-colors duration-(--duration-fast)",
        "data-highlighted:bg-muted data-selected:bg-accent data-selected:text-foreground",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              className="focus-ring mt-0.5 shrink-0 cursor-pointer rounded-sm opacity-40 transition-opacity duration-(--duration-fast) group-hover:opacity-100 focus-visible:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                props.onToggleFavorite();
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
              }}
              type="button"
              aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
            >
              <StarIcon className={cn("size-4", props.isFavorite && "fill-current text-warning")} />
            </button>
          }
        />
        <TooltipPopup side="top" align="center">
          {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
        </TooltipPopup>
      </Tooltip>

      <div className="min-w-0 flex-1 text-left">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="text-xs font-medium leading-snug flex items-center gap-2 min-w-0">
            <span className="truncate">
              {props.useTriggerLabel
                ? getTriggerDisplayModelLabel(props.model)
                : getDisplayModelName(
                    props.model,
                    props.preferShortName ? { preferShortName: true } : undefined,
                  )}
            </span>
            {props.showNewBadge ? (
              <span
                className="shrink-0 rounded-sm border border-warning/30 bg-warning/12 px-1 py-px text-2xs font-medium leading-none text-warning-foreground"
                aria-label="New model"
              >
                New
              </span>
            ) : null}
          </div>
          {props.jumpLabel ? (
            // Hide the keyboard-shortcut badge on touch-only devices (no
            // keyboard/hover); desktop and mouse/trackpad devices are unchanged.
            <Kbd className="h-4 min-w-0 shrink-0 rounded-sm px-1.5 text-2xs [@media(hover:none)_and_(pointer:coarse)]:hidden">
              {props.jumpLabel}
            </Kbd>
          ) : null}
        </div>
        {props.showProvider ? (
          <div className="mt-0.5 flex items-center gap-1">
            {ProviderIcon ? <ProviderIcon className="size-3 shrink-0" /> : null}
            {props.providerAccentColor ? (
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: props.providerAccentColor }}
                aria-hidden
              />
            ) : null}
            <span className="truncate text-xs font-normal leading-snug text-muted-foreground">
              {providerLabel}
            </span>
          </div>
        ) : props.model.subProvider && !props.useTriggerLabel ? (
          // The sidebar already names the provider; keep only the routing
          // sub-provider, which is not repeated anywhere else.
          <div className="mt-0.5 truncate text-xs font-normal leading-snug text-muted-foreground">
            {props.model.subProvider}
          </div>
        ) : null}
      </div>
    </ComboboxItem>
  );
});
