# Agent visualizations and MCP Apps

Status: integrated source implementation; native-platform and hosted release qualification remain separate from local evidence. This guide describes source behavior, not a verified release.
Last updated: 2026-10-13 02:22:03 JST (UTC+0900)

Cafe has separate paths for agent-authored pages and external MCP Apps. Both
produce immutable private artifacts and inert poster cards. Run is a separate
explicit owner action, not a consequence of receiving HTML. Ordinary HTML/SVG
attachments remain inert; Markdown, Mermaid admission and native PNG save
authority are unchanged.

## Support and adoption

| Surface                                                       | Generated pages                                                                                    | External MCP Apps                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Cafe-owned Codex session with an available desktop host       | Session-only preview/publish tools; exact native MCP completion required for a card                | Original configured MCP server only; actual native resource/catalogue APIs required |
| Cafe-owned Claude session with an available desktop host      | Session-only preview/publish tools; exact SDK tool-use/result ownership required                   | Not enabled                                                                         |
| Grok and other provider paths                                 | Not advertised or enabled without qualified native server/tool provenance                          | Not enabled                                                                         |
| Browser, remote environment or backend without a desktop host | Authenticated historical poster/source access; no borrowed local execution or runtime installation | Historical inspection only; no local viewer or provider-action parity               |

Grok's current ACP title/unknown metadata cannot establish the native MCP server
and tool. Cafe does not infer root/child provenance from it. Codex protocol types
also do not prove the configured native runtime supports Apps calls: unsupported
operations fail closed, without global-server/account fallback. Account-hosted
Apps targets are not enabled.

Native hosting reuses the existing pinned Cafe Electron application. Each
Windows/Linux/macOS host still needs its own process/watchdog/retirement and
keyboard/IME/accessibility qualification; mocked platform policies or local
browser cases do not qualify another OS. Full repository checks, final forced
desktop build and applicable hosted Quality/artifact/AppImage jobs remain release
gates, not implications of source integration.

No new runtime, browser, helper, VM, package installation, OS service or OS-policy
change is introduced. Production launches no separate application or Dock entry.
Only the opt-in synthetic native fixture launches an isolated Electron application
with its Dock entry hidden. Existing provider work receives new tools through
normal rebuilt-runtime startup/resume, not interruption or live-session repair.

## Session tools and native admission

[`visualizations/mcp.ts`](../apps/server/src/visualizations/mcp.ts) exposes only
`preview_visualization` and `publish_visualization`. Preview returns a bounded
image and diagnostics to the producer without publishing a card. Publish captures
a poster and creates an immutable revision. Neither a screenshot nor schema-valid
JSON authorizes execution or publication of another document.

Input accepts exact source, bounded title, appearance, optional viewport, request
UUID and opaque aliases for committed raster attachments. It has no chat,
account, native-session, server, path, destination or network selector. Actual
UTF-8 source bytes are bounded; unpaired UTF-16 surrogates and unknown properties,
including nested ones, are refused. Raster URLs use `asset/<logical-id>`; file
paths and arbitrary URLs do not become attachment capabilities.

[`sessionRuntime.ts`](../apps/server/src/visualizations/sessionRuntime.ts) owns a
distinct session-only MCP audience and private connection file, using the current
executable, structured argv and standalone `visualization-mcp-bridge.mjs`. It does
not edit provider profiles, approval policy or native permissions. Tokens are not
passed in URLs, argv, environment, renderer state or normal logs. Candidate
sessions can discover tools, but operations require exact generation activation.
Trusted conditional guidance preserves Build/Plan and never advertises absent
tools.

Producer authority binds chat, provider instance, session generation, runtime
generation, token digest and server name. Activation compares the predecessor
under the SQL writer; old disposal cannot revoke a replacement. Store operations
recheck current authority under the writer. Internal native Apps operations use
`requireActiveSession` before and after asynchronous native I/O. Replacement,
retirement or hard deletion revokes producer/action authority; renderer/backend
reconnect alone does not prove a surviving detached owner has retired.

Publication returns an **unclaimed**, private per-invocation receipt. Request UUID
and exact input digest deduplicate immutable bytes, while every invocation gets a
fresh 256-bit proof. Only the owning adapter can claim it against the actual
successful completed native call: bound server/tool/generation, original input
digest, native item/turn and root/child ownership must match. Proof digest and
unique native-call binding settle transactionally. Arrival order, titles,
model-authored IDs and copied/stale/incomplete receipts cannot admit a card.

