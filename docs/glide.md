# Glide: computer use for Cafe Code

Glide provides opt-in background desktop control for Cafe chats on macOS. It
uses the architecture reconstructed from the desktop Sky audit: model
JavaScript → persistent ESM worker → trusted session broker → serialized native
Swift host → accessibility text and PNG observations. Cafe owns the code and
does not load OpenAI packages or binaries. Browser-extension communication,
in-app browser automation and audio APIs are outside this implementation.

The [implementation plan](glide-implementation-plan.md) records work packages,
acceptance criteria and qualification boundaries. The implementation includes
chat controls, durable app grants, provider attachment, shared native ownership,
window selection, background input and desktop packaging. Real ordinary-desktop
and off-Space journeys qualify their respective input paths. Hosted-dialog,
provider and release-signing evidence is tracked separately below.

## Use in Cafe

1. Use a new or existing chat with Codex, Claude Agent or Grok on macOS. Select
   **Full access** for Codex or **Bypass permissions** for Claude Agent/Grok.
   Other providers and non-macOS native control are not supported.
2. Click the cursor-icon **Computer use** button immediately to the right of the
   thinking-level control in the composer. The highlighted, pressed button with
   a checkmark means on; click it again to turn it off. This setting is saved per
   chat and persists across relaunches. There is no overflow entry.
   In a new chat, you can enable it before typing or sending the first message.
   The draft retains its own choice across reloads. First-send bootstrap saves
   that exact chat's permission before admitting the provider turn; retries never
   overwrite an explicit permission already saved for the chat. New drafts start off.
3. Enabling grants this chat access to desktop applications, including apps opened
   later. Full access and macOS Accessibility and Screen Recording remain required.
   If either permission is missing, the first click opens **Set up computer use**
   instead of enabling. It lists each permission with its live native status and an
   **Open Settings** action, plus the exact app bundle macOS must list, with **Copy
   path** and (on the local desktop) **Show in Finder** for adding it with **+** when
   it is absent. While the dialog is open, Cafe rechecks status every two seconds
   (for at most ten minutes, then **Check again**) and on returning to Cafe; a row is
   marked complete only when the native check confirms it, never because Settings
   opened. When both are on, **Turn on for this chat** enables the chat (or a new
   draft) that opened the dialog. Closing it changes nothing; click the button to
   return. An enabled chat always turns off directly.
   Status reads never capture the screen or send input.
   Native operations still select an exact running app from fresh trusted inventory
   and launch the helper with a bounded app allowlist, preserving window/process
   identity checks. Existing per-app grants are preserved until the switch changes.
4. Ask the agent to use Glide. Newly opened supported provider sessions include
   the session MCP connection automatically, including an inert catalogue before
   enablement. Execution requires current Full access and an enabled app grant.
   A provider session opened before this integration was loaded gains the
   connection on its next normal session opening.
5. Switching **Computer use** off revokes access, cancels current/queued work and
   discards its JavaScript state. Ordinary Cafe Stop cancels Glide and pauses this
   binding until the next admitted provider message; deletion, archive,
   session retirement, access downgrade and owner replacement revoke the
   affected authority.

The UI supports English, Japanese and Korean. The foreground app and
pointer are preserved by the qualified background journey. Physical mouse or
keyboard activity can interrupt a background operation; read fresh state before
deciding what to do next. Paste uses the shared clipboard.

macOS 14 or newer is required for screenshots. Accessibility and Screen Recording
must be granted to the responsible launching application under TCC. On macOS 27
the former is labelled **Device Control and Data Access** under Privacy &
Security; earlier systems use **Accessibility**. The source desktop bundle is
under `apps/desktop/.electron-runtime/` (for example the Debug profile's
`debug/Cafe Code (Debug).app`); a different installed copy does not identify that
host. The setup dialog's path comes from the helper's `--status --with-host`
report of the TCC _responsible_ process (validated against PID reuse by start
time), falling back to the owner runtime's own executable bundle. A source
desktop started from a terminal rather than LaunchServices is attributed to that
terminal, and the dialog says so by naming it. A stale entry after a development signing identity
change may need removal and re-adding by the user. Glide never edits TCC or
restarts Cafe to repair permissions.

## Model interface

The `cafe-glide` MCP connection exposes two tools:

