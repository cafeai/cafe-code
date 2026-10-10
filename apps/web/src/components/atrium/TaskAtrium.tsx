import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@cafecode/client-runtime";
import { CircleCheckIcon } from "lucide-react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { normalizeAccentColor } from "../../themeAccent";
import { useStore, type AppState } from "../../store";
import { useWorkspaceEnvironmentId } from "../../environments/workspace";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn, isWindowsPlatform } from "../../lib/utils";
import { isElectron } from "../../env";
import { retainThreadDetailSubscription } from "../../environments/runtime/service";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Skeleton } from "../ui/skeleton";
import { ThreadStatusLabel } from "../ThreadStatusIndicators";
import {
  getThreadStatusPill,
  resolveThreadStatusPill,
  type ThreadStatusPill,
} from "../Sidebar.logic";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { SubagentAvatar } from "../subagents/SubagentAvatar";
import { SubagentDetailView } from "../chat/SubagentDetailView";
import { UsageCostContent } from "../settings/UsageCostSection";
import { formatCompactTokenCount, formatFullTokenCount } from "../settings/usageStatsPresentation";
import { useUsageCostSummary } from "../stats/useUsageCostSummary";
import { createAtriumScene, type AtriumScene } from "./atriumScene";
import {
  EMPTY_ATRIUM,
  formatAtriumCardElapsed,
  formatElapsed,
  mergeTaskAtriumErrorDismissals,
  selectAtriumSnapshot,
  type AtriumCard,
  type AtriumCardState,
} from "./taskAtriumData";
import { useTaskAtriumStore } from "./taskAtriumStore";
import { AtriumSubagentDetailBoundary } from "./AtriumSubagentDetailBoundary";
import {
  paginateAtriumSubagents,
  partitionAtriumSubagents,
  type AtriumSubagentView,
} from "./atriumSubagentPagination";
import { ProviderDriverKind } from "@cafecode/contracts";
import { subagentToWorkLogEntry } from "../../session-logic";
import { presentTurnConfiguration } from "../../turnConfiguration";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

// MessagesTimeline already includes this authorization-checked reader in the
// renderer bundle. A dynamic import here only created a hashed re-export shim:
// rebuilding assets under an open renderer could remove it before the first
// worker click. Reuse the loaded implementation without another asset request.

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
 * visible. Its local controls filter/page retained child observations or clear
 * exact historical error cards; none alters provider or orchestration state.
 *
 * Everything above the scene uses the theme's surface/text/status tokens, so
 * cards read like the rest of the app in both themes; only the scene itself is
 * tinted by the Atrium colour.
 */

const FALLBACK_TINT = "#48cfff";
const MemoizedUsageCostContent = memo(UsageCostContent);
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

/**
 * Card status in the shared chat-status vocabulary (docs/style-guide.md §2):
 * working uses the accent colour, attention amber, completed green and failed
 * red, rendered through the same `ThreadStatusLabel` dot as the sidebar.
 *
 * The Atrium's card state is its own read-only derivation — it deliberately
 * keeps recently finished or failed work on the wall whether or not the chat
 * was viewed — so terminal and running cards cannot be resolved from the
 * sidebar's unseen-completion rule. A card waiting on the user, though, is
 * resolved through `resolveThreadStatusPill` from the same shell summary, so
 * an approval and a question read exactly as they do in the sidebar.
 */
const ATRIUM_CARD_STATUS: Record<Exclude<AtriumCardState, "holding">, ThreadStatusPill> = {
  running: getThreadStatusPill("Working"),
  error: getThreadStatusPill("Failed"),
  done: getThreadStatusPill("Completed"),
};
/** Used only if the summary is momentarily missing for a waiting card. */
const ATRIUM_HOLDING_FALLBACK_STATUS = getThreadStatusPill("Awaiting Input");

/** "Pending Approval" → "Pending approval": sentence case for visible text. */
function statusText(status: ThreadStatusPill): string {
  return status.label.charAt(0) + status.label.slice(1).toLowerCase();
}