Ordinary streams carry compact references and safe attribution only. Source,
proofs, assets and native payloads are filtered before Cafe native logs, daemon
replay, canonical mapping and child projection. The upstream provider necessarily
receives source in its tool request and may retain it in its own history; Cafe
cannot erase or promise privacy of provider-owned transcripts.

Malformed Claude parent frames mask their own unowned results without hiding
later valid ordinary tool output; an uncorrelatable genuinely private tool or
exhausted private identity table remains fail-closed. Codex rejected-schema
diagnostics retain fixed metadata/auth/framing classifications, never received
causes or arbitrary rejected method text.

## Private storage and long history

[`store.ts`](../apps/server/src/visualizations/store.ts) and
[migration 096](../apps/server/src/persistence/Migrations/096_GeneratedVisualizations.ts)
keep source, original input JSON, assets, diagnostics and poster bytes in dedicated
private SQLite rows, outside ordinary event journals. Domain-bound digests commit
exact content/manifests. Ready rows cannot be edited or revived through a
pending-state transition. Hashes prove integrity, not authorization.

Raster imports require an existing same-chat attachment commitment, held
no-follow original-file reads, file/parent identity and private-mode checks where
applicable, actual byte bounds and SHA-256 verification. Cross-chat IDs, unsafe
namespaces, replaced/growing originals and changed commitments are refused.
Snapshots survive later original-file movement/deletion. Native image admission
also bounds dimensions/pixels and decodes/re-encodes the raster. Imported SVG is
not a raster exemption; agent-authored inline SVG belongs to the code budget.

Durable compact history is independent of the 500-activity tail. Bounded pages
carry canonical message/turn anchors, attribution and immutable refs. Fork copies
deliberate historical references, never producer tokens or Apps action authority.
Revert prunes exact discarded anchors; hard deletion releases only that chat's
references. Retained forks prevent removal of their bytes. Last-orphan retirement
and cleanup are indexed bounded batches, not full-history/token-path scans.

The renderer retains at most 1,000 compact entries, not every stored row. Explicit
Load older gestures slide that window through older history; new activity does
not replace an older review window. Return to latest requests a fresh current
window. There is one in-flight page and at most one trailing current refresh,
without automatic history scans. Exact originating-call anchors distinguish
history/card/viewer identity even when publication deduplicates immutable bytes;
source and poster caches remain content/revision keyed. Retrying a failed page
preserves its mode/cursor rather than silently returning to live history.

Claimed history is not silently age-evicted. Quota exhaustion refuses new writes,
not retained source. Unclaimed receipts and failed pending captures have finite
recovery lifetimes. Failed capture keeps pending source private but produces no
success receipt/card/claimed-details read. This version exposes fixed failure
counts/reason, not a separate failed-source inspection UI.

## Poster-first hosting and its limits

Timeline cards are inert by default; private Source/Details load only after
explicit authentication. Active ownership is outside recycled timeline rows.
Run obtains an exact revision's one-use viewer ticket. Trusted renderer-to-main
IPC carries the opaque ticket, bounds and appearance, never source, paths or an
arbitrary executable URL.

[`DesktopVisualizationHost.ts`](../apps/desktop/src/visualizations/DesktopVisualizationHost.ts)
owns one app-wide slot shared by previews and interactive viewing, with a finite
preview queue. A fresh nonpersistent Session and sandboxed context-isolated
`WebContentsView` have Node disabled, no ordinary Cafe preload, credentials or
management bridge. Before private source, an inert bootstrap must demonstrate
actual exclusive renderer identity distinct from trusted Cafe views. Unknown or
shared ownership is refused; a matching PID is not termination authority.

The isolated bootstrap loads one dedicated top-frame. Native session gates deny
source-controlled frames, workers, navigation, windows, downloads, permissions,
filesystem/backend URLs and arbitrary network requests. Header CSP is defense in
depth, not a quota. Active pages receive finite presentation/protocol channels
only. Generated pages are offline. External Apps get separately approved
originating-server operations, not a generic network or MCP proxy.

