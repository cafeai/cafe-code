/**
 * The Task Atrium's cherry-blossom scene.
 *
 * Canvas 2D only — no WebGL context and no dependency. The expensive parts
 * (sky, branches, blossom clusters) are rendered into two offscreen layers once
 * per resize; only the petals move per frame. Parallax is then just two
 * `drawImage` offsets, which keeps the whole scene at a fixed, small per-frame
 * cost regardless of how much is drawn into it.
 *
 * Layers are ordered back to front — sky and far branch, near branches, then
 * petals — and each takes a larger share of the pointer offset than the one
 * behind it, which is what sells the depth.
 */

/** Fraction of the pointer offset each layer takes. Nearer moves more. */
const FAR_PARALLAX = 0.35;
const NEAR_PARALLAX = 0.85;
const PETAL_PARALLAX = 1.35;
/** Offscreen layers are oversized so parallax never exposes an edge. */
const OVERSCAN = 0.07;
const PETAL_COUNT = 64;

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

function hexRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
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

/**
 * The whole scene is derived from the Atrium tint so it follows the colour
 * setting rather than being locked to cherry pink. A tint of #e8a0bd gives the
 * classic blossom; the default cyan gives a cool, frosted version of the same
 * scene. Petals are the tint lifted toward white on a dark sky and pushed
 * toward a deep shade on a light one, so they stay legible either way.
 */
type ScenePalette = {
  petals: string[];
  skyTop: string;
  skyMid: string;
  skyBottom: string;
  glow: string;
  bark: string;
  stamen: string;
  hazeFrom: string;
  hazeTo: string;
};

/**
 * A blossom base the tint is blended into. Deriving petals from the tint alone
 * means a cyan accent produces white-blue puffs that read as cloud, not flower;
 * blending through this keeps the hue following the setting while the scene
 * stays recognisably a blossom tree whatever colour is chosen.
 */
const BLOSSOM_BASE = "#f0b9cd";

function buildPalette(tint: string, dark: boolean): ScenePalette {
  const bloom = mix(BLOSSOM_BASE, tint, 0.5);
  if (dark) {
    return {
      petals: [
        mix(bloom, "#ffffff", 0.45),
        mix(bloom, "#ffffff", 0.2),
        mix(bloom, "#8d4f6a", 0.22),
        mix(bloom, "#ffffff", 0.62),
      ],
      // Sky takes only a trace of the tint; a saturated wash would fight the
      // cards sitting on top of it.
      skyTop: mix("#4b3a46", tint, 0.22),
      skyMid: mix("#3a2c37", tint, 0.16),
      skyBottom: mix("#241b23", tint, 0.1),
      glow: mix("#ffe2ec", tint, 0.35),
      bark: mix("#3a2b2c", tint, 0.12),
      stamen: "#fff3d8",
      hazeFrom: mix("#241b23", tint, 0.1),
      hazeTo: mix("#1e161c", tint, 0.1),
    };
  }
  return {
    petals: [
      mix(bloom, "#5c2f45", 0.2),
      mix(bloom, "#5c2f45", 0.36),
      mix(bloom, "#5c2f45", 0.5),
      mix(bloom, "#5c2f45", 0.08),
    ],
    skyTop: mix("#f6ecef", tint, 0.14),
    skyMid: mix("#efe4ea", tint, 0.12),
    skyBottom: mix("#e3d8e1", tint, 0.12),
    glow: "#ffffff",
    bark: mix("#6b5148", tint, 0.1),
    stamen: mix("#b98a4a", tint, 0.15),
    hazeFrom: mix("#e2d6e0", tint, 0.12),
    hazeTo: mix("#dcd0dc", tint, 0.12),
  };
}

function petalPath(target: CanvasRenderingContext2D, s: number): void {
  target.beginPath();
  target.moveTo(0, 0);
  target.bezierCurveTo(-s * 0.6, -s * 0.4, -s * 0.46, -s * 1.12, 0, -s);
  target.bezierCurveTo(s * 0.46, -s * 1.12, s * 0.6, -s * 0.4, 0, 0);
  target.closePath();
}

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

export type AtriumScene = {
  resize: () => void;
  setDark: (dark: boolean) => void;
  /** #rrggbb; the whole palette is derived from it. */
  setTint: (tint: string) => void;
  /** Pointer offset in -1..1 on each axis. */
  setPointer: (x: number, y: number) => void;
  draw: () => void;
  dispose: () => void;
};

