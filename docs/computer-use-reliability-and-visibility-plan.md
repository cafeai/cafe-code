# Computer-use reliability and visibility implementation plan

Status: implementation complete; available native fixtures, required repository checks and final forced desktop build passed.

This is the continuation checkpoint for the October 12, 2026 computer-use
evaluation. Read this file after compaction, then re-read the applicable
`AGENTS.md` guidance and inspect the working tree before editing. Continue the
authorized implementation without asking the user to approve this plan again.

## User decisions and scope

- Improve computer-use reliability first. Implement visibility after those
  changes have been qualified.
- Address the problems found while controlling Lightcraft: real-pointer
  displacement, interference with concurrent human desktop use, ineffective
  accessibility substitution for coordinate clicks, slider verification,
  poorly rendered action schemas, opaque validation errors, misleading input
  diagnostics, unsupported verification predicates, and redundant observation.
- Add a persistent macOS menu-bar indicator and an indicator attached to the
  target window, with clear activity, target, provider identity, and Stop.
- Improve Cafe's existing computer-use status presentation using the same
  authoritative activity state.
- Do not implement cloud-delivery confirmation or a "what was shared" panel.
  Do not add screenshot thumbnails, capture-history panels, or persistent
  screenshot logging as part of this work.
- Keep the existing screenshot-based observation model. Do not start a
  continuous capture stream merely to obtain a macOS system recording icon.
- Retain macOS-only native control, Codex/Claude support, privacy redaction,
  exact-window routing, active-turn admission, exclusive ownership, and the
  prohibition on replaying uncertain physical input.

## Repository and baseline

Repository: `/Users/salt/sync2/work/cafe-code`.

The working tree already contains extensive user changes. In particular,
`NativeControlHost.ts`, its tests, `NativeDaemon.ts`, its tests, `AGENTS.md`,
`docs/decisions/computer-use-interface.md`, and the native driver patch/policy
are already modified. Preserve those changes. Do not reset, stash, clean,
overwrite whole files, or treat the existing native patch as pristine.
Record the starting diff before implementation and review the final diff
against that baseline. No implementation edits were made during the review.

Native runtime reviewed:

- Cua Driver 0.34.0.
- Source commit: `b0968e1b12834e485dda68789541a3cc57664a9f`.
- Starting patch SHA-256:
  `82aa6e61228252cdb3a540e06acc9c22d05e4d11c8d507d2df7fdcfa23fa6681`.
- Starting executable SHA-256:
  `cfc40307ce40f0642ebea8720b28cda8977a92b99e4748c923964443291dc300`.
- The source checkout used to build that runtime is currently
  `.explorations/cua-driver/source-HP5yZ7/libs/cua-driver/rust`.
  Recover the current source location from the runtime's
  `dependency-metadata.json` (`workspace_root`) rather than assuming that
  temporary directory remains the active build forever.
- Native fixes must be incorporated into `native/cua-driver/local-only.patch`,
  with the reviewed policy/hash in `build.json`, a rebuilt runtime, and updated
  qualification documentation. Editing only the ignored checkout is not a
  deliverable. Retain existing patch changes and notices.

Review validation already completed:

```sh
corepack yarn test --filter=@cafecode/desktop --filter=@cafecode/shared -- NativeComputerSession.test.ts NativeControlActions.test.ts NativeControlHost.test.ts nativeControl.test.ts
```

Result: 95 tests passed. These are isolated fixtures, not qualification of
concurrent human desktop use. Read-only Node checks also reproduced rejected
action payloads and inspected the generated JSON Schema.

## Confirmed findings and implementation anchors

Rust paths below are relative to the pinned checkout's `libs/cua-driver/rust`.