The watchdog runs in trusted Electron main, outside the page event loop. Missing
heartbeat/deadline revokes actions and retires the exact surface. Observed renderer
disappearance plus destruction is required before releasing the slot; uncertainty
quarantines it and refuses a competitor. This does **not** supervise a stalled
main process, native browser service, kernel or whole-system pressure. The user
explicitly accepts **no hard total-memory cap on macOS**. No Job/cgroup/VM resource
enforcement is installed or universal CPU/RAM envelope claimed. Chromium
sandboxing and bounded trusted copies/messages remain independent controls.

Viewer startup remains hidden until its exact trusted lease commits current
geometry and visibility. Revocation during capability, ticket or open acknowledgement
cannot reveal the stale document; consent resume cannot expose an uncommitted view.
Expansion changes native bounds without replacing the document. Approvals/modal
UI hide/yield the view. Stop, owner loss, route/window changes, deadline or actual
visibility loss retire it; CSS hiding is not indefinite execution permission.
State survives only in the same admitted live document; reopening gets a fresh
generation. The opt-in macOS arm64 fixture verifies real focus, pointer/character
input, Unicode committed text, keyboard selection and Chromium's semantic
accessibility tree. Committed text is not installed IME composition/cancellation;
the Chromium tree is not an OS screen-reader smoke test. Those manual native
checks and other platforms remain distinct, not inferred from pixels or mocks.

Saved posters represent their immutable capture, not arbitrary current state.
Explicit appearance controls publication capture; `auto` currently uses a dark
baseline. Trusted live appearance can differ. PNG actions are labelled saved
poster unless an exact current-state capture has been established.

## External Apps and one-use consent

[`mcpApps/owner.ts`](../apps/server/src/mcpApps/owner.ts) captures only actual
successful completed Codex MCP calls with exact configured server/tool/native
owner and a catalogue-matching `ui://` resource. Expected MIME is
`text/html;profile=mcp-app`. Private snapshots include exact original input/result,
resource metadata and immutable native witness. Missing, oversized and unsupported
resources do not become successful Apps artifacts.

Private poster capture supplies only the exact bounded original input/result
tuple through a preview-only initialization replay. This data-only lane refuses
tool/resource actions, model-context changes, chat messages, links and display-mode
requests. It is absent from stored viewer documents, viewer preparation and
renderer IPC; active viewers use the separately authenticated protocol broker.

The supported Apps protocol is `2026-01-26`. Initialization delivers the exact
captured input/result once and in order for each fresh document. Dedicated
isolated-bootstrap transport is not the ordinary Cafe preload. Unknown/draft
methods are rejected. Unsupported downloads, native permissions and arbitrary
remote resources are not advertised as generic host capabilities.

[`mcpApps/service.ts`](../apps/server/src/mcpApps/service.ts) requires the owned
immutable revision, current native account/session/server, and actual host
inspection matching ticket, lease and document generation. Consequential actions
need separate one-use consent consumed before I/O. Catalogue, app tool visibility,
argument schema, resource scope and exact owner are re-observed after asynchronous
reads and immediately before execution. `readOnlyHint` is advisory, not consent.
Account/session A→B→A, old documents and lost ACKs cannot replay authority.

`tools/call` and `resources/read` stay on the originating server. `ui/message`
requires approval and normal durable chat submission. `ui/update-model-context`
replaces bounded untrusted next-turn context, not system/developer instructions;
it starts no inference. Links need exact credential-free safe-destination consent.
Provider stop/replacement removes actions, not historical poster/source. Reopening
does not restart a provider. Consent yields the view for a fixed finite interval:
duplicate suspension cannot renew it or the document's absolute lease. Fullscreen
retains the same document where supported; native approvals stay outside its
authority.

## Explicit inspection and HTML export

Owner-only Source/Details bind and echo **thread, artifact and revision**.
Integrity/tombstones and authentication are rechecked around asynchronous work.
Bounded raw JSON/source are escaped received data behind disclosure, never
collapsed summaries, automatic logs or inference context. Schemas do not prove
user-authored text contains no credentials: deliberate inspection can reveal
private material authored into the request/document.

