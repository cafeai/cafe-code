import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A curved composer tab whose right edge and caret stay fixed as its content
 * folds away. The composer reserves the same height in both states, so neither
 * the editor nor the pointer target moves during repeated toggles. */
export function ComposerTab({
  label,
  collapsed,
  onCollapsedChange,
  active = false,
  children,
}: {
  label: string;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  active?: boolean;
  children: ReactNode;
}) {
  const contentId = useId();
  const toggleLabel = `${collapsed ? "Expand" : "Minimize"} ${label.toLowerCase()}`;
  return (
    <div className="no-drag cafe-composer-tab-entry inline-flex max-w-full">
      <div
        className="cafe-composer-tab"
        data-collapsed={collapsed ? "true" : "false"}
        data-popup-open={active ? "true" : "false"}
      >
        <svg
          aria-hidden="true"
          className="cafe-composer-tab-shape"
          viewBox="0 0 180 32"
          preserveAspectRatio="none"
        >
          <path
            className="cafe-composer-tab-fill"
            d="M0 32C9 32 14 31 16 20L18 11C19 5 23 1 30 1H150C157 1 161 5 162 11L164 20C166 31 171 32 180 32Z"
          />
          <path
            className="cafe-composer-tab-outline"
            d="M0 32C9 32 14 31 16 20L18 11C19 5 23 1 30 1H150C157 1 161 5 162 11L164 20C166 31 171 32 180 32"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <span id={contentId} className="cafe-composer-tab-content" hidden={collapsed}>
          {children}
        </span>
        <Tooltip>
          <TooltipTrigger
            delay={250}
            render={
              <button
                type="button"
                className="cafe-composer-tab-toggle"
                aria-label={toggleLabel}
                aria-expanded={!collapsed}
                aria-controls={contentId}
                onClick={() => onCollapsedChange(!collapsed)}
              />
            }
          >
            {collapsed ? (
              <ChevronUpIcon aria-hidden="true" className="size-3.5" />
            ) : (
              <ChevronDownIcon aria-hidden="true" className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipPopup role="tooltip" className="no-drag pointer-events-none">
            {toggleLabel}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}
