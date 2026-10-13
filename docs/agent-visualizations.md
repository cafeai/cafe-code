# Agent visualizations and MCP Apps

Status: Full-access inline-browser implementation
Last updated: 2026-10-14 03:54:42 JST (UTC+0900)

Visualizations are live, ordinary same-origin browser documents embedded in the
conversation. They are not image previews. They fill the available chat width,
reserve measured natural height, and start automatically when actually visible.
Multiple visible units can run together; offscreen documents are removed.

## Full access and risk

Visualization MCP is registered only for actual Full-access Codex and Claude
launches. Current persisted thread policy is checked again at publication and
source loading. Missing or restricted policy denies; changing the received
thread policy removes live frames. Composer drafts/defaults do not grant access.

These frames intentionally have no sandbox attribute. They can access the
same-origin chat application and its authority. Full access means accepting that
privileged-code risk, not proving source trustworthy or imposing a hard memory,
CPU or GPU limit. The offline CSP and integrity hashes are useful policies, not
execution containment. Do not run untrusted charts in a sensitive environment.

Generic HTML attachments, Mermaid, provider permission modes and native PNG-save
authorization are separate and unchanged. No installation, new application/Dock
entry, profile change or OS setting is required. Existing sessions get the new
tool through normal rebuilt-runtime startup/resume; no live retrofit is performed.

## Publication and provenance

The session-only `visualization-mcp-bridge.mjs` exposes
`publish_visualization`, not a preview tool. Publication saves bounded immutable
source and declared owned raster assets without executing code or capturing PNG.
Saving succeeds independently of browser rendering. An exact observed provider
tool completion still admits the durable history reference.

The connection is bound to its chat, account and actual native provider
generation; it is separate from scheduling and the optional management MCP.
Publication input cannot select a chat, account, path, destination or arbitrary
network resource. Request UUID/content idempotency, tombstones, private
commitments, storage quotas, transport bounds and opaque failures remain enforced.
Grok and other provider paths are not advertised without qualified provenance.

Ordinary history contains compact references, not source, raw JSON, credentials
or executable authority. Existing immutable artifacts need no migration or
poster deletion; old poster metadata remains decodable but is never a live-display
fallback. Exact authenticated historical source loading does not start a provider.

## Browser lifecycle and layout

The renderer uses a shared finite FIFO pool: four frames, two in-flight source
reads, eight pending reads, 128 anchors and 16 panes. It does not eagerly execute
the whole history. Source reads return only the owned tuple/purpose/HTML and a
short browser action grant. The server checks current Full access before and
after assembling source. Renderer checks owner, exact tuple and current received
policy again before installing a late response.

Frames occupy normal chat flow, not a floating native overlay. Natural extent
uses bounded/coalesced natural-flow descendant measurement; supported inline
height is 80–2000 CSS pixels. Generated authors must reflow controls/labels within the
available width. Oversized arbitrary source has truthful constrained status and
can be expanded; hiding overflow is not a universal repair for malformed HTML.
The actual conversation owns wheel/review/tail position. Partial scrolling keeps
the same document, so it does not replay an entrance animation. Fully leaving
view removes the frame; returning creates a new document and arbitrary page state
is not persisted automatically.

Actual clipped geometry is the viewport admission truth. Threshold-zero
intersection notifications only wake sampling: an edge or fractional crop can
be intersecting without yet having usable pixels. Owning scroll and bounded
anchor/ancestor resize observations resample at most once per animation frame,
so moving inward cannot leave that chart stuck outside admission. Partial scroll
still retains the same document; sampling never adds frame/read capacity.

While an actually visible unit waits for admission, source or document readiness,
a delayed small loading sparkle and status identify pending work. Ready charts
remain interactive without an overlay; paused, failed, offscreen and revoked
units are not advertised as loading. Reduced motion keeps the indicator static.
This is not a preview image or permission to execute outside the viewport.

There is no five-minute execution limit. The built-in fluid pauses when hidden,
and removing the frame terminates its document. Arbitrary privileged code can
ignore cooperative animation hints. A 30-second renewable server action grant is
not an execution lifetime: visible current owners refresh it, while App consents
remain one-use and nonrenewable. Hidden owner, pane/route/access or authenticated
transport loss removes active frames and clears private bytes.

## Appearance and authoring

Use one unit per independent chart/KPI strip/table so the conversation stays
readable. Prefer responsive actual-width chart coordinates, uniformly scaled
text and finite animated data/filter/KPI transitions. Run an entrance once per
document, not on every scroll, theme or resize event. Respect reduced motion.

