# Cafe computer-use interface and reliability plan

Status: implemented. This plan covers all six improvements from
the October 9 computer-use investigation.

Cafe will keep the reviewed, pinned MIT Cua Driver as its macOS native backend.
The model-facing interface will use session-scoped app/tab bindings and short
ordered action batches. This adopts useful patterns observed in ChatGPT's
shipped interface without importing its proprietary implementation or claiming
equivalent model training. No new unrestricted JavaScript runtime is required.

## 1. Repair lifecycle and recovery

- Mint a fresh native lifecycle label whenever a Cafe binding reacquires the
  controller after acknowledged release. Invalidate target handles and state
  when that control episode ends. Releasing desktop control preserves the
  provider's active turn so it can acquire a fresh episode without a new message.
  Trusted end-turn/disposal still revokes further input.
- Recognize the pinned driver's precise before-input Electron text refusal for
  same-window foreground fallback. Never replay partial, uncertain, or lost
  input, and recheck authority before each native subcall.
- Include `set_value` and file-input changes in the action/observation adapter.
- Observe uncertain action errors when an exact target is known, while keeping
  the original failure and stopping subsequent input.
- Return a fresh screenshot after coordinate actions when observation is
  requested. Accessibility-only observations invalidate pixel grounding;
  subsequent pixel input must use a new screenshot.

Acceptance: isolated regression tests reproduce each original defect and prove
that no uncertain action is repeated. Native qualification exercises release
and reacquisition in two episodes using the pinned driver.

## 2. Bind apps and browser tabs

- Add `computer_select`, returning an opaque target handle and initial state.
- Resolve macOS app names or bundle IDs, launch only the explicitly requested
  app when necessary, and retain exact native process/window identity internally.
- Report ambiguous windows/tabs for explicit selection instead of guessing.
- Support exact browser tab bindings using the existing-profile integration.
- Keep a bounded set of handles within the host-owned control episode. Another
  chat, replacement provider binding, release, or controller failure cannot
  reuse them.

Acceptance: bindings work across multiple calls and cannot cross session or
release boundaries. Native and browser routing remain host-owned.

## 3. Make text entry explicit and verifiable

- Add bound text insertion, direct native value setting, and paste actions.
- Use the connected browser's DOM text API for browser fields; retain native
  typing/value routes for apps and explicit foreground recovery when eligible.
- Paste through Cua's clipboard/input tools, retaining clipboard text only in
  transient host memory. The pinned clipboard API cannot round-trip arbitrary
  rich/image/file formats: refuse that paste route before writing instead of
  destroying unsupported clipboard contents. Ordinary typing remains available.
- Restore supported clipboard text after the paste settles, including action
  failures; do not replay input while performing cleanup.
- Report native delivery/effect and fresh observed value separately. A web AX
  echo is not proof of application-level acceptance.
- Rebind refreshed native fields by a unique role, label and native bounds,
  rather than a traversal index that menu updates can shift. For web fields,
  establish physical focus with one captured foreground click before text or
  paste. Stop on uncertain focus and preserve Select All by avoiding another
  click before replacement typing.
- The reviewed Mac source patch identifies Electron from the live process
  bundle path, then routes explicitly requested foreground Unicode typing
  through Cua's existing exact-window HID guard. Other native, background and
  Screen Sharing paths remain unchanged.

Acceptance: tests cover successful insertion, partial delivery, refusal,
uncertain outcomes, clipboard preservation, and unsupported-format refusal.

## 4. Batch predictable actions

- Add `computer_act` with a validated, ordered array of at most 16 actions.
- Provide click, type, paste, set value, key, scroll, drag, navigation and
  browser file-input actions using the bound target.
- Validate the entire batch before sending input. Execute sequentially inside
  the existing exclusive operation, rechecking chat/turn authority each time.
- Stop on refusal, partial delivery, uncertainty, or failed acknowledgement.
  Return completed step results, the stopping step, and a final observation.
- Never accept arbitrary tool names or process/window/session substitution
  inside a normal action batch.

Acceptance: malformed later steps produce zero input; uncertainty and revocation
stop subsequent steps; deterministic click/type/read sequences use one call.

## 5. Unify observations

- Add `computer_observe` with accessibility, screenshot, and combined views.
- Return current element handles, capture identity, truncation information and
  exact target context. Use optional bounded accessibility diffs with a full
  state escape hatch; fresh handles must always remain available.
- Scope native records to the exact window before applying the 200-record
  response limit. An application's large menu tree must not hide its fields.
  Report nonwindow omissions; advanced operations retain menu access.
- Settle recent actions inside bounded observation logic, without requiring
  model-authored sleeps. Stable observations mean stable observed state, not
  successful task completion. Return a settling timeout as data.
- Preserve screenshot images in action results and require valid image
  grounding for coordinates. Do not silently reuse stale geometry.

Acceptance: tests cover unchanged/changed/full state, fresh tokens, invalidated
captures, coordinate bounds, settling and image propagation.

## 6. Reduce the default tool surface

- Advertise `health`, `computer_select`, `computer_observe`, `computer_act`,
  `computer_advanced`, `open_url`, and `release_control` by default.
