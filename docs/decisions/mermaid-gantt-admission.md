# Decision: bounded Mermaid Gantt admission

Decision status: Accepted
Created: 2026-10-11 23:36:08 JST (UTC+0900)
Last updated: 2026-10-12 00:01:04 JST (UTC+0900)
Decision authority: implementation choices within the human's explicit request to render the supplied Gantt schedule and push the verified feature to dev.
Implementation status: Implemented; focused real-renderer, source/clipboard, controls/export and pre-resolution checks pass. PNG task-paint checks include stripped-bar negative controls in both themes. Repository checks and the forced desktop build gate delivery; hosted platform artifacts are a separate release qualification.
Supersedes: None. Supplements the accepted [isolated rendering](mermaid-rendering.md) and [XY/pie admission](mermaid-chart-admission.md) decisions without changing their trust boundaries or historical rationale.

## Context and alternatives

The locked Mermaid Tiny 12.0.0 bundle already includes Gantt. Cafe's source-family
allowlist and parsed-type switch excluded it. Adding only the type would be
unsafe: the native `getTasks()` accessor compiles dates and dependencies, and
calendar exclusions can enter day-by-day correction loops before SVG layout.
Custom d3 calendar intervals may reset fields each month or year, so elapsed
span divided by the requested multiplier is not a valid tick-work bound.

Use the existing engine and shared diagram UI, with a fail-closed admission
adapter. A dependency upgrade, second renderer or remote service is unnecessary.
Widening SVG CSS for milestones would change an independent security decision;
silently drawing them as squares would instead lose semantic fidelity. Keep
those constructs as literal source until separately qualified.

## Decision and data contracts

The opaque runtime first scans the bounded source for the admitted native task
grammar, without rewriting it. It tracks native generated IDs, unique sections,
status tags and earlier task references. Duplicate/reserved prototype identities,
numeric section names that the engine can reorder, repeated tags,
missing/forward/cyclic references, unsupported metadata and
calendar exclusions/includes fail before native date resolution.

After the real parser runs, bind every task to `findTaskById()` and its exact raw
start/end data, preceding identity, section, order and flags. Validate native
section and empty link/class collections plus date/axis/tick/marker metadata;
unknown or sparse parsed contracts do not represent an empty/safe chart.
Independently predict strict Gregorian starts, local calendar day/week addition,
elapsed shorter durations, earlier `after`/`until` references and inclusive ends.
Only then call `getTasks()`, checking the same native object identities and exact
finite predicted dates before allowing layout. An engine change must requalify
this contract rather than guessing corrected dates.

Authored dates use `YYYY-MM-DD` in years 1000–9999. Explicit end dates require an explicit
`dateFormat YYYY-MM-DD`; absent format retains Tiny's ISO-start UTC fallback.
Positive integer week/day/hour/minute/second/millisecond durations are bounded,
as is the complete elapsed schedule domain. Default adaptive axis selection and
custom calendar work are bounded before tick allocation. Custom interval
multipliers are themselves bounded because filtered native week intervals can
walk to a count multiple. Tasks, sections and tick work share the existing item
budget; all predecessor references share the existing connection budget.
Canonical constants and checks live in `sandboxRuntime.js` and `policy.ts`.

Ordinary bars and section labels fit the unchanged SVG allowlist. Native
milestone CSS transforms, top axes, calendar exclusion/include lists, custom
marker styles and unqualified formats remain source. Omitted today markers and
the inert `off` switch retain native behavior. No callbacks are bound.

## Security, privacy and compatibility

No dependency, provider action, persisted schema, transcript migration or new
capability is introduced. The cache identity advances to prevent older policy
results from crossing admission versions. Source/output/graph/queue/cache limits,
nonce CSP, opaque origin, one-use ports, content-free errors and independent
SVG sanitization remain unchanged. Output remains an inert local image.

Conservative admission may refuse valid exotic Mermaid syntax. The existing
asynchronous deadline is not a hard synchronous CPU guarantee; source bounds
and pre-resolution checks reduce work but do not establish real-time isolation.
Old messages render on reopening in the rebuilt app, never by rewriting history.

## Verification and replay

See [Mermaid diagrams](../mermaid-diagrams.md) for supported syntax, limits and
pinned Node/Corepack Yarn replay commands. Tests cover the supplied 11-task,
three-section schedule with exact multi-predecessor dates, decoded light/dark
images, literal Source/Copy, expanded controls, narrow/scale/reduced-motion
layouts and complete PNG task pixels. Real-parser admission fixtures exercise
invalid dates, identities, dependencies, tick/loop bounds and unfamiliar parsed
contracts before the layout sentinel; existing SVG/CSP and other families remain.

These credential-free renderer fixtures run in the existing macOS/Windows
subset and Linux full browser suite with unchanged workers and deadlines.
Local Chromium does not qualify native Windows/Linux or packaged application
smoke. All repository gates and the forced desktop build LAST gate delivery;
exact-head hosted checks and release artifacts qualify the later release.
