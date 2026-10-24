# Browser test input isolation

Last updated: 2026-10-24 08:17:53 JST (UTC+0900)

Current suite design is governed by [Test suite policy](test-suite-policy.md).
The October 16 overhaul retires the exact fluid inventory, sample commit-chart
qualification, cosmetic coordinate/animation matrices and fixed frame-count
readiness below. Historical failure investigations remain useful evidence;
they do not require reinstating removed tests. Native input/context isolation,
security admission, worker/deadline limits and feature assertions still apply.

Last updated: 2026-10-22 15:13:25 JST (UTC+0900)

Cafe's pinned Vitest browser runner isolates test files by replacing a tester
iframe. Its owning Playwright page and browser context can be reused for later
files. CDP device/touch emulation targets that outer page, not the disposable
iframe; an iframe reset is therefore not an input-policy ownership boundary.

Use native Playwright context options for fixtures requiring a different device
or motion policy. `apps/web/vitest.browser.config.ts` has four explicit projects:

- `chromium` retains ordinary desktop input and the remaining browser files,
  excluding the exact touch, fluid-lifecycle and reduced-motion fixtures below.
- `chromium-touch` includes only `MessagesTimeline.touch.browser.tsx`, with a
  native mobile/touch context and the existing 430×932 viewport. Vitest owns and
  disposes the context; no desktop fixture can reuse it.
- `chromium-visualization-fluid-motion` includes the complete
  `VisualizationFluid.browser.tsx` file in its own native `no-preference` motion
  context, retaining ordinary mouse input and all lifecycle/resource assertions.
- `chromium-context-reduced-motion` includes the complete context-dialog,
  diagnostic-work-entry and visualization reduced-motion files in their own
  native `reduce` context. Production still honors that actual preference.

The desktop, touch, ordinary-motion fluid and reduced-motion groups execute
sequentially in that order using Vitest's supported `sequence.groupOrder`.
CI additionally partitions them into three sequential Vitest invocations:
desktop/touch, ordinary-motion fluid, then reduced motion. The pinned runner
retains project browser providers until its pool closes, and providers may
prewarm browsers before their group's execution. Group ordering alone does not
retire the earlier providers. Process completion joins their cleanup before the
next invocation starts. Linux's complementary project filters retain the full
inventory; macOS/Windows retain their exact file subset with `--maxWorkers=2`
on each invocation. Existing worker caps, 30-second test and hook deadlines,
locator matching policy, cache boundaries, assertions and CI permissions remain.
Root include/browser arrays remain absent because inherited array merging would
otherwise include unrelated files in the specialized projects.

The touch fixture retains the original message-action opacity, positioning,
containment and accessible-control assertions. It additionally observes native
no-hover/coarse-pointer/touch state. Desk sidebar coverage independently observes
native hover/fine-pointer state and still exercises all original real mouse and
keyboard actions. Never substitute a `matchMedia` stub, forced CSS rule or
synthetic dispatched event for this native input qualification. Do not use raw
device/touch CDP overrides in the shared desktop project.

## Verification

Use the pinned Node runtime and repository Yarn release. Run focused input and
layout coverage with:

```sh
corepack yarn workspace @cafecode/web test:browser src/components/desk/DeskSidebar.browser.tsx src/components/chat/MessagesTimeline.browser.tsx src/components/chat/MessagesTimeline.touch.browser.tsx
```

Run the full suite with `corepack yarn workspace @cafecode/web test:browser`.
The existing macOS/Windows CI subset explicitly includes both timeline files;
Linux retains the complete suite across these invocations. A file inventory must
assign each browser file exactly once, with only the exact files in each specialized
project. Node qualification reads the actual configuration's syntax tree and
scoped browser-file inventory without starting a provider or importing Vite's
application configuration; real browser assertions separately observe native
owning-document and fixture-document media.

The motivating Linux failure delivered real trusted mouse input and DOM hover,
but native media reported neither hover nor fine/coarse pointer capability.
The installed hover media guard explained why action controls stayed hidden;
missing CSS or broken sidebar hit targets were not observed. A controlled Mac
probe restored native mouse media after touch reset, so it did not reproduce the
Linux media-state origin. Context isolation removes the shared raw-emulation
boundary without claiming that unobserved platform-specific origin is proven.
Local Mac passes do not qualify Linux or Windows; hosted native checks remain
required. This test-only policy changes no production CSS, provider lifecycle,
permissions, credentials or live user session.

