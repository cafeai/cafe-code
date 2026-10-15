import type { VisualizationHostPresentation } from "@cafecode/contracts/visualizationHost";

/** Generated geometry updates must not replay an authored entrance through an
 * unchanged presentation attribute/event. Compare the actual DOM scalars, not
 * a lifetime cache: a source-changed value is restored on the next native hint.
 * Apps retain their existing notifications and acquire no new permission. */
export function applyVisualizationPresentation(
  document: Document,
  window: Window,
  appearance: "light" | "dark",
  value: VisualizationHostPresentation | undefined,
  generated: boolean,
  contextChanged = false,
): void {
  const root = document.documentElement;
  let changed = contextChanged;
  const write = (previous: string, next: string, assign: () => void) => {
    if (!generated || previous !== next) {
      assign();
      changed = true;
    }
  };
  write(root.style.colorScheme, appearance, () => {
    root.style.colorScheme = appearance;
  });
  if (value) {
    write(root.lang, value.locale, () => {
      root.lang = value.locale;
    });
    write(root.dataset.cafeReducedMotion ?? "", String(value.reducedMotion), () => {
      root.dataset.cafeReducedMotion = String(value.reducedMotion);
    });
    write(root.style.getPropertyValue("--cafe-interface-scale"), String(value.scale), () => {
      root.style.setProperty("--cafe-interface-scale", String(value.scale));
    });
    const names = {
      background: "--background",
      foreground: "--foreground",
      muted: "--muted-foreground",
      accent: "--accent",
      accentForeground: "--accent-foreground",
      chart1: "--chart-1",
      chart2: "--chart-2",
      chart3: "--chart-3",
      chart4: "--chart-4",
      chart5: "--chart-5",
      chart6: "--chart-6",
    } as const;
    for (const key of Object.keys(names) as (keyof typeof names)[]) {
      const name = names[key],
        next = value.colors[key];
      write(root.style.getPropertyValue(name), next, () => {
        root.style.setProperty(name, next);
      });
    }
  }
  if (!generated || changed)
    window.dispatchEvent(
      new CustomEvent("cafe-presentation-changed", { detail: { appearance, presentation: value } }),
    );
}

/** A private native generated-viewer paint hint, never a source postMessage or
 * execution/ownership claim. External Apps and previews do not receive it.
 * Keep the old logical visibility attribute/event untouched so an older chart
 * does not replay its entrance when a positive crop/menu briefly hides pixels. */
export function applyVisualizationPaintVisibility(
  document: Document,
  window: Window,
  raw: unknown,
  generatedViewer: boolean,
): boolean {
  if (!generatedViewer || typeof raw !== "object" || raw === null || Array.isArray(raw))
    return false;
  const value = raw as { kind?: unknown; visible?: unknown };
  if (
    Object.keys(value).length !== 2 ||
    value.kind !== "presentation-visibility" ||
    typeof value.visible !== "boolean"
  )
    return false;
  const root = document.documentElement;
  const next = String(value.visible);
  if (root.dataset.cafePresentationVisible !== next) {
    root.dataset.cafePresentationVisible = next;
    window.dispatchEvent(
      new CustomEvent("cafe-presentation-visibility-changed", {
        detail: { visible: value.visible },
      }),
    );
  }
  return true;
}

/** Exact semantic tooltips only: preserve authored placement/content/hidden
 * state while making their surface legible in both native presentation themes.
 * This is wrapper CSS, never a stored-source/poster mutation or broad selector. */
export const GENERATED_VISUALIZATION_TOOLTIP_STYLE =
  '[role="tooltip"],[data-cafe-tooltip]{background:var(--background)!important;color:var(--foreground)!important;border:1px solid color-mix(in srgb,var(--foreground) 18%,transparent)!important;color-scheme:inherit}';
