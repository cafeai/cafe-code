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
import { CircleCheckIcon } from "lucide-react";

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
/** Matches the engine's state palette so the two views never disagree. */
const HOLD_COLOR = "#f5a524";
const FAULT_COLOR = "#ef4444";
const SETTLED_COLOR = "#9aa3ad";
/**
 * Detail streams are live backend resources, not free renderer selectors. A
 * large imported environment must not pin one subscription per shell card.
 * The observer prefetches nearby cards and rotates this fixed window as the
 * user scrolls; every card remains in the scroll column and hydrates on demand.
 */
const MAX_ATRIUM_DETAIL_SUBSCRIPTIONS = 24;
const ATRIUM_DETAIL_PREFETCH_MARGIN_PX = 320;

const currencyFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Compact currency for the stat grid. Full precision overflows a narrow column
 * and truncates to something like "$140,83…", which is worse than rounding.
 */
function compactCurrency(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `$${(value / 1_000).toFixed(0)}K`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return currencyFormat.format(value);
}

/** `48.0B` / `142M` — matches the Usage page so the two figures read alike. */
function compactTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(0)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(Math.round(value));
}

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
  const continueBackgroundAnimations = useSettings(
    (settings) => settings.continueBackgroundAnimations,
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = createAtriumScene(canvas);
    if (!scene) return;
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
  tone,
  muted,
  color,
}: {
  label: string;
  value: string;
  tone: string;
  muted: string;
  color?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className={cn("font-mono text-[10px] uppercase tracking-[0.1em]", muted)}>{label}</dt>
      <dd
        className={cn("mt-0.5 truncate text-xl tabular-nums", tone)}
        style={color ? { color } : undefined}
      >
        {value}
      </dd>
    </div>
  );
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
        <ul
          aria-label={`Subagents for ${card.title}`}
          className="mt-3 flex flex-col gap-1 rounded-xl bg-[#ece7e2] p-2.5 dark:bg-white/8"
          data-cafe-atrium-subagent-list="true"
        >
          {card.subagents.map((subagent) => (
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
  const [taskScrollerElement, setTaskScrollerElement] = useState<HTMLDivElement | null>(null);
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
    if (!taskScrollerElement) return;
    let frame: number | null = null;
    const refreshVisibleCards = () => {
      frame = null;
      const root = taskScrollerElement.getBoundingClientRect();
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
            root: taskScrollerElement,
            rootMargin: `${ATRIUM_DETAIL_PREFETCH_MARGIN_PX}px 0px`,
          });
    cardIntersectionObserverRef.current = observer;
    for (const element of cardElementsRef.current.values()) observer?.observe(element);
    taskScrollerElement.addEventListener("scroll", scheduleVisibleCardsRefresh, { passive: true });
    window.addEventListener("resize", scheduleVisibleCardsRefresh);
    scheduleVisibleCardsRefresh();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      taskScrollerElement.removeEventListener("scroll", scheduleVisibleCardsRefresh);
      window.removeEventListener("resize", scheduleVisibleCardsRefresh);
      if (refreshVisibleCardsRef.current === scheduleVisibleCardsRefresh) {
        refreshVisibleCardsRef.current = null;
      }
      if (cardIntersectionObserverRef.current === observer) {
        cardIntersectionObserverRef.current = null;
      }
    };
  }, [taskScrollerElement]);
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
    const observed = filtered.filter((card) => visibleCardKeys.has(card.key));
    // Before the first observer callback, hydrate the leading card so a cold
    // board never sits empty. The fixed slice remains a security boundary even
    // when an unusually tall viewport intersects many compact cards at once.
    const candidates = observed.length > 0 ? observed : filtered.slice(0, 1);
    return candidates.slice(0, MAX_ATRIUM_DETAIL_SUBSCRIPTIONS);
  }, [filtered, visibleCardKeys]);
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

      {/* Glass pill nav, floating over the scene. */}
      <div className="relative z-20 flex min-w-0 shrink-0 justify-center py-4 pr-14 pl-3 sm:pl-4">
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

      {filtered.length === 0 ? (
        <div className="relative z-10 flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className={cn("text-2xl font-light tracking-tight", heading)}>
            {providerFilter === null ? "The garden is quiet" : "Nothing from this provider"}
          </p>
          <p className={cn("max-w-sm text-sm", muted)}>
            {providerFilter === null
              ? "When threads and their subagents are working, they appear here."
              : `No ${providerLabel(providerFilter)} threads are running right now.`}
          </p>
        </div>
      ) : (
        <div className="relative z-10 grid min-h-0 flex-1 grid-cols-1 items-stretch gap-4 overflow-hidden px-3 pb-4 sm:px-6 sm:pb-6 lg:grid-cols-[1fr_1.2fr] lg:px-10">
          {/* Lede. Hidden on narrow layouts, where the cards need the room. */}
          <div className="hidden lg:block">
            <h2
              className={cn(
                "text-4xl leading-[1.06] font-light tracking-tight xl:text-5xl",
                heading,
              )}
            >
              {filtered.length === 1 ? "One thread" : `${filtered.length} threads`},
              <br />
              <span className="font-semibold" style={{ color: tint }}>
                {filteredMetrics.subagentCount === 1
                  ? "one subagent"
                  : `${filteredMetrics.subagentCount} subagents`}
              </span>
              ,<br />
              {filteredMetrics.holdingCount > 0
                ? "one needs you."
                : filteredMetrics.runningCount > 0
                  ? "all working."
                  : filteredMetrics.errorCount > 0
                    ? "stopped."
                    : "all done."}
            </h2>
            <p className={cn("mt-3 max-w-xs text-sm", muted)}>
              {filteredMetrics.holdingCount > 0
                ? `${filteredMetrics.holdingCount} waiting on you. Everything else is moving on its own.`
                : filteredMetrics.errorCount > 0 && filteredMetrics.runningCount === 0
                  ? `${filteredMetrics.errorCount} ${filteredMetrics.errorCount === 1 ? "thread" : "threads"} stopped on an error. Open one to see what happened.`
                  : "Nothing here asks for you. The garden keeps its own hours."}
            </p>
            <dl className="mt-7 grid max-w-md grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <Stat label="Threads" value={String(filtered.length)} tone={heading} muted={label} />
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
              {filteredMetrics.holdingCount > 0 ? (
                <Stat
                  label="Holding"
                  value={String(filteredMetrics.holdingCount)}
                  tone=""
                  muted={label}
                  color={HOLD_COLOR}
                />
              ) : null}
              {filteredMetrics.errorCount > 0 ? (
                <Stat
                  label="Errors"
                  value={String(filteredMetrics.errorCount)}
                  tone=""
                  muted={label}
                  color={FAULT_COLOR}
                />
              ) : null}
              {usage.cachedShare !== null ? (
                <Stat
                  label="Cache hits"
                  value={`${(usage.cachedShare * 100).toFixed(1)}%`}
                  tone={heading}
                  muted={label}
                />
              ) : null}
              {usage.cacheSavings > 0 ? (
                <Stat
                  label="Cache saved"
                  value={compactCurrency(usage.cacheSavings)}
                  tone={heading}
                  muted={label}
                />
              ) : null}
              {usage.outputTokens > 0 ? (
                <Stat
                  label="Output"
                  value={compactTokens(usage.outputTokens)}
                  tone={heading}
                  muted={label}
                />
              ) : null}
            </dl>
          </div>

          <div
            ref={setTaskScrollerElement}
            className="ml-auto flex h-full min-h-0 w-full max-w-md flex-col gap-3 self-stretch overflow-y-auto overscroll-contain py-2 pr-1 pb-4 [scrollbar-gutter:stable]"
            data-cafe-atrium-task-scroll="true"
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
        </div>
      )}

      {/* The same cost panels as Settings → Usage, not a second implementation.
          Always rendered: it describes every thread ever run, so an idle Atrium
          still has something worth reading. Scrolls on its own and collapses to
          one column on narrow layouts, where the panels stack. */}
      {usage.loaded && usage.raw ? (
        <div
          // Fades at the bottom edge so a clipped panel reads as "scroll for
          // more" rather than as a layout that ran out of room.
          className={cn(
            "relative z-20 mx-3 mb-3 max-h-[min(28vh,18rem)] shrink-0 overflow-y-auto overscroll-contain sm:mx-4 sm:mb-4 lg:mx-10",
            "[mask-image:linear-gradient(to_bottom,black_calc(100%-2.5rem),transparent)]",
          )}
        >
          <div className={cn("rounded-2xl border backdrop-blur-md", glass)}>
            <div className="flex items-center gap-3 px-4 pt-3 sm:px-5">
              <span className={cn("font-mono text-[10px] uppercase tracking-[0.14em]", label)}>
                Summary &middot; all threads
              </span>
            </div>
            <UsageCostContent usage={usage.raw} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