- `js({code, title?, timeout_ms?})`: persistent JavaScript with top-level await,
  variables, functions, classes and supported static/dynamic imports. Chain
  related actions in one cell using `await`.
- `js_reset({})`: discard this session's worker, bindings and observations and
  cancel its owned native work. Application edits remain.

The default deadline is 30 seconds and the maximum is 60 seconds. Queue time
consumes that deadline. Arguments reject unknown fields. Optional titles are
nonempty, trimmed and at most 80 characters. Observations emit unless emit:false is selected, and actions automatically emit
structured receipts. The final expression is not automatically printed.

```js
import { glide } from "@cafecode/glide";

var apps = await glide.listApps();
var windows = await glide.listWindows("com.apple.TextEdit");
// Choose an ID from the observed inventory, not a guessed ID.
var editor = await glide.getApp("com.apple.TextEdit", { windowId: windows[0].id });
await editor.getAXStateAndScreenshot();
```

`getApp` emits a full AX description and returns an immutable handle bound to
the canonical app path and exact window ID. Omit `windowId` only when native
selection is unambiguous. After inspecting an actual field index, a later cell
can run:

```js
await editor.typeInto(fieldIndex, "café 👩‍💻", { replace: true });
await editor.getAXStateAndScreenshot();
```

`nodeRepl.write(value)` emits text; `nodeRepl.emitImage(bytesOrPngDataUrl)` emits
PNG content. Images are inline bytes, not arbitrary filesystem paths or URLs.
`glide` is global and exported by `@cafecode/glide`. `cua` and
`@cafecode/computer` remain aliases; `sky` and virtual `@oai/sky` expose Cafe's
legacy facade through the same broker.

| Legacy method                                                                              | Current method                                                                                                         | Implementation                                                                                                       |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `list_apps()`                                                                              | `glide.listApps({emit?}?)`                                                                                             | Discover allowed running apps; legacy records contain `id`, `displayName`, `isRunning`.                              |
| `list_windows({app})`                                                                      | `glide.listWindows(app,{emit?}?)`                                                                                      | Return IDs, titles, bounds and on-screen status; aggregate processes only for one canonical app identity.            |
| `resolve_app({app})`                                                                       | `glide.resolveApp(bundleIdOrPath,{emit?}?)`                                                                            | Resolve an exact installed app without launching it.                                                                 |
| `launch_app({app})`                                                                        | `glide.launchApp(selector)`                                                                                            | Request one exact native launch without activation in background mode, then observe its process.                     |
| `restore_window({app,windowId?})`                                                          | `restoreWindow()`                                                                                                      | Write AXHidden on the owning app and AXMinimized on the exact window, then verify state and invalidate observations. |
| `focus_element({app,windowId?,element_index})`                                             | `focus(index)`                                                                                                         | Establish and observe target focus before keyboard input.                                                            |
| `type_into({app,windowId?,element_index,text,replace?})`                                   | `typeInto(index,text,{replace?}?)`                                                                                     | Verify focus and optional replacement selection, post Unicode, then verify readable text.                            |
| —                                                                                          | `glide.getActionReceipts({emit?,clear?}?)`                                                                             | Return copies of the latest 64 receipts in this kernel, including failed steps.                                      |
| `get_app_state({app,windowId?,disableDiff?,includeScreenshot?})`                           | `getAXState({emit?,disableDiffing?}?)`, `getScreenshot({emit?}?)`, `getAXStateAndScreenshot({emit?,disableDiffing?}?)` | Bind process birth, native window/frame and available AX objects; capture the selected window when requested.        |
| `click({app,windowId?,element_index?...,x?,y?,mouse_button?,click_count?,key?,duration?})` | `click(indexOrPoint,options?)`                                                                                         | Eligible advertised AXPress or addressed native mouse events.                                                        |
| `drag({app,windowId?,from_x,from_y,to_x,to_y})`                                            | `drag(from,to)`                                                                                                        | Bounded trajectory inside the observed window.                                                                       |
| `scroll({app,windowId?,element_index?...,x?,y?,direction,pages?})`                         | `scroll(indexOrPoint,direction,pages?)`                                                                                | Convert page distance using observed size; pixel-object arguments are refused.                                       |
| `set_value({app,windowId?,element_index,value})`                                           | `setValue(index,value)`                                                                                                | Typed AX write followed by bounded readback; accepted-but-unchanged writes return not-observed and stop the chain.   |
| `select_text({app,windowId?,element_index,text,prefix?,suffix?,selection_type?})`          | `selectText(index,text,options?)`                                                                                      | Unique UTF-16 range; text selection or cursor before/after.                                                          |
| `type_text({app,windowId?,text})`                                                          | `typeText(text)`                                                                                                       | PID-directed Unicode; complete surrogate pairs, native newline/tab.                                                  |
| `press_key({app,windowId?,key,duration?})`                                                 | `pressKey(key,{durationMs?}?)`                                                                                         | Mac keys/modifiers; legacy duration uses seconds.                                                                    |
| `paste({app,windowId?,text,format})`                                                       | `paste(text,{format?}?)`                                                                                               | Text, Markdown or inert HTML via guarded clipboard provider and conditional restoration.                             |
| `perform_secondary_action({app,windowId?,element_index,action})`                           | `performSecondaryAction(index,action)`                                                                                 | Only an action actually advertised by that element; background AXRaise is refused.                                   |

