import type { AmbianceEffect } from "@cafecode/contracts";

/**
 * WebGL back end for the ambiance layer.
 *
 * Every effect here is a single fullscreen-quad fragment shader — there is no
 * scene graph and no three.js. The vertex stage is one oversized triangle; all
 * of the work happens per fragment against the same uniform block the canvas-2D
 * effects consume, so a WebGL effect reacts to thread state exactly like rain
 * and fire do: `u_drive` is the eased session drive, `u_wind` the tool-burst
 * gust, and `u_burst` / `u_fog` / `u_fault` / `u_clearing` / `u_hold` are the
 * decaying pulses. `u_tint` is already the resolved state colour (amber while
 * an approval holds, red on faults, settled grey when stopped).
 *
 * Reliability constraints (AGENTS.md):
 * - Renderer-only decoration. Nothing here reads or writes orchestration state.
 * - Per-frame work is bounded by the viewport, and the backing store is capped
 *   (`MAX_BACKING_PIXELS`) so a 5K display does not pay millions of fragments
 *   per frame for decoration.
 * - Construction returns `null` on any failure (no context, failed compile,
 *   failed link). The caller falls back to a canvas-2D effect rather than
 *   leaving a blank layer — a decoration must never look like a broken screen.
 * - Context loss is tolerated: the renderer stops drawing and reports itself
 *   dead so the layer can rebuild.
 */

/** Roughly a 1440p worth of fragments; ambiance is soft enough to upscale. */
const MAX_BACKING_PIXELS = 2_500_000;
const MAX_BACKING_DPR = 1.75;

const VERTEX_SHADER = `attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

/**
 * Shared prelude. `themeOut` is the single place light mode is handled: on a
 * light UI an additive glow reads as washed-out haze, so the colour is pushed
 * down into a tinted stain and alpha carries more of the contrast.
 */
const PRELUDE = `precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_tint;
uniform float u_drive;
uniform float u_wind;
uniform float u_burst;
uniform float u_hold;
uniform float u_fault;
uniform float u_clearing;
uniform float u_fog;
uniform float u_dark;
uniform float u_side;
uniform vec2 u_surf;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Per-surface clipping. The 2D engine uses ctx.clip() with two rects; the
// equivalent here is a discard against the sidebar/thread split.
bool surfaceAllowed() {
  if (gl_FragCoord.x < u_side) return u_surf.x > 0.5;
  return u_surf.y > 0.5;
}

