import type { UsageStatsDay } from "@cafecode/contracts";
import { uiFormatDateTime, uiLabelList, uiText } from "@cafecode/shared/i18n";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useUiLocale, useUiPresentation } from "~/i18n";
import { buildActivityCalendar } from "./activityCalendar";

import { usageDayToUtcDayIndex, utcDayIndexToUsageDay } from "./usageRange";

/** ~6 months of history, GitHub-style week columns. */
/** Bounded calendars keep readable cells instead of stretching seven days across a card. */
const BOUNDED_CELL_SIZE_REM = 0.875;
const BOUNDED_CELL_GAP_REM = 0.1875;
/** Settings may grow cells, but never turn a short calendar into enormous squares. */
const RESPONSIVE_MAX_CELL_SIZE_REM = 1.5;
/** Weekday labels share the same gutter in both month and day rows. */
const WEEKDAY_GUTTER_REM = 1.75;
/** The scale must fit even when a one-week calendar is narrower than its legend. */
const MIN_LEGEND_WIDTH_REM = 9;
/**
 * At most two years are cheap to lay out in full. Longer calendars retain their
 * complete scroll extent but materialize only the viewport plus nearby weeks.
 * Bounds admit four-digit years, so a valid old date must not allocate millions
 * of empty day objects or DOM nodes merely because All was selected.
 */
const VIRTUALIZE_AFTER_WEEKS = 104;
const VIRTUAL_WEEK_OVERSCAN = 4;
const DEFAULT_ROOT_FONT_SIZE = 16;
const DEFAULT_VIEWPORT_WIDTH = 640;
/**
 * Steepness of the exponential intensity curve. Higher spreads the top of the
 * range apart (peak days stand out more) at the cost of dimming mid days.
 */
const CURVE_STEEPNESS = 2;
const MONTH_LABELS = uiLabelList([
  () => uiText("Jan"),
  () => uiText("Feb"),
  () => uiText("Mar"),
  () => uiText("Apr"),
  () => uiText("May"),
  () => uiText("Jun"),
  () => uiText("Jul"),
  () => uiText("Aug"),
  () => uiText("Sep"),
  () => uiText("Oct"),
  () => uiText("Nov"),
  () => uiText("Dec"),
] as const);
/** GitHub labels alternating weekday rows; row 0 is Sunday. */
const WEEKDAY_LABELS = [
  { day: "sunday", label: "" },
  {
    day: "monday",
    get label() {
      return uiText("Mon");
    },
  },
  { day: "tuesday", label: "" },
  {
    day: "wednesday",
    get label() {
      return uiText("Wed");
    },
  },
  { day: "thursday", label: "" },
  {
    day: "friday",
    get label() {
      return uiText("Fri");
    },
  },
  { day: "saturday", label: "" },
] as const;

function dayKeyOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Softmax-style relative scale: a day's weight is e^(k·n) with n its share of
 * the busiest visible day, normalized so the busiest day is exactly 1 and an
 * empty day is exactly 0. The domain is anchored at zero rather than the
 * quietest day, so a stretch with no idle days still reads as uniformly warm
 * instead of stretching to fill the whole ramp. The convex curve keeps
 * mid-sized days visibly dimmer than the peak (the previous concave curve
 * rendered a 3h day nearly identical to a 5h one).
 */
function intensityOf(generatingMs: number, maxMs: number): number {
  if (generatingMs <= 0 || maxMs <= 0) {
    return 0;
  }
  const share = Math.min(1, generatingMs / maxMs);
  return Math.expm1(CURVE_STEEPNESS * share) / Math.expm1(CURVE_STEEPNESS);
}

/**
 * Sequential single-hue scale: the user's accent composited over the surface,
 * so perceived lightness runs monotonically from the empty-cell neutral to the
 * full accent in both themes. Nonzero days keep a small floor above the empty
 * color so "a little" is still distinguishable from "none".
 */
function cellColor(intensity: number): string {
  if (intensity <= 0) {
    return "color-mix(in oklab, var(--color-muted-foreground) 12%, transparent)";
  }
  const percent = Math.round(100 * (0.15 + 0.85 * intensity));
  return `color-mix(in oklab, var(--color-primary) ${percent}%, transparent)`;
}