Coordinates are absolute macOS screen points. Observation headers/legacy results
include bounds and screenshot dimensions for conversion. Native screenshots cap
their longest side at 2048 pixels. `getAXState` returns a string,
`getScreenshot` PNG `Uint8Array`, and the combined method `{state,screenshot?}`.
`emit:false` suppresses output without changing returns.

AX text includes advertised actions, bounds and available enabled, selected and
focused flags. Attached native sheets participate in explicit window selection;
use `listWindows` and select their own ID when a dialog extends outside its
parent. Parent-window input bounds do not expand to the dialog automatically.

`getApp`/`getAXState` bypass ScreenCaptureKit. Missing Screen Recording permits
AX text with an explicit notice and null screenshot; `getScreenshot` throws.
Legacy `get_app_state` requests capture by default and accepts
`includeScreenshot:false`. A selected native window without a matching AX
handle reports `accessibilityAvailable:false` and issues no element indices.
Image/coordinate operations require exact native ownership/capture checks;
unavailable AX never becomes invented semantic controls.

ScreenCaptureKit can capture an attached parent/sheet family even when its
filter names only a sheet. Glide verifies that family's AX relationship, native
IDs, frames and observer generations around capture, allocates within the same
2048-pixel bound, and normalizes the PNG back to the selected window's bounds.
Parent chrome and letterboxing must not change the image-to-input mapping.

## Action outcomes and recovery

Every action returns and automatically emits a receipt. Dispatch, OS acknowledgment
and an observed postcondition are separate evidence. Native brokers opt into receiptVersion:1 on the trusted envelope. Older clients
retain error-channel failures instead of discarding unsuccessful action results.
Native progress counts AX
attempts/acceptances, posted events and submitted Unicode scalars; these are not
counts of committed characters. A lost response has unknown dispatch and null
counters, never invented zero progress. Generic clicks, keys, drags, scrolling and
paste normally return unverified: posting input does not acknowledge delivery.

| Status       | Meaning and recovery                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| verified     | The named AX value, focus, text, selection, process or window state was observed. The overall application task still needs inspection. |
| unverified   | Dispatch or an acknowledgment is available, but there is no verified postcondition. Obtain a fresh observation.                        |
| not-observed | The intended postcondition did not appear within the bounded allowance. Inspect the actual result before choosing another mechanism.   |
| uncertain    | Input may have taken effect, or a response/ownership fence was lost. Inspect before any retry.                                         |
| refused      | The action was refused before dispatch. Correct the target, capability or state.                                                       |

The final three statuses throw GlideActionError with a .receipt property, stopping
an awaited chain. Receipts from earlier steps remain in the cell output and in
glide.getActionReceipts({emit:false}), which keeps at most 64 entries.
getActionReceipts({clear:true}) returns and clears that history. Returned receipts
are copies and confer no replay or ownership authority. On cancellation/timeout,
the parent retains at most 64 completed/pending receipts and includes them in the
authenticated error result when that result can still be delivered. A reset
discards kernel history. Earlier OS effects remain. Uncertain or not-observed
actions invalidate the session observations; fresh state is required before input.

