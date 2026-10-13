# Decision: visibility-owned generated charts and quiet inline controls

Decision status: Accepted and implemented; isolated macOS native and integrated test qualification passed. Actual parent-compositor, installed OS and hosted native-platform/release qualification remain separate.
Created: 2026-10-13 11:23:52 JST (UTC+0900)
Last updated: 2026-10-13 13:40:12 JST (UTC+0900)
Decision authority: the user explicitly requested no five-minute chart limit,
execution while visible and stopping when out of view, full-width natural-height
charts, no necessary inner scrollbar, stronger supplied fluid, dark tooltips,
no scroll-triggered entrance replay and secondary controls under a quiet menu.
Local implementation and tests are authorized; a subsequent push is not.
Supersedes: [inline flow](agent-visualization-inline-flow.md) only for the
generated viewer's five-minute lifetime and bundled fluid's cumulative frame
ceiling; [viewport pool](agent-visualization-viewport-pool.md) only for tiny
positive-crop presentation retirement and the always-visible generated toolbar.
External Apps' absolute lifetime and consequential consent remain unchanged.

## Context and alternatives

An artificial clock stops a healthy chart the user is reading. A prose-width
wrapper wastes available chat space. A positive crop smaller than the native
mask's supported minimum can be mistaken for a failed document, destroying and
reloading it during scrolling. Hiding a scrollbar alone conceals content, and a
native guest covers DOM controls placed over its pixels.

Choose generated-only visibility-owned lifetime, natural-flow sizing and stable
document presentation. Do not freeze arbitrary page JavaScript through a new
debugger, pretend cooperative visibility pauses are authoritative execution
stops, keep unlimited hidden DOMs, or enlarge the finite viewer pool. Genuine
offscreen retirement frees its exact source surface; a later new admission does
not promise universal persistence of arbitrary JavaScript state.

## Decision

- Advertise an explicit current-host generated visibility-lifetime capability.
  Generated viewer expiry is nullable, where null means owner/visibility-owned,
  never Infinity, a distant timestamp or silently renewed finite lease. Only
  exact generated viewer admission receives that policy. Legacy hosts retain
  their truthful finite fallback. Prepared and continuation tokens retain finite
  spending deadlines and exact source/window/frame commitments.
- Keep preview, startup, capture, watchdog, retirement and quarantine budgets.
  Generated first presentation must commit within a fixed20seconds from native
  record admission, checked against monotonic time as well as a timer. Neither
  startup acknowledgements nor a delayed timer can renew this allowance. Only
  the first exact qualified presentation commit removes that startup fence.
  External Apps retain their finite absolute execution and consent suspension
  deadlines. Null expiry must not pass external App action admission.
- Partial scrolling updates the same document. For a genuine positive crop too
  small to mask safely, hide native presentation without losing the document,
  while exact ownership and the ordinary watchdog remain active. Resume only
  after fresh qualified geometry. Never display an unmasked tiny slice. Whole
  offscreen, hidden owner, route/pane loss, Stop or uncertain ownership retires.
- Generated-only action menus may hide native presentation temporarily without
  reloading the page. This is not permission to ignore owner loss or to suspend
  external App consent indefinitely. Input/capture continue to require current
  exact native presentation; closing a menu cannot revive terminal ownership.
  Hold the overlay reservation until its menu/dialog portal exit or unmount,
  including when the selected viewer becomes terminal; siblings must not paint
  through a still-present panel. Clear private bytes independently and immediately.
- Give generated visualization rows the available chat column width, preserving
  prose reading width and surrounding row order. Measure natural content into
  chat flow rather than clipping a fixed-height root or stretching SVG glyphs.
  Retain finite viewport/pixel/height bounds. Responsive chart authorship must
  reflow labels/controls at narrow widths, not require horizontal scrolling.
- Put title/provenance/time, Start/Stop, Expand, Copy/Save/Export and private
  source/JSON inspection behind the shared accessible menu. Reveal its trigger
  on hover, keyboard focus and touch access; keep it outside native guest pixels
  or coordinate exact presentation hiding before overlays. Private details load
  only after explicit inspection and clear at ownership loss.
- Remove the bundled helper's cumulative 9,000-frame freeze for visible charts.
  Keep a single 30fps-bounded RAF, finite textures/programs/dimensions/resize
  admission, latest passive pointer coalescing, hidden/reduced-motion pause and
  exact cleanup. Use bounded modular animation phase and saturating diagnostic
  counters, not lifetime-growing arrays or imprecise phase accumulation.
