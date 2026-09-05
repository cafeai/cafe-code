import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@cafecode/client-runtime";
import { ChevronDownIcon, ChevronUpIcon, CircleCheckIcon } from "lucide-react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { normalizeAccentColor } from "../../themeAccent";
import { useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import { retainThreadDetailSubscription } from "../../environments/runtime/service";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SubagentAvatar } from "../subagents/SubagentAvatar";
import { UsageCostContent } from "../settings/UsageCostSection";
import { formatCompactTokenCount, formatFullTokenCount } from "../settings/usageStatsPresentation";
import { useUsageCostSummary } from "../stats/useUsageCostSummary";
import { createAtriumScene, type AtriumScene } from "./atriumScene";
import {
  EMPTY_ATRIUM,
  formatElapsed,
  mergeTaskAtriumErrorDismissals,
  selectAtriumSnapshot,
  type AtriumCard,
  type AtriumCardState,
} from "./taskAtriumData";
import { useTaskAtriumStore } from "./taskAtriumStore";

/**
 * Task Atrium — a read-only view of everything running, staged as a scene.
 *
 * Cards float at three depths over a canvas cherry-blossom scene and drift with
 * the pointer; that parallax is where the depth comes from, not from any 3D.
 * The whole palette — sky, branches, blossoms, petals — is derived from the
 * Atrium tint, so the colour setting drives the season rather than the scene
 * being locked to cherry pink.
 *
 * It is not a provider control surface: no approve, no deny, no stop. A card
 * says a thread is waiting on you because that is information about what is
 * going on, but the decision happens in the thread where the request is
 * visible. Its only local state mutation clears exact historical error cards
 * from the presentation; it never alters provider or orchestration state.
 */

const FALLBACK_TINT = "#48cfff";
const MemoizedUsageCostContent = memo(UsageCostContent);
/** Matches the engine's state palette so the two views never disagree. */
const HOLD_COLOR = "#f5a524";
const FAULT_COLOR = "#ef4444";
const SETTLED_COLOR = "#9aa3ad";
/** Compact supporting estimate for the restored Atrium metrics grid. */
const compactUsdFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
/**
 * Detail streams are live backend resources, not free renderer selectors. A
 * large imported environment must not pin one subscription per shell card.
 * The observer prefetches nearby cards and rotates this fixed window as the
 * user scrolls; every card remains in the scroll column and hydrates on demand.
 */
const MAX_ATRIUM_DETAIL_SUBSCRIPTIONS = 24;
const ATRIUM_DETAIL_PREFETCH_MARGIN_PX = 320;
/** Give the tiny usage RPC priority over multi-megabyte thread detail hydration. */
const ATRIUM_USAGE_PRIORITY_WINDOW_MS = 750;
/** Keep recent completions useful without letting historical rows dominate a card. */
const COMPLETED_SUBAGENT_PREVIEW_COUNT = 3;

const STATE_LABEL: Record<AtriumCardState, string> = {
  holding: "Waiting on you",
  running: "Running",
  error: "Error",
  done: "Done",
};

function useAtriumTint(): string {
  const atriumColor = useSettings((settings) => settings.ambianceAtriumColor);
  const ambianceColor = useSettings((settings) => settings.ambianceColor);
  const appAccentColor = useSettings((settings) => settings.appAccentColor);
  const themeAccentColor = useSettings((settings) => settings.themeAccentColor);
  return useMemo(
    () =>
      normalizeAccentColor(atriumColor) ??
      normalizeAccentColor(ambianceColor) ??
      normalizeAccentColor(appAccentColor) ??
      normalizeAccentColor(themeAccentColor) ??
      FALLBACK_TINT,
    [atriumColor, ambianceColor, appAccentColor, themeAccentColor],
  );
}

function stateColor(state: AtriumCardState, tint: string): string {
  switch (state) {
    case "holding":
      return HOLD_COLOR;
    case "error":
      return FAULT_COLOR;
    case "done":
      return SETTLED_COLOR;
    default:
      return tint;
  }
}

/** Display name for a provider driver slug. Unknown slugs render as-is. */
function providerLabel(provider: string): string {
  switch (provider) {
    case "claudeAgent":
      return "Claude";
    case "codex":
      return "Codex";
    case "grok":
      return "Grok";
    case "opencode":
      return "OpenCode";
    default:
      return provider.length > 0 ? provider : "Provider";
  }
}

const PROVIDER_DOT: Record<string, string> = {
  claudeAgent: "#d97757",
  codex: "#8d858b",
  grok: "#a78bfa",
  opencode: "#4ade80",
};