function formatCellDuration(generatingMs: number): string {
  if (generatingMs <= 0) {
    return uiText("No generating time");
  }
  const totalSeconds = Math.round(generatingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  // The complete label owns unit order and conditional spacing. Preserve the
  // existing display policy (seconds hidden when hours are present), without
  // constructing English-only unit fragments outside the catalog.
  return uiText(
    "{hasHours, select, yes {{hours}h{hasMinutes, select, yes { {minutes}m} other {}}} other {{hasMinutes, select, yes {{minutes}m{hasSeconds, select, yes { {seconds}s} other {}}} other {{seconds}s}}}} generating",
    {
      hours,
      minutes,
      seconds,
      hasHours: hours > 0 ? "yes" : "no",
      hasMinutes: minutes > 0 ? "yes" : "no",
      hasSeconds: seconds > 0 ? "yes" : "no",
    },
  );
}

function formatCellDate(dayKey: string): string {
  // UTC is a calendar representation here, not a conversion of the server's
  // local day into a browser-local instant. Explicit UTC formatting keeps both
  // the weekday and date stable across browser timezones and DST transitions.
  const dayIndex = usageDayToUtcDayIndex(dayKey);
  if (dayIndex === undefined) return dayKey;
  const date = new Date(dayIndex * 86_400_000);
  return uiFormatDateTime(date, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

interface HeatmapCell {
  readonly dayKey: string;
  readonly generatingMs: number;
  readonly inRange: boolean;
}

interface HeatmapWeek {
  readonly index: number;
  readonly cells: ReadonlyArray<HeatmapCell>;
}

interface CalendarViewport {
  readonly calendarKey: string;
  readonly scrollLeft: number;
  readonly width: number;
  readonly rootFontSize: number;
}

interface HoveredCell {
  readonly dayKey: string;
  /** Cell center, in fractions of the grid box, for tooltip placement. */
  readonly xFraction: number;
  readonly yFraction: number;
  /** Hide a tooltip as soon as its calendar is replaced by another range. */
  readonly calendarKey: string;
  /** Bounded calendars place their tooltip outside the horizontal scroller. */
  readonly anchorX: number;
  readonly anchorY: number;
}

/**
 * GitHub-style activity calendar: week columns x 7 day rows,
 * colored by generating time per day relative to the busiest day shown. One
 * shared tooltip follows the hovered cell instead of one instance per cell.
 */
export function ActivityHeatmap({
  days,
  today,
  bounds,
  layout = "compact",
  className,
}: {
  days: ReadonlyArray<UsageStatsDay>;
  /** Live value for today's cell; supersedes the fetched history. */
  today?: UsageStatsDay | undefined;
  /** Inclusive server-local calendar keys. Omission preserves the 26-week default. */
  bounds?: { readonly startDay: string; readonly endDay: string } | undefined;
  /** Opt-in Settings layout; compact/unbounded consumers retain their existing geometry. */
  layout?: "compact" | "responsive";
  className?: string;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [hovered, setHovered] = useState<HoveredCell | null>(null);
  const calendarViewportRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const viewportGeometryRef = useRef<{
    readonly width: number;
    readonly height: number;
    readonly rootFontSize: number;
  } | null>(null);
  const [viewport, setViewport] = useState<CalendarViewport | null>(null);
  const bounded = bounds !== undefined;
  const responsive = bounded && layout === "responsive";
  const startDayKey = bounds?.startDay;
  const endDayKey = bounds?.endDay;
  const todayDayKey = today?.day;
  const todayGeneratingMs = today?.generatingMs;
  const byDay = useMemo(() => new Map(days.map((day) => [day.day, day.generatingMs])), [days]);

  const { rangeStart, start, endDay, weekCount, historicalMaxMs, calendarKey } = useMemo(() => {
    return buildActivityCalendar({
      byDay,
      bounded,
      startDayKey,
      endDayKey,
      todayDayKey,
      browserDay: dayKeyOf(new Date()),
    });
  }, [byDay, todayDayKey, bounded, startDayKey, endDayKey]);
  const todayDayIndex = todayDayKey === undefined ? undefined : usageDayToUtcDayIndex(todayDayKey);
  const maxMs =
    todayDayIndex !== undefined && todayDayIndex >= rangeStart && todayDayIndex <= endDay
      ? Math.max(historicalMaxMs, todayGeneratingMs ?? 0)
      : historicalMaxMs;

  const virtualized = bounded && weekCount > VIRTUALIZE_AFTER_WEEKS;
  // The viewport snapshot belongs to an exact calendar. Range changes begin at
  // its first week even before the layout effect resets the real scroll offset.
  const currentViewport = viewport?.calendarKey === calendarKey ? viewport : null;
  const rootFontSize = currentViewport?.rootFontSize ?? DEFAULT_ROOT_FONT_SIZE;
  const viewportWidth = currentViewport?.width ?? DEFAULT_VIEWPORT_WIDTH;
  // Measure the full available viewport, not the centered, shrink-wrapped grid.
  // Otherwise its initial compact width would prevent it from ever growing.
  // Overflow and virtualized history keep the original pitch so resize does not
  // change the day at an existing scroll offset. One/two-week calendars stay
  // compact rather than visually overstating an extremely short history.
  const availableGridWidthRem =
    viewportWidth / rootFontSize - WEEKDAY_GUTTER_REM - BOUNDED_CELL_GAP_REM;
  const fittedCellSizeRem =
    (availableGridWidthRem - Math.max(0, weekCount - 1) * BOUNDED_CELL_GAP_REM) /
    Math.max(1, weekCount);
  const cellSizeRem =
    responsive && !virtualized && weekCount > 2
      ? Math.max(BOUNDED_CELL_SIZE_REM, Math.min(RESPONSIVE_MAX_CELL_SIZE_REM, fittedCellSizeRem))
      : BOUNDED_CELL_SIZE_REM;
  const weekPitchRem = cellSizeRem + BOUNDED_CELL_GAP_REM;
  const gridWidthRem = weekCount * cellSizeRem + Math.max(0, weekCount - 1) * BOUNDED_CELL_GAP_REM;
  const calendarWidthRem = WEEKDAY_GUTTER_REM + BOUNDED_CELL_GAP_REM + gridWidthRem;
  const weekSizePx = weekPitchRem * rootFontSize;
  const visibleWeekCount = Math.ceil(viewportWidth / weekSizePx);
  const firstVisibleWeek = Math.floor((currentViewport?.scrollLeft ?? 0) / weekSizePx);
  const firstRenderedWeek = virtualized ? Math.max(0, firstVisibleWeek - VIRTUAL_WEEK_OVERSCAN) : 0;
  const endRenderedWeek = virtualized
    ? Math.min(weekCount, firstVisibleWeek + visibleWeekCount + VIRTUAL_WEEK_OVERSCAN + 1)
    : weekCount;
  const renderedWeekCount = Math.max(0, endRenderedWeek - firstRenderedWeek);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !bounded) return;
    scroller.scrollLeft = 0;
    const observeViewport = () => {
      const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      const next = {
        calendarKey,
        scrollLeft: scroller.scrollLeft,
        width: scroller.clientWidth,
        rootFontSize: rootFontSize > 0 ? rootFontSize : DEFAULT_ROOT_FONT_SIZE,
      };
      const geometry = { ...next, height: scroller.clientHeight };
      const previousGeometry = viewportGeometryRef.current;
      // Hover anchors are pointer-entry coordinates. A centered calendar can
      // move even when its capped cells keep the same size. Retire that anchor
      // on a real geometry change instead of showing a tooltip over the old
      // cell position; ordinary live updates keep both hover and scroll intact.
      if (
        previousGeometry &&
        (previousGeometry.width !== geometry.width ||
          previousGeometry.height !== geometry.height ||
          previousGeometry.rootFontSize !== geometry.rootFontSize)
      ) {
        setHovered(null);
      }
      viewportGeometryRef.current = geometry;
      setViewport((current) =>
        current?.calendarKey === next.calendarKey &&
        current.scrollLeft === next.scrollLeft &&
        current.width === next.width &&
        current.rootFontSize === next.rootFontSize
          ? current
          : next,
      );
    };
    observeViewport();
    // Both viewport width and cell height change with interface scaling. The
    // observer remeasures the rem unit so scrolling retains exact day alignment.
    const observer = new ResizeObserver(observeViewport);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [bounded, calendarKey]);

  const { weeks, monthLabelByWeek } = useMemo(() => {
    const columns: HeatmapWeek[] = [];
    const labels = new Map<number, string>();
    let previousMonth =
      firstRenderedWeek > 0
        ? new Date(
            Math.max(start + (firstRenderedWeek - 1) * 7, rangeStart) * 86_400_000,
          ).getUTCMonth()
        : -1;
    for (let week = firstRenderedWeek; week < endRenderedWeek; week += 1) {
      const column: HeatmapCell[] = [];
      for (let weekday = 0; weekday < 7; weekday += 1) {
        const dayIndex = start + week * 7 + weekday;
        const inRange = dayIndex >= rangeStart && dayIndex <= endDay;
        // Alignment padding can cross the four-digit calendar boundary at
        // year 0000/9999. Preserve expanded ISO years there so inert cells still
        // have unique keys; selected dates remain canonical server day keys.
        const dayKey = inRange
          ? utcDayIndexToUsageDay(dayIndex)
          : new Date(dayIndex * 86_400_000).toISOString().split("T")[0]!;
        // Alignment cells are empty even if fetched history contains activity
        // there; neither their color nor the selected range's intensity scale
        // may be influenced by dates outside the requested calendar.
        const generatingMs = inRange
          ? dayKey === todayDayKey
            ? (todayGeneratingMs ?? 0)
            : (byDay.get(dayKey) ?? 0)
          : 0;
        column.push({ dayKey, generatingMs, inRange });
      }
      const firstOfColumn = new Date(Math.max(start + week * 7, rangeStart) * 86_400_000);
      // Label a column when the month changes at its start, skipping a label
      // crammed into the very last columns.
      if (firstOfColumn.getUTCMonth() !== previousMonth) {
        if (bounded || week > 0 || firstOfColumn.getUTCDate() <= 7) {
          labels.set(week, uiPresentation.MONTH_LABELS[firstOfColumn.getUTCMonth()] ?? "");
        }
        previousMonth = firstOfColumn.getUTCMonth();
      }
      columns.push({ index: week, cells: column });
    }
    return {
      weeks: columns,
      monthLabelByWeek: labels,
    };
  }, [
    firstRenderedWeek,
    endRenderedWeek,
    start,
    rangeStart,
    endDay,
    byDay,
    bounded,
    todayDayKey,
    todayGeneratingMs,
    uiPresentation,
  ]);
  const activeHover = hovered?.calendarKey === calendarKey ? hovered : null;
  const tooltipDuration = activeHover
    ? uiPresentation.formatCellDuration(
        activeHover.dayKey === todayDayKey
          ? (todayGeneratingMs ?? 0)
          : (byDay.get(activeHover.dayKey) ?? 0),
      )
    : "";
  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    const calendarViewport = calendarViewportRef.current;
    if (!bounded || !activeHover || !tooltip || !calendarViewport) return;
    // The scroll viewport can be narrower than a date tooltip. Clamp its actual
    // measured width inside the panel rather than assuming a fixed text length
    // or relying on fractions that only work on a wide calendar.
    const maxLeft = Math.max(0, calendarViewport.clientWidth - tooltip.offsetWidth);
    tooltip.style.left = `${Math.max(0, Math.min(activeHover.anchorX - tooltip.offsetWidth / 2, maxLeft))}px`;
  }, [bounded, activeHover, tooltipDuration, viewport]);
  const gridStyle = {
    gridTemplateColumns: `repeat(${renderedWeekCount}, minmax(0, 1fr))`,
    ...(bounded
      ? {
          width: `${gridWidthRem}rem`,
          // Padding replaces offscreen columns while preserving full extent and
          // the exact same week positions for cells and month labels.
          paddingLeft: `${firstRenderedWeek * weekPitchRem}rem`,
          paddingRight: `${(weekCount - endRenderedWeek) * weekPitchRem}rem`,
        }
      : {}),
  };

  // Anchor the tooltip to the hovered cell's near edge close to the grid
  // borders so its overhang isn't clipped by the card's `overflow-hidden`;
  // center it everywhere in between.
  const tooltipAlignClass =
    activeHover === null
      ? "-translate-x-1/2"
      : activeHover.xFraction < 0.2
        ? "translate-x-0"
        : activeHover.xFraction > 0.8
          ? "-translate-x-full"
          : "-translate-x-1/2";
  const tooltip =
    activeHover !== null ? (
      <div
        ref={tooltipRef}
        className={`pointer-events-none absolute z-10 ${bounded ? "" : tooltipAlignClass} ${bounded && activeHover.yFraction < 2 / 7 ? "translate-y-[6px]" : "-translate-y-[calc(100%+6px)]"} whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-2xs text-popover-foreground shadow-md/5`}
        style={{
          left: bounded ? activeHover.anchorX : `${activeHover.xFraction * 100}%`,
          top: bounded ? activeHover.anchorY : `${activeHover.yFraction * 100}%`,
          ...(bounded
            ? ({ maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere" } as const)
            : {}),
        }}
        role="tooltip"
        data-activity-tooltip-day={activeHover.dayKey}
      >
        <span className="font-medium">{tooltipDuration}</span>
        <span className="text-muted-foreground"> · {formatCellDate(activeHover.dayKey)}</span>
      </div>
    ) : null;

  return (
    <div className={bounded ? `min-w-0 max-w-full ${className ?? ""}` : className}>
      <div
        ref={calendarViewportRef}
        className="relative flex w-full min-w-0 max-w-full flex-col gap-1.5"
      >
        <div
          ref={scrollerRef}
          className={bounded ? "min-w-0 max-w-full overflow-x-auto pb-1" : "w-full"}
          data-activity-heatmap-scroll={bounded ? "true" : undefined}
          role={virtualized ? "region" : undefined}
          aria-label={
            virtualized
              ? uiText("Scroll through daily activity history", undefined, undefined, uiLocale)
              : undefined
          }
          tabIndex={virtualized ? 0 : undefined}
          onScroll={
            bounded
              ? (event) => {
                  setHovered(null);
                  const scrollLeft = event.currentTarget.scrollLeft;
                  setViewport((current) =>
                    current?.calendarKey === calendarKey ? { ...current, scrollLeft } : current,
                  );
                }
              : undefined
          }
        >
          <div
            className={
              bounded
                ? `flex w-max flex-col gap-1.5 ${responsive ? "mx-auto" : ""}`
                : "flex w-full flex-col gap-1.5"
            }
          >
            <div className={bounded ? "flex gap-[0.1875rem]" : "flex gap-[3px]"} aria-hidden>
              <div className="w-7 shrink-0" />
              <div
                className={
                  bounded
                    ? "grid shrink-0 gap-[0.1875rem] text-2xs leading-none text-subtle-foreground"
                    : "grid flex-1 gap-[3px] text-2xs leading-none text-subtle-foreground"
                }
                style={gridStyle}
              >
                {weeks.map((column) => (
                  <span
                    key={column.cells[0]?.dayKey}
                    className={
                      bounded
                        ? "h-3 overflow-visible whitespace-nowrap"
                        : "h-3 overflow-visible whitespace-nowrap"
                    }
                  >
                    {monthLabelByWeek.get(column.index) ?? ""}
                  </span>
                ))}
              </div>
            </div>
            <div className={bounded ? "flex gap-[0.1875rem]" : "flex gap-[3px]"}>
              <div
                className={
                  bounded
                    ? "grid w-7 shrink-0 grid-rows-7 gap-[0.1875rem] text-2xs leading-none text-subtle-foreground"
                    : "grid w-7 shrink-0 grid-rows-7 gap-[3px] text-2xs leading-none text-subtle-foreground"
                }
                aria-hidden
              >
                {uiPresentation.WEEKDAY_LABELS.map(({ day, label }) => (
                  <span key={day} className="flex items-center">
                    {label}
                  </span>
                ))}
              </div>
              <div
                className={
                  bounded
                    ? "relative grid shrink-0 gap-[0.1875rem]"
                    : "relative grid flex-1 gap-[3px]"
                }
                style={gridStyle}
                role="img"
                data-activity-range-day-count={Math.max(0, endDay - rangeStart + 1)}
                aria-label={
                  bounds
                    ? uiText(
                        "Daily generating time from {value0} through {value1}; brighter cells mean more time.",
                        { value0: bounds.startDay, value1: bounds.endDay },
                        undefined,
                        uiLocale,
                      )
                    : uiText(
                        "Daily generating time for the last few months; brighter cells mean more time.",
                        undefined,
                        undefined,
                        uiLocale,
                      )
                }
                onPointerLeave={() => setHovered(null)}
              >
                {weeks.map((column) => (
                  <div
                    key={column.cells[0]?.dayKey}
                    className={
                      bounded ? "grid grid-rows-7 gap-[0.1875rem]" : "grid grid-rows-7 gap-[3px]"
                    }
                  >
                    {column.cells.map((cell, weekday) =>
                      cell.inRange ? (
                        <div
                          key={cell.dayKey}
                          data-activity-day={cell.dayKey}
                          data-activity-in-range="true"
                          className="aspect-square w-full rounded-xs ring-1 ring-inset ring-border-subtle transition-colors duration-(--duration-slow) hover:ring-muted-foreground motion-reduce:transition-none"
                          style={{
                            backgroundColor: cellColor(intensityOf(cell.generatingMs, maxMs)),
                          }}
                          onPointerEnter={(event) => {
                            const viewport = calendarViewportRef.current?.getBoundingClientRect();
                            const cellBox = event.currentTarget.getBoundingClientRect();
                            const anchorX =
                              cellBox.left + cellBox.width / 2 - (viewport?.left ?? 0);
                            setHovered({
                              dayKey: cell.dayKey,
                              calendarKey,
                              anchorX,
                              anchorY: cellBox.top + cellBox.height / 2 - (viewport?.top ?? 0),
                              xFraction:
                                bounded && viewport
                                  ? anchorX / viewport.width
                                  : (column.index + 0.5) / weekCount,
                              yFraction: (weekday + 0.5) / 7,
                            });
                          }}
                        />
                      ) : (
                        <div
                          key={cell.dayKey}
                          data-activity-day={cell.dayKey}
                          data-activity-in-range="false"
                          className="aspect-square w-full"
                          aria-hidden
                        />
                      ),
                    )}
                  </div>
                ))}
                {!bounded ? tooltip : null}
              </div>
            </div>
          </div>
        </div>
        {bounded ? tooltip : null}
        <div
          data-activity-heatmap-legend="true"
          className="flex items-center justify-end gap-1.5 pt-0.5 text-2xs leading-none text-subtle-foreground"
          style={
            responsive
              ? {
                  // Keep the scale attached to the centered calendar, rather
                  // than stranded at the far edge of a wide Settings card.
                  width: `${Math.max(MIN_LEGEND_WIDTH_REM, calendarWidthRem)}rem`,
                  maxWidth: "100%",
                  marginInline: "auto",
                }
              : undefined
          }
        >
          <span>{uiText("Less", undefined, undefined, uiLocale)}</span>
          {[0, 0.25, 0.5, 0.75, 1].map((intensity) => (
            <span
              key={intensity}
              className="size-2.5 rounded-xs ring-1 ring-inset ring-border-subtle"
              style={{ backgroundColor: cellColor(intensity) }}
              aria-hidden
            />
          ))}
          <span>{uiText("More", undefined, undefined, uiLocale)}</span>
        </div>
      </div>
    </div>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { MONTH_LABELS, WEEKDAY_LABELS, formatCellDuration };