## Real-list proposal baseline readiness

The schedule-proposal fixture in `MessagesTimelineRealList.browser.tsx` must
observe its exact committed list's `initial-list-load` callback before preparing
the physical tail or review baseline. The existing scope-fenced debug callback
is installed before render. DOM tail proximity, parent follow flags and four
animation frames can all be observed while LegendList's initial bootstrap is
still pending; they are not completion receipts.

Bounded content-free native observations showed initial-load completion after
the old baseline and proposal refresh. A later public end target can differ from
the physically clamped scroller, so following mode keeps its original physical
tail checks. Review baseline admission instead compares exact public/native
scroll, a valid current range, each mounted logical row's index/identity, and
the pinned virtualizer's known full-row size against `Math.round` of real native
geometry. It retains the exact visible message before refresh.

Keep every original proposal/request identity, original input and four-frame
measurement steps, 2px scroll/anchor bounds, review-tail and follow-tail assertions,
worker caps and enclosing deadlines. Negative fixture controls refuse a missing
initial-load witness, stale scroll, unknown measurement and invalid range even
when other geometry looks ready. Do not add sleeps, retry input, force dimensions,
relax tolerances or change production scrolling. These observations demonstrate
an incomplete precondition, not the precise cause of an archived 48px assertion.

## Ordinary-motion fluid lifecycle ownership

The full-motion fluid suite requires native ordinary motion before testing
continuous RAF, pause/resume, bounded resource replacement and passive pointer
delivery. In failed native macOS and Windows runs, its actual fixture document
reported `prefers-reduced-motion: reduce`. Static output and twelve warm-up
frames therefore matched the runtime's intended accessibility behavior, not a
demonstrated animation or GPU defect. The logs do not identify which earlier
media operation or platform preference supplied that state.

The dedicated provider-owned context binds the full-motion precondition at
native context construction. Every fixture observes real ordinary motion and
desktop hover/fine-pointer media in both owning and child documents. Keep the
complete lifecycle file exactly once, the existing native-host selectors,
sequential groups, worker caps, deadlines, recorder assertions and independent
reduced-motion tests. Do not repair inherited media by mocking it, forcing CSS,
issuing raw CDP resets on a reused worker page, changing OS preferences or
altering the production static branch. Recorder cases qualify synthetic lifecycle
and input accounting, not physical GPU pixels/memory or live user preferences.
The finite registration guard binds all four reviewed opacity/width/lifecycle
tables and the complete expanded case count, without evaluating fixture bodies;
its negative controls reject omissions, substitutions, skips and dynamic tables.
The separate native WebGL positive keeps GL, RAF and media unmocked, observes each
of the first seven size replacements and compares nonempty RGBA SHA-256 samples
after the eight-admission cap at identical canvas/context/buffer dimensions.
Trusted further controls must retain motion, while pause retains exact pixels
and resumption changes them. This qualifies that browser's real pixel behavior,
not hardware memory, live Electron adoption or another host's graphics driver.
The separate app-wide ambiance iframe-focus fixture keeps its existing engine
and background-animation setting. Its native control is in the ordinary desktop
group; it grants no special motion policy or relaxed input/deadline. Its passing
baseline is not evidence of the recording's original stopping cause. Native
hosted delivery remains required after local checks.

Native chart input targets each exact-named button through the current fixture's
frame locator. Preserve the button's measured nonempty geometry, exact document
ownership and trusted count/choice receipts; do not target the outer iframe at a
manually calculated offset. Ordinary Playwright actionability and hit-target
checks now apply to the actual child control. An identically named outer button
receives no input during the same original repeated-click sequence. There are no
forced clicks, raw pointer/CDP commands, synthetic events or new input contexts.