1. **Real mouse movement and incomplete restoration.**
   `crates/platform-macos/src/tools/click.rs` around lines 1208-1266 selects
   the foreground HID click helper. `input/mouse.rs` around lines 80-101
   calls its implementation with `preserve_cursor: false`; around line 148
   it warps the hardware pointer. `input/skylight.rs` around lines 861-909
   restores the previous frontmost process, but does not restore the pointer.
   A cursor-preserving helper already exists. Restoration alone still causes
   a transient warp and must not override intervening human input.
2. **Focus ownership is not aware of human input.**
   `window_change_detector.rs` around lines 254-271 installs wildcard focus
   suppression. `focus_steal.rs` around lines 330-350 matches other app
   activations and around lines 498-520 reactivates the saved app. An
   intentional human app switch can match the same rule. Foreground restore
   also needs to respect a human focus change during dispatch.
3. **Coordinate intent can be lost.**
   `tools/click.rs` around lines 1049-1101 replaces a background coordinate
   click with an AX hit-test and `AXPress`; AX success causes an early return.
   This did not move Lightcraft's color-wheel marker. Coordinates inside a
   custom control cannot be represented by an arbitrary semantic press.
4. **Numeric value verification uses the wrong reader.**
   `tools/set_value.rs` around lines 399-438 reads `AXValue` with
   `copy_string_attr`, which rejects `CFNumber`. Observation uses
   `copy_stringish_attr` in `ax/tree.rs` around line 463. Consequently, the
   mutation result says "unreadable" while the observation shows the value.
   Fixing the reader does not prove that Lightcraft accepts an AX write.
5. **Source schemas are typed; their model-facing rendering is degraded.**
   `packages/shared/src/nativeComputer.ts` defines nine action variants.
   Its generated schema puts bounds in `allOf` on typed strings/arrays. The
   tool declaration shown to the model rendered `actions` and some IDs as
   `unknown & unknown`. This is a publication/consumer compatibility issue;
   the precise downstream converter has not been identified. Do not describe
   the source API as untyped or assume missing `$defs`: this schema has none.
6. **Validation diagnostics are discarded.**
   `NativeControlHost.ts` around lines 408-413 replaces all validation
   failures with "Unsupported desktop tool or reserved arguments." The
   decoder has a useful path, e.g. `["actions"][0]["x"]`. Bound actions use
   `type: "type"`, `type: "key", keys: [...]`, and `point: { x, y }`.
7. **Background-only intent cannot be expressed through the bound API.**
   `ComputerAct` exposes only target/actions/view/query/full. The lower-level
   `NativeControlActions.ts` around lines 246-275 defaults to allowing
   foreground recovery after specific before-input refusals. High-level
   text replacement, web keys, paste, and native drag can explicitly choose
   foreground routes. A policy must cover those paths and advanced calls.
8. **Diagnostics conflate activation, transport, and causality.**
   Window-scoped foreground scroll in `tools/scroll.rs` around lines 527-578
   activates the app but uses PID-routed wheel events. It emits
   `path: "cgevent_fg"`, which `cua-driver-core/src/action_record.rs` around
   line 786 classifies as global HID. This is not proof that scrolling warped
   the hardware pointer. The window detector compares global inventories and
   says "Action caused/opened" without establishing causality.
9. **Verification contract and latency need cleanup.**
   `cua-driver-contract/src/verification.rs` publishes element existence as a
   boolean; `cua-driver-core/src/expectation.rs` around lines 354-360 always
   rejects `element.exists: false`. The native window detector defaults to
   one-second post-action polling; Cafe does not override that budget.
   `NativeComputerSession.observe` around lines 342-373 adds settling scans
   and potentially a final screenshot read. Cursor animation can also be
   awaited before input. Measure these stages before changing budgets.

## Phase 1: control reliability

### 1A. Enforce input policy and respect concurrent human activity

- [x] Introduce a validated input policy that can enforce background-only
      operation at the host and bound interface. Cover explicit foreground
      choices, automatic fallback, advanced/legacy operations, and composites.
      A model argument must not weaken a host/user restriction.
