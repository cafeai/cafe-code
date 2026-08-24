import type {
  AmbianceEffect,
  AmbianceReactMode,
  OrchestrationSessionStatus,
} from "@cafecode/contracts";

import { ambianceBackend } from "./ambianceEffects";
import { AmbianceGLRenderer } from "./ambianceGL";

/**
 * Ambiance weather engine.
 *
 * A decorative canvas-2D particle renderer drawn over the app chrome
 * (pointer-events: none). This is a direct TypeScript port of the approved
 * ambiance mockup so the shipped effects look identical to the design:
 * five effects (stars / rain / snow / matrix / fire), a "drive" value that
 * eases toward a target derived from settings intensity plus optional thread
 * reaction signals, a wind term fed by tool bursts, and per-surface clipping
 * (sidebar column vs. the rest of the window).
 *
 * Reliability/perf constraints (see AGENTS.md):
 * - The engine is renderer-only decoration. It consumes projected thread
 *   state pushed in by the layer component; it must never synthesize
 *   lifecycle truth, and nothing here feeds back into orchestration.
 * - All particle pools are fixed-size and independent of chat history,
 *   thread count, or turn duration. Per-frame work is bounded by the pools
 *   and the (drive-scaled) draw counts, exactly like the mockup.
 * - The RAF loop only runs while `start()` is active; the owning layer stops
 *   it when ambiance is disabled, the document is hidden, or background
 *   animations are paused, so long provider runs never pay for hidden frames.
 */

export type AmbianceSurfacesConfig = {
  sidebar: boolean;
  thread: boolean;
};

export type AmbianceEngineConfig = {
  effect: AmbianceEffect;
  /** Baseline density 0..1 before the thread has any say. */
  intensity: number;
  reactMode: AmbianceReactMode;
  /** #rrggbb weather tint (already resolved from settings/accent fallback). */
  tint: string;
  surfaces: AmbianceSurfacesConfig;
  /** Freeze particle motion for prefers-reduced-motion users. */
  reducedMotion: boolean;
  /**
   * Resolved app theme. Every effect is authored for a dark ground; on a light
   * one an additive glow washes out, so colours are pushed down into a stain
   * and alpha carries more of the contrast. See `ink()` / `lift()` / `alphaK()`.
   */
  dark: boolean;
};

/**
 * Session drive targets from the mockup: how "busy" the sky is for each
 * orchestration session status before intensity scaling.
 */
const SESSION_DRIVE: Record<OrchestrationSessionStatus | "idle", number> = {
  idle: 0.16,
  ready: 0.2,
  starting: 0.44,
  running: 0.62,
  interrupted: 0.1,
  stopped: 0.05,
  error: 0.85,
};

/** State colors mirroring the mockup tokens (danger/warn/neutral). */
const FAULT_COLOR = "#ef4444";
const HOLD_COLOR = "#f5a524";
const SETTLED_COLOR = "#9aa3ad";
const FALLBACK_TINT = "#48cfff";

const LAYER_SPEED = [0.42, 0.72, 1.15] as const;
const FIRE_STOPS = ["#fff6d5", "#ffd166", "#ff8c1a", "#e8471c", "#7a1206"] as const;
const GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓ0123456789<>[]{}/\\=+-*";
/** Blossom petal tones. Index chosen per petal, then tinted by the state color. */
const PETAL_TONES = ["#f8dbe4", "#f2c3d3", "#eab0c6", "#fce9ef"] as const;
const BLOSSOM_BARK_DARK = "#3a2b2c";
const BLOSSOM_BARK_LIGHT = "#6d5a52";

type Drop = { x: number; y: number; l: number; v: number };
type Flake = {
  layer: 0 | 1 | 2;
  bx: number;
  y: number;
  r: number;
  ph: number;
  sf: number;
  sa: number;
  v: number;
  th: number;
};
type MatrixColumn = { x: number; y: number; v: number; len: number; t: number; th: number };
type FireParticle = {
  spark: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  max: number;
  life: number;
  ph: number;
};
type Star = { x: number; y: number; r: number; ph: number; v: number };
/** Glass: a bead of condensation, either resting and growing or running. */
type Bead = {
  x: number;
  y: number;
  py: number;
  r: number;
  rMax: number;
  grow: number;
  running: boolean;
  vy: number;
  vx: number;
  ph: number;
  shed: number;
};
type Splash = { x: number; y: number; r0: number; born: number };
/** Lattice: a node in the particle network. */
type Node = { x: number; y: number; vx: number; vy: number; r: number; ph: number };
/** Blossom: a tumbling petal. */
type Petal = {
  x: number;
  y: number;
  s: number;
  vy: number;
  vx: number;
  rot: number;
  vr: number;
  ph: number;
  sway: number;
  spin: number;
  alpha: number;
  tone: number;
};

function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

/** A resting bead lets go and begins to run. */
function startBeadRun(bead: Bead): void {
  bead.running = true;
  bead.vy = 18;
  bead.py = bead.y;
}

/** Cubic bezier sample in normalized 0..1 space. */
function bezierAt(p: number[][], u: number): [number, number] {
  const m = 1 - u;
  return [
    m * m * m * p[0]![0]! +
      3 * m * m * u * p[1]![0]! +
      3 * m * u * u * p[2]![0]! +
      u * u * u * p[3]![0]!,
    m * m * m * p[0]![1]! +
      3 * m * m * u * p[1]![1]! +
      3 * m * u * u * p[2]![1]! +
      u * u * u * p[3]![1]!,
  ];
}

function hexRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function mix(a: string, b: string, t: number): string {
  const x = hexRgb(a);
  const y = hexRgb(b);
  let out = "#";
  for (let i = 0; i < 3; i++) {
    const channel = Math.round(x[i]! + (y[i]! - x[i]!) * t).toString(16);
    out += channel.length < 2 ? `0${channel}` : channel;
  }
  return out;
}

/** #rrggbb guard so hostile/legacy persisted strings cannot reach hexRgb. */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/u;

export function normalizeAmbianceTint(value: string | undefined | null): string {
  const trimmed = value?.trim() ?? "";
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed : FALLBACK_TINT;
}

export class AmbianceEngine {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  /**
   * Non-null only while a WebGL effect is selected. A canvas can hold exactly
   * one context type, so the owning layer remounts the canvas element when the
   * backend changes and constructs a fresh engine — this field is decided once,
   * at construction, from the effect it was built for.
   */
  private readonly gl: AmbianceGLRenderer | null;
  /** True when a WebGL effect was requested but the context could not be made. */
  private readonly glUnavailable: boolean;

  private config: AmbianceEngineConfig = {
    effect: "rain",
    intensity: 0.55,
    reactMode: "live",
    tint: FALLBACK_TINT,
    surfaces: { sidebar: true, thread: true },
    reducedMotion: false,
    dark: true,
  };

