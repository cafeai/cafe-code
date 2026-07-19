import { useMemo, useState } from "react";
import type { UsageStatsDay } from "@cafecode/contracts";

/** ~6 months of history, GitHub-style week columns. */
const WEEKS = 26;
/**
 * Steepness of the exponential intensity curve. Higher spreads the top of the
 * range apart (peak days stand out more) at the cost of dimming mid days.
 */
const CURVE_STEEPNESS = 2;
const MONTH_LABELS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** GitHub labels alternating weekday rows; row 0 is Sunday. */
const WEEKDAY_LABELS = [
  { day: "sunday", label: "" },
  { day: "monday", label: "Mon" },
  { day: "tuesday", label: "" },
  { day: "wednesday", label: "Wed" },
  { day: "thursday", label: "" },
  { day: "friday", label: "Fri" },
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
    return "No generating time";
  }
  const totalSeconds = Math.round(generatingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: Array<string> = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (hours === 0 && (seconds > 0 || parts.length === 0)) parts.push(`${seconds}s`);
  return `${parts.join(" ")} generating`;
}

function formatCellDate(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

interface HeatmapCell {
  readonly dayKey: string;
  readonly generatingMs: number;
  readonly inRange: boolean;
}

interface HoveredCell {
  readonly dayKey: string;
  readonly generatingMs: number;
  /** Cell center, in fractions of the grid box, for tooltip placement. */
  readonly xFraction: number;
  readonly yFraction: number;
}

/**
 * GitHub-style activity calendar: week columns x 7 day rows ending today,
 * colored by generating time per day relative to the busiest day shown. One
 * shared tooltip follows the hovered cell instead of one instance per cell.
 */
export function ActivityHeatmap({
  days,
  today,
  className,
}: {
  days: ReadonlyArray<UsageStatsDay>;
  /** Live value for today's cell; supersedes the fetched history. */
  today?: UsageStatsDay | undefined;
  className?: string;
}) {
  const [hovered, setHovered] = useState<HoveredCell | null>(null);

  const { weeks, monthLabelByWeek, maxMs } = useMemo(() => {
    const byDay = new Map(days.map((day) => [day.day, day.generatingMs]));
    if (today !== undefined) {
      byDay.set(today.day, today.generatingMs);
    }

    const now = new Date();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Start on the Sunday that begins the earliest column.
    const start = new Date(endOfToday.getTime());
    start.setDate(start.getDate() - start.getDay() - (WEEKS - 1) * 7);

    const columns: Array<Array<HeatmapCell>> = [];
    const labels = new Map<number, string>();
    let previousMonth = -1;
    let max = 0;
    for (let week = 0; week < WEEKS; week += 1) {
      const column: Array<HeatmapCell> = [];
      for (let weekday = 0; weekday < 7; weekday += 1) {
        const date = new Date(start.getTime());
        date.setDate(date.getDate() + week * 7 + weekday);
        const dayKey = dayKeyOf(date);
        const inRange = date.getTime() <= endOfToday.getTime();
        const generatingMs = byDay.get(dayKey) ?? 0;
        if (inRange && generatingMs > max) {
          max = generatingMs;
        }
        column.push({ dayKey, generatingMs, inRange });
      }
      const firstOfColumn = new Date(start.getTime());
      firstOfColumn.setDate(firstOfColumn.getDate() + week * 7);
      // Label a column when the month changes at its start, skipping a label
      // crammed into the very last columns.
      if (firstOfColumn.getMonth() !== previousMonth) {
        if (week > 0 || firstOfColumn.getDate() <= 7) {
          labels.set(week, MONTH_LABELS[firstOfColumn.getMonth()] ?? "");
        }
        previousMonth = firstOfColumn.getMonth();
      }
      columns.push(column);
    }
    return { weeks: columns, monthLabelByWeek: labels, maxMs: max };
  }, [days, today]);

  // Anchor the tooltip to the hovered cell's near edge close to the grid
  // borders so its overhang isn't clipped by the card's `overflow-hidden`;
  // center it everywhere in between.
  const tooltipAlignClass =
    hovered === null
      ? "-translate-x-1/2"
      : hovered.xFraction < 0.2
        ? "translate-x-0"
        : hovered.xFraction > 0.8
          ? "-translate-x-full"
          : "-translate-x-1/2";

  return (
    <div className={className}>
      <div className="flex w-full flex-col gap-1.5">
        <div className="flex gap-[3px]" aria-hidden>
          <div className="w-7 shrink-0" />
          <div
            className="grid flex-1 gap-[3px] text-[9px] leading-none text-muted-foreground/70"
            style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: WEEKS }, (_, week) => (
              <span key={week} className="h-[10px] overflow-visible whitespace-nowrap">
                {monthLabelByWeek.get(week) ?? ""}
              </span>
            ))}
          </div>
        </div>
        <div className="flex gap-[3px]">
          <div
            className="grid w-7 shrink-0 grid-rows-7 gap-[3px] text-[9px] leading-none text-muted-foreground/70"
            aria-hidden
          >
            {WEEKDAY_LABELS.map(({ day, label }) => (
              <span key={day} className="flex items-center">
                {label}
              </span>
            ))}
          </div>
          <div
            className="relative grid flex-1 gap-[3px]"
            style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}
            role="img"
            aria-label="Daily generating time for the last few months; brighter cells mean more time."
            onPointerLeave={() => setHovered(null)}
          >
            {weeks.map((column, week) => (
              <div key={column[0]?.dayKey ?? week} className="grid grid-rows-7 gap-[3px]">
                {column.map((cell, weekday) =>
                  cell.inRange ? (
                    <div
                      key={cell.dayKey}
                      className="aspect-square w-full rounded-[2px] ring-1 ring-inset ring-foreground/[0.06] transition-colors duration-300 hover:ring-foreground/40 motion-reduce:transition-none"
                      style={{ backgroundColor: cellColor(intensityOf(cell.generatingMs, maxMs)) }}
                      onPointerEnter={() =>
                        setHovered({
                          dayKey: cell.dayKey,
                          generatingMs: cell.generatingMs,
                          xFraction: (week + 0.5) / WEEKS,
                          yFraction: (weekday + 0.5) / 7,
                        })
                      }
                    />
                  ) : (
                    <div key={cell.dayKey} className="aspect-square w-full" />
                  ),
                )}
              </div>
            ))}
            {hovered !== null ? (
              <div
                className={`pointer-events-none absolute z-10 ${tooltipAlignClass} -translate-y-[calc(100%+6px)] whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md`}
                style={{
                  left: `${hovered.xFraction * 100}%`,
                  top: `${hovered.yFraction * 100}%`,
                }}
              >
                <span className="font-medium">{formatCellDuration(hovered.generatingMs)}</span>
                <span className="text-muted-foreground"> · {formatCellDate(hovered.dayKey)}</span>
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center justify-end gap-1.5 pt-0.5 text-[10px] leading-none text-muted-foreground/70">
          <span>Less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((intensity) => (
            <span
              key={intensity}
              className="size-[10px] rounded-[2px] ring-1 ring-inset ring-foreground/[0.06]"
              style={{ backgroundColor: cellColor(intensity) }}
              aria-hidden
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
