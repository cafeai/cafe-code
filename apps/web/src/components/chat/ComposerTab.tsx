import { ChevronDownIcon } from "lucide-react";
import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** A curved composer tab whose caret stays fixed as its content folds away.
 * Its expanded decoration extends slightly past the layout box for balanced
 * caret spacing. Reserved height keeps the editor and pointer target steady. */
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
  const tabRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const itemsRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const tab = tabRef.current;
    const content = contentRef.current;
    const items = itemsRef.current;
    if (!tab || !content || !items) return;
    // Keep a numeric expanded width so every browser can animate it. The
    // mounted contents retain their natural size while minimized, and changes
    // to provider controls, fonts or interface scale update the same tab.
    const measure = () => {
      const { left, right } = getComputedStyle(content);
      const width = items.offsetWidth + Number.parseFloat(left) + Number.parseFloat(right);
      if (width > 0) tab.style.setProperty("--composer-tab-expanded-width", `${width}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(items);
    return () => observer.disconnect();
  }, []);
  const toggleLabel = `${collapsed ? "Expand" : "Minimize"} ${label.toLowerCase()}`;
  return (
    <div className="no-drag cafe-composer-tab-entry inline-flex max-w-full">
      <div
        ref={tabRef}
        className="cafe-composer-tab"
        role="group"
        aria-label={label}
        data-collapsed={collapsed ? "true" : "false"}
        data-popup-open={active ? "true" : "false"}
      >
        <div aria-hidden="true" className="cafe-composer-tab-shape">
          <span className="cafe-composer-tab-middle" />
          {(["left", "right"] as const).map((side) => (
            <svg
              key={side}
              className={`cafe-composer-tab-edge cafe-composer-tab-edge-${side}`}
              viewBox="0 0 30 32"
              preserveAspectRatio="none"
            >
              <path
                className="cafe-composer-tab-fill"
                d="M0 32C9 32 14 31 16 20L18 11C19 5 23 1 30 1V32Z"
              />
              <path
                className="cafe-composer-tab-outline"
                d="M0 32C9 32 14 31 16 20L18 11C19 5 23 1 30 1"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          ))}
        </div>
        <span
          ref={contentRef}
          id={contentId}
          className="cafe-composer-tab-content"
          inert={collapsed}
          aria-hidden={collapsed}
        >
          <span ref={itemsRef} className="cafe-composer-tab-items">
            {children}
          </span>
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
            <ChevronDownIcon aria-hidden="true" className="cafe-composer-tab-caret size-3.5" />
          </TooltipTrigger>
          <TooltipPopup role="tooltip" className="no-drag pointer-events-none">
            {toggleLabel}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}