  // Reaction signals. `session`/`holding` are level-set from projected store
  // state; the rest are decaying pulses poked by the layer on transitions.
  private session: OrchestrationSessionStatus | "idle" = "idle";
  private holding = false;
  private burst = 0;
  private fog = 0;
  private hold = 0;
  private fault = 0;
  private clearing = 0;
  private drive = 0;
  private wind = 0;

  // Geometry. `side` is the sidebar/thread split in CSS pixels.
  private width = 0;
  private height = 0;
  private dpr = 1;
  private side = 0;

  private drops: Drop[] = [];
  private flakes: Flake[] = [];
  private cols: MatrixColumn[] = [];
  private fire: FireParticle[] = [];
  private stars: Star[] = [];
  private beads: Bead[] = [];
  private splashes: Splash[] = [];
  private nodes: Node[] = [];
  private petals: Petal[] = [];

  // Glass keeps two offscreen layers: a pristine misted pane that is never
  // accumulated into, and a trail mask whose alpha is multiplied down each
  // frame (re-misting). Filling mist on top every frame would only ever
  // saturate to opaque, never converge.
  private glassMist: HTMLCanvasElement | null = null;
  private glassTrails: HTMLCanvasElement | null = null;
  private glassTrailsCtx: CanvasRenderingContext2D | null = null;
  private beadSprites = new Map<number, HTMLCanvasElement>();
  private beadSpriteKey = "";
  // Blossom draws its branches and blossom clusters once per resize.
  private blossomBack: HTMLCanvasElement | null = null;
  private blossomBackKey = "";
  private lastCascade = 0;

  private rafId: number | null = null;
  private lastFrameAt = 0;
  private time = 0;

  constructor(canvas: HTMLCanvasElement, effect: AmbianceEffect) {
    this.canvas = canvas;
    const wantsGL = ambianceBackend(effect) === "webgl";
    const gl = wantsGL ? AmbianceGLRenderer.create(canvas, effect) : null;
    this.gl = gl;
    // A failed GL context is not fatal: `setConfig` falls the effect back to a
    // canvas-2D one so the layer never renders as a blank rectangle.
    this.glUnavailable = wantsGL && gl === null;
    this.ctx = wantsGL && gl !== null ? null : canvas.getContext("2d");
    this.config = { ...this.config, effect: this.resolveEffect(effect) };
  }

  /**
   * The effect this engine can actually draw. When WebGL was requested but is
   * unavailable (or the context was lost), fall back to a cheap 2D effect
   * rather than showing nothing.
   */
  private resolveEffect(effect: AmbianceEffect): AmbianceEffect {
    if (ambianceBackend(effect) !== "webgl") return effect;
    if (this.gl && !this.gl.isLost()) return effect;
    return "stars";
  }

  /** Backend this engine was constructed for; the layer remounts on change. */
  usesWebgl(): boolean {
    return this.gl !== null;
  }

  /** True when the GL context died and the layer should rebuild the canvas. */
  needsRebuild(): boolean {
    return this.gl !== null && this.gl.isLost();
  }

  // ── theme helpers ───────────────────────────────────────────────────
  // Effects are authored against a dark ground. On a light one the same low
  // alpha glow disappears, so colours are darkened into a stain and alphas are
  // scaled up. Keeping this in three helpers means every effect gets light mode
  // without a second set of hand-tuned constants.

  /** Particle colour for the current theme. */
  private ink(color: string): string {
    return this.config.dark ? color : mix(color, "#0b1220", 0.55);
  }

  /** Highlight colour: white lifts on dark, ink darkens on light. */
  private lift(): string {
    return this.config.dark ? "#ffffff" : "#101826";
  }

  /** Alpha multiplier so light mode keeps comparable perceived contrast. */
  private alphaK(): number {
    return this.config.dark ? 1 : 1.5;
  }

  setConfig(config: AmbianceEngineConfig): void {
    const resolved = this.resolveEffect(config.effect);
    const effectChanged = resolved !== this.config.effect;
    const themeChanged = config.dark !== this.config.dark;
    const tintChanged = config.tint !== this.config.tint;
    this.config = { ...config, effect: resolved };
    if (effectChanged) {
      // Match the mockup's tile switch: keep pools, only top up so the new
      // effect fades in from a believable mid-state instead of a burst.
      this.seed(false);
    }
    if (themeChanged || tintChanged) {
      // Cached bitmaps bake the tint and the theme, so they have to go.
      this.beadSprites.clear();
      this.glassMist = null;
      this.blossomBack = null;
    }
  }

  /** Level-set the projected orchestration session status (or "idle" when none). */
  setSession(session: OrchestrationSessionStatus | "idle"): void {
    this.session = session;
  }

  /** Level-set "an approval or user-input request is waiting on the user". */
  setHolding(holding: boolean): void {
    this.holding = holding;
    if (holding) {
      this.hold = 1;
    }
  }

  /** Tool activity gust; decays over ~1.2s like the mockup. */
  pulseBurst(): void {
    this.burst = Math.min(1, this.burst + 0.75);
  }

  /** Context-compaction fog sweep. */
  pulseFog(): void {
    this.fog = 1;
  }

  /** Runtime/session error squall. */
  pulseFault(): void {
    this.fault = 1;
  }

  /** Turn completion: sky clears briefly, then drifts back to session drive. */
  pulseClear(): void {
    this.clearing = 1;
    this.burst = 0;
  }

  resize(width: number, height: number, dpr: number, side: number): void {
    const ctx = this.ctx;
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.dpr = Math.min(Math.max(dpr, 1), 2);
    this.side = Math.max(0, Math.min(this.width, Math.round(side)));
    if (this.gl) {
      // The GL back end owns its own (capped) backing store.
      this.gl.resize(this.width, this.height, this.dpr);
      return;
    }
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    if (ctx) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    this.glassMist = null;
    this.glassTrails = null;
    this.glassTrailsCtx = null;
    this.blossomBack = null;
    this.seed(true);
  }

  setSideBoundary(side: number): void {
    this.side = Math.max(0, Math.min(this.width, Math.round(side)));
  }

  /** Current state color for the composer ring + settings surfaces. */
  stateColor(): string {
    if (this.fault > 0.02) return FAULT_COLOR;
    if (this.hold > 0.02) return HOLD_COLOR;
    if (this.session === "stopped" || this.session === "interrupted") return SETTLED_COLOR;
    return normalizeAmbianceTint(this.config.tint);
  }

  /** Current eased drive 0..1 (used for the composer ring gradient). */
  currentDrive(): number {
    return this.drive;
  }

