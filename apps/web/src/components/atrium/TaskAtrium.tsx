import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@cafecode/client-runtime";

import { useSettings } from "../../hooks/useSettings";
import { normalizeAccentColor } from "../../themeAccent";
import { useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import {
  EMPTY_ATRIUM,
  formatElapsed,
  selectAtriumSnapshot,
  type AtriumCard,
  type AtriumCardState,
} from "./taskAtriumData";

/**
 * Task Atrium — a read-only view of everything running right now.
 *
 * It is a display, not a control surface: no approve, no deny, no stop. A card
 * says a thread is waiting on you because that is information about what is
 * going on, but the decision happens in the thread where the request is
 * visible. Clicking a card opens that thread; that is the whole interaction,
 * which keeps this renderer-only exactly like the ambiance layer above it.
 *
 * The ambiance canvas sits at z-40 over all app content, so when a weather
 * effect is enabled its petals and beads fall in front of these cards for free
 * — the depth in the design comes from that layering, not from a scene graph.
 *
 * Colour: the Atrium tint follows its own setting, then the ambiance weather
 * colour, then the Appearance accent, matching the resolution order the weather
 * layer uses. Everything else is drawn from theme tokens so light and dark both
 * come out right without a second palette.
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

function TaskAtriumCardView({
  card,
  now,
  tint,
  onOpen,
}: {
  card: AtriumCard;
  now: number;
  tint: string;
  onOpen: (card: AtriumCard) => void;
}) {
  const accent = stateColor(card.state, tint);
  const elapsed = formatElapsed(card.startedAt, now);

  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      aria-label={`Open ${card.title}`}
      style={{ "--cafe-atrium-accent": accent } as CSSProperties}
      className={cn(
        "group relative flex w-full flex-col overflow-hidden rounded-2xl border bg-card/85 p-4 text-left",
        "backdrop-blur-md transition-all duration-200",
        "border-border/70 shadow-lg shadow-black/5 dark:shadow-black/40",
        "hover:-translate-y-0.5 hover:border-[var(--cafe-atrium-accent)]/55 hover:shadow-xl",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cafe-atrium-accent)]",
        card.state === "done" && "opacity-70",
        card.state === "holding" && "border-[var(--cafe-atrium-accent)]/45",
      )}
    >
      {/* Lit top edge in the state colour — the same vocabulary as the weather. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-6 top-0 h-px"
        style={{
          background: "linear-gradient(90deg, transparent, var(--cafe-atrium-accent), transparent)",
        }}
      />

      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: PROVIDER_DOT[card.provider] ?? SETTLED_COLOR }}
          />
          {providerLabel(card.provider)}
        </span>
        <span
          className="ml-auto rounded-full border px-2 py-0.5 text-[10px] font-medium"
          style={{
            color: accent,
            borderColor: `color-mix(in srgb, ${accent} 34%, transparent)`,
            background: `color-mix(in srgb, ${accent} 12%, transparent)`,
          }}
        >
          {STATE_LABEL[card.state]}
        </span>
      </div>

      <div className="mt-2 line-clamp-2 text-sm font-semibold leading-snug text-foreground">
        {card.title}
      </div>
      {card.projectName ? (
        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80">
          {card.projectName}
        </div>
      ) : null}

      {card.subagents.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1.5 rounded-xl bg-muted/45 p-2.5">
          {card.subagents.map((subagent) => (
            <div key={subagent.id} className="flex items-center gap-2 text-[11px]">
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: subagent.running ? accent : SETTLED_COLOR }}
              />
              <span className="shrink-0 font-semibold text-foreground/85">{subagent.label}</span>
              <span className="truncate text-muted-foreground">{subagent.detail}</span>
            </div>
          ))}
          {card.extraSubagents > 0 ? (
            <div className="pl-3.5 text-[10px] text-muted-foreground/70">
              and {card.extraSubagents} more
            </div>
          ) : null}
        </div>
      ) : null}

      {card.activityLabel ? (
        <div className="mt-3 flex items-center gap-2 border-t border-border/60 pt-2.5 text-[11px] text-muted-foreground">
          <span className="truncate">
            {card.activityLabel}
            {card.activityDetail ? (
              <span className="text-muted-foreground/70"> · {card.activityDetail}</span>
            ) : null}
          </span>
          {elapsed ? (
            <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
              {elapsed}
            </span>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}

export function TaskAtriumBoard({ compact = false }: { compact?: boolean }) {
  const tint = useAtriumTint();
  const navigate = useNavigate();

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

  const providerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of snapshot.cards) {
      counts.set(card.provider, (counts.get(card.provider) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([provider]) => provider.length > 0);
  }, [snapshot.cards]);

  const openCard = (card: AtriumCard) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(card.environmentId, card.threadId)),
    });
  };

  if (snapshot.cards.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <p className="text-base font-medium text-foreground/85">Nothing running</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          When threads and their subagents are working, they show up here.
        </p>
      </div>
    );
  }

  const total = snapshot.cards.length + snapshot.overflow;

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-5", compact ? "p-5" : "p-6 sm:p-8")}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-foreground px-3 py-1 text-xs font-semibold text-background">
          All work {total}
        </span>
        {providerCounts.map(([provider, count]) => (
          <span
            key={provider}
            className="flex items-center gap-1.5 rounded-full border border-border/70 bg-card/60 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm"
          >
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full"
              style={{ background: PROVIDER_DOT[provider] ?? SETTLED_COLOR }}
            />
            {providerLabel(provider)}
            <span className="tabular-nums opacity-60">{count}</span>
          </span>
        ))}
      </div>

      {!compact ? (
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-light tracking-tight text-foreground sm:text-3xl">
            {snapshot.runningCount === 1 ? "One thread" : `${snapshot.runningCount} threads`}
            {snapshot.subagentCount > 0 ? (
              <>
                ,{" "}
                <span className="font-semibold">
                  {snapshot.subagentCount === 1
                    ? "one subagent"
                    : `${snapshot.subagentCount} subagents`}
                </span>
              </>
            ) : null}
            {snapshot.holdingCount > 0 ? (
              <>
                {" · "}
                <span style={{ color: HOLD_COLOR }}>{snapshot.holdingCount} waiting on you</span>
              </>
            ) : null}
          </h2>
          <p className="text-sm text-muted-foreground">
            Everything currently in flight. Select a card to open its thread.
          </p>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2 xl:grid-cols-3">
        {snapshot.cards.map((card) => (
          <TaskAtriumCardView key={card.key} card={card} now={now} tint={tint} onOpen={openCard} />
        ))}
      </div>

      {snapshot.overflow > 0 ? (
        <div className="shrink-0 rounded-xl border border-border/60 bg-card/50 px-4 py-2 text-xs text-muted-foreground">
          and {snapshot.overflow} more {snapshot.overflow === 1 ? "thread" : "threads"} running
        </div>
      ) : null}
    </div>
  );
}