setValue reads the exact element after an accepted write, allowing only floating
representation tolerance for numbers; clamping or an ignored write is not verified.
The readback allowance is at most 600 ms within the original request deadline.
An unacknowledged write can still produce a verified receipt when fresh readback
proves its exact postcondition. Ownership/admission refusals never enter that
reconciliation path. No input is repeated; `osStatus` preserves the first rejected
AX status even if a later substep succeeds. Posted events remain unacknowledged,
with AX attempt/acceptance counts reported separately.
Readback proves the AX value, not rendered photo edits, search results or saving.
There is no automatic pointer/keyboard fallback and no repeated uncertain AX call.

app.focus(index) establishes and observes focus inside the exact admitted window.
app.typeInto(index,text,{replace:true}) additionally selects and verifies the full
readable UTF-16 range before posting Unicode input and checking the resulting value.
Without replace, the expected edit uses the observed selection when available.
An empty full-field replacement deletes the verified selection; an empty append
request leaves text unchanged.
Unsupported or lost focus stops text entry. A click/AXPress alone does not attest
keyboard focus. Secure fields never expose receipt before/after values and cannot
use verified full-field replacement. Verified text editing is bounded to 65536 UTF-16 units before constructing an edit
expectation; larger documents can use incremental typeText with explicit inspection.
Receipt value previews are bounded to 1024 UTF-16 units; comparisons use the full
admitted value.

Outside-input receipts include key-down/button-down/scroll category, external-process
or unattributed source, and a source PID where available. They contain no key
contents. These fields do not prove physical human input. The existing conservative
takeover guard remains enabled. Each admission retains its first interrupting event,
and focus re-admission inside an operation cannot reset that activity fence.
Ambiguous coordinates report at most eight distinct
AX candidates with indices, roles and bounds; only CFEqual AX objects are collapsed.
Refresh state and choose an exact new index. Indexed pointer input uses that exact
observed element rather than repeating the ambiguous coordinate inference.

## Application launch and window restoration

- glide.resolveApp(bundleIdOrAbsoluteAppPath) returns installed name, bundleId and
  canonical path, including for a stopped app. It does not launch or capture.
- glide.launchApp(selector) launches the exact installation through NSWorkspace.
  Background mode requests no activation and no application substitution, shell,
  custom arguments, environment, URLs or documents. An already running exact app
  is observed without repeating launch. A verified receipt proves only the process,
  so list windows and obtain a fresh app handle next.
- app.restoreWindow() explicitly unhides its application and unminimizes the observed window without
  requesting activation or AXRaise. It preserves process/window ownership fences,
  checks foreground/Space continuity and invalidates the old observations. Observe
  again before selecting element indices. No restoration is implicit in another action.

The desktop grant admits stopped installed apps only after fresh trusted native
resolution, and is checked again before native dispatch. Legacy app allowlists
remain restricted to their exact bundle IDs and helper-resolved installations.
Launch/restoration may have an uncertain outcome if the app or OS changes focus or
Space; Glide detects that and stops further work, without trying to reverse an app
startup or secretly activating it. Applications own their startup behavior.

AX observations annotate hidden/minimized state and currently blocked actions
separately from available actions. AXRaise is blocked in background mode. Startup
identity churn permits bounded observation-only rediscovery, never input replay or
rebinding an explicit window ID to another window. Browser-extension communication
remains outside Glide.

## Authority and lifetime

The provider owner mints a private session stdio bridge using Cafe's existing
authenticated daemon. Session credentials are not model arguments. The MCP
audience is isolated from other tools, loopback-only and authenticated before
body processing. The broker checks current provider ownership, persisted Full
access and the per-chat app grant at admission and again before native dispatch.
Grant publication checks the current live thread in the same SQL statement.
Hard deletion removes its grants.

Each provider binding owns persistent JavaScript state. One native host per
provider owner serializes operations across chats and partitions snapshots by
server-minted UUID. A per-user advisory lease prevents competing owners or
standalone helpers from controlling the desktop concurrently. The historic
`cafe-computer-use-UID.lock` filename is retained for cross-version contention;
private owner/mode, single-link and held/named identities are checked.

Queued cancellation affects its own promises without killing foreign active
work. Active cancellation joins retirement of the exact native child. Helper
replacement invalidates all old host-generation observations. Another chat must
refresh before input. Cleanup uncertainty remains a refusal, not permission for
a competing helper. Transport failure, timeout and cancellation never replay
an operation; earlier dispatched OS events may have taken effect.

