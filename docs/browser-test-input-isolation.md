# Browser test input isolation

Cafe's pinned Vitest browser runner isolates test files by replacing a tester
iframe. Its owning Playwright page and browser context can be reused for later
files. CDP device/touch emulation targets that outer page, not the disposable
iframe; an iframe reset is therefore not an input-policy ownership boundary.

Use native Playwright context options for fixtures requiring a different device
policy. `apps/web/vitest.browser.config.ts` has two explicit projects:

- `chromium` retains ordinary desktop input and every existing browser file
  except the exact touch fixture.
- `chromium-touch` includes only `MessagesTimeline.touch.browser.tsx`, with a
  native mobile/touch context and the existing 430×932 viewport. Vitest owns and
  disposes the context; no desktop fixture can reuse it.

The desktop group executes before the touch group using Vitest's supported
`sequence.groupOrder`. This preserves the existing aggregate active test-worker
limit, including the native-host `--maxWorkers=2` policy. Providers may prewarm
their browser processes before execution; sequential groups do not promise a
single browser process. Existing 30-second test and hook deadlines, locator
matching policy, cache boundaries, assertions and CI permissions are unchanged.
Root include/browser arrays remain absent because inherited array merging would
otherwise include unrelated files in the touch project.

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
Linux retains the complete suite. A file inventory must assign each browser file
exactly once, with only the touch file in the touch project.

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

## Keyboard popup readiness

Base UI queues initial item focus and Home/End navigation focus asynchronously.
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

## Real-list review readiness

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
