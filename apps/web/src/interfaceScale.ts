import {
  DEFAULT_INTERFACE_SCALE_PERCENT,
  MAX_INTERFACE_SCALE_PERCENT,
  MIN_INTERFACE_SCALE_PERCENT,
} from "@cafecode/contracts/settings";

const ROOT_FONT_SIZE_PROPERTY = "font-size";

export function normalizeInterfaceScalePercent(value: number | undefined): number | undefined {
  if (
    value === undefined ||
    !Number.isInteger(value) ||
    value < MIN_INTERFACE_SCALE_PERCENT ||
    value > MAX_INTERFACE_SCALE_PERCENT
  ) {
    return undefined;
  }

  return value;
}

/** One press of Settings → Appearance → Interface size −/+. */
export const INTERFACE_SCALE_STEP_PERCENT = 5;

/** The next size up or down, snapped to the step and kept within bounds. */
export function stepInterfaceScalePercent(value: number, direction: -1 | 1): number {
  return snapInterfaceScalePercent(value + direction * INTERFACE_SCALE_STEP_PERCENT);
}

export function snapInterfaceScalePercent(value: number): number {
  const bounded = Math.min(
    MAX_INTERFACE_SCALE_PERCENT,
    Math.max(MIN_INTERFACE_SCALE_PERCENT, value),
  );
  return Math.round(bounded / INTERFACE_SCALE_STEP_PERCENT) * INTERFACE_SCALE_STEP_PERCENT;
}

/**
 * Scale the root rem unit rather than rewriting individual component sizes.
 * Cafe's typography, controls, spacing, and icons predominantly use rem-based
 * utilities, so one bounded root value keeps the interface internally
 * proportional. The default removes the inline declaration and gives browser
 * and stylesheet defaults full authority again.
 */
export function applyInterfaceScalePercent(value: number | undefined): void {
  if (typeof document === "undefined") {
    return;
  }

  const scalePercent = normalizeInterfaceScalePercent(value);
  if (scalePercent === undefined || scalePercent === DEFAULT_INTERFACE_SCALE_PERCENT) {
    document.documentElement.style.removeProperty(ROOT_FONT_SIZE_PROPERTY);
    return;
  }

  document.documentElement.style.setProperty(ROOT_FONT_SIZE_PROPERTY, `${scalePercent}%`);
}