An AX call that opens a modal can return an unconfirmed OS result after its
action has taken effect. Glide reports that uncertainty. Inspect fresh state
instead of replaying the action; the native picker qualification waits for the
exact panel-start receipt and verifies the actual selected private file.

Async callbacks retain their originating cell identity and cannot borrow the
next cell's output/input rights. Calling a saved function or app handle from a
current cell remains supported. Reset discards state without rolling back edits.

This is trusted local JavaScript execution for explicitly enabled Full-access
chats. The VM/module policy is not an OS sandbox. General Node, filesystem and
network imports are not implemented. Native allowlists constrain the helper;
they are not an OS sandbox for arbitrary trusted code.

## Native background implementation

App identity binds canonical path, bundle ID, current user, PID and OS process
birth. Window identity binds CGWindow ID, frame and available AX object. AX
observers invalidate snapshots on changes; bounded settling retries observation
only, never input. Historical move-away and return still invalidates old state.
Indices are monotonic within a host generation and session-partitioned. Changed
or ambiguous targets require fresh state. AX and capture are not atomic.

Mouse/scroll events carry exact window fields, local coordinates and addressed
recipient. Keyboard/Unicode events are PID-directed. Background mode has no
global HID pointer route or foreground fallback. Hidden/minimized windows,
changed births and stale indices are refused.

The prohibited-activation helper has no Dock/window UI. It reconstructs private
WindowServer focus/event mechanisms from static Sky evidence: paired
Taken/Returned/Changed handling, one-use CPS release tokens, root-only synthetic
AppKit activation and scoped menu/input guards. AX parent traversal can resolve
a verified hosted recipient, binding actual PID/birth and native window.
Ordinary input has at most the root and one proven recipient. Menu mouse taps
are scoped to PID and known windows; unknown ownership passes.

Menu discovery considers the focused AX ancestry and the exact selected window's
descendants under one 100ms allowance, at most 512 nodes/32 levels and local
10ms AX timeouts. It requires a unique live cancelable menu with visible item
geometry and exact root/recipient identities. Observations bind its native
window/owner/bounds; absent native proof refuses input. The tested popup PNG
includes its menu as well as the parent window.

PID posting only queues input. One retained synthetic activation belief binds
the exact root birth, session and native window across requests, so request
cleanup cannot deactivate a menu before its queued opening event runs. This
retention grants no input/focus admission. Each new operation still establishes
actual CPS focus, the external foreground generation, active display Spaces and
outside-input generation. Outside input retires the retained belief once and
queues exact-reference cleanup; late cleanup cannot erase a replacement. A
target/session change, death or connection close also retires it.

Keyboard rescue forwards an exact admitted misdirected human key to the original
human process and drops the duplicate. An optional third raw auxiliary stream
requires equal paired AX handles, matching logical/actual owners and exact
births. It grants suppression/rescue, not agent input authority. Predispatch
discovery has a shared 150ms checked budget and local 10ms AX timeouts.

A helper first encountered in a Taken focus notification can instead be proved
on a separate bounded AX lane. The original callback waits at most 40ms total
for proof and exact PID-tap readiness, outside the focus lock. Admission then
rechecks the same root, operation epoch, activity generation, retained human
foreground, live process births and rescue guard. A timeout or stale result
cannot publish authority later. Only the exact proven ViewBridge auxiliary uses
the special NewFront suppression branch; other proven prohibited services keep
ordinary paired focus handling. These proof requirements and deadlines are
Cafe's design, not a claim of identical Sky behavior.

Background operations also bind the exact active Space ID for each managed
display. Unknown, changed, added or removed display/Space identities refuse
further input. Glide never switches Spaces or changes window memberships.

Outside mouse/keyboard activity revokes future input/focus admission. Already
admitted paired release cleanup may finish without authorizing a new theft
cycle. Missing private symbols, failed taps or uncertain focus ownership refuse
input. Private APIs require qualification on each OS release.

