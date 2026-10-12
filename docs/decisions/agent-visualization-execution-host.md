# Decision: sandboxed native visualization view with an external-page watchdog

Decision status: Accepted; integrated implementation with focused macOS qualification
Created: 2026-10-12 23:36:18 JST (UTC+0900)
Last updated: 2026-10-13 02:22:03 JST (UTC+0900)
Decision authority: the user explicitly selected sandboxed Electron execution and a watchdog, accepted no hard macOS memory cap, prohibited installations, and retained the full visualization/MCP Apps goal.
Implementation status: integrated source; focused native macOS arm64 checks pass. Full native-platform and hosted release qualification are separate gates, not established by the source or this decision.
Supersedes: the unresolved macOS hard-memory execution gate described in the [foundation decision](agent-visualization-foundations.md), only to the extent of the explicit exception below. Data, privacy and lifecycle foundations remain in force.

## Context and alternatives

Interactive generated pages and external MCP Apps require real browser DOM,
keyboard input, text selection and accessibility. A poster remains the default
historical presentation, but cannot substitute for those active capabilities.
Cafe must reuse the already pinned Electron runtime without installing a browser,
helper, virtual machine, service or changing OS policy.

A separately launched Electron application cannot insert its native view into
another application's BrowserWindow. An anchored extra window or pixel relay
would not provide equivalent inline DOM and accessibility. A renderer iframe
inside Cafe's existing webContents also does not establish process separation.

Select a main-owned `WebContentsView` with a fresh nonpersistent Electron session.
This keeps native input and permits inline/expanded presentation to retain the
same document. Session separation is an isolation mechanism, not sufficient
evidence by itself: verify actual renderer process identity before admitting
private source, and refuse shared/unknown process ownership.

## Decision

- Use a dedicated sandboxed, context-isolated native view with Node disabled and
  no ordinary Cafe preload, provider credentials or management API. A narrow
  dedicated bootstrap may carry only validated presentation/protocol messages.
- Admit an inert bootstrap first. Bind its exact webContents/session and actual
  renderer identity, distinct from trusted Cafe views and other active hosts,
  before loading adversarial source. Recheck lifecycle identity on replacement.
- Use one dedicated sandboxed top-frame. Actual pinned-Electron qualification
  refused the initial opaque child-frame wrapper because it allocated an OOPIF.
  The isolated preload replaces the admitted inert document, with header CSP
  retained and no Cafe API exposed. Standard Apps self-parent messages are
  consumed before page listeners; only native replies are delivered back.
  Cross-world delivery, unchanged CSP and exclusive renderer ownership require
  native evidence, not an assumption about Session or iframe isolation.
- Keep execution single-slot and queue-bounded. Preview and capture have finite
  absolute budgets. Interactive activation also has a visible finite lifetime;
  expiration stops execution rather than silently renewing/reloading it.
- Run the watchdog in trusted Electron main, outside the adversarial renderer's
  JavaScript event loop. Missing bounded heartbeat or a deadline revokes actions
  immediately and requests retirement through the exact owned webContents.
  Observe native renderer disappearance and view destruction before releasing
  the execution slot. An uncertain stop quarantines the slot; an acknowledgement
  or PID alone does not prove retirement.
- Deny navigation, new windows, native permissions, downloads, service workers,
  filesystem URLs, backend/loopback access and arbitrary network traffic at the
  native session boundary. Generated pages are offline. External Apps receive
  only the separately approved originating-server broker, not a network proxy.
- Render inert posters inline until explicit activation. Geometry and visibility
  belong to the exact trusted owner window/document. Expansion changes bounds,
  not document identity; approval/credential/modal UI hides and yields the native
  view. Unsupported browser/remote surfaces retain truthful poster/source access.
  A newly opened viewer remains hidden until the exact current lease commits
  geometry/visibility; consent resume cannot reveal an uncommitted surface.
  Startup modal revocation also fences late capability/ticket/open acknowledgements.
- Each fresh App-operation consent may yield the view for at most30 seconds;
  repeated requests while suspended cannot reset that deadline. Sequential
  operations never renew the document's absolute5-minute execution lease.

## Security, privacy and failure consequences

The watchdog protects against adversarial page-JavaScript hangs; it is not an
independent supervisor for a stalled Electron main process, native Chromium/browser
service failure, kernel failure or whole-system resource pressure. No hard total
memory limit is promised on macOS, as explicitly accepted by the user. Chromium
sandboxing and bounded trusted copies/messages remain required; neither is a
claim of a universal RAM quota or escape-proof browser implementation.

Renderer termination may affect other views if their processes are shared. The
pre-source separation check is therefore mandatory, as are exact retirement and
quarantine tests. Native platform evidence remains distinct from synthetic policy
tests. Do not kill an adopted or merely matching PID to recover a slot.

Source/assets/diagnostics remain private immutable backend artifacts. A native
host is execution authority only for a narrowly admitted revision; it does not
authorize a page to read other chats, select a provider or tool, change permissions,
write arbitrary files or silently start inference. MCP App actions require fresh
exact-operation owner consent independent of ordinary provider approvals.

## Compatibility and operational consequences

No runtime/package/browser installation, OS policy modification, VM, privileged
helper or persistent service. Existing inert attachments, Mermaid admission,
image-export authority and provider permission policies are unchanged. Normal
rebuilt adoption is required; this work does not repair or interrupt live sessions.

Production uses the existing Cafe Electron application and adds no Dock app.
The synthetic native fixture alone launches an isolated Electron application,
whose Dock entry is hidden by that fixture. The debug endpoint reports bounded
fixed lifecycle/queue/byte/watchdog/retirement states, not source, raw JSON,
credentials, paths or retained native buffers.

The existing foundation's short finite lane is coordination for bounded jobs,
not a promise of a long-lived viewer policy. The active-host implementation must
document its own immutable lease, watchdog budgets and accepted resource envelope.
No performance improvement is claimed before measurements.

Native capture separately admits physical display output (scale 0.5–4, at most
12.8 million pixels) and normalizes it to the exact requested dimensions (at most
3.2 million pixels). Actual image dimensions and owner/document/display identity
must match around capture. Physical and normalized RGBA copies can respectively
consume 51.2 MB and 12.8 MB, plus independently finite encoded/transport buffers;
these are not a hard total-memory allowance. No zoom/color flag or renderer
ownership relaxation is used to normalize Retina capture.

## Implementation and evidence impact

Required evidence includes actual pinned-Electron session/process separation,
hostile page-loop retirement and responsive trusted owner, navigation/resource/
permission rejection, uncertain-stop quarantine, private source admission,
same-document expansion, native input/accessibility and approval yielding.
Backend publication/claims, source filtering before native journals, private
artifact reads, session tools and external Apps protocol/consent must qualify
separately. Acceptance of this decision is not successful implementation or tests.

The actual existing Electron 42.10.0 / Node 24.18.1 / ABI 146 macOS arm64 fixture
passes native poster pixels, original App data replay, focus/character input,
Unicode committed text, keyboard selection, Chromium semantic accessibility,
same-document expansion/context, CSP, consent, owner-hide retirement and
startup/active page-loop retirement. This is not real installed IME composition,
an OS screen-reader smoke test, whole-main-stall protection, a total-memory cap,
or native Windows/Linux qualification. The guide gives the exact opt-in replay.

## Supersession and preserved decisions

This decision supplements the foundation ADR and records the explicit macOS
memory exception. It does not supersede inert-file/Mermaid policies, native
provider permissions, exact owner/provenance rules, safe export publication or
the requirement to pass the repository checks and final forced desktop build.
