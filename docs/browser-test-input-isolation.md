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