type AtriumCardPresentation = {
  readonly status: ThreadStatusPill;
  /** True until the card's detail stream has delivered any activity slice. */
  readonly detailPending: boolean;
};

/**
 * Presentation-only facts read alongside the snapshot on the board's existing
 * one-second clock. It never subscribes to the store, so streamed tokens still
 * cannot re-render the board.
 */
function readCardPresentation(state: AppState, card: AtriumCard): AtriumCardPresentation {
  const environment = state.environmentStateById[card.environmentId];
  const detailPending = environment?.activityIdsByThreadId[card.threadId] === undefined;
  if (card.state !== "holding") {
    return { status: ATRIUM_CARD_STATUS[card.state], detailPending };
  }
  const summary = environment?.sidebarThreadSummaryById[card.threadId];
  return {
    status:
      (summary ? resolveThreadStatusPill({ thread: summary }) : null) ??
      ATRIUM_HOLDING_FALLBACK_STATUS,
    detailPending,
  };
}

/**
 * A sliding selection indicator for a row of toggle buttons that are not a
 * plain exclusive choice (the provider filter can be cleared by pressing the
 * active pill again, so it keeps button/aria-pressed semantics instead of the
 * shared SegmentedControl). The indicator moves with `translate`; the first
 * measurement places it without sliding in from the edge.
 */
function useSlidingIndicator(
  trackRef: RefObject<HTMLElement | null>,
): { left: number; width: number; animate: boolean } | null {
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);
  const [animate, setAnimate] = useState(false);
  const measure = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const selected = track.querySelector<HTMLElement>(
      '[data-cafe-atrium-segment][aria-pressed="true"]',
    );
    if (!selected) {
      setIndicator(null);
      return;
    }
    setIndicator((previous) =>
      previous?.left === selected.offsetLeft && previous.width === selected.offsetWidth
        ? previous
        : { left: selected.offsetLeft, width: selected.offsetWidth },
    );
  }, [trackRef]);
  // Re-measure after every render: selection and pill counts change through
  // ordinary renders, and an unchanged measurement bails out without a render.
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    const track = trackRef.current;
    if (!track || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [trackRef, measure]);
  useEffect(() => {
    if (!indicator || animate) return undefined;
    const frame = window.requestAnimationFrame(() => setAnimate(true));
    return () => window.cancelAnimationFrame(frame);
  }, [indicator, animate]);
  return indicator ? { ...indicator, animate } : null;
}

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

