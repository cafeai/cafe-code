import { useMemo, useState, type ReactNode } from "react";
import type { ProviderDriverKind, UsageStatsGetResult } from "@cafecode/contracts";
import { rollUpCost, resolveModelRate, type ModelRate } from "@cafecode/shared/modelPricing";

import { useSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { UsageAreaChart, type UsageChartSeries } from "../stats/UsageAreaChart";
import { useCountUp } from "../stats/useCountUp";
import { dailyUsageCost } from "../stats/dailyUsageCost";
import { selectUsageRange, type UsageRangeKey } from "../stats/usageRange";
import { UsageRangeSelector } from "../stats/UsageRangeSelector";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsSection } from "./settingsLayout";
import {
  formatCompactTokenCount,
  formatFullTokenCount,
  formatGeneratingTime,
  formatUsageModelLabel,
  getUsageModelExplanation,
  formatUsageProviderLabel,
  formatUsageRecordingDate,
} from "./usageStatsPresentation";

/**
 * Cost and token composition for the Usage page.
 *
 * Everything here is derived client-side from recorded counters plus the
 * pricing table; nothing is fetched. The headline is deliberately labelled as a
 * standard API-rate estimate (or a user-defined rate). The aggregate ledger
 * does not retain individual request sizes or service tiers, so it cannot
 * reproduce long-context or speed-tier adjustments or subscription charges.
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
/** Keep the familiar dollar sign while naming the accounting currency. */
function formatUsd(value: number): string {
  return `${currency.format(value)} USD`;
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
const INITIAL_VISIBLE_MODEL_ROWS = 12;

interface ModelCostRow {
  readonly provider: ProviderDriverKind;
  readonly model: string;
  readonly cost: number;
  readonly priced: boolean;
  readonly tokens: number;
  readonly hasTokenUsage: boolean;
  generatingMs: number | undefined;
}

const TOKEN_BAND_COLORS = {
  cached: "#48cfff",
  fresh: "#a78bfa",
  written: "#fbbf24",
  output: "#4ade80",
} as const;

type TokenFigureContext =
  | "provider"
  | "range"
  | "model"
  | "reasoning"
  | `composition-${"processed" | "cached" | "uncached" | "output"}`;

/**
 * Every usage surface follows one hierarchy: the complete counter is the
 * readable, animated value; the abbreviated figure is supporting context.
 * Keeping the order here prevents the Settings and Atrium copies from drifting
 * back into different visual conventions.
 */
function TokenCountFigure({
  value,
  context,
  primarySuffix = " tokens",
  className,
  primaryClassName,
  compactClassName,
  align = "left",
}: {
  value: number;
  context: TokenFigureContext;
  primarySuffix?: ReactNode;
  className?: string;
  primaryClassName?: string;
  compactClassName?: string;
  align?: "left" | "right";
}) {
  return (
    <div
      className={cn("min-w-0", align === "right" && "text-right", className)}
      data-usage-token-figure={context}
    >
      <div
        className={cn(
          "break-words text-sm font-medium tabular-nums text-foreground [overflow-wrap:anywhere]",
          primaryClassName,
        )}
        data-usage-token-full={context}
      >
        {formatFullTokenCount(value)}
        {primarySuffix}
      </div>
      <div
        className={cn("mt-0.5 text-[10px] tabular-nums text-muted-foreground/70", compactClassName)}
        aria-hidden="true"
        data-usage-token-compact={context}
      >
        {formatCompactTokenCount(value)}
      </div>
    </div>
  );
}

type TokenCompositionId = "processed" | "cached" | "uncached" | "output";
type StatTileProps =
  | {
      id: TokenCompositionId;
      label: string;
      rawTokens: number;
      detail?: ReactNode;
    }
  | {
      id: "cache-savings";
      label: string;
      value: string;
      detail?: ReactNode;
    };

function StatTile(props: StatTileProps) {
  return (
    <div className="min-w-0 px-4 py-3" data-usage-composition-tile={props.id}>
      <div className="text-[11px] text-muted-foreground">{props.label}</div>
      {"rawTokens" in props ? (
        <TokenCountFigure
          value={props.rawTokens}
          context={`composition-${props.id}`}
          className="mt-1"
          primaryClassName="text-lg sm:text-xl"
          compactClassName="text-[11px]"
        />
      ) : (
        <div
          className="mt-1 break-words text-lg font-medium tabular-nums text-foreground [overflow-wrap:anywhere]"
          data-usage-composition-value={props.id}
        >
          {props.value}
        </div>
      )}
      {props.detail ? (
        <div className="mt-0.5 break-words text-[11px] text-muted-foreground/70 [overflow-wrap:anywhere]">
          {props.detail}
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
export function UsageCostContent({
  usage,
  range: controlledRange,
  showRangeSelector = true,
}: {
  usage: UsageStatsGetResult | null;
  range?: UsageRangeKey;
  showRangeSelector?: boolean;
}) {
  const [localRange, setLocalRange] = useState<UsageRangeKey>("30");
  const range = controlledRange ?? localRange;
  const [mode, setMode] = useState<Mode>("cost");
  const selected = useMemo(
    () => (usage === null ? null : selectUsageRange(usage, range)),
    [usage, range],
  );

  // The mode survives period changes, but the numeric odometers must not:
  // tweening lifetime counters into a seven-day figure briefly labels values
  // from another period as if they belonged to the new one.
  return (
    <UsageCostMetrics
      key={`${range}:${selected?.today.day ?? "loading"}`}
      usage={selected}
      mode={mode}
      setMode={setMode}
      range={range}
      setRange={setLocalRange}
      showRangeSelector={showRangeSelector && controlledRange === undefined}
    />
  );
}

function UsageCostMetrics({
  usage,
  mode,
  setMode,
  range,
  setRange,
  showRangeSelector,
}: {
  usage: UsageStatsGetResult | null;
  mode: Mode;
  setMode: (mode: Mode) => void;
  range: UsageRangeKey;
  setRange: (range: UsageRangeKey) => void;
  showRangeSelector: boolean;
}) {
  const [showAllModels, setShowAllModels] = useState(false);
  const overrides = useSettings((settings) => settings.modelPricingOverrides) as
    | Record<string, ModelRate>
    | undefined;

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
    const models: ModelCostRow[] = breakdown.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      cost: rollUpCost([entry], overrides).cost,
      priced: resolveModelRate(entry.model, overrides) !== undefined,
      tokens: entry.inputTokens + entry.outputTokens,
      hasTokenUsage: true,
      generatingMs: undefined,
    }));
    const modelRows = new Map<ProviderDriverKind, Map<string, ModelCostRow>>();
    for (const entry of models) {
      let providerRows = modelRows.get(entry.provider);
      if (providerRows === undefined) {
        providerRows = new Map();
        modelRows.set(entry.provider, providerRows);
      }
      providerRows.set(entry.model, entry);
    }
    let modelTimeAvailable = usage?.modelGeneratingTime !== undefined;
    for (const time of usage?.modelGeneratingTime?.totals ?? []) {
      let providerRows = modelRows.get(time.provider);
      if (providerRows === undefined) {
        providerRows = new Map();
        modelRows.set(time.provider, providerRows);
      }
      let entry = providerRows.get(time.model);
      if (entry === undefined) {
        // Time can be observed before the first token report. Add a visible
        // row without feeding it into token/cost rollups or inventing a cost.
        entry = {
          provider: time.provider,
          model: time.model,
          cost: 0,
          priced: false,
          tokens: 0,
          hasTokenUsage: false,
          generatingMs: undefined,
        };
        providerRows.set(time.model, entry);
        models.push(entry);
      }
      const previousMs = entry.generatingMs ?? 0;
      if (
        !Number.isSafeInteger(time.generatingMs) ||
        time.generatingMs < 0 ||
        time.generatingMs > Number.MAX_SAFE_INTEGER - previousMs
      ) {
        // Do not display rounded/partial durations from a corrupt or
        // mixed-version response. This matches backend/finite-range omission.
        modelTimeAvailable = false;
        break;
      }
      entry.generatingMs = previousMs + time.generatingMs;
    }
    const visibleModels = modelTimeAvailable
      ? models
      : models.filter((entry) => entry.hasTokenUsage);
    if (!modelTimeAvailable) {
      for (const entry of visibleModels) entry.generatingMs = undefined;
    }
    visibleModels.sort(
      (left, right) =>
        right.cost - left.cost ||
        right.tokens - left.tokens ||
        (right.generatingMs ?? 0) - (left.generatingMs ?? 0),
    );

    const totals = usage?.totals;
    const cached = totals?.cachedInputTokens ?? 0;
    const written = totals?.cacheWriteInputTokens ?? 0;
    const input = totals?.inputTokens ?? 0;
    const output = totals?.outputTokens ?? 0;

    return {
      rollup,
      providers,
      models: visibleModels,
      modelTimeAvailable,
      processed: input + output,
      input,
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
  // full counters alongside their compact forms without creating one RAF loop
  // per provider or model row.
  const processedDisplay = useCountUp(view.processed);
  const cachedDisplay = useCountUp(view.cached);
  const freshDisplay = useCountUp(view.fresh);
  const outputDisplay = useCountUp(view.output);

  const chart = useMemo(() => {
    const days = usage?.days ?? [];
    const labels = days.map((day) => day.day.slice(5));
    // All may contain lifetime volume predating the daily ledger. Keep the
    // range counter consistent with the dashboard rather than silently drop
    // that history simply because it cannot be placed on the daily graph.
    const rangeTokens = view.processed;
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
          // Cache writes are already included in processed input, but not in
          // either the cached-read or fresh-input band. Keep them explicit so
          // the stacked graph accounts for the same tokens as the totals.
          key: "written",
          label: "Cache writes",
          color: TOKEN_BAND_COLORS.written,
          values: days.map((day) => day.cacheWriteInputTokens),
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
        hasUnpriced: false,
        format: (value: number) =>
          `${formatFullTokenCount(value)} tokens (${formatCompactTokenCount(value)})`,
      };
    }

    const pricedDays = usage === null ? [] : dailyUsageCost(usage, overrides);
    const dailyCosts = new Map(pricedDays.map((day) => [day.day, day]));
    const series: UsageChartSeries[] = [
      {
        key: "cost",
        label: "Estimated cost",
        color: TOKEN_BAND_COLORS.cached,
        values: days.map((day) => dailyCosts.get(day.day)?.cost ?? 0),
      },
    ];
    return {
      labels,
      series,
      rangeTokens,
      hasUnpriced: days.some((day) => (dailyCosts.get(day.day)?.unpricedTokens ?? 0) > 0),
      format: (value: number) => formatUsd(value),
    };
  }, [usage, mode, overrides, view.processed]);

  // Missing model attribution is real recorded usage, but has no trustworthy
  // rate. Include that gap in cost quality instead of implying 100% coverage.
  const share = Math.max(view.processed, view.rollup.pricedTokens + view.rollup.unpricedTokens);
  const unpricedTokens = Math.max(0, share - view.rollup.pricedTokens);
  const pricedPercent = share === 0 ? null : (view.rollup.pricedTokens / share) * 100;
  const maxProviderCost = Math.max(0, ...view.providers.map((entry) => entry.cost));
  const recordingStartedAt = view.modelTimeAvailable
    ? usage?.modelGeneratingTime?.startedAt
    : undefined;
  const recordedSince =
    recordingStartedAt === undefined ? undefined : formatUsageRecordingDate(recordingStartedAt);
  const recordingUtc =
    recordedSince && recordingStartedAt ? new Date(recordingStartedAt).toISOString() : undefined;
  const modelTimeExplanation =
    "Time spent generating covers full active-turn time, including tools and waits. Concurrent chats count separately. " +
    (recordingUtc
      ? `Recording began ${recordingUtc} (UTC); earlier history is not included. `
      : "Earlier history is not included. ") +
    "Models without a recorded time row show Not recorded.";

  return (
    // This content also appears in Atrium. Container queries must live here,
    // rather than assume either surface occupies the full browser viewport.
    <div className="@container/usage-cost min-w-0" data-usage-cost-layout>
      <div className="flex flex-wrap items-center justify-end gap-3 px-4 pt-3 sm:px-5">
        {showRangeSelector ? <UsageRangeSelector value={range} onChange={setRange} /> : null}
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
      <div
        className="grid gap-5 px-4 py-4 sm:px-5 @min-[52rem]/usage-cost:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]"
        data-usage-cost-overview
      >
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
            * USD estimate at standard API rates or your custom rates. Excludes long-context and
            speed-tier adjustments; not your subscription bill.
          </div>

          <div className="mt-5 flex flex-col gap-3">
            {view.providers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No model-attributed token usage recorded yet.
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
                    <TokenCountFigure value={entry.tokens} context="provider" className="mt-1" />
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
            {chart.hasUnpriced ? (
              <span className="text-muted-foreground/70">
                Partial estimate: usage without daily model pricing is excluded.
              </span>
            ) : null}
            <TokenCountFigure
              value={chart.rangeTokens}
              context="range"
              primarySuffix=" tokens in range"
              className="min-w-[9rem]"
              primaryClassName="text-xs"
            />
            {mode === "tokens" ? (
              <span className="ml-auto flex items-center gap-3">
                {(
                  [
                    ["Cached", TOKEN_BAND_COLORS.cached],
                    ["Fresh", TOKEN_BAND_COLORS.fresh],
                    ["Cache writes", TOKEN_BAND_COLORS.written],
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
          <UsageAreaChart
            labels={chart.labels}
            series={chart.series}
            format={chart.format}
            displayHeight="clamp(12rem, 24cqw, 20rem)"
          />
        </div>
      </div>

      {/* Composition tiles */}
      {/* Fit readable metrics instead of dividing a narrow settings column
          into five cells merely because the overall window is wide. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] divide-x divide-y divide-border/60 border-t border-border/60">
        <StatTile
          id="processed"
          label="Processed tokens"
          rawTokens={processedDisplay}
          detail={
            view.hasInputDetail
              ? "Includes cached input read again on each request"
              : "output only before token detail"
          }
        />
        <StatTile
          id="cached"
          label="Cached input"
          rawTokens={cachedDisplay}
          detail={
            view.input > 0
              ? `${((view.cached / view.input) * 100).toFixed(1)}% of input`
              : undefined
          }
        />
        <StatTile id="uncached" label="Uncached input" rawTokens={freshDisplay} />
        <StatTile
          id="output"
          label="Output"
          rawTokens={outputDisplay}
          detail={
            view.reasoning > 0 ? (
              <TokenCountFigure
                value={view.reasoning}
                context="reasoning"
                primarySuffix=" reasoning tokens"
                primaryClassName="text-[11px] font-normal text-muted-foreground/70"
              />
            ) : undefined
          }
        />
        <StatTile
          id="cache-savings"
          label="Net cache savings (USD)"
          value={formatUsd(view.rollup.cacheSavings)}
          detail={
            view.rollup.cacheSavings < 0
              ? "Cache writes cost more than reads have saved"
              : "Read discounts minus cache-write premiums"
          }
        />
      </div>

      {/* Breakdown + cost quality */}
      <div
        className="grid gap-5 border-t border-border/60 px-4 py-4 sm:px-5 @min-[52rem]/usage-cost:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]"
        data-usage-cost-breakdown
      >
        <div className="min-w-0">
          <div className="min-w-0 max-w-full overflow-x-auto" data-usage-model-table-scroll>
            <table className="w-full min-w-[36rem] border-collapse text-sm" data-usage-model-table>
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="min-w-[8rem] py-1.5 text-left font-medium">
                    Model
                  </th>
                  <th scope="col" className="py-1.5 pl-3 text-right font-medium">
                    Cost (USD)
                  </th>
                  <th scope="col" className="py-1.5 pl-3 text-right font-medium">
                    Tokens
                  </th>
                  <th scope="col" className="min-w-[8rem] py-1.5 pl-4 text-right font-medium">
                    <Tooltip>
                      <TooltipTrigger
                        className="cursor-help text-right uppercase underline decoration-dotted underline-offset-2"
                        aria-label="About time spent generating"
                      >
                        Time spent generating
                      </TooltipTrigger>
                      <TooltipPopup role="tooltip" className="max-w-[20rem]">
                        {modelTimeExplanation}
                      </TooltipPopup>
                    </Tooltip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.models.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-3 text-xs text-muted-foreground">
                      Nothing recorded yet.
                    </td>
                  </tr>
                ) : (
                  (showAllModels
                    ? view.models
                    : view.models.slice(0, INITIAL_VISIBLE_MODEL_ROWS)
                  ).map((entry) => {
                    const Icon = PROVIDER_ICON_BY_PROVIDER[entry.provider as never];
                    return (
                      <tr
                        key={JSON.stringify([entry.provider, entry.model])}
                        className="border-t border-border/50"
                        data-usage-model={entry.model}
                        data-usage-provider={entry.provider}
                      >
                        <td className="max-w-[20rem] py-1.5 pr-3">
                          <span className="flex min-w-0 items-center gap-1.5">
                            {Icon ? <Icon className="size-3.5 shrink-0 opacity-70" /> : null}
                            <span
                              className="truncate"
                              title={getUsageModelExplanation(entry.model)}
                            >
                              {formatUsageModelLabel(entry.model)}
                            </span>
                          </span>
                        </td>
                        <td
                          className="py-1.5 pl-3 text-right tabular-nums"
                          data-usage-model-cost-value="true"
                        >
                          {!entry.hasTokenUsage ? (
                            <span className="text-muted-foreground">—</span>
                          ) : entry.priced ? (
                            formatUsd(entry.cost)
                          ) : (
                            <span className="text-muted-foreground">unpriced</span>
                          )}
                        </td>
                        <td className="py-1.5 pl-3 text-right tabular-nums text-muted-foreground">
                          <TokenCountFigure
                            value={entry.tokens}
                            context="model"
                            primarySuffix=""
                            align="right"
                          />
                        </td>
                        <td
                          className="whitespace-nowrap py-1.5 pl-4 text-right text-[11px] tabular-nums text-muted-foreground"
                          data-usage-model-generating-time
                        >
                          {entry.generatingMs === undefined
                            ? "Not recorded"
                            : formatGeneratingTime(entry.generatingMs)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] leading-relaxed text-muted-foreground/70">
            <p data-usage-model-time-coverage>
              {recordedSince && recordingUtc ? (
                <>
                  Recorded since <time dateTime={recordingUtc}>{recordedSince}</time>
                </>
              ) : (
                "Per-model time is unavailable on this server."
              )}
            </p>
            {view.models.length > INITIAL_VISIBLE_MODEL_ROWS ? (
              <button
                type="button"
                className="shrink-0 text-foreground underline underline-offset-2 hover:text-primary"
                aria-expanded={showAllModels}
                onClick={() => setShowAllModels((value) => !value)}
              >
                {showAllModels ? "Show fewer models" : `Show all ${view.models.length} models`}
              </button>
            ) : null}
          </div>
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
                {pricedPercent === null ? "—" : formatShare(100 - pricedPercent, unpricedTokens)}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-muted-foreground">Net cache savings (USD)</dt>
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
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/70">
            Priced share covers recorded tokens only. Interrupted provider requests may not report
            all usage, so these totals are estimates, not a complete billing record.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Settings → Usage placement. */
export function UsageCostSection({
  usage,
  range,
}: {
  usage: UsageStatsGetResult | null;
  range: UsageRangeKey;
}) {
  return (
    <SettingsSection title="Cost (USD)">
      <UsageCostContent usage={usage} range={range} showRangeSelector={false} />
    </SettingsSection>
  );
}
