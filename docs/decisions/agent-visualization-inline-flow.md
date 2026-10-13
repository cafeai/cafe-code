# Decision: natural inline chart flow and sustained visible motion

Decision status: Accepted; implemented, local source/runtime checks passed; release qualification pending
Created: 2026-10-13 05:42:46 JST (UTC+0900)
Last updated: 2026-10-13 11:31:05 JST (UTC+0900)
Decision authority: the user requested automatic visible activation, no separate
chart scrollbar, continuing pointer-responsive fluid, animated range changes and
undistorted chart labels. Local implementation/testing is authorized; another
commit/push, installation, OS change or live-session intervention is not.
Implementation status: integrated; current default/full-browser and local macOS
native checks pass. The forced desktop build remains the required last handoff
gate. Native-platform/manual/hosted qualification is separate; acceptance is not
runtime evidence.
Supersedes: the [fluid-background decision](agent-visualization-fluid-background.md)
only for short initial/interaction settling limits, and the [viewport-pool
decision](agent-visualization-viewport-pool.md) only for normal generated root
scrolling. Pool, sandbox, privacy and absolute deadline decisions remain intact.
Superseded by: the [visibility-owned chart decision](agent-visualization-visible-lifetime.md),
only the generated viewer's five-minute lifetime and helper's cumulative frame
ceiling. The original rationale and historical verification below are preserved;
new lifetime, presentation and scroll-state checks must qualify the successor.

## Context and alternatives

A generated chart should be part of the conversation's scroll flow. A fixed
guest viewport can produce a second scrollbar and clip the chart while the host
footer remains visible. Merely hiding scrollbars would conceal content rather
than fix its layout. A short decorative frame budget also makes the requested
fluid appear frozen even while the native viewer is healthy.

Choose bounded native content measurement and continuing visible decoration,
not arbitrary parent DOM access, history-wide eager execution, unlimited native
surfaces, a renewed viewer lease, or universal source rewriting. Existing source
may intentionally use its own viewport/internal scroll; no host can guarantee
that arbitrary received HTML follows authoring guidance.

## Decision

- For generated documents only, measure natural content height in the existing
  isolated preload. Report only finite bounded/coalesced height, bound to the
  exact document nonce, monotonic sequence, native source frame and lease.
  Native main rechecks exact active ownership before presenting the scalar to
  the trusted renderer. Apply it to the inline card's reserved geometry so the
  chat remains the normal scroll owner. No page-selected CSS/parent actions,
  raw DOM, source or new external Apps permission is added.
- Keep private mode-context epochs distinct from public output sequences.
  A queued fullscreen measurement cannot overwrite the hidden inline reservation
  after return, and a genuine owner zoom change remaps the cached guest extent
  without renewing its source or lease. A fresh inline context resets only its
  private measurement sequence; the trusted public sequence remains monotonic.
- Keep existing finite inline height and native viewport/pixel bounds. Refuse
  malformed/stale/cross-document messages and bound measurement callbacks and
  publication rate. Avoid recursive height feedback from the previous viewport;
  genuinely oversized or viewport-dependent documents retain honest constrained
  behavior rather than silently clipping their controls. Expansion still uses
  the same admitted live document and does not extend its deadline.
- Preserve four app-wide viewer reservations, exact visibility admission,
  poster-until-ACK, terminal visibility epochs and manual external Apps. Fix
  activation and short retirement only from actual source/replay evidence;
  do not mask Stop, expiry, revoked ownership or uncertain acknowledgement.
- Within the real timeline, generated registration waits for that exact list's
  public initial-load completion before issuing a ticket or native source. An
  unfinished virtualizer can still reposition its startup rows independently
  of ordinary scroll commands; do not admit an interactive native overlay before
  that startup settles. The poster and private inspection stay available.
  Readiness is scope-bound, requires a fresh completion after an absent list
  remounts, and never resets for streamed rows, theme or height;
  standalone cards and manual external Apps keep their existing admission.
  No timer, fabricated offscreen transition or general scroll-policy override
  is used.
- Preserve the exact owning list's review position around generated height
  changes. Native wheel is physically applied once, then synchronized through
  the list's supported absolute-offset API so queued end targeting cannot undo
  it. A partially visible generated chart in review may retain one weak exact
  anchor and one coalesced layout correction; newer real user scrolling must
  supersede any queued correction. Do not disable general visible-content
  anchoring, broaden parent actions, scan history, or patch the dependency.
- The actual supplied fluid runs only while both native presentation and actual
  document visibility allow it and reduced motion is absent. Retain the fixed
  30fps ceiling, size/texture/program/resize limits and exact GL cleanup. Replace
  the short settling/pointer-burst allowance with a finite frame allowance for
  the existing five-minute session (at most 9,000 frames). Passive trusted pointer
  motion is coalesced to the latest bounded input; it cannot capture focus,
  cancel scrolling or perform a parent action. Hidden/static exports get bounded
  warm-up only; context loss retains readable fallback.
- Static reduced-motion presentation must still match its actual visible size.
  An event-driven, admitted physical resize may rebuild the same bounded targets
  and perform at most twelve existing solver warm-up steps, consuming the global
  frame allowance without resetting it. Duplicate sizes and later hidden events
  do no work; the initial hidden/export warm-up remains twelve steps. This has
  no RAF or polling loop and does not enlarge the existing resize/resource caps.
- Canonical authoring guidance requires finite attractive data/filter/KPI
  transitions and responsive chart coordinates that keep text glyphs uniformly
  scaled. Avoid non-uniform SVG viewBox stretching. Respect real reduced motion,
  theme and native visibility. Test an exact explicit derivative of the supplied
  chart; do not rewrite private immutable artifacts or the supplied original.

## Security, privacy and operational consequences

Height is adversarial presentation data, never permission, native lifecycle truth
or provider state. Bounded exact-frame admission, coalescing and teardown are
required before exposing it. Native clipping, absolute five-minute viewer and
20-second preview deadlines, watchdog, uncertainty quarantine, source integrity,
offline CSP and one-use Apps consent are unchanged. The finite fluid allowance is
not a hard GPU/RAM quota and the accepted macOS memory exception still applies.

No dependency/runtime installation, lockfile change, profile access, database
repair, global OS setting, desktop control or live-session adoption is selected.
Normal rebuilt adoption remains user-owned. Improved instructions apply to new
source; a corrected demonstration is a derivative, not a silent saved migration.

## Implementation and evidence impact

Coordinate strict contracts/preload/native host events with renderer sizing and
automatic lifecycle. Require adversarial scalar/rate/ownership tests, real browser
chat-flow/review/focus/activation checks, native natural-height measurement and
unchanged document identity, fluid movement beyond the old frame limit and
trusted pointer response, and exact supplied-chart responsive/range animation
qualification. Preserve all earlier failed logs before interpretation. Run all
required repository checks and the forced desktop build last on final source.

The affected five-file browser suite passes 140 checks with original input,
worker and deadline policy. Full browser coverage passes 2,072 checks and the
default suite passes 8,904 tests, with ten existing/opt-in skips and one expected
failure. The local macOS native slice passes four checks, including tight natural
sizing, sustained fluid, repeated native pointer input and the same chart's own
normal-motion frosted capture. Cached stopped presentation notification never
grants a new native epoch. Required final build, native-platform/manual/hosted
release and user-owned rebuilt adoption remain separate boundaries.

Native parent bounds/guest PNGs are not full screen-compositor evidence; installed
IME/screen-reader, native Windows/Linux, hosted releases and actual RSS remain
distinct qualification boundaries. The predecessor decisions retain historical
rationale and are superseded only in the narrow scope above.
