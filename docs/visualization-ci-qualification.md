# Visualization CI qualification

Status: Implemented; native multi-platform delivery requires the exact hosted run
Created: 2026-10-13 18:22:30 JST (UTC+0900)
Last updated: 2026-10-13 19:03:42 JST (UTC+0900)

These checks qualify committed synthetic fixtures using the repository's pinned
Node, Corepack/Yarn, Chromium and existing Electron. They do not install a runtime,
open providers or a user profile, or establish live account capacity. Keep the
ordinary desktop launch and the [execution host](decisions/agent-visualization-execution-host.md)
security policy separate from disposable hosted test infrastructure.

## Exact checks, not equivalent-looking measurements

The four offline chat font faces retain complete byte equality, fixed independent
digests, headers, descriptor limits and their full license. Native byte comparison
avoids traversing every byte as a test-framework object; first/middle/last-byte
changes and truncated/extended buffers still fail. The fixed fluid library runs
inside a fresh ordinary Node VM realm only in its deterministic test harness.
This VM is not a security boundary for untrusted source. All original frames,
resource counters, phase limits and disposal checks remain enforced.

SVG advance (`getComputedTextLength`) is not the painted glyph's ink bounds.
The chart fixture instead verifies each label's identity transform and compares
local ink bounds with screen ink bounds, independently preserving root aspect,
font size, layout and overflow checks. Deliberate nonuniform label scaling and
`textLength`/`lengthAdjust` distortion must fail rather than being hidden by a
larger comparison tolerance.

Mermaid caches only immutable escaped bundle text, not documents or runtime
state. Every render retains a fresh nonce, opaque iframe, restrictive CSP and
one-use port. The family probes use an absolute ten-second observation allowance,
clean up every settlement/error path, refuse malformed matching replies, and
record only finite code-owned phases. A missing reply does not identify an engine
phase or prove that an unsafe graph was admitted.

Manual generated Run also waits for the timeline's accepted public initial-load
admission, just as the exact native binding does. Painting a title is not proof
that registration has committed. The connection-loss fixture observes the real
list completion and positive native geometry before its gesture, then retains
the same late-acknowledgement retirement and no-visible-commit assertions. A
separate controlled-admission case proves an early disabled gesture prepares no
private ticket or host, while the admitted gesture starts exactly once. No
forced scrolling, media override, retry or deadline expansion supplies readiness.

## GPU-less Linux runner

`nativeVisualizationFixturePolicy.ts` selects the pinned full GLES SwiftShader
driver only for the comprehensive, synthetic ranked-bar and font entrypoints on
Linux. An exact retained private bar replay and every other host retain their
ordinary driver. Conflicting switches, unsafe WebGL fallback, disabled GPU or
renderer sandboxing, in-process GPU and late configuration are refused.

Before source execution the fixture must observe the native GPU process's exact
driver tuple, `sandboxed: true` and `inProcessGpu: false`. Requested switches and
page-owned canvas properties are not substitutes for that observation. This CPU
JIT graphics path is confined to trusted committed fixtures; it adds no production
graphics fallback or new permission. The existing Linux sandbox-helper setup is
confined to the disposable hosted runner, never a user's machine.

Preserve bounded raw child stdout/stderr before diagnosing failures. Only exactly
qualified native diagnostics may be classified as expected; SSL/GPU/unknown
errors remain failures. Pinned Linux Chromium logs its exact “Crashing because
hung” FATAL when Electron deliberately retires an exclusive renderer. Bar/font
fixtures may classify that message only once for each positively observed exact
native crash-request PID followed by successful same-generation retirement and
actual gone/destroyed state. Merely matching a message, an early crash, a foreign
PID, a duplicate, or a missing/uncertain witness never qualifies. The observer
preserves the original native call, receiver, arguments, errors and retirement
Promise; it does not request a crash or alter production process policy.

Clipped-capture failures retain a finite tuple describing
the exact zoom/DPR, expected/reported/encoded dimensions, sample channels and
capture outcome, plus the exact synthetic guest PNG when available. An absent
image or unobserved phase is not evidence of a particular cause.

## Replay and delivery boundaries

Use existing dependencies, with the repository-pinned standalone Node on PATH:

```sh
corepack yarn workspace @cafecode/shared test src/visualizationFonts.test.ts src/visualizationFluidRuntime.test.ts
corepack yarn workspace @cafecode/web test:browser src/components/visualizations/VisualizationCommitChart.browser.tsx src/components/MermaidFamilies.browser.tsx
corepack yarn workspace @cafecode/desktop test src/visualizations/nativeVisualizationFixturePolicy.test.ts src/visualizations/NativeVisualizationElectron.e2e.test.ts
CAFE_CODE_VISUALIZATION_E2E=1 corepack yarn workspace @cafecode/desktop test src/visualizations/NativeVisualizationElectron.e2e.test.ts
CAFE_CODE_VISUALIZATION_E2E=1 CAFE_CODE_VISUALIZATION_FONT_REPLAY=1 corepack yarn workspace @cafecode/desktop test src/visualizations/NativeVisualizationElectron.e2e.test.ts
```

Linux runs the opt-in native commands under the workflow's existing Xvfb runner.
Do not copy that hosted OS setup to a developer machine. Full formatting, lint,
typecheck, default and browser suites, the copied MCP bridges and the final forced
desktop build remain required; focused tests do not replace those gates.

Failure artifacts contain only the two named synthetic browser fixture screenshot
directories and allowlisted synthetic native guest PNGs in exclusively prepared
runner-temp directories. They exclude the user chart replay, source/JSON, profiles
and parent screen, have seven-day retention, and never qualify a release.

Bind delivery to the exact push event, `dev` head and run. All three platform
Quality jobs, native artifact targets, Linux AppImage qualification and the four
nonempty unexpired matching release artifacts must pass. Local macOS evidence
does not qualify Windows/Linux or manual parent-compositor and original
publication phases. Preserve raw failures and their byte counts/SHA-256 before
diagnosis; do not guess a production fix or weaken deadlines, workers, assertions
or sandbox permissions to turn an incomplete observation into a pass.