If the real WebGL positive fails, it flushes at most 128 content-free phase/index,
elapsed-time, trusted-click/frame-count and physical-dimension observations before
cleanup. The observer adds no timers, GL calls or input and never logs source or
pixels. The motivating Linux failure exhausted its enclosing 30-second allowance
during a post-cap iframe click; the 486ms action timeout was the remaining budget,
not a separately configured short deadline. Initial frames, all seven physical
admissions and the first nonempty pixel sample had passed. The exact failing
iteration and earlier elapsed-time distribution were unobserved; neither a GPU
cause nor stopped pixels is established. The targeting repair preserves every
original action, frame/pixel/resource assertion, worker cap and deadline.

A subsequent Linux trace observed all initial/admission-frame checks complete,
but native clicks consumed most of that same 30-second allowance. At timeout
the fixture remained visible and running in the viewport, with its frame count
still advancing; the pixel digest took about one millisecond. Another run of
the same source passed. These observations do not establish stopped pixels or a
GPU cause. CI's separate invocations retire the preceding native providers
before the complete fluid file opens, and retire fluid before reduced motion.
Every original trusted click and pixel/resource/pause/resume assertion remains,
with no retry, input replay, relaxed deadline or smaller fixture.

Register the idempotent diagnostic/temporary-DOM cleanup before appending a decoy
or starting frame navigation, and drain it first in `afterEach`. Vitest's hard
deadline can settle while a test-body await remains unresolved; that body's
`finally` is not sufficient cleanup ownership. The fixture registers its pending
frame before source assignment/append, and late creation cannot resume input
after retirement. Normal completion uses the same one-shot cleanup before the
existing loaded-frame disposal.

Failure cleanup also records finite document-visibility, runtime-state and
viewport-intersection phase labels before retirement. These inspect only the
fixture's current presentation metadata and geometry within the same 128-entry
bound. They distinguish an unobserved pause or offscreen document from a running
counter without reading GL state or claiming a graphics-driver cause.

The initial-paint precondition observes both completed clears and actual nonempty
pixels in the same original poll. A returned lifecycle clear or draw clear is not
proof that eased drive has reached the engine's paint branch. Keep the original
numeric clear and pixel assertions afterward, then all 24 trusted child clicks,
frame identity, focus, continued painting and cleanup assertions. Do not replace
real pixels with counter-only readiness, change production animation, force media
or relax the existing input, worker or deadline policy.

The separate ambiance positive retains at most 128 fixed phase/index/elapsed,
trusted-event and completed-frame observations, including native child pointer
delivery, click return and completion of the original two animation frames.
Its latest phase/index remains available if the trace fills. Failure emits the
stored observations before cleanup, rather than relying on reaching the final
continuity assertion after all 24 clicks. Keep every trusted-count, focus,
identity, actual-pixel and per-click frame-progress assertion unchanged. The
earlier full-suite timeout retained neither its failing index nor input-delivery
phase; it does not establish a production animation, GPU or hit-target cause.

Own pending rendering synchronously before awaiting it. A one-shot test-completion
hook joins that render and explicit unmount before restoring the exact native
recorder or removing its host; the ordinary `finally` joins the same cleanup.
Retired load/render/input continuations cannot start another input sequence.
The pinned React browser adapter cleans up before the next test, not in an
automatic per-test `afterEach`, so that later cleanup is not a retirement receipt
for a timed-out owner. Diagnostics read only fixed synthetic fixture metadata,
not received source, pixels, provider data or native GL state.

## Transient Mermaid copy feedback

The incomplete-source fixture owns its copy mock's exact deferred result before
render or native input. Complete the original click and exact source/count
assertion while feedback remains absent, then resolve that result and retain the
original visible `Copied`, completed-source and render assertions. Production's
real feedback timer remains unchanged. An already-resolved mock can start that
timer while the awaited input round trip still hides the feedback window from
the fixture; a later `Copy` snapshot alone cannot prove which phase occurred.

Register shared one-shot cleanup before awaiting render. It joins the owned
pending render and explicit unmount before releasing an abandoned copy result,
including hard deadlines and unmount failures. Retired continuations cannot
rerender or release success feedback after that owner has been removed. This is
test synchronization, not a production clipboard, feedback-duration, renderer,
permission or input-policy change; native input, worker caps and deadlines stay
unchanged.

## Native-host Mermaid security scheduling

