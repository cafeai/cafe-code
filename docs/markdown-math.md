# Markdown math in chat

Created: 2026-10-15 02:12:55 JST (UTC+0900)

Last updated: 2026-10-15 03:28:22 JST (UTC+0900)

## Rendering and source boundaries

`apps/web/src/components/ChatMarkdown.tsx` renders received Markdown through
ReactMarkdown, `remarkChatMath` and `rehype-katex`. The math-only normalization in
`apps/web/src/lib/chatMarkdownMath.ts` handles supported provider spellings before
Markdown parsing; it does not rewrite the persisted message.

Supported spellings include `$...$`, `$$...$$`, `\(...\)` and `\[...\]`, plus
closed equation-only `math`, `tex` or `latex` fences. A LaTeX document fragment,
mixed prose, theorem environment or unterminated fence remains literal code.
Normalization preserves code spans, non-math fences, Markdown links, Mermaid
source and list/blockquote continuation indentation. Currency is distinguished
from inline math at the tokenizer boundary. The existing narrowly scoped
`\texttt` underscore repair applies only inside recognized math.

KaTeX stays configured with `trust: false`, `strict: false` and
`throwOnError: false`. Unsupported trusted HTML-style extensions must not create
HTML classes, links or executable content, and malformed formulas remain a
contained visible error rather than crashing or consuming following prose.
Equation labels are inert rendered math; CSS must not turn them into navigation
or execution capabilities.

MathML annotations retain the equation source for accessibility. Complete-message
Markdown copy uses the shared existing normalization policy; plain-text selection
retains native visible-text copy. Display layout must not strip `\tag`, change
the stored source, replace the annotation or alter literal code-fence copy.

## Display layout and equation tags

`apps/web/src/index.css` gives each display equation its own horizontal scroll
viewport. Its intrinsic-width KaTeX child keeps wide formulas out of the message
column's width calculation. Ordinary prose keeps its separate emergency wrapping
policy, and table math stays inside the table's local scroll viewport.

Native KaTeX places a direct display `.katex-tag` absolutely at the right edge of a
full-width equation box. That assumption is incompatible with chat's
intrinsic-width equation: the tag's width is excluded from the box, so a label
such as `(MX-1)` paints over the formula's final terms. The issue was reproduced
with both a boxed inequality and a later atomic-sector bound using their explicit
`\tag{MX-1}` and `\tag{MX-2}` source. Untagged subscript examples did not reproduce
the overlap; no prose-wrap or font-version cause was established.

Only a direct display tag now participates in ordinary inline flow, separated
from the equation by an `em`-scaled gap. The equation and label contribute to the
same scrollable width. KaTeX's native tag strut and baseline remain intact;
untagged formulas, internal aligned/array positioning and the accessibility
MathML copy are not relaid out. A long label therefore scrolls with its equation
instead of overlaying it or widening the chat timeline. `\tag*` preserves its
explicit unparenthesized label.

## Qualification

The renderer regression file is
`apps/web/src/components/ChatMarkdown.browser.tsx`. It loads the actual local
KaTeX faces before checking native glyph and element geometry; a font-family
string or mocked text measurement is not layout evidence. Tagged checks compare
the visible direct `.base` rectangles with the label rectangle in wide and narrow
layouts, light/dark themes and interface-scale bounds. They retain exact source
annotations, literal code, message-local overflow and untagged/table controls.
Additional cases cover long unnumbered labels, multiline aligned equations,
untrusted tag extensions and malformed-math containment.

Run the focused renderer checks through the repository-pinned Node and Yarn:

```sh
corepack yarn workspace @cafecode/web test:browser --project desktop src/components/ChatMarkdown.browser.tsx
```

Math normalization/tokenizer checks are in `chatMarkdownMath.test.ts` and
`remarkChatMath.test.ts`. Keep the existing native browser input/context ownership,
worker caps and deadlines. Synthetic local Chromium layout evidence does not
qualify another host's native font/rendering stack; hosted platform checks remain
separate. Repository-wide formatting, lint, typecheck, default/applicable browser
tests and the forced desktop build remain required for publication, with the
desktop build last.
