/** The exact offline chat families from apps/web/src/index.css. Keep this small
 * policy module independent of the binary payload: ordinary renderer imports
 * must not retain four font files merely to present a font-family declaration. */
export const CHAT_SANS_FONT_FAMILY =
  '"DM Sans Variable", "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
export const CHAT_MONO_FONT_FAMILY =
  '"SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace';

/** Fixed generated-only family policy. Native main installs this at user origin
 * so an author-important SVG axis cannot replace the chat face. Hard-code the
 * admitted families in these declarations rather than resolving an author-
 * replaceable custom property. Tokens remain useful to cooperative canvas/chart
 * authors. This changes no font size, weight, style, layout or drawing API.
 * Semantic code/raw details retain the chat's exact monospace fallback chain. */
export const GENERATED_VISUALIZATION_FONT_FAMILY_STYLE =
  `:root{--font-sans:${CHAT_SANS_FONT_FAMILY};--font-mono:${CHAT_MONO_FONT_FAMILY}}` +
  `body,body *{font-family:${CHAT_SANS_FONT_FAMILY}!important}` +
  `pre,code,kbd,samp,pre *,code *,kbd *,samp *{font-family:${CHAT_MONO_FONT_FAMILY}!important}`;
