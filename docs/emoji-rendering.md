# Emoji rendering in chat

Created: 2026-10-30 01:14:54 JST (UTC+0900)
Last updated: 2026-10-30 01:14:54 JST (UTC+0900)

Emoji remain Unicode text in messages, Markdown, storage and copy operations.
Their appearance is supplied by the renderer's font fallback. Main chat uses
the normal bundled DM Sans and platform text families first, then the local
`Cafe Emoji` face before the generic fallback. Semantic code retains its normal
monospace families before the same emoji fallback.

The bundled face is the exact WOFF2 from
`@fontsource/noto-color-emoji@5.3.2`, licensed under OFL-1.1. The font contains
COLR/CPAL vector glyphs and is served from Cafe's own built assets. It makes no
font-CDN requests and does not install a system font. The complete copyright and
licence are retained at `public/licenses/noto-color-emoji-OFL.txt` in the web app
and copied into its built assets. Normal text families precede this face so
ordinary text symbols keep their presentation; explicit text/emoji variation
selectors and joined sequences must remain intact.

This avoids dependence on the Apple bitmap-emoji path affected by the
[Chromium Lockdown Mode issue](https://issues.chromium.org/issues/403993360).
The compatibility workaround changes neither Lockdown Mode nor Chromium's
sandbox, entitlements, permissions or image-service access. It does not use a
missing glyph as permission to relax security settings.

The reported seven-heart sentence reproduced as blank glyphs in an isolated,
sandboxed native Electron window using the compiled chat CSS, while its exact
DOM text and Apple Color Emoji font selection remained present. A local vector
face rendered the hearts and joined emoji; the late fallback position preserved
English/Japanese text, ordinary arrows and explicit text-style heart rendering.
The browser regression separately checks text preservation and actual colored
ink after the bundled face loads. These are content-readability checks rather
than fixed glyph-shape or typography-coordinate snapshots.

Generated visualizations, Mermaid/SVG and portable exports have separate font
loading and output limits. Their existing four-face DM Sans payload is unchanged;
main-chat qualification does not attest emoji in those surfaces. An affected
installed runtime needs a renderer rebuild/update and reload to use this font;
an ordinary source pull alone does not update already-compiled assets.