Clipboard restoration requires the publication's exact change count; newer
content wins. Target AX calls are avoided while clipboard delivery might depend
on the helper. Inert HTML permits well-formed text/formatting tags and safe
links, refusing scripts, styles, resource attributes, declarations and
unsupported tags. Provider-read/quiet heuristics are not proof of an accepted
edit: observe the actual target afterwards.

| Resource                                   | Bound                                                           |
| ------------------------------------------ | --------------------------------------------------------------- |
| Live bindings / retained workers per owner | 32 / 4; disabling or retiring frees a worker slot               |
| Worker V8 old generation                   | 256 MiB each; not a total OS-memory cap                         |
| Active and queued cells per runtime        | 4                                                               |
| Shared native queued requests              | 64                                                              |
| Native snapshots / per-session snapshots   | 64 / 16                                                         |
| Apps per grant / native windows per app    | 16 / 64                                                         |
| JS source / request body                   | 128 KiB / 1 MiB                                                 |
| Outstanding worker RPCs / RPCs per cell    | 64 / 256                                                        |
| Output / ordinary blocks                   | 10 MiB / 128                                                    |
| Child frame / PNG                          | 12 MiB / 8 MiB                                                  |
| PNG dimensions                             | 16384 per side, 40 million pixels; native capture 2048 per side |
| AX tree                                    | 2048 nodes, 32 levels, 128 children/node, 256 KiB rendered text |
| Native text input                          | 16384 UTF-16 units and at most 64 KiB UTF-8                     |
| Clipboard preservation                     | 64 items, 64 types/item, 8 MiB after reads                      |

Native HTTP leases remain owned through response finish/close, with four
execution lanes and four separately bounded control lanes. Reset/Stop remain
available under execution saturation. Bodies, chunks, output and response
lifetimes are bounded. Native readers may allocate before sizes are available;
data limits are not total OS-memory guarantees.

## Build and standalone development

Building does not launch or restart Cafe:

```sh
nice -n 10 node apps/desktop/scripts/build-mac-glide-helper.mjs
nice -n 10 corepack yarn workspace @cafeai/cafe-code build:bundle
```

The desktop build compiles all seven native sources. Server assets include
`glide-worker.mjs`, standalone `glide-mcp.mjs` and managed
`glide-mcp-bridge.mjs`. Trusted server code resolves source/packaged helper paths,
never a renderer-provided executable. Release staging includes architecture-correct
`Resources/mac-glide`, required by artifact audit. Existing Developer ID,
hardened-runtime and notarization tooling signs Mach-O resources. A source build
does not establish signed-release TCC/notarization acceptance.

Standalone MCP remains available for isolated development, using its own
connection-owned helper/worker instead of Cafe's shared host:

```json
{
  "command": "/absolute/path/to/node",
  "args": [
    "/absolute/path/to/cafe-code/apps/server/dist/glide-mcp.mjs",
    "--native-helper",
    "/absolute/path/to/cafe-code/apps/desktop/native/build/arm64/mac-glide",
    "--input-mode",
    "background",
    "--allow-app",
    "com.apple.TextEdit"
  ]
}
```

`--allow-app` repeats up to sixteen bundle IDs resolved to canonical paths.
Apps must already be running. Background is default; explicit foreground mode
may activate/raise the target and move the pointer. Do not run its separate
`GlideMac.e2e.test.ts` foreground journey during uninterrupted human use.
Standalone execution does not acquire Cafe's managed per-chat policy merely
by sharing the facade.

## Qualification and limits

Default tests cover authorization, persistence, exact owners, cancellation,
transport recovery, facade translation, framing and bounds with synthetic peers.
Native browser tests exercise actual Glide menu/dialog input, app choices,
enable/save/disable/Stop, explicit Settings buttons and late old-chat retirement.

The managed pipeline uses real copied stdio bridges, native HTTP transports,
broker and ESM workers in local, daemon and supervisor placements; only its OS
peer is synthetic. It verifies isolation, persistent imports, reset, held native
cancellation and revocation without live accounts. Codex adapter tests separately
qualify startup attachment, activation, turn resume and interruption disposal.
Claude SDK and Grok ACP fixtures also verify exact binding identity, native MCP
configuration and disposal while retaining their ordinary permission policy.
No real provider account is used by these fixtures.

