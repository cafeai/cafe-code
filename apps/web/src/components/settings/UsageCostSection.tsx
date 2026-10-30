import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import { useMemo, useState, type ReactNode } from "react";
import type { ProviderDriverKind, UsageStatsGetResult } from "@cafecode/contracts";
import { rollUpCost, type ModelRate } from "@cafecode/shared/modelPricing";

import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { useSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { UsageAreaChart, type UsageChartSeries } from "../stats/UsageAreaChart";
import { useCountUp } from "../stats/useCountUp";
import { dailyUsageCost } from "../stats/dailyUsageCost";
import { selectUsageRange, type UsageRangeKey } from "../stats/usageRange";
import { UsageRangeSelector } from "../stats/UsageRangeSelector";
import { Button } from "../ui/button";
import { InfoTip } from "../ui/info-tip";
import { SegmentedControl } from "../ui/segmented-control";
import { Skeleton } from "../ui/skeleton";
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
 * The shared usage response supplies recorded counters and optional settled
 * cost receipts. Native Axiom receipts retain their reported amounts; other
 * rows use a standard API-rate estimate (or a user-defined rate). The aggregate
 * counters cannot reproduce per-request long-context or speed-tier adjustments
 * or subscription charges. This component performs no provider requests.
 *
 * Two honesty rules run through the whole section. Models with no rate are
 * counted but never costed, and the priced share is shown so a partial figure
 * cannot read as the whole spend. Days recorded before token detail existed
 * carry output only, so their input reads as zero rather than as free.
 *
 * Currency is named once per surface (AGENTS.md usage-cost presentation): the
 * Settings section heading reads "Cost (USD)", while standalone content such as
 * Atrium labels its headline estimate instead. Individual values keep the
 * familiar dollar sign without repeating the currency code.
 */

const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
function formatUsd(value: number): string {
  return currency.format(value);
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
const MODE_OPTIONS = [
  {
    value: "cost",
    get label() {
      return uiText("Cost");
    },
  },
  {
    value: "tokens",
    get label() {
      return uiText("Tokens");
    },
  },
] as const satisfies ReadonlyArray<{ value: Mode; label: string }>;
const INITIAL_VISIBLE_MODEL_ROWS = 12;
/** Narrow enough that all five composition figures share one row on a wide page. */
const COMPOSITION_GRID_CLASS =
  "grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),1fr))] gap-x-6 gap-y-4 border-t border-border-subtle px-4 py-4 sm:px-5";
const OVERVIEW_GRID_CLASS =
  "grid gap-5 px-4 py-4 sm:px-5 @min-[52rem]/usage-cost:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]";
const CHART_DISPLAY_HEIGHT = "clamp(12rem, 24cqw, 20rem)";
const TOOLBAR_CLASS = "flex flex-wrap items-center justify-end gap-3 px-4 pt-3 sm:px-5";

interface ModelCostRow {
  readonly provider: ProviderDriverKind;
  readonly model: string;
  readonly cost: number;
  readonly priced: boolean;
  readonly reported: boolean;
  readonly tokens: number;
  readonly hasTokenUsage: boolean;
  generatingMs: number | undefined;
}

/**
 * Chart series colours are theme custom properties, so they follow light and
 * dark mode. The stacked token bands need four distinguishable hues that do not
 * depend on the user's accent: info blue (cache reads), neutral grey (uncached
 * input), warning amber (cache writes) and success green (output). The single
 * cost series uses the accent, like the Activity calendar.
 */
const TOKEN_BAND_COLORS = {
  cached: "var(--info)",
  fresh: "var(--muted-foreground)",
  written: "var(--warning)",
  output: "var(--success)",
} as const;
const COST_SERIES_COLOR = "var(--primary)";

type TokenFigureContext =
  | "provider"
  | "range"
  | "model"
  | "unattributed"
  | "reasoning"
  | `composition-${"processed" | "cached" | "uncached" | "output"}`;

/**
 * The complete counter is the primary, animated value; its abbreviated K/M/B
 * readout sits below in smaller text. Both derive from the same displayed
 * number, so even increments too small to change the abbreviation stay visible.
 * Hide only the redundant abbreviation from screen readers. Keeping this in
 * one component gives Settings and Atrium the same readable hierarchy.
 */
function TokenCountFigure({
  value,
  context,
  suffix = " tokens",
  stackSuffix = false,
  className,
  valueClassName,
  align = "left",
}: {
  value: number;
  context: TokenFigureContext;
  suffix?: string;
  stackSuffix?: boolean;
  className?: string;
  valueClassName?: string;
  align?: "left" | "right";
}) {
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const exact = formatFullTokenCount(value);
  return (
    <div
      className={cn("min-w-0", align === "right" && "text-right", className)}
      data-usage-token-figure={context}
    >
      <div
        className={cn(
          "break-words text-sm font-medium tabular-nums text-foreground [overflow-wrap:anywhere]",
          valueClassName,
        )}
        data-usage-token-full={context}
      >
        {exact}
        {stackSuffix ? <span className="block">{suffix}</span> : suffix}
      </div>
      <div
        className="mt-0.5 text-2xs tabular-nums text-subtle-foreground"
        aria-hidden="true"
        data-usage-token-compact={context}
      >
        {uiPresentation.formatCompactTokenCount(value)}
      </div>
    </div>
  );
}

/** Provider identity keeps its ticker state stable when cost ordering changes. */
function UsageProviderSummary({
  entry,
  maxCost,
}: {
  entry: Pick<ModelCostRow, "provider" | "cost" | "priced" | "tokens">;
  maxCost: number;
}) {
  const uiLocale = useUiLocale();

  const Icon = PROVIDER_ICON_BY_PROVIDER[entry.provider as never];
  const displayedCost = useCountUp(entry.cost, { decimals: 2 });
  const displayedTokens = useCountUp(entry.tokens);
  const width = maxCost > 0 ? Math.max(2, (entry.cost / maxCost) * 100) : 0;

  return (
    <div className="min-w-0" data-usage-provider-summary={entry.provider}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
          {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
          <span className="truncate">{formatUsageProviderLabel(entry.provider)}</span>
        </span>
        <span
          className={cn(
            "ml-auto max-w-full break-words text-right text-sm tabular-nums [overflow-wrap:anywhere]",
            entry.priced ? "text-foreground" : "text-muted-foreground",
          )}
          data-usage-provider-cost-value="true"
        >
          {entry.priced
            ? formatUsd(displayedCost)
            : uiText("Unpriced", undefined, undefined, uiLocale)}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground/80" style={{ width: `${width}%` }} />
      </div>
      <TokenCountFigure
        value={displayedTokens}
        context="provider"
        className="mt-1"
        valueClassName="text-xs font-normal text-muted-foreground"
      />
    </div>
  );
}

/**
 * A model row owns independent targets but uses the page-wide count-up frame
 * source. Keeping these hooks in a keyed component preserves each model's
 * displayed value across resorting without creating per-row RAF timers.
 */
function UsageModelRow({ entry }: { entry: ModelCostRow }) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const Icon = PROVIDER_ICON_BY_PROVIDER[entry.provider as never];
  const displayedCost = useCountUp(entry.cost, { decimals: 2 });
  const displayedTokens = useCountUp(entry.tokens);
  const displayedGeneratingMs = useCountUp(entry.generatingMs ?? 0);
  const label = uiPresentation.formatUsageModelLabel(entry.model);
  const explanation = uiPresentation.getUsageModelExplanation(entry.model);

  return (
    <tr
      className="border-t border-border-subtle"
      data-usage-model={entry.model}
      data-usage-provider={entry.provider}
      data-usage-cost-source={entry.reported ? "reported" : "estimated"}
    >
      <td className="max-w-[20rem] py-1.5 pr-3">
        <span className="flex min-w-0 items-center gap-1.5">
          {Icon ? <Icon className="size-3.5 shrink-0 opacity-70" /> : null}
          <span className="truncate">{label}</span>
          {explanation ? (
            <InfoTip label={uiText("About {value0}", { value0: label }, undefined, uiLocale)}>
              {explanation}
            </InfoTip>
          ) : null}
        </span>
      </td>
      <td className="py-1.5 pl-3 text-right tabular-nums" data-usage-model-cost-value="true">
        {!entry.hasTokenUsage ? (
          <span className="text-muted-foreground">
            {uiText("—", undefined, undefined, uiLocale)}
          </span>
        ) : entry.priced ? (
          <>
            {formatUsd(displayedCost)}
            {entry.reported ? (
              <span className="block text-2xs text-muted-foreground">
                {uiText("Reported", undefined, undefined, uiLocale)}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-muted-foreground">
            {uiText("Unpriced", undefined, undefined, uiLocale)}
          </span>
        )}
      </td>
      <td className="py-1.5 pl-3 text-right">
        <TokenCountFigure
          value={displayedTokens}
          context="model"
          suffix=""
          align="right"
          valueClassName="font-normal text-muted-foreground"
        />
      </td>
      <td
        className="whitespace-nowrap py-1.5 pl-4 text-right text-2xs tabular-nums text-muted-foreground"
        data-usage-model-generating-time
      >
        {entry.generatingMs === undefined
          ? uiText("Not recorded", undefined, undefined, uiLocale)
          : uiPresentation.formatGeneratingTime(displayedGeneratingMs)}
      </td>
    </tr>
  );
}

type TokenCompositionId = "processed" | "cached" | "uncached" | "output";
type StatTileProps = (
  | {
      id: TokenCompositionId;
      rawTokens: number;
    }
  | {
      id: "cache-savings";
      value: string;
    }
) & {
  label: string;
  /** Optional explanation, shown in an info tooltip beside the label. */
  info?: ReactNode;
  detail?: ReactNode;
};

function StatTile(props: StatTileProps) {
  const uiLocale = useUiLocale();

  return (
    <div className="min-w-0" data-usage-composition-tile={props.id}>
      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <span className="truncate">{props.label}</span>
        {props.info ? (
          <InfoTip label={uiText("About {value0}", { value0: props.label }, undefined, uiLocale)}>
            {props.info}
          </InfoTip>
        ) : null}
      </div>
      {"rawTokens" in props ? (
        <TokenCountFigure
          value={props.rawTokens}
          context={`composition-${props.id}`}
          stackSuffix
          className="mt-1"
          valueClassName="text-lg sm:text-xl"
        />
      ) : (
        <div
          className="mt-1 break-words text-lg font-medium tabular-nums text-foreground [overflow-wrap:anywhere] sm:text-xl"
          data-usage-composition-value={props.id}
        >
          {props.value}
        </div>
      )}
      {props.detail ? (
        <div className="mt-0.5 break-words text-2xs text-subtle-foreground [overflow-wrap:anywhere]">
          {props.detail}
        </div>
      ) : null}
    </div>
  );
}

/**
 * First-load placeholder with the same blocks as the loaded content, so data
 * arriving does not move the page. It stays invisible (but reserves space)
 * until `useDelayedFlag` says the wait is noticeable, so fast loads show
 * nothing at all (docs/style-guide.md §9).
 */
function UsageCostSkeleton({
  visible,
  showRangeSelector,
}: {
  visible: boolean;
  showRangeSelector: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("@container/usage-cost min-w-0", !visible && "invisible")}
      data-usage-cost-skeleton
    >
      <div className={TOOLBAR_CLASS}>
        {showRangeSelector ? <Skeleton className="h-7 w-52 rounded-lg" /> : null}
        <Skeleton className="h-7 w-32 rounded-lg" />
      </div>
      <div className={OVERVIEW_GRID_CLASS}>
        <div className="flex min-w-0 flex-col gap-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-10 w-40" />
          <div className="mt-4 flex flex-col gap-4">
            {[0, 1].map((row) => (
              <div key={row} className="flex flex-col gap-1.5">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-1 w-full rounded-full" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="w-full rounded-xl" style={{ height: CHART_DISPLAY_HEIGHT }} />
        </div>
      </div>
      <div className={COMPOSITION_GRID_CLASS}>
        {[0, 1, 2, 3, 4].map((tile) => (
          <div key={tile} className="flex flex-col gap-1.5">
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="h-6 w-24" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2.5 border-t border-border-subtle px-4 py-4 sm:px-5">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-5 w-full" />
        ))}
      </div>
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
  labelCurrency = true,
}: {
  usage: UsageStatsGetResult | null;
  range?: UsageRangeKey;
  showRangeSelector?: boolean;
  /**
   * Name the USD currency on the headline estimate. Settings turns this off
   * because its section heading already reads "Cost (USD)".
   */
  labelCurrency?: boolean;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [localRange, setLocalRange] = useState<UsageRangeKey>("30");
  const range = controlledRange ?? localRange;
  const [mode, setMode] = useState<Mode>("cost");
  const selected = useMemo(
    () => (usage === null ? null : uiPresentation.selectUsageRange(usage, range)),
    [usage, range, uiPresentation],
  );
  const rangeSelectorVisible = showRangeSelector && controlledRange === undefined;
  // Until the first detailed response arrives there is nothing to estimate:
  // show a layout-matching skeleton (only once the wait is noticeable), never
  // zero figures or "nothing recorded" copy that the data may contradict.
  const showSkeleton = useDelayedFlag(selected === null);
  if (selected === null || showSkeleton) {
    return <UsageCostSkeleton visible={showSkeleton} showRangeSelector={rangeSelectorVisible} />;
  }

  return (
    // This content also appears in Atrium. Container queries must live here,
    // rather than assume either surface occupies the full browser viewport.
    <div className="@container/usage-cost min-w-0" data-usage-cost-layout>
      {/* The controls sit outside the keyed metrics so a period change does not
          remount (and re-measure) them. */}
      <div className={TOOLBAR_CLASS}>
        {rangeSelectorVisible ? (
          <UsageRangeSelector value={range} onChange={setLocalRange} />
        ) : null}
        <SegmentedControl
          aria-label={uiText("Chart measure", undefined, undefined, uiLocale)}
          value={mode}
          onValueChange={setMode}
          options={uiPresentation.MODE_OPTIONS}
        />
      </div>
      {/* The mode survives period changes, but the numeric odometers must not:
          tweening lifetime counters into a seven-day figure briefly labels
          values from another period as if they belonged to the new one. */}
      <UsageCostMetrics
        key={`${range}:${selected.today.day}`}
        usage={selected}
        mode={mode}
        labelCurrency={labelCurrency}
      />
    </div>
  );
}

function UsageCostMetrics({
  usage,
  mode,
  labelCurrency,
}: {
  usage: UsageStatsGetResult;
  mode: Mode;
  labelCurrency: boolean;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [showAllModels, setShowAllModels] = useState(false);
  const overrides = useSettings((settings) => settings.modelPricingOverrides) as
    | Record<string, ModelRate>
    | undefined;

  const view = useMemo(() => {
    const breakdown = usage.tokenBreakdown;
    const rollup = rollUpCost(breakdown, overrides);

    // Per provider, for the split bars.
    const byProvider = new Map<
      ProviderDriverKind,
      { cost: number; tokens: number; priced: boolean }
    >();
    for (const entry of breakdown) {
      const priced = rollUpCost([entry], overrides);
      const tokens = entry.inputTokens + entry.outputTokens;
      const current = byProvider.get(entry.provider) ?? { cost: 0, tokens: 0, priced: false };
      current.tokens += tokens;
      if (priced.pricedTokens > 0 || priced.reportedCost !== undefined) {
        current.priced = true;
        current.cost += priced.cost;
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
      reported: rollUpCost([entry], overrides).reportedCost !== undefined,
      priced:
        rollUpCost([entry], overrides).pricedTokens > 0 ||
        rollUpCost([entry], overrides).reportedCost !== undefined,
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
    let modelTimeAvailable = usage.modelGeneratingTime !== undefined;
    for (const time of usage.modelGeneratingTime?.totals ?? []) {
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
          reported: false,
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

    const totals = usage.totals;
    const cached = totals.cachedInputTokens;
    const written = totals.cacheWriteInputTokens;
    const input = totals.inputTokens;
    const output = totals.outputTokens;
    // Recorded volume without provider/model attribution (for example usage
    // recorded before attribution existed) is real, counted and unpriced. Show
    // it as its own row instead of silently assigning it to a model.
    const attributedTokens = models.reduce(
      (sum, entry) => (entry.hasTokenUsage ? sum + entry.tokens : sum),
      0,
    );

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
      reasoning: totals.reasoningOutputTokens,
      unattributed: Math.max(0, input + output - attributedTokens),
      // The ledger only began recording input later; a history with output but
      // no input at all is unmeasured, not free, and must not be costed.
      hasInputDetail: input > 0,
    };
  }, [usage, overrides]);

  // Same shared counter as the token odometer; currency just settles on cents.
  const costDisplay = useCountUp(view.rollup.cost, { decimals: 2 });
  // Aggregate figures and keyed model rows all subscribe to the same shared
  // frame source, so adding the full table does not create a RAF loop per row.
  const processedDisplay = useCountUp(view.processed);
  const cachedDisplay = useCountUp(view.cached);
  const freshDisplay = useCountUp(view.fresh);
  const outputDisplay = useCountUp(view.output);
  const reasoningDisplay = useCountUp(view.reasoning);
  const cacheSavingsDisplay = useCountUp(view.rollup.cacheSavings, { decimals: 2 });
  const cachedInputPercent = view.input > 0 ? (view.cached / view.input) * 100 : 0;
  const cachedInputPercentDisplay = useCountUp(cachedInputPercent, { decimals: 1 });
  const unattributedDisplay = useCountUp(view.unattributed);

  const chart = useMemo(() => {
    const days = usage.days;
    const labels = days.map((day) => day.day.slice(5));
    if (mode === "tokens") {
      const series: UsageChartSeries[] = [
        {
          key: "cached",
          label: uiText("Cached input", undefined, undefined, uiLocale),
          color: TOKEN_BAND_COLORS.cached,
          values: days.map((day) => day.cachedInputTokens),
        },
        {
          key: "fresh",
          label: uiText("Uncached input", undefined, undefined, uiLocale),
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
          label: uiText("Cache writes", undefined, undefined, uiLocale),
          color: TOKEN_BAND_COLORS.written,
          values: days.map((day) => day.cacheWriteInputTokens),
        },
        {
          key: "output",
          label: uiText("Output", undefined, undefined, uiLocale),
          color: TOKEN_BAND_COLORS.output,
          values: days.map((day) => day.outputTokens),
        },
      ];
      return {
        labels,
        series,
        hasUnpriced: false,
        format: (value: number) =>
          `${formatFullTokenCount(value)} tokens (${uiPresentation.formatCompactTokenCount(value)})`,
      };
    }

    const pricedDays = dailyUsageCost(usage, overrides);
    const dailyCosts = new Map(pricedDays.map((day) => [day.day, day]));
    const series: UsageChartSeries[] = [
      {
        key: "cost",
        label: usage.tokenBreakdown.some((row) => row.reportedCost !== undefined)
          ? uiText("Cost", undefined, undefined, uiLocale)
          : uiText("Estimated cost", undefined, undefined, uiLocale),
        color: COST_SERIES_COLOR,
        values: days.map((day) => dailyCosts.get(day.day)?.cost ?? 0),
      },
    ];
    return {
      labels,
      series,
      hasUnpriced: days.some((day) => (dailyCosts.get(day.day)?.unpricedTokens ?? 0) > 0),
      format: (value: number) => formatUsd(value),
    };
  }, [usage, mode, overrides, uiLocale, uiPresentation]);

  // Missing model attribution is real recorded usage, but has no trustworthy
  // rate. Include that gap in cost quality instead of implying 100% coverage.
  const share = Math.max(view.processed, view.rollup.pricedTokens + view.rollup.unpricedTokens);
  const unpricedTokens = Math.max(0, share - view.rollup.pricedTokens);
  const pricedPercent = share === 0 ? null : (view.rollup.pricedTokens / share) * 100;
  // Keep extra precision around the honest `<0.1%` boundary. Quantizing the
  // ticker itself to one decimal would turn a real 0.05% share into 0.1%.
  const pricedPercentDisplay = useCountUp(pricedPercent ?? 0, { decimals: 3 });
  const displayedPricedPercent = Math.max(0, Math.min(100, pricedPercentDisplay));
  const displayedUnpricedPercent = 100 - displayedPricedPercent;
  const maxProviderCost = Math.max(0, ...view.providers.map((entry) => entry.cost));
  const recordingStartedAt = view.modelTimeAvailable
    ? usage.modelGeneratingTime?.startedAt
    : undefined;
  const recordedSince =
    recordingStartedAt === undefined ? undefined : formatUsageRecordingDate(recordingStartedAt);
  const recordingUtc =
    recordedSince && recordingStartedAt ? new Date(recordingStartedAt).toISOString() : undefined;
  const modelTimeExplanation = recordingUtc
    ? uiText(
        "Counts full active-turn time, including tools and waits. Concurrent chats count separately. Recorded since {recordedSince} (UTC); earlier history is not included. Not recorded means no time was measured for that model.",
        { recordedSince: recordingUtc },
        undefined,
        uiLocale,
      )
    : uiText(
        "Counts full active-turn time, including tools and waits. Concurrent chats count separately. Earlier history is not included. Not recorded means no time was measured for that model.",
        undefined,
        undefined,
        uiLocale,
      );

  const costRecordingDetails = (
    <InfoTip label={uiText("About cost estimates", undefined, undefined, uiLocale)}>
      {uiText(
        "Priced share covers recorded tokens only; interrupted requests may not report all usage, so this is not a complete billing record. Codex subagent usage includes only observed increments after a baseline; earlier child usage is not backfilled, and child tokens do not increase the main chat’s context-window meter.",
        undefined,
        undefined,
        uiLocale,
      )}
    </InfoTip>
  );

  return (
    <>
      <div className={OVERVIEW_GRID_CLASS} data-usage-cost-overview>
        {/* Hero + provider split */}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <span>
              {view.rollup.reportedCost !== undefined
                ? labelCurrency
                  ? uiText("Cost (USD)", undefined, undefined, uiLocale)
                  : uiText("Cost", undefined, undefined, uiLocale)
                : labelCurrency
                  ? uiText("Estimated cost (USD)", undefined, undefined, uiLocale)
                  : uiText("Estimated cost", undefined, undefined, uiLocale)}
            </span>
            <InfoTip label={uiText("About estimated cost", undefined, undefined, uiLocale)}>
              {view.rollup.reportedCost !== undefined
                ? uiText(
                    "Includes settled Axiom costs reported by the native CLI. Other providers use standard API-rate estimates. Only recorded requests are included; this is not the account-wide bill.",
                    undefined,
                    undefined,
                    uiLocale,
                  )
                : uiText(
                    "Published standard API rates, or your custom rates if set. Excludes long-context and speed-tier adjustments; not your subscription bill.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}{" "}
              {uiText(
                "Claude estimates cannot account for provider-side custom pricing or fallback after a refusal.",
                undefined,
                undefined,
                uiLocale,
              )}
            </InfoTip>
          </div>
          <div
            className="mt-1 max-w-full break-words text-3xl font-light tracking-tight tabular-nums text-foreground [overflow-wrap:anywhere] sm:text-4xl"
            data-usage-cost-hero-value="true"
          >
            {formatUsd(costDisplay)}
          </div>
          {view.rollup.unknownCacheWriteTokens !== undefined && (
            <p className="mt-1 text-xs text-muted-foreground" data-usage-unknown-cache-ttl>
              {uiText(
                "Cache-write duration is unknown for {tokens} tokens; the estimate uses the regular cache-write rate for those tokens.",
                { tokens: formatFullTokenCount(view.rollup.unknownCacheWriteTokens) },
                undefined,
                uiLocale,
              )}
            </p>
          )}

          <div className="mt-5 flex flex-col gap-3">
            {view.providers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {uiText("No usage by model in this period.", undefined, undefined, uiLocale)}
              </p>
            ) : (
              view.providers.map((entry) => (
                <UsageProviderSummary
                  key={entry.provider}
                  entry={entry}
                  maxCost={maxProviderCost}
                />
              ))
            )}
          </div>
        </div>

        {/* Chart */}
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span
              className="text-xs font-medium text-muted-foreground"
              data-usage-cost-chart-label="true"
            >
              {mode === "cost"
                ? uiText("Daily cost", undefined, undefined, uiLocale)
                : uiText("Daily tokens", undefined, undefined, uiLocale)}
            </span>
            <TokenCountFigure
              // All can include lifetime volume predating the daily ledger.
              // Reuse the aggregate ticker instead of dropping that history or
              // allowing two displays of the same total to animate differently.
              value={processedDisplay}
              context="range"
              suffix=" tokens in range"
              valueClassName="text-xs font-normal text-muted-foreground"
            />
            {chart.hasUnpriced ? (
              <span className="flex items-center gap-1 text-xs text-subtle-foreground">
                <UiMessage
                  message={"Partial estimate<slot1></slot1>"}
                  slots={{
                    slot1: (
                      <InfoTip
                        label={uiText("About partial estimate", undefined, undefined, uiLocale)}
                      >
                        {uiText(
                          "Usage without a daily model rate is left out of the daily cost.",
                          undefined,
                          undefined,
                          uiLocale,
                        )}
                      </InfoTip>
                    ),
                  }}
                />
              </span>
            ) : null}
          </div>
          <UsageAreaChart
            labels={chart.labels}
            series={chart.series}
            format={chart.format}
            displayHeight={CHART_DISPLAY_HEIGHT}
          />
          {mode === "tokens" ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
              {(
                [
                  ["Cached input", TOKEN_BAND_COLORS.cached],
                  ["Uncached input", TOKEN_BAND_COLORS.fresh],
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
            </div>
          ) : null}
        </div>
      </div>

      {/* Composition tiles. Spacing, not dividers, separates the figures so
          wrapping rows never leave stray borders. */}
      <div className={COMPOSITION_GRID_CLASS}>
        <StatTile
          id="processed"
          label={uiText("Processed tokens", undefined, undefined, uiLocale)}
          rawTokens={processedDisplay}
          info="Input plus output. Cached input counts again each time a request reads it."
          detail={view.hasInputDetail ? undefined : "Older history recorded output only"}
        />
        <StatTile
          id="cached"
          label={uiText("Cached input", undefined, undefined, uiLocale)}
          rawTokens={cachedDisplay}
          detail={view.input > 0 ? `${cachedInputPercentDisplay.toFixed(1)}% of input` : undefined}
        />
        <StatTile
          id="uncached"
          label={uiText("Uncached input", undefined, undefined, uiLocale)}
          rawTokens={freshDisplay}
        />
        <StatTile
          id="output"
          label={uiText("Output", undefined, undefined, uiLocale)}
          rawTokens={outputDisplay}
          detail={
            view.reasoning > 0 ? (
              <TokenCountFigure
                value={reasoningDisplay}
                context="reasoning"
                suffix=" reasoning tokens"
                valueClassName="text-xs font-normal text-subtle-foreground"
              />
            ) : undefined
          }
        />
        <StatTile
          id="cache-savings"
          label={uiText("Net cache savings", undefined, undefined, uiLocale)}
          value={
            view.rollup.reportedCost !== undefined &&
            usage.tokenBreakdown.every((row) => row.provider === "axiom")
              ? uiText("Not recorded", undefined, undefined, uiLocale)
              : formatUsd(cacheSavingsDisplay)
          }
          info={
            view.rollup.reportedCost !== undefined
              ? uiText(
                  "Axiom reports settled costs without a cache savings breakdown. Cache savings for other providers use their estimated rates.",
                  undefined,
                  undefined,
                  uiLocale,
                )
              : "Cache-read discounts minus cache-write premiums."
          }
          detail={
            view.rollup.cacheSavings < 0
              ? "Cache writes cost more than reads have saved"
              : undefined
          }
        />
      </div>

      {/* Breakdown + cost quality */}
      <div
        className="grid gap-5 border-t border-border-subtle px-4 py-4 sm:px-5 @min-[52rem]/usage-cost:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]"
        data-usage-cost-breakdown
      >
        <div className="min-w-0">
          <div className="min-w-0 max-w-full overflow-x-auto" data-usage-model-table-scroll>
            <table className="w-full min-w-[36rem] border-collapse text-sm" data-usage-model-table>
              <thead>
                <tr className="text-xs text-muted-foreground">
                  <th scope="col" className="min-w-[8rem] py-1.5 text-left font-medium">
                    {uiText("Model", undefined, undefined, uiLocale)}
                  </th>
                  <th scope="col" className="py-1.5 pl-3 text-right font-medium">
                    {uiText("Cost", undefined, undefined, uiLocale)}
                  </th>
                  <th scope="col" className="py-1.5 pl-3 text-right font-medium">
                    {uiText("Tokens", undefined, undefined, uiLocale)}
                  </th>
                  <th scope="col" className="min-w-[8rem] py-1.5 pl-4 text-right font-medium">
                    <span className="inline-flex items-center justify-end gap-1">
                      <UiMessage
                        message={"Time spent generating<slot1></slot1>"}
                        slots={{
                          slot1: (
                            <InfoTip
                              label={uiText(
                                "About time spent generating",
                                undefined,
                                undefined,
                                uiLocale,
                              )}
                            >
                              {modelTimeExplanation}
                            </InfoTip>
                          ),
                        }}
                      />
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.models.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-3 text-xs text-muted-foreground">
                      {uiText("Nothing recorded in this period.", undefined, undefined, uiLocale)}
                    </td>
                  </tr>
                ) : (
                  (showAllModels
                    ? view.models
                    : view.models.slice(0, INITIAL_VISIBLE_MODEL_ROWS)
                  ).map((entry) => (
                    <UsageModelRow
                      key={JSON.stringify([entry.provider, entry.model])}
                      entry={entry}
                    />
                  ))
                )}
                {view.unattributed > 0 ? (
                  <tr className="border-t border-border-subtle" data-usage-unattributed-row>
                    <td className="py-1.5 pr-3">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">
                          {uiText("Unattributed usage", undefined, undefined, uiLocale)}
                        </span>
                        <InfoTip
                          label={uiText("About unattributed usage", undefined, undefined, uiLocale)}
                        >
                          {uiText(
                            "Usage recorded without a provider or model, such as older history. It''s counted but not priced.",
                            undefined,
                            undefined,
                            uiLocale,
                          )}
                        </InfoTip>
                      </span>
                    </td>
                    <td className="py-1.5 pl-3 text-right text-muted-foreground">
                      {uiText("Unpriced", undefined, undefined, uiLocale)}
                    </td>
                    <td className="py-1.5 pl-3 text-right">
                      <TokenCountFigure
                        value={unattributedDisplay}
                        context="unattributed"
                        suffix=""
                        align="right"
                        valueClassName="font-normal text-muted-foreground"
                      />
                    </td>
                    <td className="py-1.5 pl-4 text-right text-2xs text-muted-foreground">
                      {uiText("—", undefined, undefined, uiLocale)}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-2xs text-subtle-foreground">
            <p data-usage-model-time-coverage>
              {recordedSince && recordingUtc ? (
                <>
                  {uiText("Time recorded since ", undefined, undefined, uiLocale)}
                  <time dateTime={recordingUtc}>{recordedSince}</time>
                </>
              ) : (
                uiText(
                  "Per-model time is unavailable on this server.",
                  undefined,
                  undefined,
                  uiLocale,
                )
              )}
            </p>
            {view.models.length > INITIAL_VISIBLE_MODEL_ROWS ? (
              <Button
                variant="link"
                size="xs"
                className="px-0 text-foreground"
                aria-expanded={showAllModels}
                onClick={() => setShowAllModels((value) => !value)}
              >
                {showAllModels
                  ? uiText("Show fewer models", undefined, undefined, uiLocale)
                  : uiText(
                      "Show all {value0} models",
                      { value0: view.models.length },
                      undefined,
                      uiLocale,
                    )}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">
            {uiText("Cost quality", undefined, undefined, uiLocale)}
          </div>
          <dl className="mt-2 flex flex-col gap-1.5 text-sm">
            <div className="flex items-baseline gap-2">
              <dt className="text-muted-foreground">
                {uiText("Priced", undefined, undefined, uiLocale)}
              </dt>
              <dd className="ml-auto tabular-nums">
                {pricedPercent === null
                  ? uiText("—", undefined, undefined, uiLocale)
                  : formatShare(
                      displayedPricedPercent,
                      Math.max(view.rollup.pricedTokens, displayedPricedPercent > 0 ? 1 : 0),
                    )}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="text-muted-foreground">
                {uiText("Unpriced", undefined, undefined, uiLocale)}
              </dt>
              <dd className="ml-auto tabular-nums">
                {pricedPercent === null
                  ? uiText("—", undefined, undefined, uiLocale)
                  : formatShare(
                      displayedUnpricedPercent,
                      Math.max(unpricedTokens, displayedUnpricedPercent > 0 ? 1 : 0),
                    )}
              </dd>
            </div>
          </dl>
          {/* Priced share describes recorded volume only (AGENTS.md); the
              visible line keeps that caveat at the figures, details on demand. */}
          <p
            className="mt-3 flex items-center gap-1.5 text-2xs text-subtle-foreground"
            data-usage-cost-coverage
          >
            {view.rollup.reportedCost !== undefined ? (
              <UiMessage
                message="Recorded costs and estimates may be incomplete.<slot1></slot1>"
                slots={{ slot1: costRecordingDetails }}
              />
            ) : (
              <UiMessage
                message="Estimates from recorded usage; may be incomplete.<slot1></slot1>"
                slots={{ slot1: costRecordingDetails }}
              />
            )}
          </p>
        </div>
      </div>
    </>
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
  const uiLocale = useUiLocale();

  return (
    <SettingsSection
      searchId="usage.cost"
      title={uiText("Cost (USD)", undefined, undefined, uiLocale)}
    >
      <UsageCostContent
        usage={usage}
        range={range}
        showRangeSelector={false}
        labelCurrency={false}
      />
    </SettingsSection>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = {
  MODE_OPTIONS,
  formatCompactTokenCount,
  formatGeneratingTime,
  formatUsageModelLabel,
  getUsageModelExplanation,
  selectUsageRange,
};
