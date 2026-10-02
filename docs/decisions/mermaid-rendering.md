# Decision: isolated Mermaid rendering with inert image output

Decision status: Accepted
Created: 2026-10-03 07:02:36 JST (UTC+0900)
Last updated: 2026-10-03 07:15:35 JST (UTC+0900)
Decision authority: implementation choices within the user's approved Mermaid design and explicit request to implement and push dev.
Implementation status: Implemented. Independent review and local Chromium checks cover the real renderer, security boundary, UI and Markdown integration. Repository checks and a forced desktop build gate publication; replay commands are linked below.
Supersedes: None. Existing Markdown math, file-link and clipboard policies remain in force.

## Context and alternatives

Provider-generated diagram source is untrusted. Rendering it in the main React
document would give parser/layout/HTML-label defects access to app DOM and local
desktop capabilities. A remote rendering service would disclose transcript
content and introduce availability and privacy dependencies. Mermaid needs DOM
measurement, so an ordinary Worker is not a drop-in rendering environment.

Use an ephemeral opaque-origin iframe and a fully bundled Mermaid Tiny IIFE,
followed by independent SVG validation and an inert image presentation. The tiny
distribution supplies the qualified families without dynamic network-loaded
diagram engines. Exact dependency and integrity pins live in the web manifest
and Yarn lock. The initial 12.0.0 pin meets dependency age admission; the newer
12.1.0 release was still quarantined during implementation. Upgrades are deliberate
and require requalification, not permanent version freezes.

## Data flow and responsibilities

`remarkMermaid` observes actual parser closing-fence tokens and hands the exact
DSL plus completion state to `MermaidBlock`. `chatMarkdownMermaid` protects these
parser-owned ranges from math/citation display and copy normalization. Stable
Markdown pre/list renderers preserve local view state across streamed prose.

`renderService` admits bounded source, deduplicates exact source/theme/version/
policy identities, serializes jobs, and maintains a bounded memory-only cache
(including content-free failures). `sandboxDocument` lazily loads only the locked
local IIFE and fixed runtime into a nonce-protected srcdoc. A one-use transferred
MessagePort belongs to one iframe/job; responses must match the request identity.
The runtime checks source/config and parsed graph size before layout. There is
no document-wide Mermaid scan, callback binding, provider API, or persisted
derived diagram. Components ignore stale results and own/revoke their blob URLs.

`sanitizeSvg` uses an independently pinned DOMPurify plus an explicit SVG element,
attribute and style-property policy. It rejects entities, invalid geometry,
external/disguised CSS resources and oversized output; drops active content and
animation; and serializes an SVG that is used only as a blob-backed image.
Shiki's sanitizer remains restricted to code markup. The toolbar and accessible
expanded dialog are ordinary Cafe UI outside the rendering sandbox.

## Security, privacy and failure consequences

The iframe grants scripts but not same-origin, storage, popups, forms, or top-level
navigation. Its CSP denies subresources, connections, fonts, child frames and
objects; script execution requires the generated nonce. Parent credentials,
storage, app DOM and desktop bridge are not available. Desktop preload now
explicitly exposes the bridge only in the main frame, alongside the existing
top-frame IPC authorization and explicit no-subframe-Node preference.

Mermaid remains configured strict with HTML labels disabled. Source configuration,
click/link directives and image nodes are refused. Parser output/errors are never
logged or sent to app diagnostics; fixed failure text and original copyable source
are used instead. The sandbox suppresses library console/error reporting before
the library loads. Clipboard use happens only on the user's Copy action through
Cafe's existing clipboard boundary.

This is defense in depth, not an arbitrary-code containment proof. A compromised
dependency executing JavaScript could navigate its own sandboxed iframe; ordinary
CSP does not universally block such self-navigation. The sandbox denies access to
parent secrets and final images are inert, but a hypothetical dependency compromise
could expose the diagram it was given. Keep the locked library audited and updated.
Likewise, the iframe is not guaranteed a separate CPU process: a deadline cannot
interrupt synchronous layout. Pre-layout input/graph bounds and serialized work
limit ordinary resource use, but do not establish a hard real-time guarantee.

## Compatibility and verification

No provider lifecycle, token accounting, OS launcher or persisted transcript
schema changes. macOS/Linux/Windows and browser clients share the same renderer;
unknown browser features fail to source. Existing Desk panes retain their own
bounded preview/expanded view, while sharing the window's renderer queue/cache.

Unit tests exercise fence grammar, nested literal preservation, copy, cache
identity/eviction, scheduling and limits. Browser tests use the real local bundle
for all qualified families, sample graph, accessible labels, image decoding,
source fallback, malicious SVG/CSS, opaque-origin isolation, interactive controls,
theme/scale, and stale-result/cleanup paths. Desktop fixtures verify main-frame
capability isolation. CI runs the focused diagram browser suites across operating
systems; local macOS Chromium evidence is not native Linux/Windows qualification.
The local full browser suite passed 717 cases, including a real 240-node layout;
this exercises substantial admitted work without asserting a machine-dependent
timing guarantee. Graph-boundary fixtures also verify synthesized nodes, nested
containers, notes, participant boxes and expanded relations before layout.
See [Mermaid diagrams](../mermaid-diagrams.md) for user behavior and replay commands.