The complete `MermaidSecurity.browser.tsx` file has a dedicated sequential
macOS/Windows CI browser invocation with the existing `--maxWorkers=2` cap.
Linux's complete suite continues to select it normally. Do not omit cases,
reuse an admitted frame/realm, change native input contexts or renew the fixed
ten-second probe allowance. The source, parsed-graph and render-output refusal
assertions remain exact, and the final forced desktop build follows all browser
qualification steps.

The motivating macOS frame-load callback arrived after its deadline, with the
last observed phase `document-constructed` before accepting frame load or
transferring the port. No parser, mutation or render phase was observed. It does
not establish a Gantt-admission defect or the underlying runner delay. The
scheduling partition is an empirical qualification change, not a claim that CPU
contention was proven. Failure upload admits only this synthetic fixture's exact
screenshot directory in the existing diagnostic allowlist; diagnostic ZIPs do
not qualify native release artifacts. Native hosted results remain required.

Graph probes also retain the existing exact engine/receiver/fixture startup
observations, with `admitSourceOnReady: false`: they still transfer source only
from their original native load callback. An expiry before that transfer is not
a parser refusal. An expired exact-ID port message is rejected before its phase
is decoded, so a last `request-sent` breadcrumb does not prove that parsing never
ran. Startup observations do not renew the absolute ten-second allowance or
establish the cause of a historical delay.

The chart-boundary table captures each row's public test signal before its first
native probe. Its helper refuses a retired owner before document construction
and again before transport. Optional signal retirement uses the same exact
frame/port/callback cleanup as ordinary completion, and late callbacks cannot
send again or accept success. Keep both original admitted/refused counts and
sources unchanged; this test-lifetime ownership does not alter production
admission, contexts, worker caps or deadlines. A DOM marker sweep is not evidence
that an outstanding helper's callbacks and transferred ports have retired.

## Native Mermaid family startup readiness

The additional family probes construct fresh opaque documents containing the
complete locked engine and production receiver. Their test-only startup markers
run inside those exact script bodies and after all fixture overrides. Only the
two native family builders opt into transferring their source when that exact
document reports the ordered terminal readiness marker; the generic iframe load
callback does not grant those builders source authority. Graph-security and
ordinary transport probes retain their original load gate.

Admission binds the owning WindowProxy, opaque origin, fresh nonce and invocation
ID, exact content-free message shape, absent transferred ports and ordered
engine/receiver/fixture observations. Reserve the one-use source transfer before
either transport call. Duplicate, stale, foreign, malformed or retired callbacks
cannot send source again, regress progress or revive a settled owner. The same
absolute ten-second allowance begins before appending the document and covers
engine startup, parsing and reply; readiness never renews it or admits an expired
message ahead of a delayed timer callback. Keep all original source, parsed-data,
native parser-count and output refusal assertions unchanged.

The parsed-family boundary table also captures each row's public test signal
before either original accepted/rejected invocation. Its builder checks that
owner before and after inert document construction and passes it to the same
exact frame/port retirement path. A failed row retains at most sixteen fixed
accepted/rejected invocation, startup-phase and bounded elapsed observations;
it never logs source, received errors, native results or private identities.
Both invocations otherwise report `baseline`, so a last request-sent breadcrumb
alone cannot identify which boundary expired. Keep the original counts, sources,
assertions, readiness gate and absolute allowance. The full-engine cancellation
control retires its owner synchronously at the real fixture-ready marker and
requires zero source sends plus closed ports/frame and no queued-load replay;
this qualifies cancellation propagation, not the cause of a historical timeout.

The full-engine held-load positive separately proves actual receiver readiness
and successful native parsing without releasing the generic callback. Synthetic
transport controls prove the ownership, expiry and one-use negatives, not native
platform delivery. Earlier macOS failures retained only a pre-request
`document-constructed` phase, so neither those controls nor local passes establish
the original delay's CPU, parser or scheduling cause. Native hosted results remain
required. This fixture-only repair changes no production renderer, CSP, network,
accessibility, permissions, browser contexts, worker caps or deadlines.

## Keyboard popup readiness