/** The same provider marks used by Settings → Usage, instead of colour dots. */
function ProviderMark({ provider }: { provider: string }) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[provider as never];
  return Icon ? <Icon aria-hidden="true" className="size-3 shrink-0" /> : null;
}

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
}: {
  label: string;
  value: string;
  detail?: string | undefined;
  detailAriaHidden?: boolean;
}) {
  return (
    <div className="min-w-0 py-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-xl leading-none font-medium tracking-tight tabular-nums text-foreground [overflow-wrap:anywhere] sm:text-2xl">
        {value}
      </dd>
      {detail ? (
        <dd
          className="mt-0.5 text-2xs tabular-nums text-subtle-foreground"
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
  status: ThreadStatusPill;
  detailPending: boolean;
  onOpen: (card: AtriumCard) => void;
  onOpenSubagent: (card: AtriumCard, rowKey: string) => void;
  onCardElement: (key: string, element: HTMLElement | null) => void;
}

/** Child status text colour: live work in the accent, failures red, the rest quiet. */
function subagentStatusClass(status: AtriumCard["subagents"][number]["status"]): string {
  switch (status) {
    case "active":
      return "text-primary";
    case "waiting":
      return "text-status-attention-foreground";
    case "failed":
      return "text-status-error-foreground";
    default:
      return "text-subtle-foreground";
  }
}

const TaskAtriumCardView = memo(function TaskAtriumCardView({
  card,
  now,
  status,
  detailPending,
  onOpen,
  onOpenSubagent,
  onCardElement,
}: TaskAtriumCardViewProps) {
  const elapsed = formatAtriumCardElapsed(card, now);
  const configuration = useMemo(
    () => (card.turnConfiguration ? presentTurnConfiguration(card.turnConfiguration) : null),
    [card.turnConfiguration],
  );
  const titleId = useId();
  const configurationId = useId();
  const subagentListId = useId();
  const [subagentSelection, setSubagentSelection] = useState<{
    view: AtriumSubagentView;
    pageIndex: number;
  }>({ view: "active", pageIndex: 0 });
  // The board's one-second elapsed clock must not repeatedly partition/sort
  // hundreds of retained history rows. Only immutable roster changes rebuild
  // these groups; pagination itself slices at most five display rows.
  const subagentGroups = useMemo(() => partitionAtriumSubagents(card.subagents), [card.subagents]);
  const selectedSubagents = subagentGroups[subagentSelection.view];
  const subagentPage = useMemo(
    () => paginateAtriumSubagents(selectedSubagents, subagentSelection.pageIndex),
    [selectedSubagents, subagentSelection.pageIndex],
  );
  useEffect(() => {
    if (subagentSelection.pageIndex === subagentPage.pageIndex) return;
    // Rendering already uses the clamped page. Retire the stale cursor as well
    // so a later roster growth cannot unexpectedly jump back to the old page.
    // Do not overwrite a view/page choice made after this render's observation.
    setSubagentSelection((current) =>
      current === subagentSelection ? { ...current, pageIndex: subagentPage.pageIndex } : current,
    );
  }, [subagentSelection, subagentPage.pageIndex]);
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
      className={cn(
        "group relative w-full shrink-0 overflow-hidden rounded-2xl p-4 text-left [contain-intrinsic-size:auto_14rem] [content-visibility:auto]",
        // Theme card surfaces, slightly translucent so the scene still reads
        // through: white paper on a light sky, the dark card on a dusk one.
        "border border-border bg-card/90 text-card-foreground backdrop-blur-md",
        "shadow-xl shadow-black/10 transition-shadow duration-(--duration-base) ease-out hover:shadow-2xl dark:shadow-black/40",
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
        aria-describedby={configurationId}
        title={configuration?.sourceDescription}
        className="absolute inset-0 z-10 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      />

      <div className="flex items-center gap-2 text-2xs">
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-muted-foreground">
          <ProviderMark provider={card.provider} />
          <span className="truncate">{providerLabel(card.provider)}</span>
        </span>
        <span
          className={cn("ml-auto flex shrink-0 items-center gap-1 font-medium", status.colorClass)}
          data-cafe-atrium-card-status={card.state}
        >
          {/* The dot is the shared sidebar indicator; the visible text below
              carries the accessible label, so the dot itself is decorative. */}
          <span aria-hidden="true" className="inline-flex">
            <ThreadStatusLabel status={status} />
          </span>
          {statusText(status)}
        </span>
      </div>

      {/* This is the same accepted-turn sanity check as the work log, not an
          independent assertion of native execution or billing. Long labels
          wrap as inert text; no account identifiers or raw options are read. */}
      <div
        id={configurationId}
        data-cafe-atrium-turn-configuration="true"
        className="mt-1.5 min-w-0 text-2xs [overflow-wrap:anywhere]"
        title={configuration?.sourceDescription}
      >
        {configuration ? (
          <>
            <div className="font-medium text-muted-foreground">{configuration.settings}</div>
            <div className="mt-0.5 text-subtle-foreground">
              {configuration.account} · {configuration.modes}
            </div>
          </>
        ) : (
          // Missing or not-yet-hydrated records must read as unavailable
          // rather than borrowing today's composer defaults.
          <div className="text-subtle-foreground">Settings unavailable</div>
        )}
      </div>

      <div
        id={titleId}
        className="mt-2 line-clamp-2 text-base leading-tight font-medium tracking-tight text-foreground"
      >
        {card.title}
      </div>
      {card.projectName ? (
        <div className="mt-1 truncate text-2xs text-subtle-foreground">{card.projectName}</div>
      ) : null}

      {/* The reference's photo window becomes the live subagent list. */}
      {card.subagents.length === 0 &&
      detailPending &&
      (card.state === "running" || card.state === "holding") ? (
        // Reserve one row while this live card's detail is still hydrating so
        // the grid does not jump when its subagents arrive.
        <div
          aria-hidden="true"
          className="mt-3 flex items-center gap-2.5 rounded-xl bg-muted p-2.5"
          data-cafe-atrium-subagent-placeholder="true"
        >
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ) : null}
      {card.subagents.length > 0 ? (
        <div
          className="mt-3 rounded-xl bg-muted p-2.5"
          data-cafe-atrium-subagent-view={subagentSelection.view}
        >
          <div
            role="group"
            aria-label={`Subagent view for ${card.title}`}
            className="relative z-20 mb-2 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
          >
            {/* One indicator slides between the two equal columns. */}
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.375rem)] rounded-md bg-card shadow-xs/5 dark:bg-input/70",
                "transition-[translate] duration-(--duration-base) ease-out motion-reduce:transition-none",
                subagentSelection.view === "history" && "translate-x-[calc(100%+0.25rem)]",
              )}
            />
            {(["active", "history"] as const).map((view) => (
              <button
                key={view}
                type="button"
                aria-pressed={subagentSelection.view === view}
                aria-controls={subagentListId}
                className={cn(
                  "focus-ring relative min-h-8 min-w-0 rounded-md px-2 text-2xs font-medium tabular-nums transition-colors duration-(--duration-fast)",
                  subagentSelection.view === view
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={(event) => {
                  // These are local presentation controls above the card's
                  // full-surface navigation button, never provider actions.
                  event.stopPropagation();
                  if (view !== subagentSelection.view) {
                    setSubagentSelection({ view, pageIndex: 0 });
                  }
                }}
              >
                {view === "active" ? "Active" : "History"} ({subagentGroups[view].length})
              </button>
            ))}
          </div>
          <ul
            id={subagentListId}
            aria-label={`Subagents for ${card.title}`}
            className="flex flex-col gap-1"
            data-cafe-atrium-subagent-list="true"
          >
            {subagentPage.rows.map((subagent) => (
              <li
                key={subagent.rowKey}
                className="min-w-0 text-2xs text-muted-foreground"
                data-cafe-atrium-subagent-row="true"
              >
                <button
                  type="button"
                  onClick={() => onOpenSubagent(card, subagent.rowKey)}
                  aria-label={`View ${subagent.label} activity`}
                  className="focus-ring relative z-20 grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 rounded-lg px-0.5 py-1.5 text-left transition-colors duration-(--duration-fast) hover:bg-accent"
                >
                  <SubagentAvatar seed={subagent.id} className="size-7" />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-foreground">
                      {subagent.label}
                    </span>
                    <span
                      className="mt-0.5 line-clamp-2 break-words text-muted-foreground"
                      data-cafe-atrium-subagent-detail="true"
                      title={subagent.detail}
                    >
                      {subagent.detail}
                    </span>
                  </span>
                  <span className="w-[5.5rem] min-w-0 shrink-0 pt-0.5 text-right break-words">
                    <span className={cn("block font-medium", subagentStatusClass(subagent.status))}>
                      {subagent.status === "waiting"
                        ? "Waiting"
                        : subagent.status === "active"
                          ? "Working"
                          : subagent.status === "failed"
                            ? "Failed"
                            : subagent.status === "stopped"
                              ? "Stopped"
                              : subagent.status === "unknown"
                                ? "Status unavailable"
                                : "Done"}
                    </span>
                    {subagent.status !== "unknown" &&
                    subagent.startedAt !== null &&
                    (subagent.running || subagent.completedAt !== null) ? (
                      <span className="mt-0.5 block font-mono tabular-nums text-subtle-foreground">
                        {formatElapsed(
                          subagent.startedAt,
                          subagent.running ? now : subagent.completedAt!,
                        )}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {subagentPage.total === 0 ? (
            <p className="px-1 py-3 text-center text-2xs text-muted-foreground">
              {subagentSelection.view === "active" ? "No active subagents" : "No subagent history"}
            </p>
          ) : subagentPage.pageCount > 1 ? (
            <div
              role="group"
              aria-label={`Subagent pages for ${card.title}`}
              className="relative z-20 mt-2 border-t border-border-subtle pt-2"
            >
              <p
                role="status"
                className="text-center text-2xs text-subtle-foreground tabular-nums"
                data-cafe-atrium-subagent-page-status="true"
              >
                {subagentPage.start}–{subagentPage.end} of {subagentPage.total} · Page{" "}
                {subagentPage.pageIndex + 1} of {subagentPage.pageCount}
              </p>
              <div className="mt-1 grid grid-cols-2 gap-2">
                {(["previous", "next"] as const).map((direction) => (
                  <button
                    key={direction}
                    type="button"
                    aria-controls={subagentListId}
                    aria-label={
                      direction === "previous" ? "Previous subagents page" : "Next subagents page"
                    }
                    disabled={
                      direction === "previous"
                        ? subagentPage.pageIndex === 0
                        : subagentPage.pageIndex + 1 >= subagentPage.pageCount
                    }
                    className="focus-ring min-h-8 min-w-0 rounded-md px-2 text-2xs font-medium text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSubagentSelection({
                        view: subagentSelection.view,
                        pageIndex: subagentPage.pageIndex + (direction === "previous" ? -1 : 1),
                      });
                    }}
                  >
                    {direction === "previous" ? "Previous" : "Next"}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {card.activityLabel ? (
        <div className="mt-3 flex items-center gap-2 border-t border-border-subtle pt-2.5 text-2xs text-muted-foreground">
          <span className="truncate">
            {card.activityLabel}
            {card.activityDetail ? (
              <span className="text-subtle-foreground"> · {card.activityDetail}</span>
            ) : null}
          </span>
          {elapsed ? (
            <span className="ml-auto shrink-0 font-mono tabular-nums text-subtle-foreground">
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
    previous.card.turnConfiguration === next.card.turnConfiguration &&
    previous.card.projectName === next.card.projectName &&
    previous.card.state === next.card.state &&
    previous.card.activityLabel === next.card.activityLabel &&
    previous.card.activityDetail === next.card.activityDetail &&
    previous.card.startedAt === next.card.startedAt &&
    previous.card.completedAt === next.card.completedAt &&
    previous.card.subagents === next.card.subagents;
  if (
    !cardUnchanged ||
    // Status objects are rebuilt on each clock tick; their label identifies
    // the presentation (approval vs input for a waiting card).
    previous.status.label !== next.status.label ||
    previous.detailPending !== next.detailPending ||
    previous.onOpenSubagent !== next.onOpenSubagent ||
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
  const environmentId = useWorkspaceEnvironmentId();
  const tint = useAtriumTint();
  const overviewTitleId = useId();
  const dismissedTaskAtriumErrors = useSettings((settings) => settings.dismissedTaskAtriumErrors);
  const { updateSettings } = useUpdateSettings();
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";
  const navigate = useNavigate();
  const closeAtrium = useTaskAtriumStore((state) => state.setOpen);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const providerTrackRef = useRef<HTMLDivElement | null>(null);
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
  const [cardPresentation, setCardPresentation] = useState<
    ReadonlyMap<string, AtriumCardPresentation>
  >(() => new Map());
  const [selectedWorker, setSelectedWorker] = useState<{ cardKey: string; rowKey: string } | null>(
    null,
  );
  const detailBackRef = useRef<HTMLButtonElement | null>(null);
  const selectedCard = selectedWorker
    ? snapshot.cards.find((card) => card.key === selectedWorker.cardKey)
    : undefined;
  const selectedSubagent = selectedCard?.subagents.find(
    (row) => row.rowKey === selectedWorker?.rowKey,
  );
  const openSubagent = useCallback(
    (card: AtriumCard, rowKey: string) => setSelectedWorker({ cardKey: card.key, rowKey }),
    [],
  );
  const closeSubagent = useCallback(() => setSelectedWorker(null), []);
  useEffect(() => {
    // Retraction/deletion of the exact lifecycle row revokes this local
    // selection. Do not silently reopen it if the parent later reappears.
    if (selectedWorker && !selectedSubagent) setSelectedWorker(null);
  }, [selectedWorker, selectedSubagent]);
  useEffect(() => {
    let interval: number | null = null;
    const tick = () => {
      const timestamp = Date.now();
      const state = useStore.getState();
      const nextSnapshot = selectAtriumSnapshot(
        state,
        timestamp,
        dismissedTaskAtriumErrors,
        environmentId,
      );
      setNow(timestamp);
      setSnapshot(nextSnapshot);
      setCardPresentation(
        new Map(nextSnapshot.cards.map((card) => [card.key, readCardPresentation(state, card)])),
      );
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
  }, [dismissedTaskAtriumErrors, environmentId]);

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
    // Keep the selected worker's owner subscribed even if the board scrolls
    // away or a provider filter changes. It still consumes one bounded slot.
    if (selectedCard)
      return [selectedCard, ...candidates.filter((card) => card.key !== selectedCard.key)].slice(
        0,
        MAX_ATRIUM_DETAIL_SUBSCRIPTIONS,
      );
    return candidates.slice(0, MAX_ATRIUM_DETAIL_SUBSCRIPTIONS);
  }, [detailHydrationReady, filtered, visibleCardKeys, selectedCard]);
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
        ? `${pluralizedCount(filteredMetrics.errorCount, "chat")} stopped on an error. Open one to see why.`
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
  // Translucent theme surface for chrome that floats over the scene.
  const glass = "border-border bg-card/60 text-foreground";
  const providerIndicator = useSlidingIndicator(providerTrackRef);

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
              ref={providerTrackRef}
              role="group"
              aria-label="Filter by provider"
              className={cn(
                "relative flex min-w-0 max-w-full items-center gap-1 overflow-x-auto overscroll-x-contain rounded-full border p-1 backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                glass,
              )}
            >
              {/* One indicator slides under the pressed pill. It lives inside
                  the horizontal scroller, so it scrolls with the pills. */}
              {providerIndicator ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute top-1 bottom-1 left-0 rounded-full bg-foreground",
                    providerIndicator.animate &&
                      "transition-[translate,width] duration-(--duration-base) ease-out motion-reduce:transition-none",
                  )}
                  style={{
                    translate: `${providerIndicator.left}px 0`,
                    width: providerIndicator.width,
                  }}
                />
              ) : null}
              <button
                type="button"
                onClick={() => setProviderFilter(null)}
                aria-pressed={providerFilter === null}
                data-cafe-atrium-segment=""
                className={cn(
                  "focus-ring relative rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors duration-(--duration-fast)",
                  providerFilter === null
                    ? "text-background"
                    : "text-muted-foreground hover:text-foreground",
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
                    data-cafe-atrium-segment=""
                    className={cn(
                      "focus-ring relative flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors duration-(--duration-fast)",
                      active ? "text-background" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {providerLabel(provider)}
                    <span
                      className={cn(
                        "tabular-nums",
                        active ? "text-background" : "text-subtle-foreground",
                      )}
                    >
                      {count}
                    </span>
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
                        "focus-ring flex size-8 items-center justify-center rounded-full border backdrop-blur-md",
                        "transition-colors duration-(--duration-fast) hover:bg-card",
                        glass,
                      )}
                    />
                  }
                >
                  <CircleCheckIcon className="size-4" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">
                  Clear {snapshot.errorCount} {snapshot.errorCount === 1 ? "error" : "errors"}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </div>

        <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-5 px-3 pb-5 sm:px-6 sm:pb-7 lg:px-10">
          {filtered.length === 0 ? (
            <section
              className={cn(
                "flex min-h-[clamp(15rem,32vh,22rem)] flex-col items-center justify-center gap-2 rounded-2xl border px-6 text-center backdrop-blur-sm",
                glass,
              )}
              data-cafe-atrium-empty-state="true"
            >
              <p className="text-2xl font-light tracking-tight text-foreground">
                {providerFilter === null ? "The garden is quiet" : "Nothing from this provider"}
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                {providerFilter === null
                  ? "Working chats and their subagents appear here."
                  : `No ${providerLabel(providerFilter)} chats are running.`}
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
                    className="max-w-[13ch] text-[clamp(2.5rem,10vw,5.25rem)] leading-[0.9] font-light tracking-[-0.055em] text-foreground"
                    data-cafe-atrium-overview-headline="true"
                  >
                    <span className="block">{pluralizedCount(filtered.length, "chat")},</span>
                    <span className="block font-semibold" style={{ color: tint }}>
                      {pluralizedCount(filteredMetrics.subagentCount, "subagent")},
                    </span>
                    <span className="block">{overviewStatus}</span>
                  </h2>
                  <p className="-mx-2 mt-5 w-fit max-w-md rounded-lg bg-background/50 px-2 py-1 text-sm leading-relaxed text-muted-foreground backdrop-blur-sm sm:text-base">
                    {overviewDescription}
                  </p>
                </div>
                {/* Chat and subagent counts are already the headline, so the
                    metrics carry only what it does not say. The soft backdrop
                    keeps them legible when blossoms drift behind. */}
                <dl
                  className="grid min-w-0 grid-cols-2 gap-x-5 gap-y-5 rounded-xl bg-background/60 p-4 backdrop-blur-sm sm:grid-cols-4 sm:gap-x-6 lg:mb-1 lg:grid-cols-2 2xl:grid-cols-4"
                  data-cafe-atrium-overview-metrics="true"
                >
                  <Stat label="Running" value={String(filteredMetrics.runningCount)} />
                  <Stat label="Cache hits" value={formatCachedShare(usage.cachedShare)} />
                  <Stat
                    label="Cache saved (USD)"
                    value={formatCacheSavings(usage.cacheSavings, usage.loaded)}
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
                    status={
                      cardPresentation.get(card.key)?.status ??
                      (card.state === "holding"
                        ? ATRIUM_HOLDING_FALLBACK_STATUS
                        : ATRIUM_CARD_STATUS[card.state])
                    }
                    detailPending={cardPresentation.get(card.key)?.detailPending ?? true}
                    onOpen={openCard}
                    onOpenSubagent={openSubagent}
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
              className={cn("animate-enter-fade rounded-2xl border backdrop-blur-md", glass)}
              data-cafe-atrium-usage-panel="true"
            >
              <div className="flex items-center gap-3 px-4 pt-3 sm:px-5">
                <span className="label-overline">Usage · all chats</span>
              </div>
              <MemoizedUsageCostContent usage={usage.raw} />
            </section>
          ) : (
            // Mirrors UsageCostContent's toolbar, hero/chart grid and tiles so
            // the real summary replaces it without the pane jumping.
            <section
              className={cn("rounded-2xl border backdrop-blur-md", glass)}
              data-cafe-atrium-usage-loading="true"
              aria-label="Loading usage summary"
              aria-busy="true"
            >
              <div className="flex items-center gap-3 px-4 pt-3 sm:px-5">
                <span className="label-overline">Usage · all chats</span>
              </div>
              <div className="@container/usage-cost min-w-0" aria-hidden="true">
                <div className="flex justify-end gap-3 px-4 pt-3 sm:px-5">
                  <Skeleton className="h-7 w-36 rounded-lg" />
                  <Skeleton className="h-7 w-24 rounded-md" />
                </div>
                <div className="grid gap-5 px-4 py-4 sm:px-5 @min-[52rem]/usage-cost:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
                  <div className="flex min-w-0 flex-col gap-2">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-10 w-44" />
                    <Skeleton className="h-3 w-full max-w-64" />
                    <div className="mt-4 flex flex-col gap-4">
                      <Skeleton className="h-8 w-full" />
                      <Skeleton className="h-8 w-full" />
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-col gap-2">
                    <Skeleton className="h-3 w-40" />
                    <Skeleton className="h-[clamp(12rem,24cqw,20rem)] w-full rounded-xl" />
                  </div>
                </div>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))] gap-4 border-t border-border-subtle px-4 py-4 sm:px-5">
                  <Skeleton className="h-14" />
                  <Skeleton className="h-14" />
                  <Skeleton className="h-14" />
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
      <DialogPrimitive.Root
        open={selectedSubagent !== undefined}
        onOpenChange={(open) => {
          if (!open) closeSubagent();
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-[70] bg-black/35 backdrop-blur-sm transition-opacity duration-(--duration-slow) ease-out data-ending-style:opacity-0 data-ending-style:duration-(--duration-fast) data-ending-style:ease-in data-starting-style:opacity-0" />
          <DialogPrimitive.Popup
            aria-label="Subagent activity"
            data-cafe-atrium-subagent-popup="true"
            data-cafe-window-no-drag="true"
            className={cn(
              "fixed left-1/2 top-1/2 z-[80] h-[min(85dvh,60rem)] w-[min(94vw,70rem)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border bg-background shadow-2xl outline-none [-webkit-app-region:no-drag]",
              // Fade + slight scale in, a faster fade out (docs/style-guide.md §8).
              "transition-[opacity,scale] duration-(--duration-slow) ease-out data-ending-style:scale-[0.985] data-ending-style:opacity-0 data-ending-style:duration-(--duration-fast) data-ending-style:ease-in data-starting-style:scale-[0.985] data-starting-style:opacity-0",
              // Portals do not inherit the outer modal's native inset. Keep
              // this child centered and bounded within the usable area, not
              // beneath Electron's caption controls on a short window. Every
              // layout override requires visible Windows native controls.
              isElectron &&
                isWindowsPlatform(navigator.platform) &&
                "wco:[--cafe-atrium-detail-titlebar-inset:calc(env(titlebar-area-y,0px)+env(titlebar-area-height,40px))] wco:top-[calc(50%+var(--cafe-atrium-detail-titlebar-inset)/2)] wco:h-[min(85dvh,60rem,calc(100dvh-var(--cafe-atrium-detail-titlebar-inset)-2rem))]",
            )}
          >
            {selectedCard && selectedSubagent ? (
              <AtriumSubagentDetailBoundary
                key={JSON.stringify([
                  selectedCard.key,
                  selectedSubagent.rowKey,
                  selectedSubagent.activity.turnId ?? null,
                  selectedSubagent.activity.id,
                  selectedSubagent.activity.historyId ?? null,
                ])}
                backButtonRef={detailBackRef}
                onBack={closeSubagent}
              >
                <SubagentDetailView
                  key={`${selectedCard.key}:${selectedSubagent.rowKey}`}
                  selection={{
                    environmentId: selectedCard.environmentId,
                    threadId: selectedCard.threadId,
                    rowId: selectedSubagent.rowKey,
                    turnId: selectedSubagent.activity.turnId,
                    workEntry: subagentToWorkLogEntry(selectedSubagent.activity),
                  }}
                  environmentId={selectedCard.environmentId}
                  threadId={selectedCard.threadId}
                  provider={ProviderDriverKind.make(selectedCard.provider)}
                  markdownCwd={undefined}
                  additionalWorkspaceRoots={[]}
                  skills={[]}
                  backButtonRef={detailBackRef}
                  onBack={closeSubagent}
                />
              </AtriumSubagentDetailBoundary>
            ) : null}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}
