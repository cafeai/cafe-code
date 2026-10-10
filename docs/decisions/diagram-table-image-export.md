# Decision: explicit local PNG export for diagrams and tables

Decision status: Accepted
Created: 2026-10-10 13:04:48 JST (UTC+0900)
Last updated: 2026-10-10 13:33:04 JST (UTC+0900)
Decision authority: implementation choices within the user's explicit request to add image clipboard/disk export and push this changeset to dev.
Implementation status: Implemented. All 54 combined real-browser cases, 46 isolated native cases and two contract cases passed. The final native ownership regression fails without its pre-publication fence and passes with it. Required full repository checks, independent final closure review and the final forced desktop build gate publication.
Supersedes: None. Supplements the [isolated Mermaid rendering](mermaid-rendering.md) and [chart admission](mermaid-chart-admission.md) decisions without changing their policies.

## Context and alternatives

Source copy does not provide a pasteable image. A screenshot of the visible
preview would omit scrolled content and depend on current zoom. A remote renderer
would disclose transcript content. Generic DOM screenshot libraries would add a
dependency and a broad resource-loading/HTML surface. Use the existing admitted
local SVG and a narrowly reconstructed table presentation, rasterized entirely
locally under explicit user action. No new dependency or provider call is needed.

## Decision and responsibilities

`ImageExportMenu` supplies one shared themed, accessible three-dot menu, inline
and expanded: Copy image and Save as PNG. Existing source/fit/zoom/pan controls
remain unchanged. Clipboard success gets the user's requested brief toast; saves
and cancellation are silent. Fixed failures disclose no source or destination.

`imageExport` independently re-admits Mermaid through the existing SVG sanitizer
and rejects external/active resources before image decode. It makes a complete,
opaque PNG in the exact ready result's theme. The ready theme must match before
the menu can export; changing source/theme cancels pending preparation. Intrinsic
dimensions, not viewport or zoom, determine the output. Uniform downscaling
enforces the canonical axis/area/byte bounds in
`packages/contracts/src/imageExport.ts`, including the SVG image's own decode
viewport. The asynchronous decode deadline is not a hard CPU/preemption proof.

`tableImageExport` rebuilds an explicit HTML/SVG and computed presentation
allowlist, not a generic live DOM clone. It waits for local fonts before measuring
the complete unscaled table, preserves rendered math/formatting, and embeds only
used reviewed bundled font families. Anchors retain labels but no URLs/actions.
Already decoded origin-clean image pixels can be embedded under aggregate budgets;
unreadable arbitrary images fail. Exact app-owned decorative file icons substitute
local File/Folder geometry without a new CDN request. Unsupported/generated
presentation is rejected instead of silently omitted. Node, text, presentation,
image and serialized bounds apply before the final shared bitmap budget.

Admitted data SVG images support Chromium's origin-clean foreignObject raster
path; blob SVG foreignObject images taint canvas despite local content. Neither
document is inserted into live app DOM. Embedded PNG/font data are inert resources;
the rasterizer refuses remote references, active tags/handlers and arbitrary CSS
resource loading. Mermaid's stricter no-foreignObject policy is unchanged.

## Clipboard and save authority

Browser image clipboard admission starts within the menu gesture with a promised
PNG, retaining user activation while preparation runs. It never substitutes text
or reads old clipboard contents. Permission/support failures are explicit. Browser
saves use a bounded transient object URL and safe PNG download basename; dispatch
does not prove final OS persistence.

Desktop uses the main-frame-only trusted IPC boundary. `copyPng` and `savePng`
are write-only and admit bounded complete static PNG structure, chunk CRCs and
native decoded dimensions before clipboard or disk access. The renderer proposes
only an inert PNG basename, never a destination path. The native save dialog binds
to the exact requesting document/window, not later focus; only one picker per
window is admitted. The user-selected parent namespace and exclusive temporary
file identity are reverified before write/publication. An owned private temporary
file is flushed then atomically replaces the selected file. Symlink/nonfile or
namespace uncertainty fails closed; uncertain cleanup retains recovery evidence.

Preparation and feedback are source-owned, single-flight and abortable. Once
native picker admission occurs, the explicit action owns its frozen snapshot
until save/cancel; it never adopts a later source. Closing or navigating its
requesting document revokes pending save authority. OS path checks are defensive
identity observations; ownership is rechecked immediately before publication,
including after the final awaited namespace observations. The path checks are
not proof against a privileged adversary mutating a
namespace between the final observation and path-based OS rename.

## Compatibility and evidence

Shared renderer behavior is the same across desktop hosts and ordinary browsers.
Host-specific filesystem qualification is recorded in AGENTS.md's Windows section.
No provider lifecycle, account ownership, credentials, transcripts, settings or
live database changes. Normal rebuilt app adoption is needed for the new bridge;
no automatic restart or live repair is implied.

Real browser fixtures cover all seven Mermaid families, light/dark PNG pixels,
full-table math/style/endpoints, inline/expanded controls, resource rejection,
limits, ownership, cancellation and transport failure. Native fixtures use mocked
clipboard/dialog/decoder boundaries and scoped synthetic files; they do not touch
the user's clipboard or save files. Local browser/native-fixture evidence does
not establish live native picker/clipboard behavior on every platform. The existing
native-host browser subset covers these fixtures; Linux retains full coverage.
Replay commands and user behavior are in [Mermaid diagrams](../mermaid-diagrams.md).