The scroll-to-bottom hover options use ordinary native mouse/keyboard input in
`ScrollToBottomControl.browser.tsx`, actual mobile touch events in the existing
touch timeline context, and `ScrollToBottomControl.motion.browser.tsx` in the
existing provider-owned reduced-motion context. The current macOS/Windows subset
selects these files plus `ChatPaneRuntime.browser.tsx`; Linux retains all cases.
No extra contexts, worker limits, deadlines or device/media mutations are added.
`MessagesTimelineRealList.browser.tsx` observes actual native wheel movement,
unchanged review geometry while hidden, actual bottom re-enabling and content
shrink. Hook-only owner/remount tests and the synthetic full-app Desk review
fixture are distinct from that physical-scroll proof.

Base UI queues initial item focus and Home/End navigation focus asynchronously.
A completed native click is not itself proof of popup rendering. Full-app composer
ordering fixtures observe the actual popup and each expected item/label before
synchronously reading their order; they retain one click and all later metadata
ACK, account, omission and send assertions. An absent popup snapshot alone does
not establish its original opening or dismissal timing.
A visible menu or listbox is not yet proof that it owns native keyboard input.
Keyboard fixtures must observe actual initial item focus before sending popup
navigation, then observe the exact navigation target's focus before activation
or cancellation. Send Home and Enter separately rather than assuming the next
key waits for Home's queued focus. Preserve all action, selection, cancellation,
layout and return-focus assertions. Do not manually focus the target item, sleep,
retry inputs, dispatch synthetic keys or extend deadlines to satisfy them.

This strengthens fixture synchronization without changing production menus or
selection policy. Logs without a pre-cleanup focus witness do not establish the
precise original failure's focus state; screenshots taken after fixture teardown
cannot supply that missing evidence.

## Controlled composer replacement readiness

Preparing a shorter-response draft commits its store before the controlled editor
and queued native end-caret update necessarily finish. Playwright's ordinary
contenteditable fill selects the current DOM contents before a separate native
text insertion. Observe the exact preparation text in both store and editor,
actual root focus and an editor-owned collapsed caret at the true end before
that original fill. Read prefix/suffix extents through detached Range clones;
never rewrite the live Selection to manufacture readiness. After filling,
observe exact edited text through both committed surfaces before the unchanged
Send and outgoing-command assertions.

The native ArrowLeft negative keeps text and focus unchanged while moving the
caret inside the prompt, proving those two surfaces alone cannot qualify the
replacement precondition. Preparation still dispatches zero commands. Preserve
owner, account/model, mode, cancellation, bounds and exact command-count/content
assertions, original native input and deadlines. No extra fill, selection forcing,
sleep, input replay, store correction or production-editor change is implied.
The motivating Linux log showed the prepared text concatenated with the intended
replacement, but did not retain the precise selection-update phase responsible.
This readiness repair does not claim that unobserved original phase as proven;
hosted Linux qualification remains separate from local browser evidence.

## Real-list review readiness

Image-continuity fixtures compare the complete retained image set by object
identity. LegendList may reorder retained row containers in the DOM while their
physical positions stay unchanged. A different DOM order is not an image
replacement: retain exact image membership, URL and request counts, the absence
of URL revocation, and the original visible row/image geometry assertions.

Wheel intent can commit review mode before the native gesture and the real
virtualizer finish updating their viewport. A fixed number of animation frames
is not proof that a chosen DOM row is the list's current measured review anchor.
Before appending to a stationary review fixture, observe completion of the exact
native scroller's gesture and agreement between its physical scroll position,
the public list state, the exact visible row identity and its measured extent.
Keep the subsequent exact logical identity, physical anchor position, review
mode and tail-distance assertions unchanged. Do not repair the test by scrolling
back to its anchor, retrying input, adding sleeps or increasing deadlines.

This is fixture precondition qualification, not evidence that the original
missing-row failure was caused by a particular timing phase. It does not change
production timeline anchoring, chart access or resource policies.

## Held image loading geometry

The combined image/chart real-list fixture holds each message's exact manifest
and binary reply independently. A held manifest leaves metadata unknown, but
does not suppress the production delayed loading label. The empty host's
border-box minimum and the later loading child's flow height are distinct
phases: the child retains the original 64px extent, and the host additionally
contains its two native borders. Before capturing the initial image baseline,
observe both owned loading children, exact text, absent aspect ratio, unchanged
minimum and precise border-inclusive geometry. Do not accept an arbitrary
height range, release transport early, force CSS, sleep or extend deadlines.

