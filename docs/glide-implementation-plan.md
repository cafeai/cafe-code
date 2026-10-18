# Glide implementation plan

Glide provides computer use inside ordinary Cafe chats on macOS. A user
enables desktop access for a chat, and the agent uses persistent JavaScript to
observe and operate exact applications selected from trusted native metadata. Background
control preserves the human foreground application and pointer. Cafe Stop,
permission revocation and provider replacement retire the exact admitted work.

This plan extended the kernel, MCP facade and root AppKit backend into a managed
Cafe feature. Implementation and qualification status were reconciled on
October 17, 2026; external qualification gaps are listed below.
It does not require a browser extension. In-app browser and audio APIs are
separate extensions. Implementation does not restart Cafe or publish a release.

## Acceptance criteria

1. A normal supported provider session discovers Glide without manual MCP
   configuration. Disabled Glide and sessions without current Full access cannot
   execute its JavaScript or native operations.
2. App access is chosen by the authenticated user for the exact Cafe chat.
   Model-supplied app names, window IDs and JavaScript cannot expand that grant.
   Changing access revokes old queued work and observations before new admission.
3. Each live provider owner has an independently persistent kernel. The native
   host serializes desktop operations and partitions observations by exact
   server-minted session generation. A stale owner cannot reset or act through a
   replacement owner's session.
4. Stop, disconnect, revocation, deletion and owner replacement cancel their
   exact queued and active work. Cancellation of queued work cannot interrupt
   another owner's active operation. Already-dispatched input is never replayed.
5. Window discovery supports explicit selection and refuses ambiguity. A window
   that has no AX handle may expose a truthful image/coordinate observation only
   when exact process birth, window identity and geometry are established.
   Missing AX handles never become invented element indices.
6. Background journeys cover normal and off-Space windows, native text controls,
   menus/popups and hosted recipients. Actual target effects, external foreground
   process generation and the physical pointer are verified. Hidden/minimized or
   changed targets do not become permission to act on another window.
7. Fresh observations and bounded settling handle normal UI changes. Stale
   references refuse or recover only to a uniquely verified current target.
8. The desktop package includes the native helper and bridges. Permission status
   identifies Accessibility and Screen Recording separately. Opening a permission
   pane or requesting permission is an explicit user action. Release builds use
   the repository's Developer ID, hardened-runtime and notarization pipeline.
9. Synthetic policy/session tests, native browser UI tests, isolated process
   tests and explicit native application journeys qualify their respective
   boundaries. A missing real credential, OS permission or signing identity is
   recorded as an external qualification requirement, never a synthetic pass.

## Architecture

The provider-owned Glide session broker mints a private session MCP bridge using
the existing Cafe session-file and authenticated daemon mechanisms. Tools carry
no model-chosen Cafe thread, account or session identity. The broker checks the
current provider owner, thread access policy and app grant on every execution and
again before native dispatch.

Each session owns a disposable persistent ESM worker. A Cafe-managed native host
owns one Swift child, one global native lease and one serialized request lane.
Trusted envelope session IDs partition native snapshots. Host replacement
invalidates observation proof, while kernel bindings may survive only where
their current session authority remains valid. An action requires a current
observation from that host generation.

The standalone `cafe-glide` stdio entry remains available for development.
Canonical model API is `glide` from `@cafecode/glide`; existing `cua` and `sky`
compatibility facades share the same authorization and observation path.

## Work packages

### A Native window and observation backend

- Add `list_windows`, explicit `windowId` selection and bound window identity.
- Correlate AX, CGWindow and capture inventories using exact PID/birth/ID/frame.
- Implement truthful image/coordinate fallback when AX is unavailable.
- Add trusted session envelope and exact session retirement; keep indices
  monotonic within a host generation and bound session/snapshot counts.
- Complete hosted recipient and menu/focus routing from audited native evidence.
- Add bounded observer invalidation/settling and preserve refusal on ambiguity.
- Qualify owned ordinary/off-Space and hosted/popup fixtures without disturbing
  the human's foreground or changing global accessibility preferences.

