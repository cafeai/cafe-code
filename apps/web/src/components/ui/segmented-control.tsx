"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

export interface SegmentedControlOption<Value extends string> {
  readonly value: Value;
  readonly label: ReactNode;
  readonly disabled?: boolean;
  /** Accessible name when `label` is an icon. */
  readonly ariaLabel?: string;
}

const SIZE_CLASSES = {
  xs: { track: "h-6 rounded-md p-0.5", item: "h-5 rounded-sm px-2 text-2xs" },
  sm: { track: "h-7 rounded-lg p-0.5", item: "h-6 rounded-md px-2.5 text-xs" },
  default: { track: "h-8 rounded-lg p-0.5", item: "h-7 rounded-md px-3 text-ui" },
} as const;

/**
 * The one control for choosing between 2–5 exclusive options
 * (docs/style-guide.md §6). A single indicator slides under the selected
 * option with `transform`, so switching reads as one continuous movement and
 * never relayouts its siblings.
 */
export function SegmentedControl<Value extends string>({
  value,
  onValueChange,
  options,
  size = "sm",
  className,
  "aria-label": ariaLabel,
}: {
  value: Value;
  onValueChange: (value: Value) => void;
  options: ReadonlyArray<SegmentedControlOption<Value>>;
  size?: keyof typeof SIZE_CLASSES;
  className?: string;
  "aria-label": string;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  // The first measurement places the indicator without sliding in from 0.
  const [hasMeasured, setHasMeasured] = useState(false);

  const measure = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const selected = track.querySelector<HTMLElement>("[data-segment][data-pressed]");
    if (!selected) {
      setIndicator(null);
      return;
    }
    setIndicator((previous) =>
      previous?.left === selected.offsetLeft && previous.width === selected.offsetWidth
        ? previous
        : { left: selected.offsetLeft, width: selected.offsetWidth },
    );
  }, []);

  useLayoutEffect(() => {
    measure();
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(track);
    return () => observer.disconnect();
  }, [measure, value, options]);

  useLayoutEffect(() => {
    if (indicator && !hasMeasured) {
      const frame = requestAnimationFrame(() => setHasMeasured(true));
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [indicator, hasMeasured]);

  const sizeClasses = SIZE_CLASSES[size];

  return (
    <ToggleGroupPrimitive
      ref={trackRef}
      aria-label={ariaLabel}
      data-slot="segmented-control"
      value={[value]}
      onValueChange={(next: string[]) => {
        // A segmented control always has exactly one selection; ignore the
        // toggle-off event produced by clicking the already pressed option.
        const selected = next.find((entry) => entry !== value) ?? next[0];
        if (selected !== undefined && selected !== value) {
          onValueChange(selected as Value);
        }
      }}
      className={cn(
        "relative inline-flex w-fit shrink-0 items-center bg-muted",
        sizeClasses.track,
        className,
      )}
    >
      {indicator ? (
        <span
          aria-hidden="true"
          data-slot="segmented-control-indicator"
          className={cn(
            "pointer-events-none absolute top-0.5 bottom-0.5 left-0 bg-card shadow-xs/5 dark:bg-input/70",
            size === "xs" ? "rounded-sm" : "rounded-md",
            hasMeasured
              ? "transition-[translate,width] duration-(--duration-base) ease-out motion-reduce:transition-none"
              : "",
          )}
          style={{ translate: `${indicator.left}px 0`, width: indicator.width }}
        />
      ) : null}
      {options.map((option) => (
        <TogglePrimitive
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          aria-label={option.ariaLabel}
          data-segment=""
          className={cn(
            "focus-ring relative z-10 inline-flex cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap font-medium text-muted-foreground transition-colors duration-(--duration-fast) hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-pressed:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0",
            sizeClasses.item,
          )}
        >
          {option.label}
        </TogglePrimitive>
      ))}
    </ToggleGroupPrimitive>
  );
}
