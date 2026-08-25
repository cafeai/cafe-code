import { useMemo, useState, type ReactNode } from "react";
import type { ProviderDriverKind, UsageStatsGetResult } from "@cafecode/contracts";
import { rollUpCost, resolveModelRate, type ModelRate } from "@cafecode/shared/modelPricing";

import { useSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { UsageAreaChart, type UsageChartSeries } from "../stats/UsageAreaChart";
import { useCountUp } from "../stats/useCountUp";
import { SettingsSection } from "./settingsLayout";
import { formatUsageModelLabel, formatUsageProviderLabel } from "./usageStatsPresentation";

/**
 * Cost and token composition for the Usage page.
 *
 * Everything here is derived client-side from recorded counters plus the
 * pricing table; nothing is fetched. The headline is deliberately labelled as a
 * raw API-rate figure, because that is what it is — it is what the tokens would
 * cost billed at list price, not what anyone was actually charged under a
 * subscription.
 *
 * Two honesty rules run through the whole section. Models with no rate are
 * counted but never costed, and the priced share is shown so a partial figure
 * cannot read as the whole spend. Days recorded before token detail existed
 * carry output only, so their input reads as zero rather than as free.
 */

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const integers = new Intl.NumberFormat("en-US");

/** Keep the familiar dollar sign while naming the accounting currency. */
function formatUsd(value: number): string {
  return `${currency.format(value)} USD`;
}

function fullTokens(value: number): string {
  return integers.format(Math.round(value));
}

/** `48B` / `46.2B` / `142M` — the compact form the reference uses. */
function compactTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(abs < 10e9 ? 2 : 1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs < 10e6 ? 2 : 0)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs < 10e3 ? 1 : 0)}K`;
  return integers.format(Math.round(value));
}

/**
 * Never round a non-zero share away. Reporting "0.0% unpriced" while a model
 * in the table plainly reads "unpriced" makes the figure look wrong and hides
 * the very thing this panel exists to disclose.
 */
function formatShare(percent: number, tokens: number): string {
  if (tokens > 0 && percent < 0.1) return "<0.1%";
  if (tokens === 0) return "0.0%";
  return `${percent.toFixed(1)}%`;
}

type Mode = "cost" | "tokens";

/**
 * Chart window. The daily ledger is the only day-indexed data we have, so a
 * range narrows the chart and the in-range subtotal beside it. The headline and
 * the model table stay lifetime figures — those come from the per-model ledger,
 * which carries no day dimension, and silently relabelling them as ranged would
 * be a lie.
 */
const RANGES = [
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
  { key: "90", label: "90 days", days: 90 },
  { key: "all", label: "All", days: Number.POSITIVE_INFINITY },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

const TOKEN_BAND_COLORS = {
  cached: "#48cfff",
  fresh: "#a78bfa",
  output: "#4ade80",
} as const;

function StatTile({
  id,
  label,
  value,
  rawTokens,
  detail,
}: {
  id: "processed" | "cached" | "uncached" | "output" | "cache-savings";
  label: string;
  value: string;
  rawTokens?: number | undefined;
  detail?: ReactNode;
}) {
  return (
    <div className="min-w-0 px-4 py-3" data-usage-composition-tile={id}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div
        className="mt-1 break-words text-lg font-medium tabular-nums text-foreground [overflow-wrap:anywhere]"
        data-usage-composition-compact={rawTokens === undefined ? undefined : id}
        data-usage-composition-value={id}
      >
        {value}
      </div>
      {rawTokens === undefined ? null : (
        <div
          className="mt-0.5 break-words text-[11px] tabular-nums text-muted-foreground [overflow-wrap:anywhere]"
          data-usage-composition-raw={id}
        >
          {fullTokens(rawTokens)} tokens exact
        </div>
      )}
      {detail ? (
        <div className="mt-0.5 break-words text-[11px] text-muted-foreground/70 [overflow-wrap:anywhere]">
          {detail}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The cost panels, without surrounding chrome.
 *
 * Rendered both inside Settings and over the Task Atrium's scene, so it stays
 * surface-agnostic: colours come from theme tokens and the caller owns the
 * background, padding and heading.
 */
export function UsageCostContent({ usage }: { usage: UsageStatsGetResult | null }) {
  const overrides = useSettings((settings) => settings.modelPricingOverrides) as
    | Record<string, ModelRate>
    | undefined;
  const [mode, setMode] = useState<Mode>("cost");
  const [range, setRange] = useState<RangeKey>("30");

  const view = useMemo(() => {
    const breakdown = usage?.tokenBreakdown ?? [];
    const rollup = rollUpCost(breakdown, overrides);

    // Per provider, for the split bars.
    const byProvider = new Map<
      ProviderDriverKind,
      { cost: number; tokens: number; priced: boolean }
    >();
    for (const entry of breakdown) {
      const rate = resolveModelRate(entry.model, overrides);
      const tokens = entry.inputTokens + entry.outputTokens;
      const current = byProvider.get(entry.provider) ?? { cost: 0, tokens: 0, priced: false };
      current.tokens += tokens;
      if (rate) {
        current.priced = true;
        current.cost += rollUpCost([entry], overrides).cost;
      }
      byProvider.set(entry.provider, current);
    }
    const providers = [...byProvider.entries()]
      .map(([provider, value]) => ({
        provider,
        cost: value.cost,
        tokens: value.tokens,
        priced: value.priced,
      }))
      .toSorted((left, right) => right.cost - left.cost || right.tokens - left.tokens);

    // Per model, for the breakdown table.
    const models = breakdown
      .map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        cost: rollUpCost([entry], overrides).cost,
        priced: resolveModelRate(entry.model, overrides) !== undefined,
        tokens: entry.inputTokens + entry.outputTokens,
      }))
      .toSorted((left, right) => right.cost - left.cost || right.tokens - left.tokens);

    const totals = usage?.totals;
    const cached = totals?.cachedInputTokens ?? 0;
    const written = totals?.cacheWriteInputTokens ?? 0;
    const input = totals?.inputTokens ?? 0;
    const output = totals?.outputTokens ?? 0;

    return {
      rollup,
      providers,
      models,
      processed: input + output,
      cached,
      written,
      fresh: Math.max(0, input - cached - written),
      output,
      reasoning: totals?.reasoningOutputTokens ?? 0,
      // The ledger only began recording input later; a history with output but
      // no input at all is unmeasured, not free, and must not be costed.
      hasInputDetail: input > 0,
    };
  }, [usage, overrides]);

  // Same shared counter as the token odometer; currency just settles on cents.
  const costDisplay = useCountUp(view.rollup.cost, { decimals: 2 });
  // These four hooks are aggregate and cardinality-bounded. They animate the
  // exact counters alongside their compact forms without creating one RAF loop
  // per provider or model row.
  const processedDisplay = useCountUp(view.processed);
  const cachedDisplay = useCountUp(view.cached);
  const freshDisplay = useCountUp(view.fresh);
  const outputDisplay = useCountUp(view.output);

  const chart = useMemo(() => {
    const all = usage?.days ?? [];
    const window = RANGES.find((entry) => entry.key === range)?.days ?? 30;
    const days = Number.isFinite(window) ? all.slice(-window) : all;
    const labels = days.map((day) => day.day.slice(5));
    const rangeTokens = days.reduce((total, day) => total + day.inputTokens + day.outputTokens, 0);
    if (mode === "tokens") {
      const series: UsageChartSeries[] = [
        {
          key: "cached",
          label: "Cached input",
          color: TOKEN_BAND_COLORS.cached,
          values: days.map((day) => day.cachedInputTokens),
        },
        {
          key: "fresh",
          label: "Fresh input",
          color: TOKEN_BAND_COLORS.fresh,
          values: days.map((day) =>
            Math.max(0, day.inputTokens - day.cachedInputTokens - day.cacheWriteInputTokens),
          ),
        },
        {
          key: "output",
          label: "Output",
          color: TOKEN_BAND_COLORS.output,
          values: days.map((day) => day.outputTokens),
        },
      ];
      return {
        labels,
        series,
        rangeTokens,
        format: (value: number) =>
          `${compactTokens(value)} tokens (${fullTokens(value)} tokens exact)`,
      };
    }

    // Daily rows carry no model dimension, so cost per day is approximated with
    // the blended rate implied by the lifetime ledger. Labelled as an estimate
    // wherever it is shown, because it is one.
    const blended = view.rollup.pricedTokens > 0 ? view.rollup.cost / view.rollup.pricedTokens : 0;
    const series: UsageChartSeries[] = [
      {
        key: "cost",
        label: "Estimated cost",
        color: TOKEN_BAND_COLORS.cached,
        values: days.map((day) => (day.inputTokens + day.outputTokens) * blended),
      },
    ];
    return { labels, series, rangeTokens, format: (value: number) => formatUsd(value) };
  }, [usage, mode, range, view.rollup]);

  const share = view.rollup.pricedTokens + view.rollup.unpricedTokens;
  const pricedPercent = share === 0 ? null : (view.rollup.pricedTokens / share) * 100;
  const maxProviderCost = Math.max(0, ...view.providers.map((entry) => entry.cost));

  return (
    <>
      <div className="flex justify-end px-4 pt-3 sm:px-5">
        <div className="flex overflow-hidden rounded-md border border-border/70 text-[11px]">
          {(["cost", "tokens"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMode(option)}
              aria-pressed={mode === option}
              className={cn(
                "px-2.5 py-1 uppercase tracking-wide transition-colors",
                mode === option
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-5 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* Hero + provider split */}
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Raw token cost (USD)
          </div>
          <div
            className="mt-1 max-w-full break-words text-3xl font-light tracking-tight tabular-nums text-foreground [overflow-wrap:anywhere] sm:text-4xl"
            data-usage-cost-hero-value="true"
          >
            {formatUsd(costDisplay)}
            <span className="align-super text-base text-muted-foreground">*</span>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground/70">
            * estimated in USD if billed at full API rate
          </div>

          <div className="mt-5 flex flex-col gap-3">
            {view.providers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No model-attributed usage recorded yet.
              </p>
            ) : (
              view.providers.map((entry) => {
                const Icon = PROVIDER_ICON_BY_PROVIDER[entry.provider as never];
                const width =
                  maxProviderCost > 0 ? Math.max(2, (entry.cost / maxProviderCost) * 100) : 0;
                return (
                  <div key={entry.provider} className="min-w-0">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
                        {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
                        <span className="truncate">{formatUsageProviderLabel(entry.provider)}</span>
                      </span>
                      <span
                        className="ml-auto max-w-full break-words text-right text-sm tabular-nums text-foreground [overflow-wrap:anywhere]"
                        data-usage-provider-cost-value="true"
                      >
                        {entry.priced ? formatUsd(entry.cost) : "unpriced"}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-foreground/80"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-1.5 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground/70">
                      <span data-usage-provider-token-compact="true">
                        {compactTokens(entry.tokens)} tokens
                      </span>
                      <span aria-hidden="true">·</span>
                      <span data-usage-provider-token-raw="true">
                        {fullTokens(entry.tokens)} tokens exact
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Chart */}
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span data-usage-cost-chart-label="true">
              {mode === "cost" ? "Estimated daily cost (USD)" : "Daily tokens"}
            </span>
            <div className="flex overflow-hidden rounded-md border border-border/70">
              {RANGES.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  onClick={() => setRange(entry.key)}
                  aria-pressed={range === entry.key}
                  className={cn(
                    "px-2 py-0.5 transition-colors",
                    range === entry.key ? "bg-foreground text-background" : "hover:text-foreground",
                  )}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <span className="flex flex-wrap gap-x-1.5 tabular-nums text-muted-foreground/70">
              <span data-usage-range-token-compact="true">
                {compactTokens(chart.rangeTokens)} tokens in range
              </span>
              <span aria-hidden="true">·</span>
              <span data-usage-range-token-raw="true">
                {fullTokens(chart.rangeTokens)} tokens exact
              </span>
            </span>
            {mode === "tokens" ? (
              <span className="ml-auto flex items-center gap-3">
                {(
                  [
                    ["Cached", TOKEN_BAND_COLORS.cached],
                    ["Fresh", TOKEN_BAND_COLORS.fresh],
                    ["Output", TOKEN_BAND_COLORS.output],
                  ] as const
                ).map(([label, color]) => (
                  <span key={label} className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full"
                      style={{ background: color }}
                    />
                    {label}
                  </span>
                ))}
              </span>
            ) : null}
          </div>
          <UsageAreaChart labels={chart.labels} series={chart.series} format={chart.format} />
        </div>
      </div>

      {/* Composition tiles */}
      <div className="grid grid-cols-2 divide-x divide-y divide-border/60 border-t border-border/60 sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
        <StatTile
          id="processed"
          label="Processed tokens"
          value={compactTokens(processedDisplay)}
          rawTokens={processedDisplay}
          detail={view.hasInputDetail ? undefined : "output only before token detail"}
        />
        <StatTile
          id="cached"
          label="Cached input"
          value={compactTokens(cachedDisplay)}
          rawTokens={cachedDisplay}
          detail={
            view.cached + view.fresh > 0
              ? `${((view.cached / (view.cached + view.fresh)) * 100).toFixed(1)}% of input`
              : undefined
          }
        />
        <StatTile
          id="uncached"
          label="Uncached input"
          value={compactTokens(freshDisplay)}
          rawTokens={freshDisplay}
        />
        <StatTile
          id="output"
          label="Output"
          value={compactTokens(outputDisplay)}
          rawTokens={outputDisplay}
          detail={
            view.reasoning > 0 ? (
              <>
                includes{" "}
                <span className="tabular-nums" data-usage-reasoning-token-compact="true">
                  {compactTokens(view.reasoning)} reasoning
                </span>{" "}
                ·{" "}
                <span className="tabular-nums" data-usage-reasoning-token-raw="true">
                  {fullTokens(view.reasoning)} tokens exact
                </span>
              </>
            ) : undefined
          }
        />
        <StatTile
          id="cache-savings"
          label="Cache savings (USD)"
          value={formatUsd(view.rollup.cacheSavings)}
          detail={
            view.rollup.cost > 0
              ? `${(view.rollup.cacheSavings / view.rollup.cost).toFixed(1)}x the raw cost`
              : undefined
          }
        />
      </div>

      {/* Breakdown + cost quality */}
      <div className="grid gap-5 border-t border-border/60 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,240px)]">
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 text-left font-medium">Model</th>
                <th className="py-1.5 text-right font-medium">Cost (USD)</th>
                <th className="py-1.5 text-right font-medium">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {view.models.length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-3 text-xs text-muted-foreground">
                    Nothing recorded yet.
                  </td>
                </tr>
              ) : (
                view.models.slice(0, 12).map((entry) => {
                  const Icon = PROVIDER_ICON_BY_PROVIDER[entry.provider as never];
                  return (
                    <tr
                      key={`${entry.provider}:${entry.model}`}
                      className="border-t border-border/50"
                    >
                      <td className="py-1.5 pr-3">
                        <span className="flex min-w-0 items-center gap-1.5">
                          {Icon ? <Icon className="size-3.5 shrink-0 opacity-70" /> : null}
                          <span className="truncate">{formatUsageModelLabel(entry.model)}</span>
                        </span>
                      </td>
                      <td
                        className="py-1.5 text-right tabular-nums"
                        data-usage-model-cost-value="true"
                      >
                        {entry.priced ? (
                          formatUsd(entry.cost)
                        ) : (
                          <span className="text-muted-foreground">unpriced</span>
                        )}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                        <div data-usage-model-token-compact="true">
                          {compactTokens(entry.tokens)}
                        </div>
                        <div
                          className="text-[10px] text-muted-foreground/70"
                          data-usage-model-token-raw="true"
                        >
                          {fullTokens(entry.tokens)} exact
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Cost quality (USD estimates)
          </div>
          <dl className="mt-2 flex flex-col gap-1.5 text-sm">
            <div className="flex items-baseline gap-2">
              <dt className="text-muted-foreground">Priced</dt>
              <dd className="ml-auto tabular-nums">
                {pricedPercent === null
                  ? "—"
                  : formatShare(pricedPercent, view.rollup.pricedTokens)}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-muted-foreground">Unpriced</dt>
              <dd className="ml-auto tabular-nums">
                {pricedPercent === null
                  ? "—"
                  : formatShare(100 - pricedPercent, view.rollup.unpricedTokens)}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-muted-foreground">Cache savings (USD)</dt>
              <dd
                className="ml-auto break-words text-right tabular-nums [overflow-wrap:anywhere]"
                data-usage-cost-quality-cache-savings="true"
              >
                {formatUsd(view.rollup.cacheSavings)}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/70">
            Rates come from a bundled table. Add your own in Settings to price a model this build
            does not know.
          </p>
        </div>
      </div>
    </>
  );
}

/** Settings → Usage placement. */
export function UsageCostSection({ usage }: { usage: UsageStatsGetResult | null }) {
  return (
    <SettingsSection title="Cost (USD)">
      <UsageCostContent usage={usage} />
    </SettingsSection>
  );
}