### B Shared host and persistent workers

- Separate worker lifetime from native connection lifetime.
- Add a bounded, serial native host with exact session/cell ownership.
- Cancel exact active work, invalidate host-generation observations after native
  restart, and reject stale queued continuations and cross-session resets.
- Validate app selectors against the current chat's allowed app inventory before
  any AX/image/input dispatch.

### C Cafe authority and provider attachment

- Persist per-chat preferences separately from ephemeral session credentials.
- Mint inactive bindings, activate only after the provider owner wins admission,
  and revoke before replacement/cleanup can wake new work.
- Reuse private stdio MCP files and loopback/daemon audience isolation.
- Integrate the existing supported MCP startup mechanisms for Codex, Claude and
  Grok; keep unsupported providers explicit rather than silently exposing a tool
  that cannot run.
- Wire actual Stop and lifecycle retirement to Glide cancellation. Preserve
  existing provider launch arguments, account scopes and idle/admission guards.

### D Chat controls and permission status

- Provide a cursor-icon **Computer use** on/off button immediately after the
  thinking-level control, outside the composer overflow menu. Persist the exact
  per-chat desktop grant and revoke owned work when switched off.
- Show enabled/disabled/working/busy/unavailable status and app selection.
- Fetch only app metadata for selection; no capture or input before enablement.
- Provide explicit permission-status refresh and native Settings navigation.
- Test real UI enablement, app choices, revocation, Stop and locale text using
  provider-owned browser contexts and the existing worker/deadline policy.

### E Delivery and native qualification

- Resolve the helper from trusted source/packaged assets, never renderer paths.
- Include bridge/worker/helper assets in desktop packaging and native signing.
- Add an opt-in real-editor journey using only a test-owned temporary document
  and exact newly launched process/window identity.
- Keep provider acceptance and real signing/notarization qualification separate
  from isolated fixtures; use available credentials only for authorized tests.

## Implementation order and status

| Package                   | Implementation status                                                        | Evidence                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Native backend          | Implemented; native journeys qualified on macOS 27.0.1 arm64                 | Full AX/PNG and AX-only AppKit journeys; real popup coordinate/keyboard and context selection; framed/unframed hosted file acceptance; private TextEdit; window/session invalidation; earlier off-Space capture/input; actual key-rescue transport. Raw callback-time focus events were not emitted in these journeys. |
| B Shared host/workers     | Implemented and qualified in isolation                                       | Independent persistent kernels, queued/active cancellation, transport failure without replay, grant recheck, generation invalidation, bounded queues/workers and sticky uncertain cleanup tests.                                                                                                                       |
| C Cafe/provider authority | Implemented; isolated authority and actual managed-tool acceptance qualified | Durable SQL grants, owner replacement/revocation, Codex adapter lifecycle and startup, Claude SDK/Grok ACP attachment/disposal, real stdio/HTTP/worker pipelines and actual Claude/Codex/Grok metadata acceptance.                                                                                                     |
| D Chat controls           | Implemented and browser-qualified                                            | Four native browser tests cover app choices, enable/save/Stop/disable, Full-access and permission gates, explicit Settings buttons, late old-chat response retirement and composer entry. English/Japanese/Korean copy.                                                                                                |
| E Delivery/qualification  | Assets and packaging integrated; signing excluded from follow-up             | Source helper compilation, bridge/worker bundle assertions, release staging and native artifact audit. Actual Claude/Codex managed metadata acceptance passes; Grok passes the finished-response/challenge probe. Developer ID/notarized release qualification is excluded from this follow-up.                        |

The planned implementation is connected end to end. Criterion 6 has actual
ordinary-desktop, private TextEdit and inactive ordinary-Space native evidence
on macOS 27.0.1 arm64. The off-Space journey starts with no AX handle, uses real
window PNG/coordinate input, verifies exact Unicode/key/button/scroll effects,
and preserves foreground, pointer and active display Space identities. Real
PID-key rescue transport and metadata-only two-process app-picker checks also
pass independently. Complete live menu/hosted acceptance remains in progress;
these results do not qualify arbitrary photo editors or other OS releases.
Newly created auxiliaries now have a bounded callback-time proof path, with no
guessed input or suppression authority when proof is missing or late.