Keep all subsequent metadata growth, decoded image, full-width chart, native
wheel, exact document/anchor, tail and review assertions. This corrects a
fixture assumption; it does not change production image layout or establish a
timeline ownership defect from a failure before those later checks.

## Native drag finalization and bounded diagnostics

A fixture owns cleanup as soon as it attempts its native pointer press. A failed
response does not prove the browser refused the press. Keep the press, its first
frame and subsequent movement inside the same exact-session release finalizer;
retain the original pointer path and sensor teardown. This is test input cleanup,
not a change to production drag behavior or browser input policy.

Clipped-edge tab fixtures retain at most 32 content-free observations of their
12 cells, exact-host native pointer, strip scroll and insertion marker. Retire
all listeners and observers before unmounting. Automatic edge scrolling remains
enabled, and the exact expected insertion index, order, painted boundary and
pixel assertions must not change. A later index mismatch without pointer/scroll
witnesses does not establish a production indexing defect; a diagnostic pass
does not establish the original failure's cause.

## Full-app timeout retirement and Settings reveal evidence

Preview-submit fixtures bind retirement to their exact public Vitest test signal
and register cleanup before the first mount await. The optional mount lifecycle
publishes its own cleanup before viewport/style/render/bootstrap work, retains
the exact pending render and clears only its own RPC resolver. Retirement closes
continuation admission synchronously before releasing the deliberately held ACK;
join the original mount and already-admitted native operations before destructive
unmount, keeping their exact locator targets alive until they settle. Receipt of
the intended RPC is not completion of its original native click. Cleanup must
release its held response before joining work which can need that response, and
clear only its own resolver before a later fixture can supply replacement
controls. Normal completion,
failure and hard timeout share that idempotent cleanup. Unscoped mount consumers
retain their established behavior.

Retained-account and manual-compaction callers use this same scoped ownership
contract, including a mount that fails before returning its cleanup handle.
Keep their original synchronous DOM Send activation where the journey uses it;
an activation phase is not provider acceptance or dispatch completion. Their
failure-only ledgers retain at most sixteen fixed finite phase/count/elapsed
records and use the browser tester's console channel, never a Node-only stream.
Preserve the primary body error if exact cleanup also rejects; shared retirement
still observes that cleanup result under its existing settlement policy.

Other full-app journeys share the test-only caller owner instead of copying
that retirement protocol. Browser callers inject the existing scoped mount;
inert Node controls inject a fake mount and never start the application or a
provider. Each owner admits one exact mount and injects its own lifecycle, so a
second mount or replacement cleanup handle cannot acquire an old owner's grant.
Release the exact deliberately held acknowledgement before draining work that
can depend on it. Restore an image-picker override or API spy only after the
admitted work and exact mount disposal settle. Cleanup retains failures rather
than treating a rejected disposal as success, while a primary body failure
keeps its original identity. Synthetic lifetime controls qualify this ordering,
not native browser event delivery or a historical timeout's cause.

The late-fork journey owns the original dispatch completion separately from
the native confirmation click: neither click completion nor releasing a held
fake response proves that the wire call succeeded. Release that exact response
before joining the dispatch, retain the success receipt only after its original
promise resolves, and restore the acquired API spy only after exact unmount.
Rail-docking journeys use the same owner without a held-response gate. Keep all
original hover/click, docking, navigation and acknowledgement assertions;
lifetime ownership does not grant input replay or a longer test allowance.

The shared hook owns one exact scoped caller-retirement lease, admitted before
mount mutation. Vitest's `afterEach` precedes `onTestFinished`, so the shared
hook must join that same complete caller cleanup **before** clearing its RPC
resolver, menu roots or DOM. Repeated retirement joins one completion; only
actual settlement releases the lease, and cleanup rejection still fails the
check. A held lease refuses a replacement mount and the next fixture's reset.
The original hook/native deadlines remain: this is not unlimited target
survival if a hook itself times out. React's earlier global `beforeEach` cleanup
can remove an old root in that failure case, but it does not authorize creating
replacement controls while the prior lease remains held.

