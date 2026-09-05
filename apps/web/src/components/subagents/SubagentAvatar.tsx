import type { SVGProps } from "react";
import { cn } from "~/lib/utils";

const MAX_HASH_INPUT_CODE_UNITS = 512;

type AvatarPalette = {
  petals: readonly [string, string, string];
  center: string;
  core: string;
  outline: string;
};

const PALETTES: readonly [AvatarPalette, ...AvatarPalette[]] = [
  {
    petals: ["#22d3ee", "#0891b2", "#67e8f9"],
    center: "#ecfeff",
    core: "#155e75",
    outline: "#164e63",
  },
  {
    petals: ["#c084fc", "#7c3aed", "#e9d5ff"],
    center: "#faf5ff",
    core: "#5b21b6",
    outline: "#4c1d95",
  },
  {
    petals: ["#f472b6", "#db2777", "#fbcfe8"],
    center: "#fdf2f8",
    core: "#9d174d",
    outline: "#831843",
  },
  {
    petals: ["#fbbf24", "#ea580c", "#fde68a"],
    center: "#fffbeb",
    core: "#9a3412",
    outline: "#7c2d12",
  },
  {
    petals: ["#818cf8", "#4f46e5", "#c7d2fe"],
    center: "#eef2ff",
    core: "#3730a3",
    outline: "#312e81",
  },
  {
    petals: ["#34d399", "#059669", "#a7f3d0"],
    center: "#ecfdf5",
    core: "#065f46",
    outline: "#064e3b",
  },
] as const;

const PETAL_COUNTS: readonly [number, ...number[]] = [5, 6, 7, 8];

type PetalShape = "ellipse" | "round" | "tapered";

const PETAL_SHAPES: readonly [PetalShape, ...PetalShape[]] = ["ellipse", "round", "tapered"];

function selectVariant<T>(variants: readonly [T, ...T[]], value: number): T {
  return variants[value % variants.length] ?? variants[0];
}

/**
 * Hashes an opaque provider identity without exposing it in the rendered DOM.
 *
 * Provider data can be adversarial or unexpectedly large. Sampling a bounded prefix and suffix
 * keeps render cost predictable while incorporating the original length so long identifiers with
 * a shared prefix do not all collapse to the same visual identity. FNV-1a is used only for stable
 * visual selection; it is deliberately not treated as a security or authentication primitive.
 */
function hashAvatarSeed(seed: string): number {
  const boundedSeed =
    seed.length <= MAX_HASH_INPUT_CODE_UNITS
      ? seed
      : `${seed.slice(0, MAX_HASH_INPUT_CODE_UNITS / 2)}:${seed.length}:${seed.slice(
          -(MAX_HASH_INPUT_CODE_UNITS / 2),
        )}`;

  let hash = 0x811c9dc5;
  for (let index = 0; index < boundedSeed.length; index += 1) {
    hash ^= boundedSeed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  // A final avalanche prevents short, similarly prefixed thread ids from clustering visually.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function renderPetal(shape: PetalShape, color: string, transform: string, index: number) {
  const sharedProps = {
    fill: color,
    stroke: "currentColor",
    strokeWidth: 0.7,
    transform,
  };

  switch (shape) {
    case "round":
      return <circle key={index} {...sharedProps} cx="24" cy="12.5" r="7.2" />;
    case "tapered":
      return (
        <path
          key={index}
          {...sharedProps}
          d="M24 24C19.1 20.5 17.1 14.3 19.5 9.2C21.7 4.7 26.3 4.7 28.5 9.2C30.9 14.3 28.9 20.5 24 24Z"
        />
      );
    case "ellipse":
      return <ellipse key={index} {...sharedProps} cx="24" cy="13" rx="6.2" ry="10.2" />;
  }
}

export type SubagentAvatarProps = Omit<
  SVGProps<SVGSVGElement>,
  "aria-hidden" | "aria-label" | "children" | "dangerouslySetInnerHTML" | "role" | "viewBox"
> & {
  /** Stable provider thread id (or an equivalently stable sub-agent identity). */
  seed: string;
  /** When provided, exposes the avatar as an image with this accessible name. */
  label?: string;
};

/**
 * A deterministic, code-native identity mark for a provider sub-agent.
 *
 * The artwork is assembled from local SVG primitives, so rendering never fetches a provider- or
 * user-controlled URL. The seed affects only bounded numeric/color choices and is not copied into
 * markup. This lets chat and Atrium reuse the same recognizable identity without turning opaque
 * provider thread ids into visible DOM data.
 */
export function SubagentAvatar({ seed, label, className, ...svgProps }: SubagentAvatarProps) {
  const hash = hashAvatarSeed(seed);
  const paletteIndex = hash % PALETTES.length;
  const palette = selectVariant(PALETTES, paletteIndex);
  const petalCount = selectVariant(PETAL_COUNTS, hash >>> 5);
  const shapeIndex = (hash >>> 11) % PETAL_SHAPES.length;
  const shape = selectVariant(PETAL_SHAPES, shapeIndex);
  const rotationOffset = (hash >>> 17) % Math.max(1, Math.floor(360 / petalCount));
  const colorOffset = (hash >>> 23) % palette.petals.length;
  const accessibleLabel = label?.trim();
  const accessibilityProps = accessibleLabel
    ? ({ "aria-label": accessibleLabel, role: "img" } as const)
    : ({ "aria-hidden": true, role: "presentation" } as const);

  return (
    <svg
      {...svgProps}
      {...accessibilityProps}
      className={cn("size-8 shrink-0 overflow-visible", className)}
      data-cafe-subagent-avatar="true"
      data-palette={paletteIndex}
      data-petal-shape={shape}
      fill="none"
      focusable="false"
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="24" cy="24" fill={palette.petals[0]} opacity="0.12" r="21.25" />
      <g color={palette.outline} opacity="0.92">
        {Array.from({ length: petalCount }, (_, index) => {
          const angle = rotationOffset + (360 / petalCount) * index;
          const color = selectVariant(palette.petals, index + colorOffset);
          return renderPetal(shape, color, `rotate(${angle} 24 24)`, index);
        })}
      </g>
      <circle
        cx="24"
        cy="24"
        fill={palette.center}
        r="7.2"
        stroke={palette.outline}
        strokeWidth="0.9"
      />
      <circle cx="24" cy="24" fill={palette.core} opacity="0.88" r="3.35" />
      <circle cx="22.8" cy="22.7" fill="#ffffff" opacity="0.66" r="1.05" />
    </svg>
  );
}
