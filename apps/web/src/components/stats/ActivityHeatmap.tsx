import { useMemo, useState } from "react";
import type { UsageStatsDay } from "@cafecode/contracts";

/** A day at this much generating time renders fully saturated. */
const FULL_INTENSITY_MS = 5 * 60 * 60 * 1000;
/** ~3 months of history, GitHub-style week columns. */
const WEEKS = 14;
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

function dayKeyOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Sequential single-hue scale: the user's accent composited over the surface,
 * so perceived lightness runs monotonically from the empty-cell neutral to the
 * full accent in both themes. The exponent lifts short-but-real days above the
 * noise floor, GitHub-style.
 */
function cellColor(generatingMs: number): string {
  if (generatingMs <= 0) {
    return "color-mix(in oklab, var(--color-muted-foreground) 12%, transparent)";
  }
  const intensity = Math.min(1, generatingMs / FULL_INTENSITY_MS);
  const percent = Math.round(100 * (0.18 + 0.82 * Math.pow(intensity, 0.6)));
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
 * GitHub-style activity calendar: 53 week columns x 7 day rows ending today,
 * colored by generating time per day. One shared tooltip follows the hovered
 * cell instead of 371 tooltip instances.
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

  const { weeks, monthLabelByWeek } = useMemo(() => {
    const byDay = new Map(days.map((day) => [day.day, day.generatingMs]));
    if (today !== undefined) {
      byDay.set(today.day, today.generatingMs);
    }

    const now = new Date();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    // Start on the Sunday that begins the column 52 weeks back.
    const start = new Date(endOfToday.getTime());
    start.setDate(start.getDate() - start.getDay() - (WEEKS - 1) * 7);

    const columns: Array<Array<HeatmapCell>> = [];
    const labels = new Map<number, string>();
    let previousMonth = -1;
    for (let week = 0; week < WEEKS; week += 1) {
      const column: Array<HeatmapCell> = [];
      for (let weekday = 0; weekday < 7; weekday += 1) {
        const date = new Date(start.getTime());
        date.setDate(date.getDate() + week * 7 + weekday);
        const dayKey = dayKeyOf(date);
        column.push({
          dayKey,
          generatingMs: byDay.get(dayKey) ?? 0,
          inRange: date.getTime() <= endOfToday.getTime(),
        });
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
    return { weeks: columns, monthLabelByWeek: labels };
  }, [days, today]);

  return (
    <div className={className}>
      <div className="flex w-full flex-col gap-1.5">
        <div
          className="grid gap-[3px] text-[9px] leading-none text-muted-foreground/70"
          style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}
          aria-hidden
        >
          {Array.from({ length: WEEKS }, (_, week) => (
            <span key={week} className="h-[10px] overflow-visible whitespace-nowrap">
              {monthLabelByWeek.get(week) ?? ""}
            </span>
          ))}
        </div>
        <div
          className="relative grid gap-[3px]"
          style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))` }}
          role="img"
          aria-label="Daily generating time for the last year; darker cells mean more time."
          onPointerLeave={() => setHovered(null)}
        >
          {weeks.map((column, week) => (
            <div key={column[0]?.dayKey ?? week} className="grid grid-rows-7 gap-[3px]">
              {column.map((cell, weekday) =>
                cell.inRange ? (
                  <div
                    key={cell.dayKey}
                    className="aspect-square w-full rounded-[2px] transition-colors duration-300 hover:ring-1 hover:ring-foreground/40 motion-reduce:transition-none"
                    style={{ backgroundColor: cellColor(cell.generatingMs) }}
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
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+6px)] whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-md"
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
        <div className="flex items-center justify-end gap-1.5 pt-0.5 text-[10px] leading-none text-muted-foreground/70">
          <span>Less</span>
          {[0, 0.05, 0.25, 0.6, 1].map((fraction) => (
            <span
              key={fraction}
              className="size-[10px] rounded-[2px]"
              style={{ backgroundColor: cellColor(fraction * FULL_INTENSITY_MS) }}
              aria-hidden
            />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
}