Generated HTML export requires executable-content disclosure. The
[static rewriter](../apps/server/src/visualizations/offlineHtml.ts) embeds admitted
manifest raster bytes only when a **complete literal URL attribute** is exactly
`asset/<logical-id>` in `src`, `href` or `poster`. It does not rewrite substrings,
external-URL suffixes, comments, raw script/style text or ordinary labels. CSS
URLs, `srcset`, JavaScript/dynamic URLs, encoded aliases and other dependencies
must already be self-contained. This is static declared-asset export, not universal
HTML portability. Apps are not exported as portable live server authority.

Exported HTML can run JavaScript and network requests outside Cafe and has no
Cafe native-denial/watchdog policy. No Cafe token, viewer ticket, management
capability, provider credential or local file path is intentionally embedded.
Explicit download is not arbitrary filesystem-write/provider authority. Saved
poster PNG actions retain the existing validated, requesting-document-bound
native save policy.

## Bounds and content-free debugging

Canonical data definitions are
[`visualizations.ts`](../packages/contracts/src/visualizations.ts),
[`visualizationApi.ts`](../packages/contracts/src/visualizationApi.ts),
[`visualizationHost.ts`](../packages/contracts/src/visualizationHost.ts) and
[`mcpApps.ts`](../packages/contracts/src/mcpApps.ts). Data shapes are not native
authority or process-death proof.

| Boundary                                         | Current limit                                                                                                                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source / title / asset manifest                  | 512 KiB actual UTF-8; 160 title characters; 16 aliases / 16 KiB encoded manifest                                                                                                                                                         |
| Raster snapshots                                 | 8 MiB aggregate PNG/JPEG/WebP; independent decoded/native pixel bounds                                                                                                                                                                   |
| Input wire / compact ref / presentation envelope | 4 MiB / 8 KiB / 16 KiB, finite pre-parser lexical/depth budgets                                                                                                                                                                          |
| Private diagnostics                              | 20 records × at most 500 characters; 16 KiB encoded envelope                                                                                                                                                                             |
| Viewport                                         | 240–1600 × 80–2000 CSS pixels; separate final PNG bounds                                                                                                                                                                                 |
| Backend expensive operations                     | Three concurrent operations, no unbounded waiting list                                                                                                                                                                                   |
| Native execution                                 | One app-wide slot; two waiting previews; 20-second absolute preview budget                                                                                                                                                               |
| Viewer / consent                                 | Ticket: one-use 60 seconds; document: absolute 5 minutes; consent yield: 30 seconds                                                                                                                                                      |
| Store                                            | Logical 256 MiB environment / 64 MiB chat; 2048 artifact rows / 20,000 history rows                                                                                                                                                      |
| Renderer history                                 | At most 1,000 compact entries; 50-row explicit pages, sliding older review and explicit return to latest                                                                                                                                 |
| Recovery / sweep                                 | 24-hour unclaimed/pending recovery; 16 entries per cleanup class per sweep                                                                                                                                                               |
| Apps                                             | 128 KiB protocol message / 16 KiB context / eight pending consents per connection; bounded maps                                                                                                                                          |
| App JSON                                         | Actual UTF-8, depth 16 and 4096 lexical tokens; exact replay envelopes must fit before native capture                                                                                                                                    |
| Private owner transport                          | 270,336 bytes for JSON-escaped outer request/response; inner App JSON still 128 KiB; four slots / 2048 chunks / fixed 10-second body and response guards                                                                                 |
| Generated MCP HTTP                               | Four requests through actual native response finish/close; 4 MiB body, depth 8 / 512 lexical work units, 2048 chunks and fixed 10-second body guard; outgoing 16 MiB / 2048 chunks with a separate nonrenewable 10-second delivery guard |
| Native poster capture                            | Display scale 0.5–4; at most 12.8 million physical pixels, normalized to exact requested dimensions and at most 3.2 million pixels; final PNG at most 16 MiB                                                                             |