```sh
nice -n 10 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/GlideKernel.e2e.test.ts integration/GlideSessionPipeline.e2e.test.ts
nice -n 10 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/GlideFocusPolicy.e2e.test.ts integration/GlideRoutingPolicy.e2e.test.ts integration/GlideKeyRescuePolicy.e2e.test.ts integration/GlideIncomingFocusPolicy.e2e.test.ts
```

Real background tests launch only private owned apps/documents with
`activates=false`, bind actual new PID/birth/window and abort on outside activity
or foreground/pointer changes. Full AX/PNG and AX-only journeys passed on macOS
27.0.1 arm64 on October 17, 2026: actual Unicode text, selection, paste, AX action,
click, drag and scroll effects preserved external foreground/pointer ownership.
Multi-window/session tests cover ambiguity refusal, explicit IDs, cross-session
index refusal, retirement and historical observer invalidation. These actual
native effects are separate from synthetic passes.

A separate fresh TextEdit process also passed: it opened only a private test
document, accepted background click, select-all, Unicode typing and selected
text insertion, and produced the expected final AX text and real window PNG.
All eleven ownership receipts retained the original external foreground
PID/birth and physical pointer. Existing TextEdit processes/documents are never
selected or terminated by that fixture.

A separate metadata-only native journey passed with two fresh processes from
the same canonical app bundle. `--status` produced exactly one app-picker row
with the canonical realpath and one exact owned representative PID. That check
requires neither AX window availability nor control/capture permission.

```sh
nice -n 10 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/GlideBackgroundMac.e2e.test.ts integration/GlideWindowSessionsMac.e2e.test.ts integration/GlideTextEditMac.e2e.test.ts
```

The off-Space native journey passed while the human's fullscreen video remained
on another Space. The fresh private window stayed on an existing inactive
ordinary Space. Its initial observation had no AX handle or invented indices,
and supplied a real PNG. Addressed coordinate clicks, select-all, Unicode typing,
cursor movement/insertion, button activation and scrolling produced exact target
receipts. The final observation recovered AX and confirmed
`offspace 👩‍💻 caf!é`; both real PNGs contain only the owned window. Every native
receipt preserved external foreground PID/birth, physical pointer and active
display Space identities. This qualifies the tested macOS 27.0.1 configuration,
not every application or OS version. Inspected Sky code required a primary AX
window; static evidence did not establish this general fallback.

```sh
nice -n 10 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/GlideOffSpaceMac.e2e.test.ts
nice -n 10 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/GlideKeyRescueTransportMac.e2e.test.ts
```

The real key-rescue transport journey also passed between exact fresh headless
native peers. It proves one addressed foreign event is reposted once to the
owned recipient and dropped from the original stream, while helper-origin and
retired-policy events pass unchanged. Human foreground and pointer remain
unchanged. This transport check does not manufacture production AX/CPS ownership
proof or send a key to the human application.

The ordinary-desktop batch passed five files and all ten tests after the native
and capture corrections. It covers actual popup coordinate and keyboard selection,
context-menu selection, framed and unframed NSOpenPanel journeys, both all-method
background AppKit journeys, window/session isolation, private TextEdit and real
key rescue. Every menu/picker receipt preserves the human foreground PID/birth
and pointer. Background AppKit receipts additionally retain exact active display
Space identities. Both pickers accept the exact private `Owned Choice.txt`
through independently verified hosted PID/birth/native-window ownership and
actual hosted keyboard/pointer dispatch. The unframed journey requires a new
hosted service born after the pre-dispatch timestamp.

New service birth does not establish a WindowServer focus-theft notification.
Neither picker journey emitted that notification on this host. Callback-time
auxiliary admission therefore retains its pure deadline/ownership qualification
without a new claim of live notification-path coverage. If the OS emits that
event in a journey, the fixture also requires actual `incoming.admitted` evidence.
An auxiliary without timely root-linked proof receives no guessed authority.
Arbitrary photo editors, other dialogs and other OS releases remain separate
qualification. The private menu/picker fixture requires an ordinary desktop;
it never joins the human's fullscreen Space or switches desktops.