- [x] Preserve the user's established functionality-first compatibility where
      foreground recovery is permitted. Do not silently remove necessary
      native functionality. Make the effective policy and route explicit.
- [x] Add native ownership tracking for physical human input and focus changes.
      Distinguish controller-generated events from external input using a
      reviewed event marker/monitor. Human activity supersedes restoration.
- [x] Narrow wildcard suppression; avoid bouncing a deliberate human app switch
      back to an old process. Fence restoration by operation generation and
      current ownership, and preserve exact prior-window identity where proven.
- [x] For window-scoped foreground clicks, restore the prior pointer only after
      the target has had time to consume the event and only if no human pointer
      movement intervened. Handle errors without replay or stale restoration.
      Explicit desktop gestures may retain their intentional pointer movement.
- [x] Keep cancellation, timeout, disable, and owned-helper cleanup guarantees.
      A native ownership failure must not send input to a different window.

Acceptance: background-only requests never activate or warp the pointer;
permitted foreground actions do not leave it displaced when ownership remains
unchanged; concurrent human app switches/movement are not undone. No uncertain
action is repeated to obtain a nicer result.

### 1B. Preserve coordinate intent and verify values accurately

- [x] Add an explicit input-route preference to the relevant contract and native
      patch. Preserve screenshot-point intent for pointer-dependent controls;
      keep semantic AX actions for suitable element targets. Validate exact
      window/capture ownership before every route.
- [x] Do not promote `AXPress` success into application-effect confirmation and
      do not automatically replay a possibly consumed AX action as a pixel click.
- [x] Use typed/stringish value reading consistently for numeric mutation
      verification, including stepping fallback. Reuse numeric tolerance logic.
- [x] Report before/requested/observed values and whether the value changed,
      while preserving the distinction between an AX echo and application
      acceptance. Keep unsupported/unchanged writes informative.

Acceptance: coordinate clicks can adjust a disposable color-wheel/canvas
fixture; numeric and boolean values are not mislabeled unreadable; unchanged
AX writes remain unconfirmed and do not cause duplicate input.

### 1C. Repair API discoverability, diagnostics, and observation overhead

- [x] Normalize compatible generated schema constraints into direct constraints
      without weakening validation. Preserve action unions and any future
      definitions. Add concise examples of type/key/point actions.
- [x] Test published tool schemas and their provider-visible representation.
      Treat successful backend validation as insufficient publication evidence.
- [x] Return curated validation codes, paths, and expected shapes. Never echo
      typed text, clipboard contents, credentials, or arbitrary raw arguments.
- [x] Separate target activation, actual transport, physical pointer movement,
      dispatch acknowledgment, and observed effect in diagnostics. Correct
      foreground-scroll labeling.
- [x] Describe global window/focus changes as observations with unknown
      attribution unless the operation actually proves causality.
- [x] Advertise only supported element-existence predicates (true), retaining
      separate window semantics. Support absence later only with coverage proof.
- [x] Measure cursor wait, native detection, AX scans, and screenshot time.
      Consolidate duplicate settling/observation where evidence permits it.
      Configure native budgets explicitly and preserve fresh grounding,
      asynchronous-operation support, and truthful partial/truncation metadata.

Acceptance: an agent can discover and batch valid actions without guessing;
errors identify the invalid shape; route diagnostics match dispatch code;
ordinary operations use fewer redundant observations without hiding failures.

### 1D. Qualify and document Phase 1 before proceeding

- [x] Add isolated regression tests for policy enforcement, human-input races,
      route selection, numeric values, informative validation, diagnostic
      accuracy, and observation budgets.
- [x] Extend opt-in native tests using disposable fixtures for renderer input
      acceptance, point clicks, pointer restoration, fresh handles, Stop and
      background-only refusal. Default tests do not operate user apps, use
      credentials, or invoke paid inference. Exact-window/focus and external-input
      cancellation logic is covered by isolated ownership/host tests; physical
      concurrent-input acceptance remains a manual qualification limit.
