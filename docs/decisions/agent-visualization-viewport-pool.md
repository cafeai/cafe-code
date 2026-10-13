# Decision: automatic inline chart units with a bounded native viewer pool

Decision status: Accepted; source integrated, focused browser/macOS native qualification passed, full/native-platform qualification pending
Created: 2026-10-13 03:52:10 JST (UTC+0900)
Last updated: 2026-10-13 11:31:05 JST (UTC+0900)
Decision authority: the user explicitly requested seamless individual chart units, automatic activation in or just before the viewport, and multiple live charts simultaneously. The agent selects finite resource bounds within that request; no installation or OS-policy authority is added.
Implementation status: the multi-view/automatic lifecycle and geometry/style/WebGL source are integrated locally. Current focused browser/macOS native pool checks pass; full repository, native Windows/Linux and hosted qualification remain open. Earlier single-view passes do not verify the new pool.
Supersedes: the [native execution-host decision](agent-visualization-execution-host.md), only its single app-wide viewer and manual activation requirement for generated visualizations. External MCP Apps remain manually activated. All isolation, privacy, ownership, capture and finite-deadline rules remain in force.
Superseded by: the [supplied fluid-background decision](agent-visualization-fluid-background.md), only the approximate swirl treatment. The viewer-pool decision and its authority/limits remain in force.
Further supplemented by: the [inline-flow decision](agent-visualization-inline-flow.md), for generated natural-height chat flow and sustained visible motion; pool and absolute deadline authority remain unchanged.
Further superseded by: the [visibility-owned chart decision](agent-visualization-visible-lifetime.md), only generated viewer clock lifetime, tiny positive-crop retirement and always-visible generated controls. Finite token spending, preview, external-App, watchdog and retirement budgets remain unchanged. Successor implementation/verification is separate from the historical evidence below.

## Context and alternatives

Independent charts, KPI strips and tables should flow with explanatory prose,
not require a monolithic dashboard or visible Run step. Nearby private
preparation can reduce startup latency, but hidden arbitrary JavaScript and
unbounded active history are inappropriate for a long-running chat.

Retaining one live chart fails the user's explicit simultaneous-view goal.
Unlimited native views would make resource use scale with history and windows.
Select a finite app-wide pool, rather than per-pane allowances that multiply.
Charts with genuinely shared controls remain one document; this decision adds no
cross-document storage, state broker, model context or provider-operation bus.

## Decision

- Keep up to four viewer reservations across the whole application, including
  starting, active, retiring and uncertain records. A manually activated external
  MCP App consumes one of those four slots; at most one external App is live.
  Generated units may use the remaining slots automatically. A separate single
  preview lane permits publication while all four viewers exist: at most five
  source-bearing native surfaces, not a sixth App or a pool per window.
- Prepare at most four native tickets and retain the existing two waiting
  previews. Preserve all per-document byte/pixel limits, the absolute 20-second
  preview deadline from enqueue, one-use 60-second tickets and each live epoch's
  nonrenewable five-minute deadline. Keep global expensive native setup/capture
  work serialized and finite; saturation is not permission to allocate five
  simultaneous raster copies or enlarge existing deadlines.
- Enforce an additional 64-MiB admitted input-envelope allowance across prepared,
  queued, constructing, active, retiring and quarantined records, including
  private replay data. Account actual encoded document strings, not only decoded
  asset estimates. This is retained-input accounting, not a process/GPU/RAM cap.
- Reserve native membership synchronously before asynchronous construction.
  Every callback and operation resolves its exact lease record, owner window,
  trusted main-frame generation and source commitment. Never replace a singleton
  fallback with the first map entry. Per-document ephemeral session, single
  top-frame and actual exclusive renderer proof still precede source admission.
- Keep exact uncertain retirement occupied. Any unproved ownership/retirement
  quarantines new pool admission and queued source; healthy siblings may still
  retire. Do not delete evidence, adopt a PID, or launch a competitor on an ACK.
- Mounted chart cards register exact pane plus authenticated invocation identity.
  Visible inactive split panes are eligible; focus is scheduling priority, not
  liveness. Closing one pane cannot revoke another displaying the same chat.
  Keyed subscriptions and bounded registries avoid a full-history render scan.
- Nearby preparation is bounded and inert. Source executes only after an actual
  visible clipped viewport is admitted. Keep the poster until the exact native
  visible commit. Stable viewers win; eligible waiting units are admitted fairly
  on actual capacity changes, not timer retries. More than four visible units
  retain seamless posters while waiting, without claiming they are all live.
- Stop, expiry, refusal, lost ACK and uncertainty are terminal within the actual
  visibility epoch. Remount, theme, resize, capacity events and modal/expansion
  changes cannot mint a new five-minute budget. A genuinely new offscreen-to-
  visible epoch or explicit Restart can request fresh admission. Keep epoch
  metadata bounded independently of recycled DOM anchors.
