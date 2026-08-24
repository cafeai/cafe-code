import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@cafecode/client-runtime";

import { useSettings } from "../../hooks/useSettings";
import { useTheme } from "../../hooks/useTheme";
import { normalizeAccentColor } from "../../themeAccent";
import { useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import { createAtriumScene, type AtriumScene } from "./atriumScene";
import {
  EMPTY_ATRIUM,
  formatElapsed,
  MAX_ATRIUM_CARDS,
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
 * It is a display, not a control surface: no approve, no deny, no stop. A card
 * says a thread is waiting on you because that is information about what is
 * going on, but the decision happens in the thread where the request is
 * visible. Clicking a card opens that thread; that is the whole interaction,
 * which keeps this renderer-only exactly like the ambiance layer above it.
 */

const FALLBACK_TINT = "#48cfff";
/** Matches the engine's state palette so the two views never disagree. */
const HOLD_COLOR = "#f5a524";
const FAULT_COLOR = "#ef4444";
const SETTLED_COLOR = "#9aa3ad";

const STATE_LABEL: Record<AtriumCardState, string> = {
  holding: "Waiting on you",
  running: "Running",
  error: "Error",
  done: "Done",
};

/**
 * Card slots, mirroring the staged composition rather than a grid. Each slot
 * carries a depth: nearer cards sit larger and take more of the parallax.
 */
const SLOTS: ReadonlyArray<{ left: string; top: string; depth: 1 | 2 | 3 }> = [
  { left: "0%", top: "4%", depth: 1 },
  { left: "50%", top: "0%", depth: 2 },
  { left: "2%", top: "56%", depth: 2 },
  { left: "52%", top: "50%", depth: 3 },
  { left: "24%", top: "28%", depth: 3 },
  { left: "70%", top: "24%", depth: 3 },
];

const DEPTH_SCALE: Record<1 | 2 | 3, number> = { 1: 1, 2: 0.94, 3: 0.88 };
const DEPTH_SHIFT: Record<1 | 2 | 3, number> = { 1: 26, 2: 17, 3: 10 };

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

function TaskAtriumCardView({
  card,
  slot,
  now,
  tint,
  pointer,
  onOpen,
}: {
  card: AtriumCard;
  slot: (typeof SLOTS)[number];
  now: number;
  tint: string;
  pointer: { x: number; y: number };
  onOpen: (card: AtriumCard) => void;
}) {
  const accent = stateColor(card.state, tint);
  const elapsed = formatElapsed(card.startedAt, now);
  const shift = DEPTH_SHIFT[slot.depth];
  const scale = DEPTH_SCALE[slot.depth];

  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      aria-label={`Open ${card.title}`}
      style={
        {
          "--cafe-atrium-accent": accent,
          // Transform-only parallax keeps the whole field on the compositor.
          "--cafe-atrium-parallax": `translate3d(${(-pointer.x * shift).toFixed(1)}px, ${(
            -pointer.y * shift
          ).toFixed(1)}px, 0) scale(${scale})`,
          "--cafe-atrium-left": slot.left,
          "--cafe-atrium-top": slot.top,
          zIndex: 10 - slot.depth,
        } as CSSProperties
      }
      className={cn(
        "group overflow-hidden rounded-2xl p-4 text-left will-change-transform",
        "border backdrop-blur-md transition-shadow duration-200",
        // Paper stock on a light sky, dark glass on a dusk one — the card has
        // to belong to the theme, not just to the scene behind it.
        "border-black/5 bg-[#f5f2ee] text-[#241f22] shadow-2xl shadow-black/40",
        "dark:border-white/12 dark:bg-[#1b1620]/88 dark:text-[#eee7ec]",
        "hover:shadow-[0_30px_60px_-18px_rgba(0,0,0,0.6)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cafe-atrium-accent)]",
        // Staged slots on wide layouts; a plain stacked column on narrow ones,
        // where absolute positioning would only overlap.
        "lg:absolute lg:w-[46%] lg:min-w-[250px]",
        "lg:left-[var(--cafe-atrium-left)] lg:top-[var(--cafe-atrium-top)]",
        "lg:[transform:var(--cafe-atrium-parallax)]",
        card.state === "done" && "opacity-80",
      )}
    >
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

      <div className="mt-2 line-clamp-2 text-[17px] leading-tight font-medium tracking-tight">
        {card.title}
      </div>
      {card.projectName ? (
        <div className="mt-1 truncate font-mono text-[10px] text-[#9a9199] dark:text-white/40">
          {card.projectName}
        </div>
      ) : null}

      {/* The reference's photo window becomes the live subagent list. */}
      {card.subagents.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1.5 rounded-xl bg-[#ece7e2] p-2.5 dark:bg-white/8">
          {card.subagents.map((subagent) => (
            <div
              key={subagent.id}
              className="flex items-center gap-2 text-[11px] text-[#4a4248] dark:text-white/75"
            >
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: subagent.running ? accent : SETTLED_COLOR }}
              />
              <span className="shrink-0 font-semibold">{subagent.label}</span>
              <span className="truncate text-[#6c636a] dark:text-white/50">{subagent.detail}</span>
            </div>
          ))}
          {card.extraSubagents > 0 ? (
            <div className="pl-3.5 text-[10px] text-[#948b92] dark:text-white/40">
              and {card.extraSubagents} more
            </div>
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
    </button>
  );
}

export function TaskAtriumBoard() {
  const tint = useAtriumTint();
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";
  const navigate = useNavigate();
  const closeAtrium = useTaskAtriumStore((state) => state.setOpen);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  // null = "All work". Cleared automatically if that provider stops running.
  const [providerFilter, setProviderFilter] = useState<string | null>(null);

  // Derivation allocates fresh arrays, so subscribing to the store directly
  // would re-render this board on every streamed token. Poll on one slow clock
  // instead — the same bounded-poll shape AmbianceLayer uses for its aggregate
  // signals — which also drives the elapsed readouts.
  const [now, setNow] = useState(() => Date.now());
  const [snapshot, setSnapshot] = useState(EMPTY_ATRIUM);
  useEffect(() => {
    const tick = () => {
      const timestamp = Date.now();
      setNow(timestamp);
      setSnapshot(selectAtriumSnapshot(useStore.getState(), timestamp));
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, []);

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

  // Filter first, then cap — capping first would hide threads the filter was
  // meant to reveal.
  const filtered = useMemo(
    () =>
      providerFilter === null
        ? snapshot.cards
        : snapshot.cards.filter((card) => card.provider === providerFilter),
    [snapshot.cards, providerFilter],
  );
  const visible = filtered.slice(0, MAX_ATRIUM_CARDS);
  const overflow = Math.max(0, filtered.length - visible.length);

  const openCard = (card: AtriumCard) => {
    // Close on the way out: the overlay is fixed over the whole window, so
    // navigating without closing changes the route behind a panel that still
    // covers it and nothing appears to happen.
    closeAtrium(false);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(card.environmentId, card.threadId)),
    });
  };

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
      <div className="relative z-20 flex shrink-0 justify-center p-4">
        <div
          role="group"
          aria-label="Filter by provider"
          className={cn("flex items-center gap-1 rounded-full border p-1 backdrop-blur-md", glass)}
        >
          <button
            type="button"
            onClick={() => setProviderFilter(null)}
            aria-pressed={providerFilter === null}
            className={cn(
              "rounded-full px-3 py-1 text-xs whitespace-nowrap transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current",
              providerFilter === null
                ? cn("font-semibold", dark ? "bg-white text-[#1b1620]" : "bg-[#2b2029] text-white")
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
      </div>

      {visible.length === 0 ? (
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
        <div className="relative z-10 grid min-h-0 flex-1 grid-cols-1 items-center gap-4 px-6 pb-6 lg:grid-cols-[1fr_1.2fr] lg:px-10">
          {/* Lede. Hidden on narrow layouts, where the cards need the room. */}
          <div
            className="hidden lg:block"
            style={{
              transform: `translate3d(${(-pointer.x * 8).toFixed(1)}px, ${(-pointer.y * 8).toFixed(
                1,
              )}px, 0)`,
            }}
          >
            <h2
              className={cn(
                "text-4xl leading-[1.06] font-light tracking-tight xl:text-5xl",
                heading,
              )}
            >
              {filtered.length === 1 ? "One thread" : `${filtered.length} threads`},
              <br />
              <span className="font-semibold" style={{ color: tint }}>
                {snapshot.subagentCount === 1
                  ? "one subagent"
                  : `${snapshot.subagentCount} subagents`}
              </span>
              ,<br />
              {snapshot.holdingCount > 0
                ? "one needs you."
                : snapshot.runningCount > 0
                  ? "all working."
                  : snapshot.errorCount > 0
                    ? "stopped."
                    : "all done."}
            </h2>
            <p className={cn("mt-3 max-w-xs text-sm", muted)}>
              {snapshot.holdingCount > 0
                ? `${snapshot.holdingCount} waiting on you. Everything else is moving on its own.`
                : snapshot.errorCount > 0 && snapshot.runningCount === 0
                  ? `${snapshot.errorCount} ${snapshot.errorCount === 1 ? "thread" : "threads"} stopped on an error. Open one to see what happened.`
                  : "Nothing here needs you. This is just what the garden looks like while it grows."}
            </p>
            <div className="mt-6 flex gap-6">
              <div>
                <div className={cn("font-mono text-[10px] uppercase tracking-[0.1em]", label)}>
                  Threads
                </div>
                <div className={cn("mt-0.5 text-xl tabular-nums", heading)}>{filtered.length}</div>
              </div>
              <div>
                <div className={cn("font-mono text-[10px] uppercase tracking-[0.1em]", label)}>
                  Subagents
                </div>
                <div className={cn("mt-0.5 text-xl tabular-nums", heading)}>
                  {snapshot.subagentCount}
                </div>
              </div>
              {snapshot.holdingCount > 0 ? (
                <div>
                  <div className={cn("font-mono text-[10px] uppercase tracking-[0.1em]", label)}>
                    Holding
                  </div>
                  <div className="mt-0.5 text-xl tabular-nums" style={{ color: HOLD_COLOR }}>
                    {snapshot.holdingCount}
                  </div>
                </div>
              ) : null}
              {snapshot.errorCount > 0 ? (
                <div>
                  <div className={cn("font-mono text-[10px] uppercase tracking-[0.1em]", label)}>
                    Errors
                  </div>
                  <div className="mt-0.5 text-xl tabular-nums" style={{ color: FAULT_COLOR }}>
                    {snapshot.errorCount}
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <div className="relative min-h-0 self-stretch max-lg:flex max-lg:flex-col max-lg:gap-3 max-lg:overflow-y-auto max-lg:py-2">
            {visible.map((card, index) => (
              <TaskAtriumCardView
                key={card.key}
                card={card}
                slot={SLOTS[index % SLOTS.length]!}
                now={now}
                tint={tint}
                pointer={pointer}
                onOpen={openCard}
              />
            ))}
          </div>
        </div>
      )}

      {overflow > 0 ? (
        <div
          className={cn(
            "relative z-20 mx-6 mb-4 shrink-0 rounded-xl border px-4 py-2 text-xs backdrop-blur-md",
            glass,
          )}
        >
          and {overflow} more {overflow === 1 ? "thread" : "threads"}
        </div>
      ) : null}
    </div>
  );
}