- [x] Preserve and extend the reviewed native patch, update its hash/policy,
      rebuild and verify the runtime. Do not change the upstream source pin
      unnecessarily or re-enable telemetry/update facilities.
- [x] Update the Native Desktop Control guidance in `AGENTS.md`, the interface
      decision, and native README to reflect the final behavior.
- [x] Run the repository-required checks described below and record actual
      results/limitations here before moving to visibility.

## Phase 2: visible computer-use activity

### 2A. Build one authoritative activity state

- [x] Add a bounded, versioned, session-local activity contract separate from
      controller availability. Include owning chat/provider, target app/window
      or display scope, idle/reading-controls/capturing/controlling/stopping
      state, actual input route, and last-capture time where known.
- [x] Derive it from admitted host/native execution, not model-written labels
      or redacted work-log prose. Capture events must cover local internal
      screenshots as well as screenshots included in results. Do not attach
      capture bytes, typed input, or clipboard contents to the activity feed.
- [x] Publish transitions through trusted desktop IPC with generation/sequence
      fencing. Avoid polling `host.state()` on every animation frame: that path
      currently verifies the runtime. Use one shared cached activity feed.
- [x] Provide destination disclosure from the actual owning provider/configuration.
      Do not claim cloud acknowledgment, continuous recording, or exact upload
      confirmation. Do disclose that window images and controls can be supplied
      to the selected provider.

Anchors: `NativeControlHost.ts`, `NativeComputerSession.ts`, native capture and
input hooks, `packages/contracts/src/ipc.ts`, desktop IPC/preload, and the
provider-session binding. Existing UI notifications currently primarily report
enable-state changes, not operation/capture transitions.

### 2B. Native menu-bar item and target-window indicator

- [x] Show a Cafe-owned native menu-bar item throughout an active computer-use
      episode, including idle gaps. It must remain useful with Cafe minimized
      or another app frontmost. Show target, provider, current activity, Stop,
      and a route back to the owning chat.
- [x] Show a thin target outline and compact provider/activity badge before
      observation/input. Follow movement, resize, visibility, Spaces, closure,
      and target changes without activating the target or stealing input.
- [x] Make the border click-through. If the window badge has Stop, use a bounded
      nonactivating interactive control surface. Exclude all indicator windows
      from desktop/window captures and avoid accidental agent selection of them.
- [x] Use text/icons as well as color; honor reduced motion/transparency. State
      names should distinguish idle, reading window controls, taking a screenshot,
      controlling, and using the real mouse when that route actually applies.
- [x] Show the true capture scope. A whole-display operation must not appear to
      be limited to the previously selected application window.
- [x] Add immediate Stop through trusted host revocation. Show stopping until
      cleanup is acknowledged; fence stale Stop actions and cleanup to the exact
      episode. Keep existing fail-closed/re-enable behavior after interrupted input.
- [x] Initialize visible status before capture/input can proceed. Account for
      indicator failure and helper/renderer death without continuing silently.
      Do not add a per-capture confirmation dialog.

The current native capture path uses `SCScreenshotManager`, not a persistent
`SCStream`. A custom menu-bar item is the Phase 2 solution. Native
`SCContentSharingPicker`/stream integration is a possible future project, not
part of the authorized implementation here.

### 2C. Cafe status, cleanup, and visibility qualification

- [x] Update the existing computer-use UI to consume the same activity feed and
      show the owning target/provider, rather than only permission on/off.
      Keep this compact; no capture-history or "what was shared" panel.
- [x] Retire the menu item, outline, badge, and activity generation consistently
      on release, end-turn, disable, helper failure, timeout, and quit. A later
      episode must not inherit stale target/status or be cleared by old callbacks.
- [x] Add isolated main-process, IPC, reducer, and browser tests for transitions,
      races, Stop, target changes, failure, accessibility, and provider labeling.