vec4 themeOut(vec3 col, float alpha) {
  alpha = clamp(alpha, 0.0, 1.0);
  if (u_dark < 0.5) {
    // Darkening alone restores the contrast a glow loses on a light ground;
    // scaling alpha as hard as well made wide-coverage effects (converge,
    // resonance) read as a stain over the whole window.
    col = col * 0.38;
    alpha = clamp(alpha * 1.05, 0.0, 1.0);
  }
  // Compaction fog washes the whole field out slightly, matching drawFog().
  alpha *= 1.0 - u_fog * 0.35;
  return vec4(col, alpha);
}
`;

// ── Aurora — ThreeUI ribbon-field ──────────────────────────────────
const AURORA = `
float ribbonAt(vec2 uv, float offset, float width, float phase) {
  float y = 0.54 + 0.20 * sin((uv.x * 2.05) + phase) + 0.05 * sin((uv.x * 6.5) - phase * 0.7);
  float d = abs(uv.y - y - offset);
  return exp(-(d * d) / width);
}
void main() {
  if (!surfaceAllowed()) discard;
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  float t = u_time * 0.20;
  // Wind drags the ribbons sideways, so a tool burst visibly pushes them.
  uv.x += u_wind * 0.05;
  float r1 = ribbonAt(uv, 0.06, 0.0075, t + 0.9);
  float r2 = ribbonAt(uv, -0.16, 0.0100, t + 3.25);
  float r3 = ribbonAt(uv, 0.22, 0.0165, t + 1.85);
  float glow = r1 * 1.30 + r2 * 1.10 + r3 * 0.60;
  vec3 teal = mix(u_tint, vec3(0.17, 0.95, 0.75), 0.5);
  vec3 indigo = mix(u_tint, vec3(0.45, 0.38, 0.95), 0.7);
  vec3 col = u_tint * r1 * 0.85 + teal * r1 * 0.42 + indigo * r3 * 0.55 + u_tint * r2 * 0.5;
  float bloom = exp(-pow(distance(uv, vec2(0.70, 0.72 + 0.03 * sin(t))), 2.0) / 0.070);
  col += mix(u_tint, vec3(1.0), 0.3) * bloom * 0.26;
  vec2 g = fract(gl_FragCoord.xy / 8.0) - 0.5;
  float dots = smoothstep(0.30, 0.12, length(g));
  float nz = hash21(floor(gl_FragCoord.xy / 8.0));
  float dm = mix(0.62, 1.0, dots * (0.5 + 0.5 * nz));
  float alpha = (glow * 0.85 + bloom * 0.28) * dm * (0.14 + u_drive * 0.72);
  gl_FragColor = themeOut(col, alpha);
}`;

// ── Grid — ThreeUI dot-matrix ──────────────────────────────────────
const GRID = `
void main() {
  if (!surfaceAllowed()) discard;
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  float aspect = u_res.x / u_res.y;
  uv.x *= aspect;
  vec2 grid = fract(uv * 26.0);
  vec2 id = floor(uv * 26.0);
  float dist = length(grid - vec2(0.5));
  float pulse = sin(u_time * (0.7 + u_drive * 1.1) + id.x * 0.35 + id.y * 0.35) * 0.5 + 0.5;
  float radius = 0.07 + pulse * (0.06 + u_drive * 0.14);
  float dot0 = smoothstep(radius, radius - 0.05, dist);
  vec2 centre = vec2(0.5 * aspect, 0.5);
  float depthFade = smoothstep(1.2, 0.1, length(uv - centre));
  // A tool burst sends one ripple out from the composer edge.
  vec2 origin = vec2(0.5 * aspect, 0.02);
  float ring = 1.0 - smoothstep(0.0, 0.16, abs(length(uv - origin) - (1.0 - u_burst) * 1.5));
  float lift = ring * u_burst;
  vec3 col = u_tint * (0.35 + pulse * 0.85 + lift * 0.8);
  gl_FragColor = themeOut(col, dot0 * depthFade * (0.12 + u_drive * 0.7 + lift * 0.35));
}`;

// ── Horizon — ThreeUI emerald-horizon ──────────────────────────────
const HORIZON = `
float vnoise(float x) {
  float i = floor(x);
  float f = fract(x);
  float u = f * f * (3.0 - 2.0 * f);
  return mix(fract(sin(i) * 1e4), fract(sin(i + 1.0) * 1e4), u);
}
void main() {
  if (!surfaceAllowed()) discard;
  vec2 st = gl_FragCoord.xy / u_res.xy;
  float w1 = sin(st.x * 3.0 + u_time * 0.5) * 0.1;
  float w2 = sin(st.x * 5.0 - u_time * 0.3) * 0.05;
  // Drive raises the band; it only ever occupies the bottom of the window so
  // the reading area stays completely untouched.
  float top = 0.16 + u_drive * 0.34;
  float intensity = smoothstep(top, -0.10, st.y + w1 + w2);
  float variation = vnoise(st.x * 2.0 + u_time * 0.1) * 0.5 + 0.5;
  intensity *= variation * 1.5;
  vec3 g1 = u_tint * 0.85;
  vec3 g2 = mix(u_tint, vec3(0.45, 0.40, 0.98), 0.55);
  vec3 col = mix(g1, g2, st.x + sin(u_time * 0.2) * 0.5);
  float alpha = pow(max(intensity, 0.0), 1.15) * (0.35 + u_drive * 0.75);
  alpha *= mix(0.55, 1.0, smoothstep(1.35, 0.35, length(st - vec2(0.5, 0.0))));
  gl_FragColor = themeOut(col, alpha);
}`;

// ── Resonance — ThreeUI bell-field ─────────────────────────────────
const RESONANCE = `
float bess(float x) { return cos(x - 0.785398) / sqrt(1.0 + abs(x)); }
void main() {
  if (!surfaceAllowed()) discard;
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 p = uv * 2.0 - 1.0;
  p.x *= u_res.x / u_res.y;
  float t = u_time * 0.09;
  float r = length(p);
  float a = atan(p.y, p.x);
  float ang = 3.0 + 1.6 * sin(t * 0.37) + sin(t * 0.19 + 1.7);
  float k = 3.1 + 1.0 * sin(t * 0.23 + 0.6);
  // The plate is struck by turn completion, and tapped by every tool call.
  float strike = clamp(1.0 - max(u_clearing, u_burst * 0.6), 0.0, 1.0);
  float amp = 1.0 + (1.0 - strike) * 0.55;
  float f1 = bess(r * k * 3.14159265 - t * 2.2) * cos(ang * a + t * 0.5);
  float f2 = bess(r * k * 1.6 * 3.14159265 + t * 1.4) * cos((ang * 2.0 + 1.0) * a - t * 0.31);
  float f = (f1 + f2 * 0.30) * amp;
  float node = 1.0 - smoothstep(0.0, 0.075 + 0.075 * r, abs(f));
  float anti = smoothstep(0.40, 0.95, abs(f));
  float open = smoothstep(0.14, 0.92, r);
  node *= open;
  anti *= open;
  vec3 hot = mix(u_tint, vec3(1.0), 0.45);
  vec3 col = u_tint * 0.72 * node + hot * anti * 0.5;
  col += mix(u_tint, vec3(1.0), 0.7) * pow(node, 3.0) * 0.35;
  float ring = smoothstep(0.06, 0.0, abs(r - strike * 2.3)) * (1.0 - strike);
  col += mix(hot, vec3(1.0), 0.4) * ring * 0.9;
  float alpha = (node * 0.95 + anti * 0.5 + ring * 0.95) * (0.14 + u_drive * 0.86);
  alpha *= mix(0.10, 1.0, smoothstep(2.0, 0.28, r));
  gl_FragColor = themeOut(col, alpha);
}`;

// ── Converge — ThreeUI stream-convergence ──────────────────────────
const CONVERGE = `
void main() {
  if (!surfaceAllowed()) discard;
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 p = uv * 2.0 - 1.0;
  p.x *= u_res.x / u_res.y;
  // The focus sits low-centre: the composer. Every filament runs toward it.
  vec2 focus = vec2(0.0, -0.72);
  vec2 d = p - focus;
  float r = length(d);
  float a = atan(d.y, d.x);
  float acc = 0.0;
  for (int i = 0; i < 14; i++) {
    float fi = float(i);
    float seed = hash21(vec2(fi, 7.0));
    float base = (fi / 14.0) * 6.2832;
    float swirl = base + r * 0.55 + u_time * 0.06 + sin(u_time * 0.21 + seed * 6.0) * 0.18
      + u_wind * 0.20;
    float ang = abs(mod(a - swirl + 3.14159, 6.2832) - 3.14159);
    float fil = exp(-pow(ang * (2.6 + r * 2.2), 2.0));
    // Tool bursts fire a packet down the filament.
    float packet = fract(seed + u_time * (0.055 + seed * 0.075) + u_burst * 0.35);
    float head = mix(2.4, 0.05, packet);
    float body = exp(-pow((r - head) * 1.35, 2.0) * 1.7);
    acc += fil * body * (0.45 + seed * 0.75);
  }
  acc *= smoothstep(0.04, 0.36, r);
  acc *= smoothstep(2.6, 0.6, r);
  float core = exp(-r * 3.4);
  vec3 col = u_tint * (0.8 + u_burst * 0.5) + mix(u_tint, vec3(1.0), 0.5) * core * 0.4;
  float alpha = (acc * 1.7 + core * 0.22) * (0.16 + u_drive * 0.84);
  gl_FragColor = themeOut(col, alpha);
}`;

// ── Beam — ThreeUI laser ───────────────────────────────────────────
const BEAM = `
float vnoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), u.x), u.y);
}
float fbm2(vec2 p) {
  float r = 0.0;
  float w = 0.54;
  for (int i = 0; i < 4; i++) {
    r += vnoise2(p) * w;
    p = mat2(1.62, 1.21, -1.21, 1.62) * p + 9.13;
    w *= 0.48;
  }
  return r;
}
void main() {
  if (!surfaceAllowed()) discard;
  vec2 uv = gl_FragCoord.xy / u_res.xy;
  vec2 p = uv * 2.0 - 1.0;
  p.x *= u_res.x / u_res.y;
  float drift = sin(u_time * 0.21) * 0.06 + u_wind * 0.12;
  float tilt = sin(u_time * 0.13) * 0.10 + u_wind * 0.06;
  float dist = abs(p.x - drift - p.y * tilt);
  float vmask = 1.0 - smoothstep(0.68, 1.45, abs(p.y));
  float core = exp(-pow(dist / 0.006, 2.0));
  float glow = exp(-pow(dist / 0.10, 1.25));
  vec2 fuv = vec2(p.x * 3.4, p.y * 2.15 - u_time * 0.075);
  fuv.x += sin(p.y * 3.2 - u_time * 0.17) * 0.18;
  float env = exp(-pow(dist / 0.42, 1.35));
  float fog = smoothstep(0.34, 0.78, fbm2(fuv)) * env * vmask;
  vec3 hot = mix(u_tint, vec3(1.0), 0.75);
  vec3 col = hot * core * 1.15 + u_tint * glow * 0.55 + u_tint * fog * 0.6;
  float alpha = (core * 0.9 + glow * 0.45 + fog * 0.75) * vmask * (0.16 + u_drive * 0.84);
  gl_FragColor = themeOut(col, alpha);
}`;

// ── Terminal — ThreeUI crt ─────────────────────────────────────────
// The original is a post-process over a sampler2D. An overlay above the app
// (pointer-events: none) cannot sample the DOM beneath it, so the source is
// generated procedurally here — that is the only shippable form of the effect.
const TERMINAL = `
vec2 curve(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  vec2 o = uv.yx * uv.yx;
  uv += uv * o * vec2(0.115, 0.165);
  return uv * 0.5 + 0.5;
}
vec3 source(vec2 uv) {
  float ROWS = 30.0;
  float COLS = 104.0;
  float row = floor(uv.y * ROWS);
  float rf = fract(uv.y * ROWS);
  float cell = floor(uv.x * COLS);
  float cf = fract(uv.x * COLS);
  float seed = hash21(vec2(row, 3.0));
  float len = 0.16 + seed * 0.70;
  float indent = step(0.015 + seed * 0.07, uv.x);
  float lineMask = step(0.20, rf) * step(rf, 0.80);
  float charMask = step(0.12, cf) * step(cf, 0.84);
  float on = step(uv.x, len) * step(0.30, hash21(vec2(cell, row)));
  float glyph = on * indent * lineMask * charMask;
  float curRow = floor(fract(u_time * 0.05) * ROWS);
  float cur = step(abs(uv.x - len - 0.006), 0.005) * lineMask
    * step(abs(fract(u_time * 0.8) - 0.5), 0.25) * step(abs(row - curRow), 0.5);
  return u_tint * glyph * 0.66 + mix(u_tint, vec3(1.0), 0.5) * cur * 0.95;
}
void main() {
  if (!surfaceAllowed()) discard;
  vec2 fuv = gl_FragCoord.xy / u_res.xy;
  vec2 uv = curve(fuv);
  vec2 inb = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  float inside = inb.x * inb.y;
  vec2 ed = min(uv, 1.0 - uv);
  inside *= smoothstep(0.0, 0.020, min(ed.x, ed.y));
  vec2 dir = uv - 0.5;
  vec2 ao = dir * (0.0016 + 0.012 * dot(dir, dir));
  vec3 col = vec3(source(uv + ao).r, source(uv).g, source(uv - ao).b);
  float sl = sin(uv.y * 3.14159265 * (u_res.y * 0.92) + u_time * 4.0);
  col *= mix(0.70, 1.0, sl * sl);
  float gx = gl_FragCoord.x * (6.2831853 / 3.0);
  col *= 0.66 + 0.34 * cos(gx + vec3(0.0, 2.094, 4.188));
  float bar = fract(uv.y * 0.5 - u_time * 0.07);
  bar = smoothstep(0.0, 0.05, bar) * smoothstep(0.18, 0.05, bar);
  col += bar * 0.045;
  col *= 1.0 - 0.028 * sin(u_time * 8.0);
  float lum = max(col.r, max(col.g, col.b));
  gl_FragColor = themeOut(col * 1.34, lum * 2.1 * inside * (0.22 + u_drive * 0.9));
}`;

// ── Core — ThreeUI energy-orb ──────────────────────────────────────
const CORE = `
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x),
                 mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x),
                 mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm3(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise3(p);
    p = p * 2.03 + vec3(1.7);
    a *= 0.5;
  }
  return v;
}
void main() {
  if (!surfaceAllowed()) discard;
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  float r = length(uv);
  float R = 0.19 + u_drive * 0.10;
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  if (r < R) {
    float z = sqrt(max(R * R - r * r, 0.0));
    vec3 n = normalize(vec3(uv, z));
    float ca = u_time * 0.15;
    mat3 rot = mat3(cos(ca), 0.0, sin(ca), 0.0, 1.0, 0.0, -sin(ca), 0.0, cos(ca));
    vec3 sp = rot * n;
    // Drive spins the smoke up as work arrives.
    float st = u_time * (0.6 + u_drive * 1.1);
    float f1 = fbm3(sp * 2.6 + vec3(0.0, st * 0.12, 0.0));
    float f2 = fbm3(sp * 4.5 - vec3(st * 0.08, 0.0, st * 0.05) + f1 * 1.8);
    float veil = smoothstep(0.35, 0.75, f2);
    vec3 deep = u_tint * 0.10;
    vec3 mid = u_tint * 0.55;
    vec3 bright = mix(u_tint, vec3(1.0), 0.45);
    col = mix(deep, mid, f1 * 1.2);
    col = mix(col, bright, veil * 0.65);
    float fres = pow(1.0 - z / R, 2.2);
    col += mix(u_tint, vec3(1.0), 0.25) * fres * 1.1;
    alpha = 0.30 + u_drive * 0.55;
  } else {
    float glow = clamp(exp(-(r - R) * 14.0), 0.0, 1.0);
    col = u_tint * glow * 0.8;
    alpha = glow * (0.25 + u_drive * 0.5);
  }
  gl_FragColor = themeOut(col, alpha);
}`;

const FRAGMENT_BY_EFFECT: Partial<Record<AmbianceEffect, string>> = {
  aurora: AURORA,
  grid: GRID,
  horizon: HORIZON,
  resonance: RESONANCE,
  converge: CONVERGE,
  beam: BEAM,
  terminal: TERMINAL,
  core: CORE,
};

export type AmbianceGLUniforms = {
  time: number;
  tint: [number, number, number];
  drive: number;
  wind: number;
  burst: number;
  hold: number;
  fault: number;
  clearing: number;
  fog: number;
  dark: boolean;
  /** Sidebar boundary in device pixels (the canvas' own coordinate space). */
  side: number;
  surfaceSidebar: boolean;
  surfaceThread: boolean;
};

type UniformLocations = Record<string, WebGLUniformLocation | null>;

export class AmbianceGLRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms: UniformLocations;
  private readonly onLost: () => void;
  private lost = false;

  private constructor(
    canvas: HTMLCanvasElement,
    gl: WebGLRenderingContext,
    program: WebGLProgram,
    uniforms: UniformLocations,
  ) {
    this.canvas = canvas;
    this.gl = gl;
    this.program = program;
    this.uniforms = uniforms;
    this.onLost = () => {
      this.lost = true;
    };
    canvas.addEventListener("webglcontextlost", this.onLost);
  }

  /** Returns null whenever WebGL is unusable; the caller must fall back. */
  static create(canvas: HTMLCanvasElement, effect: AmbianceEffect): AmbianceGLRenderer | null {
    const fragmentBody = FRAGMENT_BY_EFFECT[effect];
    if (!fragmentBody) return null;

    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl", {
        alpha: true,
        premultipliedAlpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: "low-power",
      }) as WebGLRenderingContext | null;
    } catch {
      gl = null;
    }
    if (!gl) return null;

    const compile = (type: number, source: string): WebGLShader | null => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        return null;
      }
      return shader;
    };

    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl.FRAGMENT_SHADER, PRELUDE + fragmentBody);
    if (!vertex || !fragment) return null;

    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return null;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // One oversized triangle covers the viewport with no index buffer.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const names = [
      "u_res",
      "u_time",
      "u_tint",
      "u_drive",
      "u_wind",
      "u_burst",
      "u_hold",
      "u_fault",
      "u_clearing",
      "u_fog",
      "u_dark",
      "u_side",
      "u_surf",
    ];
    const uniforms: UniformLocations = {};
    for (const name of names) uniforms[name] = gl.getUniformLocation(program, name);

    return new AmbianceGLRenderer(canvas, gl, program, uniforms);
  }

  isLost(): boolean {
    return this.lost;
  }

  /**
   * Size the backing store. CSS keeps the canvas at viewport size; the bitmap
   * is capped so a very large display cannot make a decorative shader
   * proportionally expensive.
   */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const scale = Math.min(Math.max(dpr, 1), MAX_BACKING_DPR);
    let width = Math.max(1, Math.round(cssWidth * scale));
    let height = Math.max(1, Math.round(cssHeight * scale));
    const pixels = width * height;
    if (pixels > MAX_BACKING_PIXELS) {
      const shrink = Math.sqrt(MAX_BACKING_PIXELS / pixels);
      width = Math.max(1, Math.round(width * shrink));
      height = Math.max(1, Math.round(height * shrink));
    }
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /** Device-pixel scale currently in force, so callers can map CSS px in. */
  backingScale(cssWidth: number): number {
    return cssWidth > 0 ? this.canvas.width / cssWidth : 1;
  }

  clear(): void {
    if (this.lost) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  draw(values: AmbianceGLUniforms): void {
    if (this.lost) return;
    const gl = this.gl;
    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (u.u_res) gl.uniform2f(u.u_res, this.canvas.width, this.canvas.height);
    if (u.u_time) gl.uniform1f(u.u_time, values.time);
    if (u.u_tint) gl.uniform3f(u.u_tint, values.tint[0], values.tint[1], values.tint[2]);
    if (u.u_drive) gl.uniform1f(u.u_drive, values.drive);
    if (u.u_wind) gl.uniform1f(u.u_wind, values.wind);
    if (u.u_burst) gl.uniform1f(u.u_burst, values.burst);
    if (u.u_hold) gl.uniform1f(u.u_hold, values.hold);
    if (u.u_fault) gl.uniform1f(u.u_fault, values.fault);
    if (u.u_clearing) gl.uniform1f(u.u_clearing, values.clearing);
    if (u.u_fog) gl.uniform1f(u.u_fog, values.fog);
    if (u.u_dark) gl.uniform1f(u.u_dark, values.dark ? 1 : 0);
    if (u.u_side) gl.uniform1f(u.u_side, values.side);
    if (u.u_surf) {
      gl.uniform2f(u.u_surf, values.surfaceSidebar ? 1 : 0, values.surfaceThread ? 1 : 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    if (this.lost) return;
    const gl = this.gl;
    gl.deleteProgram(this.program);
    // Release the driver-side context immediately rather than waiting for GC;
    // effect switches must never leave a second context resident.
    const loseContext = gl.getExtension("WEBGL_lose_context");
    loseContext?.loseContext();
  }
}