  start(): void {
    if (this.rafId !== null || (!this.ctx && !this.gl)) {
      return;
    }
    this.lastFrameAt = performance.now();
    const tick = (now: number) => {
      this.frame(now);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  clear(): void {
    this.ctx?.clearRect(0, 0, this.width, this.height);
    this.gl?.clear();
  }

  isRunning(): boolean {
    return this.rafId !== null;
  }

  // ── particle pools ──────────────────────────────────────────────────

  private newFlake(layer: 0 | 1 | 2, fresh: boolean): Flake {
    // Snow reads as snow when it has depth: three parallax layers, each with
    // its own size, speed, sway amplitude and opacity. Sway is applied at
    // draw time so the amplitude stays honest no matter the frame rate.
    return {
      layer,
      bx: Math.random() * this.width,
      y: fresh ? Math.random() * this.height : -8,
      r: layer === 0 ? rnd(0.5, 0.95) : layer === 1 ? rnd(0.95, 1.7) : rnd(1.7, 2.9),
      ph: Math.random() * 6.2832,
      sf: rnd(0.32, 0.85),
      sa: layer === 0 ? rnd(2, 5) : layer === 1 ? rnd(5, 11) : rnd(9, 18),
      v: rnd(0.8, 1.25),
      th: Math.random(),
    };
  }

  private spawnFire(particle: FireParticle, fresh: boolean): FireParticle {
    // Fire is bottom-anchored: particles are born at the floor, rise against
    // drag, cool through a colour ramp, and die. ~18% are light "sparks" that
    // escape the column and travel much further.
    particle.spark = Math.random() < 0.18;
    particle.x = Math.random() * this.width;
    particle.y = fresh ? Math.random() * this.height : this.height + rnd(0, 10);
    particle.vx = rnd(-8, 8);
    particle.vy = -rnd(28, 74) * (particle.spark ? 1.6 : 1);
    particle.r = particle.spark ? rnd(0.5, 1.1) : rnd(0.9, 2.6);
    particle.max = particle.spark ? rnd(2.2, 4.2) : rnd(0.9, 2.2);
    particle.life = fresh ? Math.random() : 0;
    particle.ph = Math.random() * 6.2832;
    return particle;
  }

  private fireColor(life: number): string {
    const x = Math.max(0, Math.min(0.9999, life)) * (FIRE_STOPS.length - 1);
    const i = Math.floor(x);
    return mix(FIRE_STOPS[i]!, FIRE_STOPS[i + 1]!, x - i);
  }

  private newBead(fresh: boolean): Bead {
    // Power-law sizes: mostly fine beads, a few fat ones that will run. A flat
    // distribution reads as evenly spaced dots rather than condensation.
    const k = Math.pow(Math.random(), 2.4);
    const rMax = 1.4 + k * 5.2;
    return {
      x: rnd(6, Math.max(7, this.width - 6)),
      y: fresh ? rnd(4, Math.max(5, this.height - 4)) : rnd(4, Math.max(5, this.height - 4)),
      py: 0,
      r: rMax * rnd(0.3, 0.8),
      rMax,
      grow: rnd(0.0016, 0.0042),
      running: false,
      vy: 0,
      vx: 0,
      ph: Math.random() * 6.2832,
      shed: 0,
    };
  }

  private newPetal(fresh: boolean): Petal {
    return {
      x: Math.random() * this.width,
      y: fresh ? Math.random() * this.height : -14,
      s: rnd(3.2, 7.4),
      vy: rnd(14, 38),
      vx: rnd(-6, 18),
      rot: Math.random() * 6.2832,
      vr: rnd(-0.7, 0.7),
      ph: Math.random() * 6.2832,
      sway: rnd(0.5, 1.7),
      spin: rnd(0.6, 1.8),
      alpha: rnd(0.45, 0.95),
      tone: Math.floor(Math.random() * PETAL_TONES.length),
    };
  }

  private seed(hard: boolean): void {
    if (hard) {
      this.drops = [];
      this.flakes = [];
      this.fire = [];
      this.stars = [];
      this.cols = [];
      this.beads = [];
      this.splashes = [];
      this.nodes = [];
      this.petals = [];
    }
    // Glass: bounded by viewport area, never by history.
    const beadTarget = Math.max(90, Math.min(420, Math.round((this.width * this.height) / 5400)));
    while (this.beads.length < Math.round(beadTarget * 0.6)) {
      const bead = this.newBead(true);
      bead.py = bead.y;
      this.beads.push(bead);
    }
    if (this.nodes.length === 0) {
      for (let i = 0; i < 50; i++) {
        this.nodes.push({
          x: Math.random() * this.width,
          y: Math.random() * this.height,
          vx: rnd(-9, 9),
          vy: rnd(-9, 9),
          r: rnd(0.9, 2.6),
          ph: Math.random() * 6.2832,
        });
      }
    }
    while (this.petals.length < 70) {
      this.petals.push(this.newPetal(true));
    }
    while (this.drops.length < 340) {
      this.drops.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        l: rnd(6, 20),
        v: rnd(0.55, 1),
      });
    }
    if (this.flakes.length === 0) {
      for (let f = 0; f < 300; f++) {
        this.flakes.push(this.newFlake(f < 150 ? 0 : f < 246 ? 1 : 2, true));
      }
    }
    if (this.fire.length === 0) {
      for (let e = 0; e < 220; e++) {
        this.fire.push(
          this.spawnFire(
            { spark: false, x: 0, y: 0, vx: 0, vy: 0, r: 0, max: 1, life: 0, ph: 0 },
            true,
          ),
        );
      }
    }
    while (this.stars.length < 190) {
      this.stars.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        r: rnd(0.4, 1.3),
        ph: Math.random() * 6.28,
        v: rnd(0.15, 0.5),
      });
    }

    // Columns are evenly spaced across the full width and thinned by a random
    // per-column threshold, so density scaling never leaves one side of the
    // window permanently dry.
    const columnCount = Math.max(6, Math.floor(this.width / 13));
    this.cols.length = 0;
    for (let i = 0; i < columnCount; i++) {
      this.cols.push({
        x: i * 13 + 3,
        y: Math.random() * -this.height,
        v: rnd(0.5, 1.3),
        len: Math.floor(rnd(6, 18)),
        t: Math.random(),
        th: Math.random(),
      });
    }
  }

  // ── drive/state math (mockup parity) ────────────────────────────────

  private targetDrive(): number {
    const { intensity, reactMode } = this.config;
    if (reactMode === "off") {
      return intensity;
    }
    let base = SESSION_DRIVE[this.session] ?? 0.2;
    if (reactMode === "live") {
      base += this.burst * 0.3;
    }
    base *= 1 - this.clearing * 0.85;
    base *= 1 - this.fog * 0.4;
    return Math.max(0, Math.min(1, base * (0.5 + intensity)));
  }

  private speedMul(): number {
    // Approval hold: the sky visibly stalls while the run waits on the user.
    if (this.hold > 0.02) return 0.14 + (1 - this.hold) * 0.86;
    // Fault squall: brief agitation on errors.
    if (this.fault > 0.02) return 1 + this.fault * 0.7;
    return 1;
  }

  // ── per-effect draw/step (mockup parity) ────────────────────────────

  private clipSurfaces(ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    let any = false;
    if (this.config.surfaces.sidebar && this.side > 0) {
      ctx.rect(0, 0, this.side, this.height);
      any = true;
    }
    if (this.config.surfaces.thread) {
      ctx.rect(this.side, 0, this.width - this.side, this.height);
      any = true;
    }
    if (!any) {
      ctx.rect(0, 0, 0, 0);
    }
    ctx.clip();
  }

  private drawRain(ctx: CanvasRenderingContext2D, d: number, col: string): void {
    const count = Math.min(this.drops.length, Math.floor(30 + d * 300));
    ctx.strokeStyle = rgba(this.ink(col), (0.06 + d * 0.2) * this.alphaK());
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const p = this.drops[i]!;
      const len = p.l * (0.6 + d * 0.9);
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + this.wind * len * 0.35, p.y + len);
    }
    ctx.stroke();
  }

  private stepRain(dt: number, d: number, sp: number): void {
    const count = Math.min(this.drops.length, Math.floor(30 + d * 300));
    for (let i = 0; i < count; i++) {
      const p = this.drops[i]!;
      p.y += (280 + d * 700) * p.v * sp * dt;
      p.x += this.wind * 40 * sp * dt;
      if (p.y > this.height + 20) {
        p.y = -20;
        p.x = Math.random() * (this.width + 60) - 30;
      }
      if (p.x < -40) p.x = this.width + 20;
      else if (p.x > this.width + 40) p.x = -20;
    }
  }

  private drawSnow(ctx: CanvasRenderingContext2D, d: number, col: string): void {
    const density = 0.1 + d * 0.9;
    const far = mix(this.lift(), col, 0.4);
    const near = mix(this.lift(), col, 0.08);
    for (const p of this.flakes) {
      if (p.th > density) continue;
      const x = p.bx + Math.sin(this.time * p.sf + p.ph) * p.sa;
      const radius = p.r * (0.82 + Math.sin(this.time * p.sf * 3.1 + p.ph * 1.7) * 0.18);
      const alpha =
        (p.layer === 0 ? 0.2 : p.layer === 1 ? 0.4 : 0.68) * (0.32 + d * 0.68) * this.alphaK();
      if (p.layer === 2) {
        // Soft halo behind the near layer sells the depth-of-field.
        ctx.fillStyle = rgba(near, alpha * 0.14);
        ctx.beginPath();
        ctx.arc(x, p.y, radius * 2.6, 0, 6.2832);
        ctx.fill();
      }
      ctx.fillStyle = rgba(p.layer === 0 ? far : near, alpha);
      ctx.beginPath();
      ctx.arc(x, p.y, radius, 0, 6.2832);
      ctx.fill();
    }
  }

  private stepSnow(dt: number, d: number, sp: number): void {
    const density = 0.1 + d * 0.9;
    for (const p of this.flakes) {
      if (p.th > density) continue;
      const layerSpeed = LAYER_SPEED[p.layer];
      const flutter = 1 + Math.sin(this.time * p.sf * 2.1 + p.ph) * 0.3;
      p.y += (10 + d * 32) * p.v * layerSpeed * flutter * sp * dt;
      p.bx += this.wind * 13 * layerSpeed * sp * dt;
      if (p.y > this.height + 10) {
        p.y = -10;
        p.bx = Math.random() * this.width;
      }
      if (p.bx < -26) p.bx = this.width + 22;
      else if (p.bx > this.width + 26) p.bx = -22;
    }
  }

  private drawMatrix(ctx: CanvasRenderingContext2D, d: number, col: string): void {
    const density = 0.12 + d * 0.88;
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "top";
    for (let i = 0; i < this.cols.length; i++) {
      const c = this.cols[i]!;
      if (c.th > density) continue;
      for (let j = 0; j < c.len; j++) {
        const y = c.y - j * 13;
        if (y < -14 || y > this.height) continue;
        const alpha = (1 - j / c.len) * (0.16 + d * 0.5);
        ctx.fillStyle =
          j === 0
            ? rgba(mix(col, this.lift(), 0.7), Math.min(0.9, 0.3 + d * 0.6))
            : rgba(this.ink(col), alpha * this.alphaK());
        const glyphIndex =
          ((((c.t * 97 + j * 31 + i * 13) | 0) % GLYPHS.length) + GLYPHS.length) % GLYPHS.length;
        ctx.fillText(GLYPHS.charAt(glyphIndex), c.x, y);
      }
    }
  }

  private stepMatrix(dt: number, d: number, sp: number): void {
    const density = 0.12 + d * 0.88;
    for (const c of this.cols) {
      if (c.th > density) continue;
      c.y += (70 + d * 220) * c.v * sp * dt;
      c.t += dt * (3 + d * 8);
      if (c.y - c.len * 13 > this.height) {
        c.y = rnd(-60, 0);
        c.v = rnd(0.5, 1.3);
        c.len = Math.floor(rnd(6, 18));
      }
    }
  }

  private flicker(phase: number): number {
    return (
      0.62 +
      Math.sin(this.time * 5.1 + phase) * 0.2 +
      Math.sin(this.time * 11.7 + phase * 2.3) * 0.18
    );
  }

  private drawFire(ctx: CanvasRenderingContext2D, d: number, col: string): void {
    // Additive blending only reads on a dark ground; on a light one it washes
    // the flame out entirely, so light mode composites normally instead.
    ctx.globalCompositeOperation = this.config.dark ? "lighter" : "source-over";

    // 1. heat haze along the floor — this is what makes it read as fire
    const fl = this.flicker(0);
    const hazeHeight = this.height * (0.13 + d * 0.3) * (0.85 + fl * 0.3);
    const base = mix("#ff5a12", col, 0.22);
    const gradient = ctx.createLinearGradient(0, this.height, 0, this.height - hazeHeight);
    gradient.addColorStop(0, rgba(base, (0.1 + d * 0.3) * fl));
    gradient.addColorStop(0.45, rgba(base, (0.035 + d * 0.13) * fl));
    gradient.addColorStop(1, rgba(base, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, this.height - hazeHeight, this.width, hazeHeight);

    // 2. flame licks: elongated radials rooted below the edge, wandering
    const licks = 6;
    for (let k = 0; k < licks; k++) {
      const ph = k * 1.73;
      const amp =
        0.5 + Math.sin(this.time * 3.1 + ph) * 0.26 + Math.sin(this.time * 6.9 + ph * 2) * 0.2;
      const lx =
        ((k + 0.5) / licks) * this.width +
        Math.sin(this.time * 0.8 + ph) * (this.width / licks) * 0.3;
      const lr = (24 + d * 62) * (0.7 + amp * 0.6);
      const lh = (1.4 + d * 1.5) * (0.75 + amp * 0.5);
      ctx.save();
      ctx.translate(lx, this.height + 5);
      ctx.scale(1, lh);
      const radial = ctx.createRadialGradient(0, 0, 0, 0, 0, lr);
      radial.addColorStop(0, rgba(mix("#ffbb4d", col, 0.14), 0.09 + d * 0.19));
      radial.addColorStop(0.5, rgba("#ff6a1f", 0.035 + d * 0.1));
      radial.addColorStop(1, rgba("#ff3d00", 0));
      ctx.fillStyle = radial;
      ctx.fillRect(-lr, -lr, lr * 2, lr * 2);
      ctx.restore();
    }

    // 3. embers, cooling as they climb
    const count = Math.min(this.fire.length, Math.floor(24 + d * 190));
    for (let i = 0; i < count; i++) {
      const p = this.fire[i]!;
      const life = p.life;
      const alpha = (1 - life) * (1 - life) * (0.3 + d * 0.6);
      ctx.fillStyle = rgba(this.ink(mix(this.fireColor(life), col, 0.12)), alpha * this.alphaK());
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.3, p.r * (1 - life * 0.55)), 0, 6.2832);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  private stepFire(dt: number, d: number, sp: number): void {
    const count = Math.min(this.fire.length, Math.floor(24 + d * 190));
    for (let i = 0; i < count; i++) {
      const p = this.fire[i]!;
      p.life += dt / p.max;
      if (p.life >= 1 || p.y < -12) {
        this.spawnFire(p, false);
        continue;
      }
      p.vy -= (16 + d * 30) * dt; // buoyancy
      p.vy *= 1 - Math.min(0.9, (p.spark ? 0.45 : 1.15) * dt); // drag
      const turbulence = Math.sin(this.time * 2.4 + p.ph + p.y * 0.022) * (14 + d * 26);
      p.vx += (turbulence + this.wind * 26 - p.vx * 1.5) * dt;
      p.x += p.vx * sp * dt;
      p.y += p.vy * sp * dt;
    }
  }

  private drawStars(ctx: CanvasRenderingContext2D, d: number, col: string): void {
    const count = Math.min(this.stars.length, Math.floor(40 + d * 150));
    for (let i = 0; i < count; i++) {
      const p = this.stars[i]!;
      const twinkle = 0.55 + Math.sin(this.time * 0.9 + p.ph) * 0.45;
      ctx.fillStyle = rgba(
        i % 3 === 0 ? this.ink(col) : this.lift(),
        (0.1 + d * 0.3) * twinkle * this.alphaK(),
      );
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 6.2832);
      ctx.fill();
    }
  }

  private stepStars(dt: number, _d: number, sp: number): void {
    for (const p of this.stars) {
      p.x -= p.v * 6 * sp * dt;
      p.y -= p.v * 13 * sp * dt;
      if (p.y < -4) {
        p.y = this.height + 4;
        p.x = Math.random() * this.width;
      }
      if (p.x < -4) p.x = this.width + 4;
    }
  }

  // ── glass ───────────────────────────────────────────────────────────
  // Condensation only reads as condensation with two things the bare port
  // lacked: a misted pane, and running beads that carve a clear trail through
  // it. Trails re-mist by multiplying their own alpha down, which converges;
  // painting mist back on top every frame would saturate to opaque instead.

  private beadSprite(radius: number, col: string): HTMLCanvasElement {
    const r = Math.max(0.6, Math.round(radius * 2) / 2);
    const key = `${col}|${this.config.dark ? "d" : "l"}`;
    if (key !== this.beadSpriteKey) {
      this.beadSprites.clear();
      this.beadSpriteKey = key;
    }
    const cached = this.beadSprites.get(r);
    if (cached) return cached;

    const dpr = this.dpr;
    const pad = Math.ceil(r * 1.1) + 3;
    const size = Math.ceil((r * 2 + pad * 2) * dpr);
    const sprite = document.createElement("canvas");
    sprite.width = size;
    sprite.height = size;
    const c = sprite.getContext("2d");
    if (!c) return sprite;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const centre = size / (2 * dpr);

    // Cast shadow, offset down: sells the bead sitting on a surface.
    const shadow = c.createRadialGradient(
      centre,
      centre + r * 0.3,
      r * 0.15,
      centre,
      centre + r * 0.28,
      r * 1.5,
    );
    shadow.addColorStop(0, `rgba(0,0,0,${this.config.dark ? 0.3 : 0.16})`);
    shadow.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = shadow;
    c.beginPath();
    c.arc(centre, centre + r * 0.28, r * 1.5, 0, 6.2832);
    c.fill();

    // Body: a lens. Light enters upper-left, so the far edge carries the load.
    const body = c.createRadialGradient(
      centre - r * 0.34,
      centre - r * 0.4,
      r * 0.06,
      centre,
      centre,
      r,
    );
    body.addColorStop(0, rgba(this.lift(), 0.34));
    body.addColorStop(0.42, rgba(col, 0.2));
    body.addColorStop(0.88, rgba(col, 0.34 * this.alphaK()));
    body.addColorStop(1, rgba(col, 0.15));
    c.fillStyle = body;
    c.beginPath();
    c.arc(centre, centre, r, 0, 6.2832);
    c.fill();

    // Refracted rim, bright on the lower right and cool opposite.
    c.lineWidth = Math.max(0.55, r * 0.14);
    c.strokeStyle = rgba(mix(col, this.lift(), 0.35), 0.55 * this.alphaK());
    c.beginPath();
    c.arc(centre, centre, r * 0.93, 0.3, 2.55);
    c.stroke();
    c.lineWidth = Math.max(0.4, r * 0.1);
    c.strokeStyle = rgba(this.lift(), 0.13);
    c.beginPath();
    c.arc(centre, centre, r * 0.95, 3.55, 5.65);
    c.stroke();

    // Specular highlight and its small partner.
    c.fillStyle = rgba(this.lift(), 0.88);
    c.beginPath();
    c.ellipse(
      centre - r * 0.33,
      centre - r * 0.39,
      Math.max(0.5, r * 0.21),
      Math.max(0.34, r * 0.14),
      -0.6,
      0,
      6.2832,
    );
    c.fill();
    c.fillStyle = rgba(this.lift(), 0.2);
    c.beginPath();
    c.arc(centre + r * 0.3, centre + r * 0.33, Math.max(0.3, r * 0.1), 0, 6.2832);
    c.fill();

    this.beadSprites.set(r, sprite);
    return sprite;
  }

  private ensureGlassLayers(d: number, col: string): void {
    if (!this.glassTrails) {
      const trails = document.createElement("canvas");
      trails.width = Math.round(this.width * this.dpr);
      trails.height = Math.round(this.height * this.dpr);
      const tctx = trails.getContext("2d");
      if (tctx) {
        tctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        tctx.lineCap = "round";
        tctx.lineJoin = "round";
      }
      this.glassTrails = trails;
      this.glassTrailsCtx = tctx;
    }
    if (this.glassMist) return;

    const mist = document.createElement("canvas");
    mist.width = Math.round(this.width * this.dpr);
    mist.height = Math.round(this.height * this.dpr);
    const c = mist.getContext("2d");
    if (!c) return;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // Mist is the tint pulled most of the way toward the page ground. A
    // saturated wash would read as a filter laid over the whole app.
    const haze = this.config.dark ? mix(col, "#ffffff", 0.72) : mix(col, "#0d1622", 0.55);
    const base = (0.05 + d * 0.05) * this.alphaK();
    c.fillStyle = rgba(haze, base);
    c.fillRect(0, 0, this.width, this.height);
    for (let i = 0; i < 30; i++) {
      const bx = Math.random() * this.width;
      const by = Math.random() * this.height;
      const br = rnd(this.width * 0.07, this.width * 0.28);
      const blot = c.createRadialGradient(bx, by, 0, bx, by, br);
      blot.addColorStop(0, rgba(haze, rnd(0.006, 0.02) * this.alphaK()));
      blot.addColorStop(1, rgba(haze, 0));
      c.fillStyle = blot;
      c.fillRect(bx - br, by - br, br * 2, br * 2);
    }
    this.glassMist = mist;
  }

  private stepGlass(dt: number, d: number, sp: number): void {
    const tctx = this.glassTrailsCtx;
    const target = Math.max(
      90,
      Math.min(420, Math.round(((this.width * this.height) / 5400) * (0.3 + d * 0.7))),
    );
    if (this.beads.length < target && Math.random() < 0.55) this.beads.push(this.newBead(false));

    // Tool bursts and turn completion both let go of the fattest beads: a
    // burst sheds a few, a clearing pulse sheets the whole pane off.
    const cascadeDue = this.time - this.lastCascade > 5.2;
    if (cascadeDue || this.burst > 0.55) {
      this.lastCascade = this.time;
      const idle = this.beads.filter((bead) => !bead.running).toSorted((a, b) => b.r - a.r);
      for (let i = 0; i < Math.min(3, idle.length); i++) startBeadRun(idle[i]!);
    }
    if (this.clearing > 0.05) {
      for (const bead of this.beads) {
        if (!bead.running && Math.random() < 0.05) startBeadRun(bead);
      }
    }

    if (tctx) {
      // Re-misting: multiply the trail mask down. Context compaction re-mists
      // faster, so the fog pulse visibly closes the streaks back up.
      tctx.globalCompositeOperation = "destination-out";
      tctx.fillStyle = `rgba(0,0,0,${(0.35 + d * 0.5 + this.fog * 1.6) * dt})`;
      tctx.fillRect(0, 0, this.width, this.height);
      tctx.globalCompositeOperation = "source-over";
      tctx.strokeStyle = "#ffffff";
    }

    for (let i = this.beads.length - 1; i >= 0; i--) {
      const bead = this.beads[i]!;
      if (!bead.running) {
        bead.r += bead.grow * (0.6 + d) * sp * 60 * dt;
        if (bead.r >= bead.rMax) startBeadRun(bead);
        continue;
      }

      bead.py = bead.y;
      bead.vy = Math.min(bead.vy + (300 + d * 260) * sp * dt, 360 * sp);
      bead.y += bead.vy * dt;
      // Beads wander as they run; a ruler-straight trail looks synthetic.
      bead.vx += (Math.sin(this.time * 1.7 + bead.ph) * 3 - bead.vx * 6) * dt;
      bead.x += bead.vx * dt + this.wind * 14 * sp * dt;

      if (tctx) {
        tctx.globalAlpha = 0.16;
        tctx.lineWidth = Math.max(1.4, bead.r * 2.3);
        tctx.beginPath();
        tctx.moveTo(bead.x, bead.py);
        tctx.lineTo(bead.x, bead.y);
        tctx.stroke();
        tctx.globalAlpha = 0.62;
        tctx.lineWidth = Math.max(0.9, bead.r * 0.95);
        tctx.beginPath();
        tctx.moveTo(bead.x, bead.py);
        tctx.lineTo(bead.x, bead.y);
        tctx.stroke();
        tctx.globalAlpha = 1;
      }

      // Shed residual beads into the trail — the detail that sells it.
      bead.shed -= bead.y - bead.py;
      if (bead.shed <= 0) {
        bead.shed = rnd(10, 28);
        if (this.beads.length < target + 40) {
          const r = Math.max(0.7, bead.r * rnd(0.13, 0.28));
          this.beads.push({
            x: bead.x + rnd(-bead.r * 0.3, bead.r * 0.3),
            y: bead.py,
            py: bead.py,
            r,
            rMax: r * rnd(1.7, 3),
            grow: rnd(0.001, 0.0026),
            running: false,
            vy: 0,
            vx: 0,
            ph: Math.random() * 6.2832,
            shed: 0,
          });
        }
        bead.r *= 0.986;
      }

      // Absorb resting beads it passes.
      for (let j = this.beads.length - 1; j >= 0; j--) {
        const other = this.beads[j]!;
        if (other === bead || other.running) continue;
        if (
          Math.abs(other.x - bead.x) < bead.r + other.r + 1.5 &&
          other.y > bead.py - bead.r &&
          other.y < bead.y + bead.r
        ) {
          bead.r = Math.sqrt(bead.r * bead.r + other.r * other.r);
          this.beads.splice(j, 1);
          if (j < i) i--;
        }
      }

      if (bead.y >= this.height - 2) {
        this.splashes.push({ x: bead.x, y: this.height - 2, r0: bead.r, born: this.time });
        this.beads.splice(i, 1);
      }
    }

    this.splashes = this.splashes.filter((splash) => this.time - splash.born < 0.85);
  }

  private drawGlass(ctx: CanvasRenderingContext2D, d: number, col: string): void {
    this.ensureGlassLayers(d, col);
    if (this.glassMist) {
      ctx.drawImage(this.glassMist, 0, 0, this.width, this.height);
    }
    if (this.glassTrails) {
      // Trails cut the mist away, revealing the app cleanly beneath.
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(this.glassTrails, 0, 0, this.width, this.height);
      ctx.globalCompositeOperation = "source-over";
    }
    for (const bead of this.beads) {
      const sprite = this.beadSprite(bead.r, col);
      const size = sprite.width / this.dpr;
      ctx.drawImage(sprite, bead.x - size / 2, bead.y - size / 2, size, size);
    }
    for (const splash of this.splashes) {
      const progress = (this.time - splash.born) / 0.85;
      if (progress < 0 || progress > 1) continue;
      const radius = splash.r0 + progress * 18;
      ctx.strokeStyle = rgba(col, (1 - progress) * 0.38 * this.alphaK());
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.ellipse(splash.x, splash.y, radius, radius * 0.32, 0, 0, 6.2832);
      ctx.stroke();
    }
  }

  // ── lattice ─────────────────────────────────────────────────────────
  // ThreeUI's semantic bloom: nodes that drift and link when they come close.
  // The most literal fit for a multi-agent tool — the graph densifies as work
  // arrives and a burst runs a pulse through the links.

  private stepLattice(dt: number, d: number, sp: number): void {
    for (const node of this.nodes) {
      node.x += node.vx * sp * dt * (0.5 + d);
      node.y += node.vy * sp * dt * (0.5 + d);
      node.x += this.wind * 10 * sp * dt;
      if (node.x < 0) {
        node.x = 0;
        node.vx *= -1;
      } else if (node.x > this.width) {
        node.x = this.width;
        node.vx *= -1;
      }
      if (node.y < 0) {
        node.y = 0;
        node.vy *= -1;
      } else if (node.y > this.height) {
        node.y = this.height;
        node.vy *= -1;
      }
    }
  }

  private drawLattice(ctx: CanvasRenderingContext2D, d: number, col: string): void {
    const count = Math.min(this.nodes.length, Math.floor(12 + d * 38));
    const link = Math.min(this.width, this.height) * (0.16 + d * 0.2);
    const alphaK = this.alphaK();
    ctx.lineWidth = 1;
    for (let a = 0; a < count; a++) {
      const p1 = this.nodes[a]!;
      for (let b = a + 1; b < count; b++) {
        const p2 = this.nodes[b]!;
        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > link) continue;
        // A tool burst brightens the whole web briefly.
        const alpha = (1 - dist / link) * (0.06 + d * 0.24 + this.burst * 0.12) * alphaK;
        ctx.strokeStyle = rgba(col, alpha);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    }
    for (let i = 0; i < count; i++) {
      const node = this.nodes[i]!;
      const pulse = 0.55 + Math.sin(this.time * 1.6 + node.ph) * 0.45;
      ctx.fillStyle = rgba(col, (0.12 + d * 0.4) * (0.4 + pulse * 0.6) * alphaK);
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r * (0.8 + pulse * 0.5), 0, 6.2832);
      ctx.fill();
    }
  }

  // ── blossom ─────────────────────────────────────────────────────────
  // Branches and blossom clusters are drawn once per resize into an offscreen
  // layer; only the petals move. Background stays transparent so the effect
  // remains an overlay rather than a backdrop.

  private petalPath(ctx: CanvasRenderingContext2D, s: number): void {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-s * 0.6, -s * 0.4, -s * 0.46, -s * 1.12, 0, -s);
    ctx.bezierCurveTo(s * 0.46, -s * 1.12, s * 0.6, -s * 0.4, 0, 0);
    ctx.closePath();
  }

  private buildBlossomBack(col: string): void {
    const key = `${this.width}x${this.height}|${col}|${this.config.dark ? "d" : "l"}`;
    if (this.blossomBack && this.blossomBackKey === key) return;

    const layer = document.createElement("canvas");
    layer.width = Math.round(this.width * this.dpr);
    layer.height = Math.round(this.height * this.dpr);
    const c = layer.getContext("2d");
    if (!c) return;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const bark = this.config.dark ? BLOSSOM_BARK_DARK : BLOSSOM_BARK_LIGHT;
    const drawBranch = (
      pts: number[][],
      w0: number,
      w1: number,
      clusters: number,
      size: number,
      spread: number,
      alpha: number,
    ) => {
      const steps = 46;
      const top: Array<[number, number]> = [];
      const bottom: Array<[number, number]> = [];
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const a = bezierAt(pts, u);
        const b = bezierAt(pts, Math.min(1, u + 0.012));
        const ax = a[0] * this.width;
        const ay = a[1] * this.height;
        const dx = b[0] * this.width - ax;
        const dy = b[1] * this.height - ay;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const w = (w0 + (w1 - w0) * u) * this.height;
        top.push([ax + nx * w, ay + ny * w]);
        bottom.push([ax - nx * w, ay - ny * w]);
      }
      c.beginPath();
      c.moveTo(top[0]![0], top[0]![1]);
      for (let i = 1; i < top.length; i++) c.lineTo(top[i]![0], top[i]![1]);
      for (let i = bottom.length - 1; i >= 0; i--) c.lineTo(bottom[i]![0], bottom[i]![1]);
      c.closePath();
      c.fillStyle = rgba(bark, alpha);
      c.fill();

      for (let q = 0; q < clusters; q++) {
        const u = Math.max(0, Math.min(1, (q + 0.5) / clusters + rnd(-0.02, 0.02)));
        const point = bezierAt(pts, u);
        const cx = point[0] * this.width;
        const cy = point[1] * this.height;
        const petals = 2 + Math.floor(Math.random() * 3);
        for (let k = 0; k < petals; k++) {
          const off = spread * this.height;
          const bx = cx + rnd(-off, off);
          const by = cy + rnd(-off, off);
          const s = size * this.height * rnd(0.72, 1.25);
          c.save();
          c.translate(bx, by);
          c.rotate(Math.random() * 6.2832);
          c.globalAlpha = alpha;
          for (let petal = 0; petal < 5; petal++) {
            c.save();
            c.rotate(petal * 1.25664);
            this.petalPath(c, s);
            // Blossoms take a little of the state colour so a fault squall or
            // an approval hold reads here exactly as it does in rain.
            c.fillStyle = mix(this.ink(PETAL_TONES[petal % PETAL_TONES.length]!), col, 0.22);
            c.fill();
            c.restore();
          }
          c.beginPath();
          c.arc(0, 0, s * 0.19, 0, 6.2832);
          c.fillStyle = this.config.dark ? "#fff3d8" : "#8a6a3a";
          c.fill();
          c.restore();
        }
      }
    };

    drawBranch(
      [
        [-0.06, 0.1],
        [0.3, 0.0],
        [0.66, 0.26],
        [1.06, 0.06],
      ],
      0.011,
      0.003,
      13,
      0.02,
      0.03,
      0.4,
    );
    drawBranch(
      [
        [-0.06, 0.3],
        [0.28, 0.14],
        [0.62, 0.4],
        [1.06, 0.2],
      ],
      0.016,
      0.004,
      15,
      0.028,
      0.04,
      0.85,
    );
    drawBranch(
      [
        [-0.06, 0.94],
        [0.26, 1.04],
        [0.6, 0.82],
        [1.06, 0.98],
      ],
      0.022,
      0.006,
      17,
      0.036,
      0.052,
      0.95,
    );

    this.blossomBack = layer;
    this.blossomBackKey = key;
  }

  private stepBlossom(dt: number, d: number, sp: number): void {
    for (let i = 0; i < this.petals.length; i++) {
      const petal = this.petals[i]!;
      petal.y += petal.vy * (0.45 + d * 0.9) * sp * dt;
      petal.x +=
        (petal.vx + Math.sin(this.time * 0.8 + petal.ph) * petal.sway * 9 + this.wind * 26) *
        sp *
        dt;
      petal.rot += petal.vr * sp * dt;
      if (petal.y > this.height + 16) {
        this.petals[i] = this.newPetal(false);
        continue;
      }
      if (petal.x < -20) petal.x = this.width + 16;
      else if (petal.x > this.width + 20) petal.x = -16;
    }
  }

  private drawBlossom(ctx: CanvasRenderingContext2D, d: number, col: string): void {
    this.buildBlossomBack(col);
    if (this.blossomBack) {
      ctx.globalAlpha = 0.35 + d * 0.55;
      ctx.drawImage(this.blossomBack, 0, 0, this.width, this.height);
      ctx.globalAlpha = 1;
    }
    const count = Math.min(this.petals.length, Math.floor(12 + d * 58));
    for (let i = 0; i < count; i++) {
      const petal = this.petals[i]!;
      // Scaling y by a cosine reads as the petal turning over as it falls.
      const flip = Math.cos(this.time * petal.spin + petal.ph);
      ctx.save();
      ctx.translate(petal.x, petal.y);
      ctx.rotate(petal.rot);
      ctx.scale(1, Math.max(0.16, Math.abs(flip)));
      ctx.globalAlpha =
        petal.alpha * (0.55 + Math.abs(flip) * 0.45) * (0.35 + d * 0.65) * this.alphaK();
      this.petalPath(ctx, petal.s);
      ctx.fillStyle = mix(this.ink(PETAL_TONES[petal.tone]!), col, 0.22);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  private drawFog(ctx: CanvasRenderingContext2D, amount: number): void {
    if (amount <= 0.005) return;
    const gradient = ctx.createLinearGradient(0, 0, this.width, this.height);
    const haze = this.config.dark ? "#c8d2dc" : "#4b5866";
    gradient.addColorStop(0, rgba(haze, 0));
    gradient.addColorStop(0.5, rgba(haze, 0.09 * amount * this.alphaK()));
    gradient.addColorStop(1, rgba(haze, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  // ── frame loop ──────────────────────────────────────────────────────

  private frame(now: number): void {
    // No early return on a missing 2D context: WebGL engines have none, and
    // the 2D draw path below guards separately.
    const ctx = this.ctx;

    const dt = Math.min(0.05, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    if (!this.config.reducedMotion) {
      this.time += dt;
    }

    // Pulse decays (per-second rates from the mockup).
    this.burst = Math.max(0, this.burst - dt * 0.85);
    this.fog = Math.max(0, this.fog - dt * 0.22);
    this.fault = Math.max(0, this.fault - dt * 0.26);
    this.clearing = Math.max(0, this.clearing - dt * 0.4);
    // The hold level stays pinned while an approval is actually pending
    // (store truth), then decays once it resolves.
    if (this.holding) {
      this.hold = 1;
    } else if (this.hold > 0) {
      this.hold = Math.max(0, this.hold - dt * 0.6);
    }

    const target = this.targetDrive();
    this.drive += (target - this.drive) * Math.min(1, dt * 2.2);
    this.wind +=
      (Math.sin(this.time * 0.23) * 0.5 + this.burst * 0.9 - this.wind) * Math.min(1, dt * 1.6);

    const d = this.drive;
    const sp = this.speedMul();
    const col = this.stateColor();

    // WebGL effects consume exactly the same signals, as uniforms. The engine
    // stays the single owner of the drive/pulse math either way.
    if (this.gl) {
      if (this.gl.isLost()) return;
      if (d <= 0.002) {
        this.gl.clear();
        return;
      }
      const [r, g, b] = hexRgb(col);
      this.gl.draw({
        time: this.time,
        tint: [r / 255, g / 255, b / 255],
        drive: d,
        // Speed multiplier is folded into the pulses the shaders read so an
        // approval hold visibly stalls a shader exactly as it stalls rain.
        wind: this.wind * sp,
        burst: this.burst,
        hold: this.hold,
        fault: this.fault,
        clearing: this.clearing,
        fog: this.fog,
        dark: this.config.dark,
        side: this.side * this.gl.backingScale(this.width),
        surfaceSidebar: this.config.surfaces.sidebar,
        surfaceThread: this.config.surfaces.thread,
      });
      return;
    }

    if (!ctx) return;
    ctx.clearRect(0, 0, this.width, this.height);
    if (d > 0.002) {
      ctx.save();
      this.clipSurfaces(ctx);
      if (!this.config.reducedMotion) {
        if (this.config.effect === "rain") this.stepRain(dt, d, sp);
        else if (this.config.effect === "snow") this.stepSnow(dt, d, sp);
        else if (this.config.effect === "matrix") this.stepMatrix(dt, d, sp);
        else if (this.config.effect === "fire") this.stepFire(dt, d, sp);
        else if (this.config.effect === "glass") this.stepGlass(dt, d, sp);
        else if (this.config.effect === "lattice") this.stepLattice(dt, d, sp);
        else if (this.config.effect === "blossom") this.stepBlossom(dt, d, sp);
        else this.stepStars(dt, d, sp);
      }
      if (this.config.effect === "rain") this.drawRain(ctx, d, col);
      else if (this.config.effect === "snow") this.drawSnow(ctx, d, col);
      else if (this.config.effect === "matrix") this.drawMatrix(ctx, d, col);
      else if (this.config.effect === "fire") this.drawFire(ctx, d, col);
      else if (this.config.effect === "glass") this.drawGlass(ctx, d, col);
      else if (this.config.effect === "lattice") this.drawLattice(ctx, d, col);
      else if (this.config.effect === "blossom") this.drawBlossom(ctx, d, col);
      else this.drawStars(ctx, d, col);
      this.drawFog(ctx, this.fog);
      ctx.restore();
    }
  }

  /** Release the GL context immediately on unmount / effect switch. */
  dispose(): void {
    this.stop();
    this.gl?.dispose();
    this.beadSprites.clear();
    this.glassMist = null;
    this.glassTrails = null;
    this.glassTrailsCtx = null;
    this.blossomBack = null;
  }

  /** True when a WebGL effect was asked for but the context could not be made. */
  isGlUnavailable(): boolean {
    return this.glUnavailable;
  }
}