- [x] Qualify menu-bar/overlay behavior through explicit native fixtures:
      tray-only host without a main window, capture/provider/pointer status,
      nonfocusable panel, resize, occlusion and recovery, fullscreen WindowServer
      presence, pointer restoration and exact Stop. Single-display live evidence
      is distinct from unit/mock exclusion and arbitrary Spaces/monitor/human
      qualification; remaining manual cases are recorded below.
- [x] Update architecture/docs and run all required checks.

## Required verification and completion rules

- Use repository-pinned Yarn 4.17.1 through Corepack and Node for JS/TS.
  No alternate JS runtime or package manager.
- After software changes, `yarn fmt`, `yarn lint`, and `yarn typecheck` must pass.
- Run tests with `yarn test`; use focused Yarn/Turbo tests during development,
  then complete the required test run. Separate opt-in native/provider tests
  from the ordinary suite and report their coverage honestly.
- After tests, run `yarn build:desktop --force` as the final verification step.
  Rust builds may be slow; do not prematurely terminate them.
- Re-read current `AGENTS.md` if provider lifecycle changes become necessary;
  those require review of current official docs and the pinned local source.
- Do not restart the user's desktop or manipulate user apps merely to qualify
  a fixture. Never push to `dev` without confirmation for the exact changes.
  Any authored commit must follow `type(scope): imperative summary`.
- Keep this file's checkboxes and continuation notes current. On completion,
  report changes, evidence, and material native qualification limitations.

## Implementation evidence and continuation checkpoint

October 12 final implementation checkpoint:

- All reliability and visibility code is implemented. Available native fixtures
  and final required checks passed. Remaining manual/hardware qualification
  limits are recorded below; no implementation task remains pending.
- Starting user changes remain preserved in ignored
  .explorations/computer-use-implementation/starting.patch and
  starting-status.txt. Incremental tracked changes were compared to that baseline
  using a disposable Git index; unrelated user changes remain intact. Never reset
  the working tree or adopt the running Cafe
  app's helper. No provider protocol/configuration or upstream pin was changed.
- Reliability: host/request input policy, whole-batch and per-subcall preflight,
  point/element route intent, typed AX receipts, safe validation paths, normalized
  schema publication, PID wheel diagnostics, supported element-presence schema,
  nonblocking cursor and explicit 100 ms/25 ms observation budget. Bound reads
  report elapsed/sample counts and keep bounded settling/fresh pixel grounding.
  Overall native fixture latency/call count was measured; fine-grained capture/AX
  profiling and live provider schema rendering remain outside this evidence.
- Native ownership: passive event provenance/epoch only, per-helper marker,
  exact foreground target guards, human-priority restoration, guarded Unicode
  and long drags, release of dispatched pairs, removal of global wildcard focus
  suppression, and launch/menu restoration fencing. Pure tests cover external
  input, unavailable monitor and changed process/window. Physical-human and
  alternate Spaces/monitor races are not qualified by those pure tests.
- Visibility: host-owned ephemeral episode/sequence/provider/target feed,
  persistent native menu item, nonactivating click-through border/badge, trusted
  background-only toggle, owning-chat navigation and exact Stop. IPC/renderer
  consumers share one cached subscription. Private AX/native and central CDP
  screenshot gates wait for visible status; valid successful captures alone
  advance lastCaptureAt. Exact host CGWindowIDs and cursor are excluded from
  display captures/enumeration. Unsafe fallback is refused. Geometry is a
  separate read-only endpoint and hides occluded/off-screen borders. Indicators
  are auxiliary windows; failures revoke the helper. Real-pointer dispatch (including AX fallback)
  waits for a native visibility ACK and rechecks ownership; native receipts
  refine the selected transport. No capture history or
  cloud-delivery confirmation was added.