The preview diagnostic retains at most 32 fixed phase/elapsed observations and
prints them only on failure. It adds no input, readiness wait or deadline. A bare
30-second test timeout and a blank cleanup-time screenshot do not identify the
historical failing await or establish a production preview-promotion defect.

Settings search likewise owns its pending render, native actions, observers and
unmount through exact test retirement. Passive failure-only evidence retains at
most 32 fixed phase/scroll/scrollend/resize observations, finite row/scroll-owner
and viewport geometry, and fixed ownership/focus booleans. It never logs DOM,
received text, arbitrary identifiers, source or errors. Successful control focus
with `preventScroll` is not a receipt that native smooth scrolling has completed:
keep the original visible-row geometry assertion, native input, motion policy,
workers and deadlines. These observations distinguish scrolling and layout
without assuming that focus, a short entrance animation or CPU load caused a
prior visibility failure. Diagnostics alone are not a production repair.

Native table and Mermaid scrolling diagnostics distinguish the original
activation from the original keyboard command without adding input or waits.
Capture-listener microtasks do not necessarily follow all dispatch handlers:
retain only bounded original events and project their fixed prevention/target
fields after the corresponding native command has actually fulfilled. Preserve
completed activation and key rows within the existing bounded ledger so later
pan/close activity does not erase successful controls. Retirement removes exact
listeners, frame callbacks and event references. A trusted, unprevented key and
emulated document focus alone do not prove the browser's native scroll default
ran; diagnostic passes do not identify an earlier failure's cause.

### Expanded viewport arrow scrolling

Expanded image, Mermaid and table viewports own their unmodified arrow scrolling
through the shared `viewportKeyboardScroll` helper. Native key input is retained;
the app applies a bounded instant native scroll only when that exact viewport is
focused and targeted, can move on the requested physical axis and owns no range
selection. Editable content, descendant controls, modified/composing/prevented
events and other keys retain their existing behavior. Physical left/right works
with the native negative RTL scroll range; direction is not inverted. A generic
boundary does not consume the key. Images separately retain their existing
overflow gallery-navigation fence, including at an edge.