- Expand retains the chosen exact live document. Other native views yield before
  it appears; no source may cover host approvals or window controls. If yield
  retires another document, automatic resumption must use a one-use native-owned
  continuation bound to that same window/frame/source and the original remaining
  deadline, not a renderer-created renewal. Stop/expired/refused documents are
  not resumable. Arbitrary DOM state survives only while the same document lives;
  no promise of universal state restoration is introduced.
- Automatic activation must not steal composer/native keyboard focus. Explicit
  native pointer interaction and Expand may focus that exact chart. Generated
  charts must not trap normal chat wheel scrolling: qualify a narrow bounded
  native-input handoff when the guest has no remaining document scroll, retaining
  local internal scrolling and deliberate modified chart gestures. Do not fake
  browser device/media ownership or dispatch arbitrary guest-selected parent
  actions. Manual external Apps retain their existing input semantics.
- Failed/cancelled preparation discards only the exact unused ticket. A revision
  ID is not a per-viewer revoke identity: viewing the same source twice must not
  let one cancellation retire its sibling. Keep backend work/ledger/SQL quotas.

## Security, privacy and failure consequences

Automatic generated rendering is explicitly authorized by the user; it is not
permission for external App tool calls, provider inference, file access or new
network capabilities. Apps still use their exact originating server and fresh
one-use consequential consent. Raw source/proofs/private JSON stay outside
ordinary transcript, telemetry and debug output. Private inspection stays explicit.

Multiple renderers increase aggregate resource use. Chromium sandboxing, input
allowances, finite source/capture budgets and the external-page main watchdog
remain separate controls. No hard total-memory cap on macOS, hard GPU quota,
shared GPU-service-stall immunity or whole-system availability is claimed.
Small self-contained WebGL remains optional, with bounded authoring guidance,
static/reduced-motion/context-loss fallbacks and owned-resource teardown.

## Compatibility and operational consequences

Update native capability/lease contracts and all consumers together; an old or
unqualified host must not silently gain automatic multi-view authority. New
read-only capacity observation is exact trusted-window scoped and bounded.
No provider/runtime/dependency install, OS change, live profile/credential read,
database repair, session interruption or inferred push authority is introduced.
Normal rebuilt adoption remains user-owned. Existing immutable source/posters
are not rewritten; improved authoring guidance applies to new revisions.

## Implementation and evidence impact

Authoring clarification, 2026-10-13 04:14:23 JST (UTC+0900): the user explicitly
requires colourful chart animation and the reference-inspired WebGL swirls as
generation defaults. Canonical guidance therefore asks for finite entrance and
interaction motion plus a small cyan/blue/violet/magenta procedural swirl behind
chart units, with static reduced-motion/unsupported/context-loss fallback. This
changes authoring guidance, not the native execution authority, admitted source,
immutable saved bytes or a hard GPU quota. A representative actual native shader
fixture must qualify colour/motion/fallback/teardown; it cannot establish that
every arbitrary generated document follows the guidance.

Authoring/presentation clarification, 2026-10-13 04:39:36 JST (UTC+0900): the
user's subsequent frosted reference adds a local translucent theme-aware veil
over soft WebGL decoration, with vivid crisp chart marks and text above. No
parent backdrop sampling, photo/hero copy, screenshot authority or heavyweight
blur engine is selected. Actual native hiding does not reliably change
`document.hidden`, so an initial false visibility scalar and isolated finite
visibility event provide cooperative animation guidance. Source can ignore or
alter its own local presentation data; native masking, absolute deadlines,
watchdog and exact retirement remain authority. Lightweight debug reports only
fixed native-visibility/last-hint/commit state, not page frames or source. These
clarifications supplement the authoring default above, not a GPU quota or a
claim of arbitrary-source compliance.

Required evidence includes simultaneous exact-owned viewer reservations and a
concurrent preview; fifth-view saturation/fairness; global byte/setup/capture
limits; exact sibling noninterference; stale owner/ticket/lease refusal; shutdown
and whole-pool quarantine; actual distinct native renderer identities; one
hostile sibling's exact retirement while the others survive; hidden-first
admission; no autofocus theft; actual native wheel handoff; pane/recycling/epoch
isolation; fixed deadline continuation; modal/expansion safety; manual-only Apps;
and bounded long-chat registration/cancellation work.

The earlier single-view geometry/WebGL/browser passes are supporting evidence,
not multi-view qualification. Native parent bounds plus guest pixels do not
prove final screen-compositor masking. Installed IME/screen-reader, native
Windows/Linux, hosted releases, total RSS and shared-GPU behavior remain distinct.
Run required repository checks and the forced desktop build last on final source.

## Supersession and preserved decisions

The existing execution-host choice, no-install constraint and accepted macOS
memory exception remain. This successor changes generated activation and finite
concurrency only. The [foundation](agent-visualization-foundations.md) and
[external Apps](mcp-apps-hosting.md) ownership/privacy/consent decisions, inert
generic files, Mermaid, native save permissions and provider policy are preserved.
