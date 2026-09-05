import { useId, useMemo, useState, type CSSProperties } from "react";

import { cn } from "../../lib/utils";

/**
 * Stacked area chart for daily usage.
 *
 * Hand-drawn SVG rather than a charting dependency: the app ships no chart
 * library, and this needs exactly one mark type, a gradient fill and a hover
 * readout. Every colour comes from the caller so the chart inherits the
 * ambiance accent rather than introducing a palette of its own.
 *
 * Series stack in the order given. Values are drawn against a shared maximum so
 * the bands read as parts of a whole, and the curve is a Catmull-Rom spline
 * converted to cubic béziers — a polyline reads as noise at daily resolution,
 * and smoothing is honest here because the underlying quantity is continuous.
 */

export interface UsageChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  /** One value per point, same length and order as `labels`. */
  readonly values: readonly number[];
}

export interface UsageAreaChartProps {
  readonly labels: readonly string[];
  readonly series: readonly UsageChartSeries[];
  /** Formats the hovered total and the axis ceiling. */
  readonly format: (value: number) => string;
  readonly className?: string;
  readonly height?: number;
}

const PADDING = { top: 14, right: 8, bottom: 20, left: 8 };

/**
 * Catmull-Rom through the points, emitted as cubic béziers. Tension is kept low
 * so the curve stays close to the data and cannot invent a peak between days.
 */
function smoothPath(points: ReadonlyArray<readonly [number, number]>): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0]![0]} ${points[0]![1]}`;
  let path = `M ${points[0]![0]} ${points[0]![1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const previous = points[Math.max(0, i - 1)]!;
    const current = points[i]!;
    const next = points[i + 1]!;
    const after = points[Math.min(points.length - 1, i + 2)]!;
    const c1x = current[0] + (next[0] - previous[0]) / 6;
    const c1y = current[1] + (next[1] - previous[1]) / 6;
    const c2x = next[0] - (after[0] - current[0]) / 6;
    const c2y = next[1] - (after[1] - current[1]) / 6;
    path += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${next[0]} ${next[1]}`;
  }
  return path;
}

export function UsageAreaChart({
  labels,
  series,
  format,
  className,
  height = 190,
}: UsageAreaChartProps) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const width = 1000; // viewBox units; the SVG scales to its container.

  const { bands, ceiling, totals } = useMemo(() => {
    const count = labels.length;
    const runningTotals: number[] = Array.from({ length: count }, () => 0);
    // Stack from the baseline up, remembering each band's lower edge.
    const stacked = series.map((entry) => {
      const lower = [...runningTotals];
      for (let i = 0; i < count; i++) {
        runningTotals[i] = (runningTotals[i] ?? 0) + Math.max(0, entry.values[i] ?? 0);
      }
      return { entry, lower, upper: [...runningTotals] };
    });
    const peak = Math.max(0, ...runningTotals);
    return { bands: stacked, ceiling: peak, totals: runningTotals };
  }, [labels.length, series]);

  const plotWidth = width - PADDING.left - PADDING.right;
  const plotHeight = height - PADDING.top - PADDING.bottom;
  const x = (index: number) =>
    PADDING.left + (labels.length <= 1 ? plotWidth / 2 : (index / (labels.length - 1)) * plotWidth);
  const y = (value: number) =>
    PADDING.top + plotHeight - (ceiling <= 0 ? 0 : (value / ceiling) * plotHeight);

  if (labels.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-xl border border-border/60 text-xs text-muted-foreground",
          className,
        )}
        style={{ height }}
      >
        No activity recorded yet
      </div>
    );
  }

  const hoveredTotal = hover === null ? null : (totals[hover] ?? 0);

  return (
    <div className={cn("relative", className)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height }}
        role="img"
        aria-label={`Daily usage across ${series.length} providers`}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (rect.width === 0) return;
          const ratio = (event.clientX - rect.left) / rect.width;
          const index = Math.round(ratio * (labels.length - 1));
          setHover(Math.max(0, Math.min(labels.length - 1, index)));
        }}
      >
        <defs>
          {series.map((entry, index) => (
            <linearGradient
              key={entry.key}
              id={`${gradientId}-${index}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={entry.color} stopOpacity="0.55" />
              <stop offset="100%" stopColor={entry.color} stopOpacity="0.06" />
            </linearGradient>
          ))}
        </defs>

        {/* Faint baseline and midline; a full grid would compete with the fill. */}
        {[0, 0.5, 1].map((fraction) => (
          <line
            key={fraction}
            x1={PADDING.left}
            x2={width - PADDING.right}
            y1={PADDING.top + plotHeight * fraction}
            y2={PADDING.top + plotHeight * fraction}
            stroke="currentColor"
            strokeWidth={1}
            className="text-border/50"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {bands.map((band, index) => {
          const upper = band.upper.map((value, i) => [x(i), y(value)] as const);
          const lower = band.lower.map((value, i) => [x(i), y(value)] as const);
          const lastLower = lower.at(-1);
          if (lastLower === undefined) return null;
          // Trace the upper edge, drop to the lower edge, and trace it back.
          const area = `${smoothPath(upper)} L ${lastLower[0]} ${lastLower[1]} ${smoothPath(
            lower.toReversed(),
          ).replace(/^M/, "L")} Z`;
          return (
            <g key={band.entry.key}>
              <path d={area} fill={`url(#${gradientId}-${index})`} />
              <path
                d={smoothPath(upper)}
                fill="none"
                stroke={band.entry.color}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {hover !== null ? (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={PADDING.top}
            y2={PADDING.top + plotHeight}
            stroke="currentColor"
            strokeWidth={1}
            className="text-foreground/40"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>

      {/* Axis ends only. Dense day labels are unreadable at this width. */}
      <div className="flex justify-between px-1 font-mono text-[10px] text-muted-foreground/70">
        <span>{labels[0]}</span>
        <span>{labels.at(-1)}</span>
      </div>

      {hover !== null ? (
        <div
          className="pointer-events-none absolute top-1 rounded-lg border border-border/70 bg-popover/95 px-2.5 py-1.5 text-[11px] shadow-lg backdrop-blur-sm"
          style={
            {
              left: `${(x(hover) / width) * 100}%`,
              transform: `translateX(${hover > labels.length / 2 ? "-105%" : "5%"})`,
            } as CSSProperties
          }
        >
          <div className="font-medium text-foreground">{labels[hover]}</div>
          <div className="mt-0.5 tabular-nums text-muted-foreground">
            {format(hoveredTotal ?? 0)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