export function createAtriumScene(canvas: HTMLCanvasElement): AtriumScene | null {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  const context = ctx;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let width = 1;
  let height = 1;
  let dark = true;
  let tint = "#48cfff";
  let palette = buildPalette(tint, dark);
  let pointerX = 0;
  let pointerY = 0;
  let easedX = 0;
  let easedY = 0;
  let time = 0;
  let petals: Petal[] = [];
  let farLayer: HTMLCanvasElement | null = null;
  let nearLayer: HTMLCanvasElement | null = null;

  function blossomAt(
    target: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    alpha: number,
  ): void {
    const tones = palette.petals;
    target.save();
    target.translate(x, y);
    target.rotate(Math.random() * 6.2832);
    target.globalAlpha = alpha;
    for (let petal = 0; petal < 5; petal++) {
      target.save();
      target.rotate(petal * 1.25664);
      petalPath(target, size);
      target.fillStyle = tones[petal % tones.length]!;
      target.fill();
      target.restore();
    }
    target.beginPath();
    target.arc(0, 0, size * 0.19, 0, 6.2832);
    target.fillStyle = palette.stamen;
    target.fill();
    target.restore();
  }

  function drawBranch(
    target: CanvasRenderingContext2D,
    layerWidth: number,
    layerHeight: number,
    pts: number[][],
    w0: number,
    w1: number,
    clusters: number,
    size: number,
    spread: number,
    alpha: number,
  ): void {
    const steps = 46;
    const top: Array<[number, number]> = [];
    const bottom: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const a = bezierAt(pts, u);
      const b = bezierAt(pts, Math.min(1, u + 0.012));
      const ax = a[0] * layerWidth;
      const ay = a[1] * layerHeight;
      const dx = b[0] * layerWidth - ax;
      const dy = b[1] * layerHeight - ay;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const w = (w0 + (w1 - w0) * u) * layerHeight;
      top.push([ax + nx * w, ay + ny * w]);
      bottom.push([ax - nx * w, ay - ny * w]);
    }
    target.beginPath();
    target.moveTo(top[0]![0], top[0]![1]);
    for (let i = 1; i < top.length; i++) target.lineTo(top[i]![0], top[i]![1]);
    for (let i = bottom.length - 1; i >= 0; i--) target.lineTo(bottom[i]![0], bottom[i]![1]);
    target.closePath();
    target.globalAlpha = alpha;
    target.fillStyle = palette.bark;
    target.fill();
    target.globalAlpha = 1;

    for (let q = 0; q < clusters; q++) {
      const u = Math.max(0, Math.min(1, (q + 0.5) / clusters + rnd(-0.02, 0.02)));
      const point = bezierAt(pts, u);
      const cx = point[0] * layerWidth;
      const cy = point[1] * layerHeight;
      const petalsInCluster = 2 + Math.floor(Math.random() * 3);
      for (let k = 0; k < petalsInCluster; k++) {
        const off = spread * layerHeight;
        blossomAt(
          target,
          cx + rnd(-off, off),
          cy + rnd(-off, off),
          size * layerHeight * rnd(0.72, 1.25),
          alpha,
        );
      }
    }
  }

  function buildLayers(): void {
    const layerWidth = Math.round(width * (1 + OVERSCAN * 2));
    const layerHeight = Math.round(height * (1 + OVERSCAN * 2));

    const far = document.createElement("canvas");
    far.width = Math.round(layerWidth * dpr);
    far.height = Math.round(layerHeight * dpr);
    const fc = far.getContext("2d");
    if (!fc) return;
    fc.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Dusk plum at night, a pale blush dawn in light mode. Both keep enough
    // separation from the paper cards for the text to stay comfortable.
    const sky = fc.createLinearGradient(0, 0, 0, layerHeight);
    sky.addColorStop(0, palette.skyTop);
    sky.addColorStop(0.52, palette.skyMid);
    sky.addColorStop(1, palette.skyBottom);
    fc.fillStyle = sky;
    fc.fillRect(0, 0, layerWidth, layerHeight);

    const glow = fc.createRadialGradient(
      layerWidth * 0.24,
      layerHeight * 0.2,
      0,
      layerWidth * 0.24,
      layerHeight * 0.2,
      layerHeight * 0.85,
    );
    const [gr, gg, gb] = hexRgb(palette.glow);
    glow.addColorStop(0, `rgba(${gr},${gg},${gb},${dark ? 0.16 : 0.55})`);
    glow.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
    fc.fillStyle = glow;
    fc.fillRect(0, 0, layerWidth, layerHeight);

    drawBranch(
      fc,
      layerWidth,
      layerHeight,
      [
        [-0.06, 0.1],
        [0.3, 0.0],
        [0.66, 0.26],
        [1.06, 0.06],
      ],
      0.011,
      0.003,
      16,
      0.014,
      0.028,
      dark ? 0.4 : 0.5,
    );
    farLayer = far;

    const near = document.createElement("canvas");
    near.width = Math.round(layerWidth * dpr);
    near.height = Math.round(layerHeight * dpr);
    const nc = near.getContext("2d");
    if (!nc) return;
    nc.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawBranch(
      nc,
      layerWidth,
      layerHeight,
      [
        [-0.06, 0.32],
        [0.28, 0.16],
        [0.62, 0.42],
        [1.06, 0.22],
      ],
      0.016,
      0.004,
      19,
      0.019,
      0.036,
      dark ? 0.85 : 0.9,
    );
    drawBranch(
      nc,
      layerWidth,
      layerHeight,
      [
        [-0.06, 0.95],
        [0.26, 1.05],
        [0.6, 0.83],
        [1.06, 0.99],
      ],
      0.022,
      0.006,
      21,
      0.025,
      0.046,
      0.95,
    );
    nearLayer = near;
  }

  function newPetal(fresh: boolean): Petal {
    return {
      x: Math.random() * width,
      y: fresh ? Math.random() * height : -14,
      s: rnd(3.2, 7.4),
      vy: rnd(14, 38),
      vx: rnd(-6, 18),
      rot: Math.random() * 6.2832,
      vr: rnd(-0.7, 0.7),
      ph: Math.random() * 6.2832,
      sway: rnd(0.5, 1.7),
      spin: rnd(0.6, 1.8),
      alpha: rnd(0.45, 0.95),
      tone: Math.floor(Math.random() * 4),
    };
  }

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(rect.width));
    const nextHeight = Math.max(1, Math.round(rect.height));
    // Rebuilding the offscreen layers is the expensive part, so skip it when a
    // ResizeObserver fires without the box actually changing.
    if (nextWidth === width && nextHeight === height && farLayer) return;
    width = nextWidth;
    height = nextHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildLayers();
    petals = [];
    for (let i = 0; i < PETAL_COUNT; i++) petals.push(newPetal(true));
  }

  let last = 0;
  function draw(): void {
    const now = performance.now();
    const dt = last === 0 ? 1 / 60 : Math.min(0.05, (now - last) / 1000);
    last = now;
    time += dt;

    // Ease toward the pointer so the scene glides rather than snapping.
    easedX += (pointerX - easedX) * Math.min(1, dt * 3.2);
    easedY += (pointerY - easedY) * Math.min(1, dt * 3.2);

    const overscanX = width * OVERSCAN;
    const overscanY = height * OVERSCAN;
    const layerWidth = width * (1 + OVERSCAN * 2);
    const layerHeight = height * (1 + OVERSCAN * 2);

    context.clearRect(0, 0, width, height);

    if (farLayer) {
      context.drawImage(
        farLayer,
        -overscanX + easedX * overscanX * FAR_PARALLAX,
        -overscanY + easedY * overscanY * FAR_PARALLAX,
        layerWidth,
        layerHeight,
      );
    }
    if (nearLayer) {
      context.drawImage(
        nearLayer,
        -overscanX + easedX * overscanX * NEAR_PARALLAX,
        -overscanY + easedY * overscanY * NEAR_PARALLAX,
        layerWidth,
        layerHeight,
      );
    }

    const tones = palette.petals;
    const petalShiftX = easedX * overscanX * PETAL_PARALLAX;
    const petalShiftY = easedY * overscanY * PETAL_PARALLAX;
    for (let i = 0; i < petals.length; i++) {
      const petal = petals[i]!;
      petal.y += petal.vy * dt;
      petal.x += (petal.vx + Math.sin(time * 0.8 + petal.ph) * petal.sway * 9) * dt;
      petal.rot += petal.vr * dt;
      if (petal.y > height + 16) {
        petals[i] = newPetal(false);
        continue;
      }
      if (petal.x < -20) petal.x = width + 16;
      else if (petal.x > width + 20) petal.x = -16;

      // Scaling y by a cosine reads as the petal turning over as it falls.
      const flip = Math.cos(time * petal.spin + petal.ph);
      context.save();
      context.translate(petal.x + petalShiftX, petal.y + petalShiftY);
      context.rotate(petal.rot);
      context.scale(1, Math.max(0.16, Math.abs(flip)));
      context.globalAlpha = petal.alpha * (0.55 + Math.abs(flip) * 0.45);
      petalPath(context, petal.s);
      context.fillStyle = tones[petal.tone % tones.length]!;
      context.fill();
      context.restore();
    }
    context.globalAlpha = 1;

    // Ground haze last, so petals settle into it rather than over it.
    const haze = context.createLinearGradient(0, height * 0.72, 0, height);
    const [hr, hg, hb] = hexRgb(palette.hazeFrom);
    const [tr, tg, tb] = hexRgb(palette.hazeTo);
    haze.addColorStop(0, `rgba(${hr},${hg},${hb},0)`);
    haze.addColorStop(1, `rgba(${tr},${tg},${tb},${dark ? 0.45 : 0.55})`);
    context.fillStyle = haze;
    context.fillRect(0, height * 0.72, width, height * 0.28);
  }

  resize();

  return {
    resize,
    setDark: (value: boolean) => {
      if (value === dark) return;
      dark = value;
      palette = buildPalette(tint, dark);
      buildLayers();
    },
    setTint: (value: string) => {
      if (value === tint) return;
      tint = value;
      palette = buildPalette(tint, dark);
      buildLayers();
    },
    setPointer: (x: number, y: number) => {
      pointerX = Math.max(-1, Math.min(1, x));
      pointerY = Math.max(-1, Math.min(1, y));
    },
    draw,
    dispose: () => {
      farLayer = null;
      nearLayer = null;
      petals = [];
    },
  };
}