- `computer_advanced` lists the existing reviewed native tools and can call one
  explicitly by name. Keep recursive argument validation, the same allowlist,
  redaction and admission checks. Unsupported runtime/configuration facilities
  remain unavailable.
- Preserve old tool-call names for already connected clients without advertising
  the entire catalog to new sessions. Clear observation assumptions after an
  advanced operation that may change native snapshots or targets.
- Update agent instructions, work-log labels and native-control documentation
  to describe the concise interface and recovery rules.

Acceptance: default discovery is small, advanced schemas remain available,
legacy calls work, and neither surface broadens native authority.

## Validation and delivery

Default tests use synthetic native/controller fixtures without user apps,
credentials or paid provider calls. Extend the explicit opt-in native daemon
qualification for fresh lifecycle episodes. Document live native/Electron text,
file-picker and browser qualification separately; record verified completion,
duplicate effects, foreground changes, call count and latency.

Run repository formatting, lint and type checking, focused integration tests,
and the applicable test suite, then `corepack yarn build:desktop --force` as the
final verification. Keep Windows/Linux native control gated off. Existing
uncommitted UI/provider work remains intact. Restart and push require separate
user instructions.

The public reference is the [OpenAI computer-use guide](https://developers.openai.com/api/docs/guides/tools-computer-use).
Installed-artifact evidence is retained in the git-ignored
`.explorations/cua-driver/chatgpt-interface-comparison.md` report. The exact
foreground Electron failure was reproduced in a disposable Electron field:
the original process-routed foreground path produced no field input, and AX
focus could disagree with the renderer's actual HTML-body focus.
The guarded HID route plus one explicit captured field click passes real
renderer input and submission checks. This does not establish successful
completion of the earlier Axiom upload task.

Automated qualification on October 9 covers the shared admission/publication
contract, synthetic native and browser targets, whole-batch validation,
uncertain/partial delivery, clipboard preservation, capture invalidation,
fresh-token diffs and host revocation between steps. The prepared pinned native
driver passed health/screen-size and acknowledged cleanup/reacquisition in two
fresh episodes. The copied Electron/Node stdio bridge passed real MCP client
discovery of the seven default tools and bound action/image propagation against
synthetic native operations. These checks use no user apps or paid inference.

The opt-in `NativeComputerInput.e2e.test.ts` passed against the prepared native
driver and real Cafe host with existing macOS grants. It verifies exact Unicode
input (`entrée` and `☕`), replacement text, actual renderer input events,
exactly one submission per batch, and release/reacquisition in the same active
provider turn. Its disposable Electron window uses a private profile, no
network, no user application, no clipboard edits and no paid inference.

Remaining live acceptance covers paste/native-field input, browser DOM input in
the requested existing profile, and an
explicitly requested file-picker/upload task. Compare completion evidence,
duplicate effects, foreground changes, model-visible call count and latency.
Do not report the earlier Axiom failure as resolved from isolated fixtures.

## Bound interface examples

Select the requested app once, then use the returned target handle:

```json
{ "app": "Calculator", "view": "both" }
```

`computer_select` returns `target`, exact process/window context, and `state`.
An ambiguous selection returns `selection_required` and candidate windows;
select again with an explicit `window_id`. To use a supported browser's
existing profile, set `browser:true`; a direct existing `target_id`/`tab_id`
also binds a DOM target, but cannot route native keyboard shortcuts.

Send a short predictable sequence with `computer_act`:

```json
{
  "target": "<returned target>",
  "actions": [
    { "type": "click", "element": "<current field token>" },
    { "type": "type", "element": "<current field token>", "text": "Hello" },
    { "type": "key", "keys": ["return"] }
  ],
  "view": "both"
}
```

Results include ordered step receipts, `attempted_steps`, `batch`, optional
`stopped_at`, and a final observation. A stopped batch does not authorize
replaying earlier steps. After internal text verification changes tokens,
later actions using those stale tokens stop; keys can use the bound native
window without repeating an element token. Browser keys require that the exact
bound tab is still active. Scroll amounts are native wheel notches (maximum 50) for apps, CSS pixels for browser tabs.

`computer_observe` accepts `view:accessibility`, `view:screenshot`, or
`view:both`, an optional bounded text query, and `full:true`. Native diffs return
changed elements, removed tokens, and fresh `token_updates` for unchanged
elements. All action element handles must come from the current snapshot.
Browser semantic outlines/refs remain complete rather than being diffed.
Observing another target invalidates older grounding; observe it again before
acting. Images retain native capture metadata. Pixel input must lie inside the
most recent image, and accessibility-only reads clear that mapping.

Paste in a native app requires a field element. Clipboard support is limited
to plain-text content; original rich formats and an empty pasteboard cannot be
faithfully reconstructed by the current native API, so this route refuses
without writing. Browser paste uses DOM text insertion and does not touch the
clipboard. Clipboard restoration checks for a newer value and preserves it,
but the driver does not provide an atomic compare-and-restore primitive.

Discover uncommon controls with `computer_advanced`:

```json
{ "operation": "list", "query": "menu" }
```

Then call one reviewed operation with `operation:call`, its exact `name`, and
its advertised `arguments`. These calls do not accept Cafe's own facade names,
session identity, cursor identity, or capture-file output paths. Observe a
bound target again afterwards. Existing native tool names stay callable for
older provider sessions.
