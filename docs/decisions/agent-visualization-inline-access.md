# Decision: Full-access-only inline browser visualizations

Decision status: Accepted; implemented
Created: 2026-10-13 20:51:13 JST (UTC+0900)
Last updated: 2026-10-13 22:28:00 JST (UTC+0900)
Decision authority: the user explicitly replaces the separate execution host
with direct chat embedding, requires Full access before visualization MCP is
enabled, and authorizes rewriting feature documentation and pushing this set.
Implementation status: Full-access policy, inert publication, direct frame
hosting and native production-host retirement implemented. Repeat the canonical
qualification commands for the exact source; acceptance is not test evidence.
Supersedes: the feature's previous separate-host, poster-first and generated
preview decisions. Storage ownership/provenance and App-operation consent remain.

## Decision

Visualizations are ordinary unsandboxed same-origin browser frames inside the
conversation. They are layout and lifecycle containers, not a security boundary.
There is no separate Electron source window/view or execution watchdog. Code
in such a frame can access the same-origin chat application; Full access is
the required explicit operating mode for accepting this privileged-code risk.
Never claim that offline CSP, source hashes or visibility hints contain it.

Expose visualization MCP only to actual Full-access provider launches. Recheck
current exact session/thread access when publishing, and exact authenticated
chat/revision plus current thread Full access when loading stored source.
Missing/changed policy denies, including late replies. Renderer retires frames
immediately when received owner/access changes. Rendering an existing owned
chart does not itself require starting a provider or performing paid inference.

Publish immutable source without execution, preview or PNG. Exact observed
provider tool completion still admits the durable reference. Use a dedicated
bounded inline-source response, not private debugging-details access. Embed at
full available width and measured natural height; the conversation owns normal
scrolling. Multiple visible charts may run within finite application-wide
performance allowances. Removing offscreen/hidden/revoked frames terminates
their documents; partial scrolling must not reconstruct an active frame or
replay its entrance. Arbitrary code may ignore cooperative animation hints.

Use the actual bundled offline chat font and supplied fluid helper. Keep fluid
subtle, responsive to pointer input and static under reduced motion. Preserve
finite source, asset, frame, texture, resize and draw-rate budgets. Chart marks
and text remain crisp. Existing stored source is not rewritten.

External MCP Apps use the same embedding model while retaining exact configured
server/protocol/source/replay ownership and fresh consent for consequential
operations. Browser request ownership must not masquerade as an old native
lease. Private JSON/source inspection and export remain deliberate actions.

## Consequences and verification

This knowingly removes execution containment. Full access is not proof that
generated code is trustworthy, nor a hard CPU/RAM/GPU bound; malicious same-origin
code may interfere with the application. Selecting a restricted access mode
disables source loading/tool registration and removes active frames. Do not
silently enable visualizations in an unknown mode or copy this change into
provider permissions, unrelated HTML attachments or other features.

No installation or OS change is required. Current feature documentation and
previous feature decisions are rewritten under the explicit user request;
historical private evidence remains historical. Verify authoritative gates,
real frame interaction/layout/motion/offscreen teardown, source/privacy bounds,
App consent, static/default/browser/copied-bridge checks, and forced desktop
build last. Local browser evidence is not live adoption or hosted release proof.