Criteria 8–9 distinguish packaging policy from real signed-release permissions
and notarization. Actual authenticated metadata acceptance now passes for Claude,
Codex and Grok; signed-release qualification remains excluded. Windows/Linux native control,
browser-extension communication, browser automation and audio were not added.
See [Glide usage and qualification](glide.md) for the current interface, bounds,
test commands and evidence paths.

## Follow-up: remaining desktop behavior, excluding signing

The October 17 follow-up requests completion of the remaining live behavior,
including off-Space input, real menus and hosted dialogs, incoming helper focus
recovery and real provider acceptance. Signing and notarization are excluded
from this follow-up. Existing no-restart and native ownership constraints remain.

- Off-Space qualification must verify exact inactive ordinary-Space membership,
  initial/final real PNGs, coordinate and Unicode/key effects, and unchanged
  foreground process, physical pointer and active display Space IDs. A missing
  safe target Space requires user setup; a fullscreen human Space is not a test
  destination.
- Popup/context-menu qualification must observe the real opened menu and its
  actual selected item, including addressed coordinate input. Hosted dialog
  tests use a fresh private application and document, never an existing user
  picker or document.
- A newly created auxiliary requires an exact logical-root/actual-process proof
  within the first relevant focus event's finite allowance. Process names alone
  grant no authority. Late proof/tap work cannot publish after expiry or owner
  retirement; the callback must not hold the focus lock while resolving AX.
- Real provider qualification must exercise an actual model call through the
  managed stdio/HTTP/broker/worker/native metadata path. Use fresh bounded normal-
  auth sessions with only the intended Glide probe, no UI input, no global MCP
  changes and no automatic paid retry. Synthetic transport tests remain separate.

The implementation is complete for the scoped macOS feature. Native evidence
and the explicit remaining qualification boundaries are recorded below. Release
signing/notarization and a restart of the running Cafe instance are excluded.

### Follow-up verification checkpoint, October 17

- Actual off-Space input/capture, two-process metadata selection, PID key-rescue
  transport, Claude Agent acceptance and Codex acceptance passed. Their evidence
  and boundaries are recorded in `glide.md`.
  The final Space preflight has one active ordinary desktop and one fullscreen
  Space, with no inactive ordinary target. Off-Space qualification retains its
  earlier real pass; this ordinary-desktop follow-up never creates or switches
  Spaces. `.logs/glide-space-preflight-final.json` records that boundary.
- The complete ordinary-desktop batch passes ten tests in five files: popup
  coordinate and keyboard selection, context-menu selection, framed and
  unframed hosted file pickers, both all-method background AppKit journeys,
  window/session isolation and invalidation, private TextEdit and native key
  rescue. `.logs/glide-native-acceptance-final.log` records the full run.
  One earlier TextEdit attempt hit the strict ownership fence; a fresh isolated
  run and the complete batch subsequently passed. The old refusal's cause is
  unproven. Native and fixture diagnostics were improved without relaxing the
  exact private-process/window requirement or replaying the failed action.
- Native fixes include exact owned menu binding rather than an inherited
  parent ID; motion/down/held-drag/up menu tracking; restoration of borrowed AX
  timeouts; exact raw-ID WindowServer descriptions without z-order assumptions;
  explicit AX sheet selection; and hosted coordinate routing through a uniquely
  observed, freshly validated AX leaf under the selected window. All original
  process-birth, grant, ancestry, activity and desktop fences remain.
- Screenshot review found parent chrome and letterboxing in sheet captures.
  Capture now verifies the attached window family and observer generations
  before and after the read, captures within the original 2048-pixel ceiling,
  and normalizes the result to the selected native window's bounds. The private
  picker PNG was visually checked against its AX/input geometry. Pure tests
  reject out-of-family and unbounded crop metadata. Observation retries share
  the original two-second allowance; input is never replayed.