- Boost the supplied fluid's final colour presentation by a display-only1.25
  gain, without changing solver equations or adding draws/resources. Preserve
  crisp foreground contrast and a local frosted veil. Canonical tooltip guidance
  uses theme-backed surface/foreground/border, not hard-coded white in dark mode.
  Generation guidance requires entrances once per document, not on scroll,
  visibility or resize. Existing arbitrary authored code is not universally
  repairable by guidance; exact supplied exports get isolated replay evidence.
  Generated-only duplicate native hints and same-value DOM presentation writes
  are suppressed, while initial/actual transitions remain observable. This fixes
  ordinary same-visible scroll callbacks without intercepting arbitrary page
  events or rewriting stored source; a true hide/return can still invoke an
  older author's deliberate replay.

### Logical visibility and native paint — 2026-10-13 12:06:40 JST (UTC+0900)

Qualified positive tiny crops and menus hide native pixels, not the chart's
logical position in the viewport. Preserve the generated logical visibility
hint through only those states and publish a separate presentation-visible
scalar/event for the bundled helper's cooperative pause. Bind initial logical
commit to the same exact positive geometry admitted by the native owner; initial
bootstrap starts both false. Whole offscreen, hidden owner, revocation or actual
retirement remain terminal, while Apps and preview retain their original hints.
Native input, focus, capture and view flags stay authoritative. This distinction
avoids replaying an older author's logical-visible entrance on a paint-only
transition without rewriting its code or suppressing arbitrary browser events.
Actual native document visibility and exact-chart replay remain test gates.

## Security, privacy and compatibility

### Additive display refinement — 2026-10-13 12:01:31 JST (UTC+0900)

The user subsequently asks for a more visible swirl than the initial25% boost.
Use display-only2.0 gain instead of1.25 and static fallback alpha.24 instead
of.15, without changing solver equations, allocation, draw rate or resource
limits. New-generation guidance uses canvasopacity.8–1 and a local60–70% veil,
keeping chart foreground crisp. Existing authored canvas/veil styles remain
immutable; their independent attenuation cannot be undone universally by gain.
Isolated native screenshot inspection and affected native/browser checks have
passed on the resulting implementation. This does not qualify actual parent
screen composition, installed OS input/accessibility or hosted releases.

Longer healthy visible execution increases total work duration, not permission.
It is no hard GPU/RAM quota or immunity to a stalled main/native service. The
accepted macOS memory exception remains. Pool/source/copy limits, sandbox,
offline CSP, exact nonce/frame/owner admission and uncertain-retirement fencing
remain independent. No generic page-to-parent, debugger or provider authority.

Stored source, manifests, proofs and posters remain immutable/private. Host
presentation synthesis and portable derived export are distinct from migration
of user artifacts. Normal rebuilt adoption remains user-owned. No installation,
runtime/dependency refresh, user UI control, live profile/database access, OS
change or subsequent push is authorized by this decision.
The user subsequently authorized a narrow read-only local database lookup for
the exact reported chart and its relevant error records. That diagnostic read
does not authorize database mutations, unrelated history/profile reads or live
runtime adoption; received source remains untrusted isolated replay material.

## Evidence required

Test generated execution beyond five minutes with unchanged generation, finite
Apps expiry, exact offscreen Stop, partial-crop/menu hide-return without reload,
stale owner/late ACK/ticket/continuation refusal and quarantine. Qualify real
scroll/list geometry, full-width/natural-height/no inner overflow, dark/light
tooltip and fluid contrast, hover/focus/touch menu, private details, reduced
motion and helper progress beyond9,000 frames without resource growth. Keep
actual native proof separate from browser mocks and guest PNGs separate from
parent screen-compositor/installed OS/Windows/Linux qualification. Preserve every
failure before diagnosis and run repository checks plus forced desktop build
last on the resulting source.

At 2026-10-13 13:40:12 JST (UTC+0900), local macOS arm64 tests qualified the
generated visibility lifetime, stable partial/menu/tiny-crop document identity,
natural-height full-width chart layout, themed tooltip and stronger supplied
fluid. Separate actual Electron font and exact-source chart replays passed,
followed by the comprehensive sandbox, input, pool, consent and watchdog checks.
The original five-second observation, child/test deadlines, worker limits and
security policies were retained. Integrated default tests (8,967 passed with
12 existing skips and one expected failure), full browser tests (2,091 passed)
and copied MCP bridge tests (four passed) also passed. Independent boundary
reviews found no outstanding must-fix issue. These are isolated/local test
results, not live-app adoption or a diagnosed cause for an earlier publication
failure. The forced desktop build must still be the last verification step for
every resulting changeset; exact outcomes and unchanged-source evidence belong
to its execution record.