/**
 * The scene canvas. Owns its own RAF loop and inherits the same battery rules
 * as the ambiance layer: stopped while the document is hidden or the window is
 * blurred unless background animations are on, and a single static frame under
 * `prefers-reduced-motion`.
 */
function AtriumSceneCanvas({
  tint,
  dark,
  pointer,
}: {
  tint: string;
  dark: boolean;
  pointer: { x: number; y: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<AtriumScene | null>(null);
  // Seed the expensive DPR-scaled backing layers with the actual appearance.
  // Later theme changes still use the setters, but the initial mount no longer
  // builds the default layers and immediately rebuilds them once or twice.
  const currentAppearanceRef = useRef({ tint, dark });
  const currentPointerRef = useRef(pointer);
  currentAppearanceRef.current = { tint, dark };
  currentPointerRef.current = pointer;
  const continueBackgroundAnimations = useSettings(
    (settings) => settings.continueBackgroundAnimations,
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = createAtriumScene(canvas, currentAppearanceRef.current);
    if (!scene) return;
    scene.setPointer(currentPointerRef.current.x, currentPointerRef.current.y);
    sceneRef.current = scene;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let running = false;

    const tick = () => {
      scene.draw();
      frame = window.requestAnimationFrame(tick);
    };
    const start = () => {
      if (running || reduced) return;
      running = true;
      frame = window.requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      window.cancelAnimationFrame(frame);
    };
    const syncRunState = () => {
      const hidden = document.visibilityState !== "visible";
      const blurred = typeof document.hasFocus === "function" && !document.hasFocus();
      if (!continueBackgroundAnimations && (hidden || blurred)) stop();
      else start();
    };

    const onResize = () => {
      scene.resize();
      // Repaint immediately when the loop is not running, so a resize while
      // paused does not leave a stale or blank scene.
      if (!running) scene.draw();
    };

    // The canvas is measured from its own box, which is zero until layout has
    // run and changes again whenever the sidebar opens or the pane is resized.
    // A window listener alone misses both, leaving the scene stuck at 1x1.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    observer?.observe(canvas);

    // Always paint one frame before deciding whether to animate. If the window
    // is blurred, background animations are off, or motion is reduced, the loop
    // never starts — and without this the pane would simply render empty.
    scene.draw();
    if (!reduced) syncRunState();

    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", syncRunState);
    window.addEventListener("focus", syncRunState);
    window.addEventListener("blur", syncRunState);
    return () => {
      stop();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", syncRunState);
      window.removeEventListener("focus", syncRunState);
      window.removeEventListener("blur", syncRunState);
      observer?.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, [continueBackgroundAnimations]);

  useEffect(() => {
    sceneRef.current?.setTint(tint);
  }, [tint]);
  useEffect(() => {
    sceneRef.current?.setDark(dark);
  }, [dark]);
  useEffect(() => {
    sceneRef.current?.setPointer(pointer.x, pointer.y);
  }, [pointer]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-cafe-atrium-scene="true"
      className="pointer-events-none absolute inset-0 size-full"
    />
  );
}

function Stat({
  label,
  value,
  detail,
  detailAriaHidden,
  tone,
  muted,
  color,
}: {
  label: string;
  value: string;
  detail?: string | undefined;
  detailAriaHidden?: boolean;
  tone: string;
  muted: string;
  color?: string;
}) {
  return (
    <div className="min-w-0 py-1">
      <dt className={cn("font-mono text-[10px] uppercase tracking-[0.1em]", muted)}>{label}</dt>
      <dd
        className={cn(
          "mt-1 break-words text-xl leading-none font-medium tracking-tight tabular-nums [overflow-wrap:anywhere] sm:text-2xl",
          tone,
        )}
        style={color ? { color } : undefined}
      >
        {value}
      </dd>
      {detail ? (
        <dd
          className={cn("mt-0.5 text-[10px] tabular-nums", muted)}
          aria-hidden={detailAriaHidden || undefined}
        >
          {detail}
        </dd>
      ) : null}
    </div>
  );
}

function pluralizedCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatCachedShare(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(Math.min(1, Math.max(0, value)) * 100).toFixed(1)}%`;
}

function formatCacheSavings(value: number, loaded: boolean): string {
  if (!loaded || !Number.isFinite(value)) return "—";
  return compactUsdFormat.format(Math.max(0, value));
}

interface TaskAtriumCardViewProps {
  card: AtriumCard;
  now: number;
  tint: string;
  onOpen: (card: AtriumCard) => void;
  onCardElement: (key: string, element: HTMLElement | null) => void;
}

const TaskAtriumCardView = memo(function TaskAtriumCardView({
  card,
  now,
  tint,
  onOpen,
  onCardElement,
}: TaskAtriumCardViewProps) {
  const accent = stateColor(card.state, tint);
  const elapsed = formatElapsed(card.startedAt, now);
  const titleId = useId();
  const subagentListId = useId();
  const [showAllCompletedSubagents, setShowAllCompletedSubagents] = useState(false);
  const completedSubagents = useMemo(
    () =>
      card.subagents
        .filter((subagent) => subagent.status === "completed")
        .toSorted((left, right) => {
          // Completion time answers which historical work is most useful now.
          // Imported legacy rows can lack it, so their start time is the
          // deterministic fallback and the stable row key breaks exact ties.
          const leftTime = left.completedAt ?? left.startedAt ?? 0;
          const rightTime = right.completedAt ?? right.startedAt ?? 0;
          return leftTime - rightTime || left.rowKey.localeCompare(right.rowKey);
        }),
    [card.subagents],
  );
  const hiddenCompletedSubagentCount = Math.max(
    0,
    completedSubagents.length - COMPLETED_SUBAGENT_PREVIEW_COUNT,
  );
  const visibleSubagents = useMemo(() => {
    if (showAllCompletedSubagents || hiddenCompletedSubagentCount === 0) {
      return card.subagents;
    }

    // Only successful historical work is eligible for disclosure. Waiting,
    // active, failed, and stopped children always stay visible so this compact
    // presentation can never hide work or a condition that needs attention.
    const recentCompletedRowKeys = new Set(
      completedSubagents
        .slice(-COMPLETED_SUBAGENT_PREVIEW_COUNT)
        .map((subagent) => subagent.rowKey),
    );
    return card.subagents.filter(
      (subagent) => subagent.status !== "completed" || recentCompletedRowKeys.has(subagent.rowKey),
    );
  }, [card.subagents, completedSubagents, hiddenCompletedSubagentCount, showAllCompletedSubagents]);
  const cardRef = useCallback(
    (element: HTMLElement | null) => onCardElement(card.key, element),
    [card.key, onCardElement],
  );

  return (
    <article
      ref={cardRef}
      aria-labelledby={titleId}
      data-cafe-atrium-card-key={card.key}
      data-cafe-atrium-task-card="true"
      style={{ "--cafe-atrium-accent": accent } as CSSProperties}
      className={cn(
        "group relative w-full shrink-0 overflow-hidden rounded-2xl p-4 text-left [contain-intrinsic-size:auto_14rem] [content-visibility:auto]",
        "border backdrop-blur-md transition-shadow duration-200",
        // Paper stock on a light sky, dark glass on a dusk one — the card has
        // to belong to the theme, not just to the scene behind it.
        "border-black/5 bg-[#f5f2ee] text-[#241f22] shadow-2xl shadow-black/40",
        "dark:border-white/12 dark:bg-[#1b1620]/88 dark:text-[#eee7ec]",
        "hover:shadow-[0_30px_60px_-18px_rgba(0,0,0,0.6)]",
        card.state === "done" && "opacity-80",
      )}
    >
      {/* Keep the full card clickable without making its status and subagent
          content children of a labelled button. Screen readers can browse the
          article normally, while this transparent sibling remains the single
          keyboard-focusable navigation action. */}
      <button
        type="button"
        onClick={() => onOpen(card)}
        aria-label={`Open ${card.title}`}
        className="absolute inset-0 z-10 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--cafe-atrium-accent)]"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-[8%] top-0 h-0.5 rounded-full"
        style={{ background: accent }}
      />

      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-[#8a8189] dark:text-white/50">
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: PROVIDER_DOT[card.provider] ?? SETTLED_COLOR }}
          />
          {providerLabel(card.provider)}
        </span>
        <span
          className="ml-auto text-[10px] font-semibold uppercase tracking-[0.04em]"
          style={{ color: accent }}
        >
          {STATE_LABEL[card.state]}
        </span>
      </div>

      <div
        id={titleId}
        className="mt-2 line-clamp-2 text-[17px] leading-tight font-medium tracking-tight"
      >
        {card.title}
      </div>
      {card.projectName ? (
        <div className="mt-1 truncate font-mono text-[10px] text-[#9a9199] dark:text-white/40">
          {card.projectName}
        </div>
      ) : null}

      {/* The reference's photo window becomes the live subagent list. */}
      {card.subagents.length > 0 ? (
        <div className="mt-3 rounded-xl bg-[#ece7e2] p-2.5 dark:bg-white/8">
          <ul
            id={subagentListId}
            aria-label={`Subagents for ${card.title}`}
            className="flex flex-col gap-1"
            data-cafe-atrium-subagent-list="true"
          >
            {visibleSubagents.map((subagent) => (
              <li
                key={subagent.rowKey}
                className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg px-0.5 py-1.5 text-[11px] text-[#4a4248] dark:text-white/75"
                data-cafe-atrium-subagent-row="true"
              >
                <SubagentAvatar seed={subagent.id} className="size-7" />
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-[#3c353a] dark:text-white/85">
                    {subagent.label}
                  </span>
                  <span
                    className="mt-0.5 block leading-4 text-[#6c636a] break-words dark:text-white/50"
                    data-cafe-atrium-subagent-detail="true"
                  >
                    {subagent.detail}
                  </span>
                </span>
                <span className="min-w-12 shrink-0 pt-0.5 text-right">
                  <span
                    className="block text-[9px] font-semibold uppercase tracking-[0.06em]"
                    style={{ color: subagent.running ? accent : SETTLED_COLOR }}
                  >
                    {subagent.status === "waiting"
                      ? "Waiting"
                      : subagent.status === "active"
                        ? "Working"
                        : subagent.status === "failed"
                          ? "Failed"
                          : subagent.status === "stopped"
                            ? "Stopped"
                            : "Done"}
                  </span>
                  {subagent.startedAt !== null ? (
                    <span className="mt-0.5 block font-mono text-[10px] tabular-nums text-[#8a8189] dark:text-white/45">
                      {formatElapsed(
                        subagent.startedAt,
                        subagent.running ? now : (subagent.completedAt ?? now),
                      )}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {hiddenCompletedSubagentCount > 0 ? (
            <button
              type="button"
              aria-controls={subagentListId}
              aria-expanded={showAllCompletedSubagents}
              aria-label={
                showAllCompletedSubagents
                  ? `Show fewer completed subagents for ${card.title}`
                  : `Show ${hiddenCompletedSubagentCount} more completed subagents for ${card.title}`
              }
              className={cn(
                "relative z-20 mt-1 flex min-h-9 w-full items-center justify-center gap-1.5 border-t border-black/10 pt-2",
                "rounded-b-lg text-[11px] font-semibold text-[#6c636a] transition-colors hover:text-[#3c353a]",
                "outline-none focus-visible:ring-2 focus-visible:ring-[var(--cafe-atrium-accent)]",
                "dark:border-white/10 dark:text-white/55 dark:hover:text-white/85",
              )}
              data-cafe-atrium-completed-subagent-toggle="true"
              onClick={(event) => {
                // The card has a full-surface navigation button beneath this
                // disclosure. Consume the click so expanding history cannot
                // unexpectedly leave the Atrium.
                event.stopPropagation();
                setShowAllCompletedSubagents((expanded) => !expanded);
              }}
            >
              {showAllCompletedSubagents ? (
                <>
                  Show less
                  <ChevronUpIcon aria-hidden="true" className="size-3.5" />
                </>
              ) : (
                <>
                  Show {hiddenCompletedSubagentCount} more completed
                  <ChevronDownIcon aria-hidden="true" className="size-3.5" />
                </>
              )}
            </button>
          ) : null}
        </div>
      ) : null}

      {card.activityLabel ? (
        <div className="mt-3 flex items-center gap-2 border-t border-black/10 pt-2.5 text-[11px] text-[#6c636a] dark:border-white/10 dark:text-white/55">
          <span className="truncate">
            {card.activityLabel}
            {card.activityDetail ? (
              <span className="text-[#948b92] dark:text-white/40"> · {card.activityDetail}</span>
            ) : null}
          </span>
          {elapsed ? (
            <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-[#948b92] dark:text-white/40">
              {elapsed}
            </span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}, areAtriumCardPropsEqual);

function areAtriumCardPropsEqual(
  previous: TaskAtriumCardViewProps,
  next: TaskAtriumCardViewProps,
): boolean {
  const cardUnchanged =
    previous.card.key === next.card.key &&
    previous.card.title === next.card.title &&
    previous.card.provider === next.card.provider &&
    previous.card.projectName === next.card.projectName &&
    previous.card.state === next.card.state &&
    previous.card.activityLabel === next.card.activityLabel &&
    previous.card.activityDetail === next.card.activityDetail &&
    previous.card.startedAt === next.card.startedAt &&
    previous.card.subagents === next.card.subagents;
  if (
    !cardUnchanged ||
    previous.tint !== next.tint ||
    previous.onOpen !== next.onOpen ||
    previous.onCardElement !== next.onCardElement
  ) {
    return false;
  }
  // Terminal cards have frozen parent/subagent durations and do not need the
  // Atrium's one-second clock. Live rows continue to update normally.
  const hasLiveClock =
    next.card.state === "running" ||
    next.card.state === "holding" ||
    next.card.subagents.some((subagent) => subagent.running);
  return !hasLiveClock || previous.now === next.now;
}

export function TaskAtriumBoard() {
  const tint = useAtriumTint();
  const overviewTitleId = useId();
  const dismissedTaskAtriumErrors = useSettings((settings) => settings.dismissedTaskAtriumErrors);
  const { updateSettings } = useUpdateSettings();
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";
  const navigate = useNavigate();
  const closeAtrium = useTaskAtriumStore((state) => state.setOpen);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  // null = "All work". Cleared automatically if that provider stops running.
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  // Lifetime spend, alongside the live work. Same odometer as the Usage page,
  // so the two never animate differently.
  const usage = useUsageCostSummary(true);
  const [detailHydrationReady, setDetailHydrationReady] = useState(false);
  useEffect(() => {
    // Reserve the first paint/transport window for the small headline request
    // even when a cached graph is already visible: that cache triggers a fresh
    // background read, and immediate multi-megabyte detail hydration could
    // otherwise starve it again. Parent task cards remain visible throughout.
    const timeout = window.setTimeout(
      () => setDetailHydrationReady(true),
      ATRIUM_USAGE_PRIORITY_WINDOW_MS,
    );
    return () => window.clearTimeout(timeout);
  }, []);

  // Derivation allocates fresh arrays, so subscribing to the store directly
  // would re-render this board on every streamed token. Poll on one slow clock
  // instead — the same bounded-poll shape AmbianceLayer uses for its aggregate
  // signals — which also drives the elapsed readouts.
  const [now, setNow] = useState(() => Date.now());
  const [snapshot, setSnapshot] = useState(EMPTY_ATRIUM);
  useEffect(() => {
    let interval: number | null = null;
    const tick = () => {
      const timestamp = Date.now();
      setNow(timestamp);
      setSnapshot(selectAtriumSnapshot(useStore.getState(), timestamp, dismissedTaskAtriumErrors));
    };
    const stop = () => {
      if (interval === null) return;
      window.clearInterval(interval);
      interval = null;
    };
    const syncVisibility = () => {
      if (document.visibilityState !== "visible") {
        stop();
        return;
      }
      if (interval !== null) return;
      tick();
      interval = window.setInterval(tick, 1000);
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, [dismissedTaskAtriumErrors]);

  const retainedDetailsRef = useRef(new Map<string, () => void>());
  const cardElementsRef = useRef(new Map<string, HTMLElement>());
  const cardIntersectionObserverRef = useRef<IntersectionObserver | null>(null);
  const refreshVisibleCardsRef = useRef<(() => void) | null>(null);
  const [paneScrollerElement, setPaneScrollerElement] = useState<HTMLDivElement | null>(null);
  const [visibleCardKeys, setVisibleCardKeys] = useState<ReadonlySet<string>>(() => new Set());
  const onCardElement = useCallback((key: string, element: HTMLElement | null) => {
    const previous = cardElementsRef.current.get(key);
    if (previous && previous !== element) {
      cardIntersectionObserverRef.current?.unobserve(previous);
    }
    if (element) {
      cardElementsRef.current.set(key, element);
      cardIntersectionObserverRef.current?.observe(element);
      refreshVisibleCardsRef.current?.();
      return;
    }
    cardElementsRef.current.delete(key);
    setVisibleCardKeys((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, []);
  useEffect(() => {
    if (!paneScrollerElement) return;
    let frame: number | null = null;
    const refreshVisibleCards = () => {
      frame = null;
      const root = paneScrollerElement.getBoundingClientRect();
      const visible = new Set<string>();
      const top = root.top - ATRIUM_DETAIL_PREFETCH_MARGIN_PX;
      const bottom = root.bottom + ATRIUM_DETAIL_PREFETCH_MARGIN_PX;
      for (const [key, element] of cardElementsRef.current) {
        const bounds = element.getBoundingClientRect();
        if (bounds.bottom >= top && bounds.top <= bottom) visible.add(key);
      }
      setVisibleCardKeys((current) =>
        current.size === visible.size && [...current].every((key) => visible.has(key))
          ? current
          : visible,
      );
    };
    const scheduleVisibleCardsRefresh = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(refreshVisibleCards);
    };
    refreshVisibleCardsRef.current = scheduleVisibleCardsRefresh;

    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(scheduleVisibleCardsRefresh, {
            root: paneScrollerElement,
            rootMargin: `${ATRIUM_DETAIL_PREFETCH_MARGIN_PX}px 0px`,
          });
    cardIntersectionObserverRef.current = observer;
    for (const element of cardElementsRef.current.values()) observer?.observe(element);
    paneScrollerElement.addEventListener("scroll", scheduleVisibleCardsRefresh, { passive: true });
    window.addEventListener("resize", scheduleVisibleCardsRefresh);
    scheduleVisibleCardsRefresh();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      paneScrollerElement.removeEventListener("scroll", scheduleVisibleCardsRefresh);
      window.removeEventListener("resize", scheduleVisibleCardsRefresh);
      if (refreshVisibleCardsRef.current === scheduleVisibleCardsRefresh) {
        refreshVisibleCardsRef.current = null;
      }
      if (cardIntersectionObserverRef.current === observer) {
        cardIntersectionObserverRef.current = null;
      }
    };
  }, [paneScrollerElement]);
  useEffect(
    () => () => {
      for (const release of retainedDetailsRef.current.values()) release();
      retainedDetailsRef.current.clear();
    },
    [],
  );

  // Pointer parallax, quantized so a stationary mouse cannot cause a render and
  // skipped entirely under reduced motion.
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const host = stageRef.current;
    if (!host) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rect = host.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = Math.round(((event.clientX - rect.left) / rect.width - 0.5) * 200) / 100;
    const y = Math.round(((event.clientY - rect.top) / rect.height - 0.5) * 200) / 100;
    setPointer((previous) => (previous.x === x && previous.y === y ? previous : { x, y }));
  }, []);
  const onPointerLeave = useCallback(() => setPointer({ x: 0, y: 0 }), []);

  const providerCounts = snapshot.providerCounts;

  // Drop a filter whose provider no longer has anything running, so the view
  // cannot get stuck showing an empty board.
  useEffect(() => {
    if (providerFilter === null) return;
    if (!providerCounts.some(([provider]) => provider === providerFilter)) {
      setProviderFilter(null);
    }
  }, [providerCounts, providerFilter]);

  const filtered = useMemo(
    () =>
      providerFilter === null
        ? snapshot.cards
        : snapshot.cards.filter((card) => card.provider === providerFilter),
    [snapshot.cards, providerFilter],
  );
  const detailHydrationCards = useMemo(() => {
    if (!detailHydrationReady) return [];
    const observed = filtered.filter((card) => visibleCardKeys.has(card.key));
    // Before the first observer callback, hydrate the leading card so a cold
    // board never sits empty. The fixed slice remains a security boundary even
    // when an unusually tall viewport intersects many compact cards at once.
    const candidates = observed.length > 0 ? observed : filtered.slice(0, 1);
    return candidates.slice(0, MAX_ATRIUM_DETAIL_SUBSCRIPTIONS);
  }, [detailHydrationReady, filtered, visibleCardKeys]);
  useEffect(() => {
    const retained = retainedDetailsRef.current;
    const desired = new Set(detailHydrationCards.map((card) => card.key));

    for (const [key, release] of retained) {
      if (desired.has(key)) continue;
      release();
      retained.delete(key);
    }
    for (const card of detailHydrationCards) {
      if (retained.has(card.key)) continue;
      retained.set(card.key, retainThreadDetailSubscription(card.environmentId, card.threadId));
    }
  }, [detailHydrationCards]);
  const filteredMetrics = useMemo(
    () => ({
      subagentCount: filtered.reduce(
        (count, card) => count + card.subagents.filter((subagent) => subagent.running).length,
        0,
      ),
      runningCount: filtered.filter((card) => card.state === "running").length,
      holdingCount: filtered.filter((card) => card.state === "holding").length,
      errorCount: filtered.filter((card) => card.state === "error").length,
    }),
    [filtered],
  );
  const overviewStatus =
    filteredMetrics.holdingCount > 0
      ? filteredMetrics.holdingCount === 1
        ? "one needs you."
        : `${filteredMetrics.holdingCount} need you.`
      : filteredMetrics.runningCount > 0
        ? "all working."
        : filteredMetrics.errorCount > 0
          ? "stopped."
          : "all done.";
  const overviewDescription =
    filteredMetrics.holdingCount > 0
      ? `${filteredMetrics.holdingCount} waiting on you. Everything else is moving on its own.`
      : filteredMetrics.errorCount > 0 && filteredMetrics.runningCount === 0
        ? `${pluralizedCount(filteredMetrics.errorCount, "thread")} stopped on an error. Open one to see what happened.`
        : "Nothing here asks for you. The garden keeps its own hours.";

  const clearErrors = useCallback(() => {
    const currentErrors = snapshot.cards.flatMap((card) =>
      card.errorDismissal === null ? [] : [card.errorDismissal],
    );
    if (currentErrors.length === 0) return;

    updateSettings({
      dismissedTaskAtriumErrors: mergeTaskAtriumErrorDismissals(
        dismissedTaskAtriumErrors,
        currentErrors,
      ),
    });
  }, [dismissedTaskAtriumErrors, snapshot.cards, updateSettings]);

  const openCard = useCallback(
    (card: AtriumCard) => {
      // Close on the way out: the overlay is fixed over the whole window, so
      // navigating without closing changes the route behind a panel that still
      // covers it and nothing appears to happen.
      closeAtrium(false);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(card.environmentId, card.threadId)),
      });
    },
    [closeAtrium, navigate],
  );

  const total = snapshot.cards.length;
  const glass = dark
    ? "border-white/15 bg-black/35 text-white/85"
    : "border-black/10 bg-white/60 text-[#3a3038]";
  const heading = dark ? "text-white" : "text-[#241b23]";
  const muted = dark ? "text-white/60" : "text-[#5d5460]";
  const label = dark ? "text-white/45" : "text-[#8a8189]";

  return (
    <div
      ref={stageRef}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <AtriumSceneCanvas tint={tint} dark={dark} pointer={pointer} />

      {/* The provider nav stays visible while one pane owns every vertical
          surface below it. Cards, the quiet state, and Usage therefore move as
          one document instead of competing for height in nested scrollers. */}
      <div
        ref={setPaneScrollerElement}
        className="relative z-10 min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
        data-cafe-atrium-pane-scroll="true"
        data-cafe-atrium-task-scroll="true"
        aria-label="Task Atrium content"
        tabIndex={0}
      >
        <div className="sticky top-0 z-30 flex min-w-0 justify-center bg-gradient-to-b from-background/65 via-background/25 to-transparent py-4 pr-14 pl-3 sm:pl-4">
          <div className="flex min-w-0 max-w-full items-center gap-2">
            <div
              role="group"
              aria-label="Filter by provider"
              className={cn(
                "flex min-w-0 max-w-full items-center gap-1 overflow-x-auto overscroll-x-contain rounded-full border p-1 backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                glass,
              )}
            >
              <button
                type="button"
                onClick={() => setProviderFilter(null)}
                aria-pressed={providerFilter === null}
                className={cn(
                  "rounded-full px-3 py-1 text-xs whitespace-nowrap transition-colors",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current",
                  providerFilter === null
                    ? cn(
                        "font-semibold",
                        dark ? "bg-white text-[#1b1620]" : "bg-[#2b2029] text-white",
                      )
                    : "opacity-70 hover:opacity-100",
                )}
              >
                All work {total}
              </button>
              {providerCounts.map(([provider, count]) => {
                const active = providerFilter === provider;
                return (
                  <button
                    key={provider}
                    type="button"
                    onClick={() => setProviderFilter(active ? null : provider)}
                    aria-pressed={active}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs whitespace-nowrap transition-colors",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current",
                      active
                        ? cn(
                            "font-semibold",
                            dark ? "bg-white text-[#1b1620]" : "bg-[#2b2029] text-white",
                          )
                        : "opacity-70 hover:opacity-100",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="size-1.5 rounded-full"
                      style={{ background: PROVIDER_DOT[provider] ?? SETTLED_COLOR }}
                    />
                    {providerLabel(provider)}
                    <span className="tabular-nums opacity-60">{count}</span>
                  </button>
                );
              })}
            </div>

            {snapshot.errorCount > 0 ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={clearErrors}
                      aria-label="Clear Task Atrium errors"
                      className={cn(
                        "flex size-8 items-center justify-center rounded-full border backdrop-blur-md",
                        "transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current",
                        "hover:bg-white/75 dark:hover:bg-black/55",
                        glass,
                      )}
                    />
                  }
                >
                  <CircleCheckIcon className="size-4" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  Clear {snapshot.errorCount} historical{" "}
                  {snapshot.errorCount === 1 ? "error" : "errors"}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-5 px-3 pb-5 sm:px-6 sm:pb-7 lg:px-10">
          {filtered.length === 0 ? (
            <section
              className={cn(
                "flex min-h-[clamp(15rem,32vh,22rem)] flex-col items-center justify-center gap-2 rounded-3xl border px-6 text-center backdrop-blur-sm",
                glass,
              )}
              data-cafe-atrium-empty-state="true"
            >
              <p className={cn("text-2xl font-light tracking-tight", heading)}>
                {providerFilter === null ? "The garden is quiet" : "Nothing from this provider"}
              </p>
              <p className={cn("max-w-sm text-sm", muted)}>
                {providerFilter === null
                  ? "When threads and their subagents are working, they appear here."
                  : `No ${providerLabel(providerFilter)} threads are running right now.`}
              </p>
            </section>
          ) : (
            <section data-cafe-atrium-work-section="true">
              <section
                aria-labelledby={overviewTitleId}
                className="mb-5 grid min-w-0 gap-7 px-2 py-6 sm:px-4 sm:py-8 lg:grid-cols-[minmax(18rem,0.9fr)_minmax(28rem,1.1fr)] lg:items-end lg:gap-12 xl:px-6 xl:py-10"
                data-cafe-atrium-overview="true"
              >
                <div className="min-w-0">
                  <h2
                    id={overviewTitleId}
                    className={cn(
                      "max-w-[13ch] text-[clamp(2.5rem,10vw,5.25rem)] leading-[0.9] font-light tracking-[-0.055em]",
                      heading,
                    )}
                    data-cafe-atrium-overview-headline="true"
                  >
                    <span className="block">{pluralizedCount(filtered.length, "thread")},</span>
                    <span className="block font-semibold" style={{ color: tint }}>
                      {pluralizedCount(filteredMetrics.subagentCount, "subagent")},
                    </span>
                    <span className="block">{overviewStatus}</span>
                  </h2>
                  <p className={cn("mt-5 max-w-md text-sm leading-relaxed sm:text-base", muted)}>
                    {overviewDescription}
                  </p>
                </div>
                <dl
                  className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-3 sm:gap-x-8 lg:pb-1"
                  data-cafe-atrium-overview-metrics="true"
                >
                  <Stat
                    label="Threads"
                    value={String(filtered.length)}
                    tone={heading}
                    muted={label}
                  />
                  <Stat
                    label="Subagents"
                    value={String(filteredMetrics.subagentCount)}
                    tone={heading}
                    muted={label}
                  />
                  <Stat
                    label="Running"
                    value={String(filteredMetrics.runningCount)}
                    tone={heading}
                    muted={label}
                  />
                  <Stat
                    label="Cache hits"
                    value={formatCachedShare(usage.cachedShare)}
                    tone={heading}
                    muted={label}
                  />
                  <Stat
                    label="Cache saved (USD)"
                    value={formatCacheSavings(usage.cacheSavings, usage.loaded)}
                    tone={heading}
                    muted={label}
                  />
                  <Stat
                    label="Output"
                    value={usage.loaded ? formatFullTokenCount(usage.outputTokens) : "—"}
                    detail={
                      usage.loaded && usage.outputTokens > 0
                        ? formatCompactTokenCount(usage.outputTokens)
                        : undefined
                    }
                    detailAriaHidden
                    tone={heading}
                    muted={label}
                  />
                </dl>
              </section>

              <div
                className={cn(
                  "grid items-start gap-3 sm:gap-4",
                  filtered.length === 1 && "md:ml-auto md:max-w-2xl",
                  filtered.length === 2 && "md:grid-cols-2 xl:ml-auto xl:max-w-5xl",
                  filtered.length > 2 && "md:grid-cols-2 2xl:grid-cols-3",
                )}
                data-cafe-atrium-task-grid="true"
              >
                {filtered.map((card) => (
                  <TaskAtriumCardView
                    key={card.key}
                    card={card}
                    now={now}
                    tint={tint}
                    onOpen={openCard}
                    onCardElement={onCardElement}
                  />
                ))}
              </div>
            </section>
          )}

          {/* This is the Settings → Usage implementation in normal document
              flow. The pane above owns scrolling, so the complete graph and
              breakdown stay visible without a second scrollbar or fade mask. */}
          {usage.loaded && usage.raw ? (
            <section
              className={cn("rounded-2xl border backdrop-blur-md", glass)}
              data-cafe-atrium-usage-panel="true"
            >
              <div className="flex items-center gap-3 px-4 pt-3 sm:px-5">
                <span className={cn("font-mono text-[10px] uppercase tracking-[0.14em]", label)}>
                  Summary &middot; all threads
                </span>
              </div>
              <MemoizedUsageCostContent usage={usage.raw} />
            </section>
          ) : (
            <section
              className={cn("rounded-2xl border p-4 backdrop-blur-md sm:p-5", glass)}
              data-cafe-atrium-usage-loading="true"
              aria-label="Loading usage summary"
            >
              <div className={cn("font-mono text-[10px] uppercase tracking-[0.14em]", label)}>
                Summary &middot; all threads
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-[minmax(13rem,0.34fr)_1fr]">
                <div className="h-28 animate-pulse rounded-xl bg-white/5 motion-reduce:animate-none" />
                <div className="h-28 animate-pulse rounded-xl bg-white/5 motion-reduce:animate-none" />
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
