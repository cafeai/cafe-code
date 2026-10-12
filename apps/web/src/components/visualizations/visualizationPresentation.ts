import type { UiLocale } from "@cafecode/shared/i18n";
import type { VisualizationHostPresentation } from "@cafecode/contracts/visualizationHost";

const COLOR =
  /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([0-9a-z.% ,+/-]+\))$/i;
const CHART_DEFAULTS = ["#0891b2", "#7c3aed", "#db2777", "#ca8a04", "#4f46e5", "#059669"] as const;

/** Read only fixed presentation tokens from Cafe's trusted document. A token
 * never becomes arbitrary CSS, an asset selector or an App/server capability.
 * The interactive guest can override its own styles, not the parent shell. */
export function visualizationPresentation(locale: UiLocale): VisualizationHostPresentation {
  const styles = getComputedStyle(document.documentElement);
  const readColor = (name: string, fallback: string) => {
    const value = styles.getPropertyValue(name).trim();
    return value.length <= 96 && COLOR.test(value) && CSS.supports("color", value)
      ? value
      : fallback;
  };
  const dark = document.documentElement.classList.contains("dark");
  const scale = Number.parseFloat(styles.fontSize) / 16;
  return {
    locale,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    scale: Number.isFinite(scale) ? Math.min(2, Math.max(0.5, scale)) : 1,
    colors: {
      background: readColor("--background", dark ? "#171717" : "#ffffff"),
      foreground: readColor("--foreground", dark ? "#fafafa" : "#171717"),
      muted: readColor("--muted-foreground", dark ? "#a3a3a3" : "#525252"),
      // Primary is the selected action/accent colour; --accent is a neutral
      // hover surface in Cafe and must not silently replace the user's colour.
      accent: readColor("--primary", "#0891b2"),
      accentForeground: readColor("--primary-foreground", "#ffffff"),
      chart1: readColor("--chart-1", CHART_DEFAULTS[0]),
      chart2: readColor("--chart-2", CHART_DEFAULTS[1]),
      chart3: readColor("--chart-3", CHART_DEFAULTS[2]),
      chart4: readColor("--chart-4", CHART_DEFAULTS[3]),
      chart5: readColor("--chart-5", CHART_DEFAULTS[4]),
      chart6: readColor("--chart-6", CHART_DEFAULTS[5]),
    },
  };
}