This is an explicit user-facing workaround, not a readiness wait or a browser
engine patch. A fresh inert Chromium reproduction observed a compositor animation
finish without an offset change after its first tick arrived beyond the keyboard
curve's duration. Source ordering is consistent with a pending sample being
discarded before activation and retirement without another sample; exact tree
flags and historical app causation were not observed. See Chromium's
[sampling boundary](https://github.com/chromium/chromium/blob/149.0.7827.55/cc/trees/property_tree.cc#L1727)
and [animation state ordering](https://github.com/chromium/chromium/blob/149.0.7827.55/cc/animation/keyframe_effect.cc#L139).
Do not infer a reliable repair from extra pre-key frames, focus options or replay.

Pure tests cover policy/geometry combinations, with actual browser wiring for
movement and non-interception. Keep the original pan/zoom/scroll/close assertions,
trusted native input, media/context ownership, sandbox, workers and deadlines.
A moved owner arrow is intentionally default-prevented now; observing that flag
does not replace the actual scroll-position assertion. No cache hit substitutes
for a fresh native action claim.

### Focused quota End scrolling

The existing focusable read-only Claude quota region explicitly handles an
unmodified End with an instant native scroll to its last meter/extra-usage row.
It uses the same exact-focused-owner, selection/modifier/composition and finite
both-axis guards as expanded viewport arrows, but a separate End-only entrypoint.
The horizontal coordinate, including native RTL, is preserved. An already-ended,
nonoverflowing or unmoved region does not consume the key. Home, other keys,
descendant controls and legacy Codex quota markup retain their native behavior;
no quota refresh, provider read or allowance semantics change.

This follows an observed trusted exact-owner native End that completed without
moving an overflowing panel. The browser's internal cause for that event was not
established; do not borrow the inert arrow trace as proof of the End mechanism.
Keep all three original layout journeys' single native End and real bottom/
extra-usage assertions, adding intentional-prevention evidence only after that
same action completes. Pure policy tests cover refusal combinations; one native
modified-End control verifies non-interception without prescribing how an
unhandled selection command should scroll or select. Do not add waits, replay,
larger budgets, different media/flags/contexts or worker changes.

Search reveal fixtures arm an exact successful navigation receipt before their
single native Enter or option click. Keep the original semantic input queries.
Observe the original navigation, highlight, control-focus and visible-row
assertions from that receipt while the action remains in flight, then require
that same action's successful completion before further input or success. The
sidebar-unmount case also retains its original disappearance assertion. A native
command acknowledgement is not the start of a transient highlight's lifetime.
Keep the real highlight timer and original polling/test budgets; navigation
failure, native rejection and exact-test retirement must reject the observation,
not turn an unobserved reveal into success. Restore only the observation's own
mock wrapper, preserving the original navigation result and errors.

Settings search positions the exact admitted anchor with native instant
`scrollIntoView` before highlighting, focusing and reporting a successful reveal.
Scheduling a smooth animation is not completion evidence: the focused control
can still be offscreen. Keep the existing frame/abort/disconnection checks,
highlight lifetime and native row-visibility assertions. Controller tests own
their exact queued frames, supersession, timers and synthetic listeners; they
do not attest native geometry or diagnose a historical animation-engine cause.

Workspace menu fixtures protect long-label containment, usable popup bounds,
selected-option focus, native cancellation and unchanged selection. Exact icon
centering, popup/trigger width equality and theme colors are not feature gates.
Scroll-preview dismissal likewise checks the exact originally open popup is
disconnected or closed, with no open replacement, then retains the original
native main press, once-only scroll/zero-hide callbacks and exact button focus.
A closed attribute alone does not prove usable controls or physical resource
retirement. Join admitted native work before exact unmount; join an unfinished
entrance after unmount can cancel it. These fixtures keep original input,
polls, workers and deadlines, without waiting for exit-animation DOM removal.

Mobile Desk navigation retains the exact open sheet from the original trusted
thread-selection press. Closing must leave no open sheet and permit the selected
chat's composer to receive an ordinary native click and printable character,
with exact editor focus outside that retained sheet and matching DOM/store draft.
Physical exit-animation DOM removal is not the feature contract; a closed data
attribute alone is also insufficient. Keep the original other-chat draft,
split/layout/group identity, viewport-boundary and no-interrupt assertions.
Register exact-test retirement before mounting and join already-admitted native
work before a later fixture can provide replacement controls. No forced focus,
input replay, submission, motion-policy or deadline change qualifies this path.

Context- and subagent-policy ACK fixtures likewise retain the exact originally open editor.
An acknowledged close may disconnect that popup or leave its closed exit node;
neither may remain open. Keep the exact canonical policy and absent stale draft
overlay assertions, along with each journey's original native reopen, current-
value and Send checks. A closed attribute by itself does not prove usable controls,
and physical exit-animation removal is not acknowledgement-ordering evidence.
Bind the deliberately held response to the exact metadata command and release
it during owned retirement, without holding unrelated dispatches or changing
the policy controller, ordinary polls, native input or test budget.

Sticky-model navigation fixtures own their mount and original native actions
before the first await. Failure-only phase observations distinguish inert
mounting, the original hover/click, route completion and saved-state assertions;
retain only a finite fixed vocabulary and bounded elapsed/count scalars. A bare
test deadline or a secondary screenshot-stability timeout does not establish
which original await failed or prove a provider/default-selection defect.

## Small-fixture timeout ownership

Context-menu, heatmap, workspace-theme, quota-reset and scheduled-review
fixtures register public test-signal retirement and completion cleanup before
their first asynchronous acquisition. Keep an exact per-case owner through
render, original native actions and unmount. Retirement fences new actions and
post-await continuations synchronously; shared cleanup joins that owner's
already-admitted work before replacing controls or resetting global state.
Retain a late render separately so it cannot repopulate the next case's mount
slot. No input replay, force, added readiness wait or deadline change is implied.

Failure-only diagnostics retain at most sixteen fixed phase/count/elapsed or
finite geometry observations per owner, never DOM/text, arbitrary identifiers,
request contents or received errors. Passive trusted pointer receipts on the
exact scheduled Review button distinguish dispatch from native actionability;
successful fake-list results are separate observations, not click completion.
Heatmap range/scroll observations explain only the current captured state.
These lifetime repairs do not establish the causes of historical timeouts, and
secondary screenshot failures are not original feature failures.
