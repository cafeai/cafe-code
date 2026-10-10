# Decision: bounded Mermaid XY and pie admission

Decision status: Accepted
Created: 2026-10-08 13:47:35 JST (UTC+0900)
Last updated: 2026-10-08 13:53:33 JST (UTC+0900)
Decision authority: implementation choices within the user's explicit request to render XY/pie charts, fix the failing flowchart and publish the verified changes.
Implementation status: Implemented. Focused real-renderer, parsed-admission and control fixtures qualify the chart/flowchart paths; repository checks and the final forced desktop build gate publication. Replay commands and evidence boundaries are linked below.
Supersedes: None. Supplements the accepted [isolated Mermaid rendering decision](mermaid-rendering.md) with two additional parsed-data contracts; its trust boundaries and historical rationale remain unchanged.

## Context and alternatives

The locked Mermaid Tiny build already includes XY and pie engines. Cafe's source
family allowlist and parsed-type switch previously refused them. Merely adding
type names would bypass graph budgets: categories, plot series, retained labels
and small pie entries still drive layout, and finite data alone does not ensure
finite axis ticks or pie angles. A dependency upgrade or separate chart library
is unnecessary; remote rendering would disclose source. Preserve the existing
opaque sandbox and inert-image UI, with explicit fail-closed admission adapters.

## Decision and contracts

Use the existing exact dependency pins and version the cache policy in
`apps/web/src/lib/mermaid/policy.ts`. `sandboxRuntime.js` admits only the pinned
`getXYChartData()` band/linear axis and bar/line tuple shapes, or pie's
`getSections()` Map plus Boolean `getShowData()`. Unknown kinds, non-string labels,
sparse arrays and malformed tuples are not evidence of an empty/small chart.

XY categories or default numeric axis ticks plus series consume the existing
node budget. Aggregate plot points and aggregate original point-label entries
each consume the connection budget. The database truncates excess band values,
but may retain the original line-label array; count that array independently.
Categorical keys must belong to the final category domain, numeric X positions
and Y values to the final finite numeric domains. Empty plots, missing values,
overflowing spans and unsafe subnormal tick calculations are refused. An
allocation-free mirror of the pinned d3-array default ten-tick calculation
validates a positive bounded tick count and finite coordinates before layout.
Equal finite endpoints retain the engine's one-tick behavior.

Pie counts every section, not just visible arcs. Values must be finite and
nonnegative with a positive finite total. The pinned engine hides slices below
1% before computing its angular multiplier, while retaining their legend
entries. Validate the visible sum and multiplier too; zero/empty/tiny unsafe
totals fall back to source rather than entering layout.

Flowchart's grammar has no standalone `link`/`links` directive: `LINK` is a valid
node ID. The source scanner's exception is limited to flowchart headers and the
runtime separately checks the actual parsed type. Other families retain the
existing case-insensitive link/links ban, including class and sequence commands;
the click/config/image bans remain unchanged. Quoted `<br/>` labels use the
engine's SVG text mode, never enabled HTML labels.

## Security, privacy and compatibility consequences

No new capability, dependency, provider call, persisted schema or transcript
migration. The nonce CSP, single-use ports, source/output/queue/cache limits,
content-free failures, independent SVG sanitizer and image-only presentation
remain in force. Old source-only chart messages can render when reopened in the
rebuilt app. Diagram/Source, literal Copy and fullscreen Fit/Reset/zoom/panning
use the existing shared components and themes.

Bounds apply to admitted parsed layout, not a proof of parser CPU or hard
real-time isolation. The existing source limit bounds parser input; synchronous
work cannot be preempted by the asynchronous deadline. Conservative admission
can refuse extreme otherwise parseable numeric data. No sanitizer weakening,
callback binding, source rewriting or guessed chart values is authorized.

## Implementation and verification

See [Mermaid diagrams](../mermaid-diagrams.md) for behavior and replay commands.
Unit/source tests, real local-bundle browser geometry/image-decoding tests,
light/dark/scale/fullscreen controls, and pre-layout sentinel security fixtures
qualify the contracts. Keep legacy graph tests and active SVG/CSP negatives.
Requalify all adapters and the tick mirror on dependency updates. Local Chromium
tests do not establish native Windows/Linux or packaged-app qualification;
cross-platform CI and the final forced desktop build remain publication gates.