- Startup failure before a child exists now closes the private activity channel
  and temporary root. Reverse-socket connections/frames/identity arrays are
  bounded, authenticated and metadata-only.
- Native changes live in .explorations/cua-driver/source-HP5yZ7/libs/cua-driver/rust
  and are delivered cumulatively through native/cua-driver/local-only.patch.
  Build policy/hash updated; fresh pinned-source preparation passed with
  the release target cache source-mhFfRs. Binary/patch hashes match the runtime
  manifest and the actual 39-tool catalog has been synced. Cargo/libgit2 fingerprint failures were
  fixed by materializing pinned root .gitignore in the sparse checkout.
- Rust unit suites passed after the final browser/ownership changes: 61 contract,
  839 core and 466 Mac tests (6 explicitly ignored). New mock-CDP tests prove
  visible-status ordering/refusal and no successful-capture event for malformed
  image data. No user-app input or providers are involved in default tests.
- Final native rebuild passed and actual catalog was synced. Rust suites passed:
  61 contract, 839 core and 466 Mac tests, with 6 explicitly ignored. The latest
  added regressions preserve unknown-window occlusion and constrain cursor peers
  to the current/atomically retired runtime namespace.
- Final native input fixture passed unlocked: exact Unicode insertion,
  replacement, renderer events/submission, off-center canvas point, pointer
  restoration, background-only refusal and fresh handles. It used 23 native
  calls in 10.122 seconds. No user apps, clipboard edits or providers were used.
- Expanded native indicator fixture passed unlocked in 6.88 seconds: capture,
  selected provider, native real-pointer ACK/restoration, nonfocusable panel,
  resizing, occlusion/hiding/recovery, actual fullscreen WindowServer presence
  and exact Stop. The tray-only fixture does not auto-quit when Stop destroys
  its last panel: the parent pipe owns fixture lifetime. After ordinary Stop,
  tool calls receive a control-off error; session capability revocation is a
  separate host lifecycle behavior.
- Live geometry exposed two real classification issues: all-Space stacking
  ranks and layer-zero accessory/cursor surfaces. Use the current visible stack;
  known untitled AX-less accessories are ignored, and cursor peers require exact
  display bounds plus the same current/retired runtime location. No existing
  helper is adopted or terminated. Unknown apps remain possible occluders.
  Geometry refresh rejects older replies; idle restores trusted policy after a
  request temporarily tightens it. Interrupted mouse-up releases at the current
  point rather than warping back to the original click point.
- Earlier GUI failures were caused by the locked desktop: AX/TCC checks could
  succeed while screenshot capture failed, and lastCaptureAt remained unset.
  Unlocking permitted the final fixtures above. Never operate loginwindow or
  restart the user's app to qualify a fixture.
- Final root fmt/lint/typecheck/test passed across all 10 workspaces. Backend
  tests: 4104 passed (1 skipped); web: 2218 passed; desktop: 433 passed (5
  opt-in tests skipped). Final build:desktop --force passed: all 3 build tasks
  executed successfully with no cache hits in 25.757 seconds.
  Focused native host,
  visibility, policy, daemon and activity-channel tests passed (48 tests).
  ComputerUseButton passed in real Chromium with a second chat, shared feed,
  stale sequence, exact Stop and stopping behavior.
- Remaining manual qualification limits: one physical display was available;
  physical concurrent human input, arbitrary Space switching, multiple displays,
  live browser DOM acceptance and native menu-popup capture exclusion were not
  qualified. Unit/mock tests cover ownership races, negative display geometry,
  capture-ID exclusion and central CDP capture ordering/failure. The GUI test
  does not assert pixel-level full-display exclusion. These limits do not imply
  missing implementation and must stay explicit in the final report.
- Documentation now reflects the final behavior in AGENTS.md,
  docs/decisions/computer-use-interface.md and native/cua-driver/README.md.

All logs and transient evidence: .explorations/computer-use-implementation/.