Codex's collaboration fragment carries a compact reminder to discover/read the
complete publisher description before authoring. The full generation guidance
remains the actual `publish_visualization` tool metadata, including deferred
discovery and Code Mode. User visual requirements and access policy are unchanged;
removing the duplicate fragment is not a measured per-turn billing claim. See
[the provider review](provider-updates-2026-10-14.md).

Generated documents receive the actual bundled DM Sans Variable faces used by
chat, with semantic code left monospace. Font bytes, descriptors and OFL notice
are fixed and offline. External Apps retain their own typography.

The optional `canvas[data-cafe-fluid]` uses the actual supplied fluid solver,
not an approximate swirl. Its MIT notice and immutable provenance are retained.
The helper is decorative and pointer-inert; foreground charts remain crisp.
Gain is original plus 10% (1.1), static alpha .132, exact opted-in canvas opacity
at most .15, and new-generation guidance uses a theme-local 65% frosted veil.
Existing authored veils can be darker; this is not an exact universal pixel ratio.

The helper retains one 30fps-bounded RAF, 512px longest physical canvas side,
eight bounded simulation/dye targets, finite resize admissions and exact cleanup.
CSS width can reach 4096 pixels without raising the physical canvas or texture budget.
The logical texture allowance is not physical driver/RSS accounting. Pointer
input is coalesced, reduced motion is static, and context loss/unsupported formats
keep a readable fallback. There is no cumulative frame-count freeze.

## Quiet controls and explicit inspection

A hover/focus/touch-accessible “…” menu contains Stop/Restart, Expand, Copy/Save
current PNG, HTML export and Private source and JSON. Ordinary viewing shows no
raw debugging data or start/stop toolbar. Private inspection loads only after a
deliberate action, remains bounded, and clears on owner loss.

PNG export snapshots the current frame into a bounded inert raster document.
CSS source width can reach 4096 pixels; larger layouts are uniformly reduced to
the existing 1600-pixel output-width and 3.2-million-pixel limits, preserving
the original layout and font aspect ratio rather than stretching either axis.
It copies actual canvas/image pixels, strips executable actions and rejects
unsupported/unreadable content rather than supplying a saved preview. Native
clipboard/save retains its trusted requesting-document and user-selected
destination checks. This is a bounded inert re-render, not pixel-exact compositor
capture: unsupported backdrop filters, masks and blend effects are not reproduced.
Arbitrary WebGL without a preserved drawing buffer may have no pixels at export
time; the bundled decorative helper preserves its buffer. HTML export is a
deliberately executable derived file; its consent explains the same privileged-code
risk and does not export App authority.

## External MCP Apps

An actual Cafe-owned Codex transport can capture the exact configured MCP
server's UI resource and original completed tool input/result. Account-hosted
targets and unsupported provider/resource methods fail explicitly. External Apps
publish immutable source/replay without preview execution and use the same
Full-access inline-frame lifecycle.

The stable 2026-01-26 protocol supports initialize/initialized, input then result
replay, ping, host presentation context and inline/fullscreen requests.
Configured-server tool/resource/link/message operations require fresh one-use
consent, exact source/frame/account/server ownership and a current catalogue.
Read-only annotations grant nothing. No general MCP/network proxy or provider
fallback is supplied. Consent is bounded to 30 seconds and consumed before
dispatch; a lost acknowledgement is not authority to repeat a mutation.
Private original JSON is not in ordinary history/debug logs.

The UI broker still validates exact WindowProxy/srcdoc routing and bounded JSON.
That is routing hygiene, not a guarantee against a same-origin malicious page
using parent APIs outside this broker. Provider termination can revoke actions
while leaving owned history inspectable; viewing history never restarts inference.

## Diagnostics, verification and decisions

Debug output uses fixed mode/access/queue/frame/byte/status scalars only, never
source, private JSON, tokens, URLs, native buffers or paths. A failure classification
is not its initiating cause. Preserve exact raw private failure logs before
diagnosis, and do not recover by resetting a live runtime.

See [CI qualification](visualization-ci-qualification.md) for replay commands.
Local synthetic browser checks do not establish live app adoption, OS dialogs,
installed IME/screen-reader behavior or hosted release delivery. The final forced
desktop build must follow all required tests on unchanged source.

Current decisions: [Full-access embedding](decisions/agent-visualization-inline-access.md),
[data/provenance](decisions/agent-visualization-foundations.md),
[execution](decisions/agent-visualization-execution-host.md),
[viewport pool](decisions/agent-visualization-viewport-pool.md),
[inline flow](decisions/agent-visualization-inline-flow.md),
[visible lifetime](decisions/agent-visualization-visible-lifetime.md),
[fluid](decisions/agent-visualization-fluid-background.md),
[typography](decisions/agent-visualization-chat-typography.md),
[live publication](decisions/agent-visualization-live-only.md), and
[Apps](decisions/mcp-apps-hosting.md).