- Whole-repository typechecking and lint pass. The six explicit kernel/pipeline/
  native-policy files pass 22 checks, Glide's native browser file passes four
  checks, and the ACP client/protocol files pass all 28 checks after the final
  JSON-RPC fixture correction. The handler-failure case uses the actual wire
  decoder/dispatcher with exact receipts before and after a failed handler;
  other tests retain native child coverage. Worker caps/deadlines are unchanged.
- Grok passed the final production Full access probe at 14:19 (9.58 seconds).
  It requires actual HTTP catalogue/finished-js receipts and an unpredictable
  worker-generated challenge repeated by the model, exactly one admitted
  program/native list and zero blocked native actions. Sparse ACP presentation
  fields do not grant proof. `.logs/glide-live-grok-challenge.log` records the
  completed pass; Claude/Codex retain their earlier scoped acceptance evidence.
- Both private pickers use actual hosted keyboard/pointer input and accept only
  the exact temporary file. The unframed journey additionally requires a service
  born after the pre-dispatch timestamp. Service birth alone does not prove a
  focus-theft notification: neither journey emitted one on this host. The
  callback-time recovery branch retains pure deadline/ownership tests without
  a fabricated native-event pass. An observed notification requires actual
  admitted proof. Unknown/late evidence cannot expand authority.
- Cafe controls have four passing native browser checks. Synthetic SQL/session/
  adapter tests, the real stdio/HTTP/worker pipeline, actual provider metadata
  acceptance and native application effects qualify distinct boundaries. The
  running Cafe process was not restarted; these are not a claim of one
  uninterrupted manual chat/UI/provider/editor journey in that old process.
- The full `yarn test --concurrency=1` passes all ten ordinary workspace tasks,
  keeping each task's original workers and deadlines. Fresh Node starts normally;
  earlier pre-entry host stalls remain unexplained. The final ordinary native
  run passes all ten tests in 35.15 seconds after capture-family membership
  revalidation. Formatting, lint and typechecking pass. The final full test run
  passes all ten tasks in 3m52.781s, followed by the required forced desktop build
  passing all three build tasks in 30.127s. The build was the last verification
  step. Exact receipts are listed below; Cafe was not restarted or published.

Current logs are `.logs/glide-completion-{fmt,lint,typecheck,test}-current.log`,
`.logs/glide-acp-corrected.log`, `.logs/glide-pipeline-policies-final.log`,
`.logs/glide-control-browser-current.log`, `.logs/glide-capture-family-build.log`,
`.logs/glide-native-acceptance-final.log` and
`.logs/glide-completion-desktop-final.log`.

## Required verification

Use the repository-pinned Node and Corepack Yarn. Start heavy commands with
`nice -n 10`; preserve worker caps and deadlines. Default tests remain synthetic
and do not contact a provider. Native/provider application journeys are explicit
opt-in commands. After relevant focused checks and required browser/native
qualification, run `yarn fmt`, `yarn lint`, `yarn typecheck`, and `yarn test`, then
`yarn build:desktop --force` as the final verification. Do not restart Cafe.

Provider integration references: [Codex app-server](https://learn.chatgpt.com/docs/app-server),
[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
and [Claude Agent SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp), checked
alongside the pinned local provider types on October 17, 2026.

## Action reliability follow-up, October 18

Implemented structured native/model receipts, bounded AX value/focus/selection/text
verification, observed-result reconciliation after unacknowledged writes, targeted
typing including empty replacement, first-event interruption diagnostics, partial
progress through failure/cancellation, bounded coordinate candidates, explicit
installed-app launch and visibility restoration, truthful blocked-action discovery
and bounded read-only startup identity recovery. Legacy native clients retain
error-channel failures until a broker opts into receiptVersion:1. No input replay,
foreground fallback, browser-extension surface or signing work was added.

The implementation and regression fixtures are complete. The current positive
native evidence and outside-input qualification limits are recorded in the
October 18 checkpoint in [Glide usage and qualification](glide.md).