The live-provider fixture uses fresh conversations and normal authentication,
with one fixed metadata-only program through the real managed stdio bridge,
HTTP route, session broker, ESM worker and native `list_apps`. It refuses app
input/capture and any other native method, counts exactly one execution and
requires a fresh nonce and worker-generated unpredictable challenge in the
finished HTTP tool result and final model reply. Sparse provider presentation
events do not substitute for the actual response. It changes no global
MCP/profile configuration and is explicitly paid opt-in. Claude Agent and Codex
completed the original nonce/tool-result path on October 17, 2026.
Codex uses the production developer-instruction and Full access contract while
retaining the fixture's fixed metadata-only gates. Grok passed the stronger
finished-response/challenge probe at 14:19 on October 17: exactly one program,
one native metadata call and a final reply containing the unpredictable result.
The run took 9.58 seconds; `.logs/glide-live-grok-challenge.log` records its pass.

Earlier runs exposed real native defects rather than merely a setup problem:
AXMenu inherited its parent document's ID, queued menu input lacked the motion/
held-pointer tracking needed for selection, AX lookup left snapshot handles at
a 10 ms timeout, and background hit-testing missed hosted controls. Glide now
requires a unique exact-geometry native menu owned by the AX-admitted recipient,
revalidates menu binding at snapshot commit, restores borrowed AX timeouts,
routes coordinates through a uniquely observed and freshly validated AX leaf,
and keeps its normal exact-window ancestry and process fences. Menu input is
still native PID-addressed motion/down/drag/up, not an AX selection substitute.
WindowServer descriptions use an exact raw-ID CFArray rather than a partial
z-order scan. Modal-opening uncertainty is inspected without replay. The
current checks and build evidence are recorded in the implementation plan.

```sh
CAFE_CODE_GLIDE_LIVE_PROVIDERS_E2E=1 CAFE_CODE_GLIDE_LIVE_PROVIDER=claudeAgent nice -n 10 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/GlideLiveProviders.e2e.test.ts
```

Select `codex` or `grok` for those separate explicit probes. These live checks
are distinct from default synthetic provider fixtures. Signed-release
permissions/notarization and other OS versions need separate native
qualification. Signing/notarization is excluded from this follow-up.
Windows/Linux native drivers are not implemented. Local browser/process fixtures
do not establish those properties.

Local artifacts include `.logs/glide-control.png`,
`.logs/glide-background-fixture.png`, `.logs/glide-textedit-fixture.png`,
`.logs/glide-offspace-initial.png`, `.logs/glide-offspace-final.png`,
`.logs/glide-offspace-receipts.json`, and bounded native receipt files.
The menu/picker artifacts are `.logs/glide-owned-{popup,context,file-picker,unframed-picker}-receipts.json`
and `.logs/glide-owned-{popup,file-picker,unframed-picker}.png`.
`.logs/glide-native-acceptance-final.log` records the complete ordinary batch.
Native reconstruction evidence is under
`.explorations/sky-analysis/background-control-2026-10-16/`.

The action reliability qualification adds these explicit opt-in commands (native
app tests require an idle input interval; interruption is a refusal, not permission
to weaken the guard or replay input):

```sh
nice -n 10 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/GlideActionPolicy.e2e.test.ts integration/GlideInstalledAppMac.e2e.test.ts integration/GlideKernel.e2e.test.ts integration/GlideSessionPipeline.e2e.test.ts
nice -n 10 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/GlideBackgroundMac.e2e.test.ts
```

## Action reliability qualification, October 18

The native launch, hidden/minimized restoration, full PNG background journey and
AX-only background journey each passed with unchanged foreground, pointer and
active Space observations. The combined four-case run had one ownership refusal
in the AX-only drag phase; its isolated rerun passed. The accepted no-op,
unfocusable field, overlapping AX targets, timeout-after-effect action, empty
replacement and Unicode replacement assertions are part of those journeys.

The broader background regression run passed popup, context-menu and framed
file-picker cases. Its unframed picker stopped after an unattributed button-down
with 23 Unicode scalars submitted, and the window/session and private TextEdit
cases stopped on external pointer changes during their preparation. These are
not recorded as clean positive qualification; no input/ownership guard, worker
cap or deadline was relaxed. They remain explicit idle-only checks.

The separate action/focus policy, installed-app/legacy framing, real kernel and
managed-bridge qualification passed 25 tests in five files. Required repository
tests passed all ten Turbo tasks. Evidence is in .logs/glide-reliability-*.log.
These private fixture results do not establish every third-party application
commits every accepted AX value; the agent must still inspect its task outcome.