Logical SQL quotas do not bound physical SQLite/WAL size or workstation RAM.
Base64/JSON/capture/decoder copies have separate finite transport limits, not
per-animation-frame history traffic. Direct private MCP HTTP counts actual bytes
before assembly/SDK parsing, with independent chunk and body-time fences.
Generated MCP responses retain their four-operation allowance through Node's
actual finish/close, not merely SDK response creation or source-stream exhaustion.
The delivery guard starts at response handoff, never renews on bytes and does not
shorten or extend the separate 20-second native preview budget. Slow or disconnected
readers cannot release an allowance while Node still retains their outgoing data.
Capture admits display scale and actual physical dimensions before accepting
native output; owner/document/display identity is rechecked around capture.
Physical RGBA (at most 51.2 MB), normalized RGBA (at most 12.8 MB) and finite
encoded/transport buffers are separate allocations, not a total-memory cap.
The private owner transport's larger outer allowance accounts only for JSON
escaping. It never enlarges App protocol, replay or page limits and does not
change ordinary daemon RPC or scheduling transport policy.
Poster-first history and bounded pagination avoid source hydration on every token.
No speed/memory improvement percentage is claimed without measurements.

Desktop debug exposes fixed lifecycle/queue/byte/capture/watchdog/retirement
counts/states only. Backend `/api/visualizations/debug?threadId=<id>` requires
explicit Debug mode, observed loopback, no HTTPS proxy marker and fresh owner
authentication. It returns pending/ready/failed capture counts and fixed
`capture-unavailable`, plus separately labelled local-process Apps owner/capture/
context/refusal counts. Those process-local counts are not exact-thread or
whole-daemon health/authority evidence. Neither path returns source, raw JSON,
tokens, native IDs, paths, image
buffers or exception causes. Debug availability cannot grant pending-source read
authority.

## Verification and replay

Focused schemas, store/session/receipt/MCP/HTTP/export, protocol, renderer and
native-policy fixtures qualify their isolated boundaries only. They do not prove
live provider support, OS permission delivery, native input/accessibility, hostile
retirement, packaged bridge parity or hosted release. Retain raw failure evidence
before diagnosis and rerun affected checks after edits.

Use pinned standalone Node and Corepack Yarn, with no installation:

```text
corepack yarn workspace @cafecode/contracts test src/visualizations.test.ts
corepack yarn workspace @cafecode/shared test src/visualizationJson.test.ts src/visualizationExecutionLane.test.ts src/mcpAppJson.test.ts src/mcpAppProtocol.test.ts src/mcpAppToolSchema.test.ts src/visualizationHostClient.test.ts
corepack yarn workspace @cafeai/cafe-code test --config vitest.config.ts src/visualizations src/mcpApps
corepack yarn workspace @cafecode/web test:browser src/components/visualizations
CAFE_CODE_VISUALIZATION_E2E=1 corepack yarn workspace @cafecode/desktop test src/visualizations/NativeVisualizationElectron.e2e.test.ts
corepack yarn workspace @cafeai/cafe-code build
CAFE_CODE_MCP_BRIDGE_E2E=1 corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/CafeMcpBridge.e2e.test.ts
```

The native Electron fixture is explicit opt-in with isolated synthetic data, not
live profiles/provider sessions. Required fmt/lint/typecheck/default tests,
relevant browser/native checks and `yarn build:desktop --force` **last on unchanged
source** remain mandatory. Exact-head native hosted jobs and nonempty release
artifacts are separate post-push verification, not implied by local passes.
The actual existing Electron 42.10.0 macOS arm64 fixture additionally verifies
exact generated and data-dependent App poster pixels/dimensions, same-document
expansion, native Apps self-message routing, offline CSP, sequential consent,
owner-hide retirement and startup/active page-loop watchdog retirement. It
preserves the original budgets and uses isolated synthetic data only. Linux CI
uses its existing `xvfb-run` display fixture; it must fail rather than install a
runtime or disable the sandbox when the required host capability is absent.
On disposable GitHub-hosted Linux runners, CI validates the already-installed
Electron `chrome-sandbox` as a regular non-symlink file, prepares its required
root ownership and `4755` mode, then verifies them before native qualification.
This changes only hosted fixture setup, never renderer sandbox flags, installed
user-machine permissions, or macOS/Windows runtime policy.

See the [foundation decision](decisions/agent-visualization-foundations.md) and
[execution-host decision](decisions/agent-visualization-execution-host.md) for
preserved boundaries, accepted resource exception and native qualification gates.
The separate [MCP Apps decision](decisions/mcp-apps-hosting.md) records exact-origin
capture, data-only poster replay, one-use consent and untrusted context boundaries.
No third-party implementation or prompt was copied into these independently
authored modules.
