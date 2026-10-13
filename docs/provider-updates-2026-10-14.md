# Codex capacity, connection stability and instruction efficiency

Created: 2026-10-14 03:37:09 JST (UTC+0900)
Last updated: 2026-10-14 03:54:42 JST (UTC+0900)
Status: source and focused provider/viewport qualification complete; hosted delivery requires independent verification

## Provider version and capacity boundary

The current stable release is Codex `rust-v0.162.1`. Cafe's generated protocol
already targets immutable commit `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`.
The stable patch contains native fixes for multiline question rendering and
background-server feature compatibility; regenerating schemas or adding a Cafe
launcher override does not install those fixes. This review installs nothing and
does not interrupt existing provider sessions.
[Official changelog](https://learn.chatgpt.com/docs/changelog),
[immutable release](https://github.com/openai/codex/releases/tag/rust-v0.162.1).

The native `ServerOverloaded` error carries the “selected model is at capacity”
condition. Native `FlexUnavailable` is a separate terminal condition, not the
same recovery category. Quota, authentication, policy and unknown errors must not
gain retry authority merely because their prose mentions capacity or HTTP 429.
Cafe already recognizes structured server overload after a definitive failed
root. It retains the exact native conversation and uses its guarded, backed-off
short continuation; it does not replay the original input or tool calls.
[Native error distinctions](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/error.rs),
[accepted recovery design](decisions/codex-persistent-transient-recovery.md).

Native Codex owns stream retry budgets, server retry advice and transport
fallback. Cafe's app-server error envelope does not expose the full native
retry-after advice, so Cafe must not invent that deadline from error text.
Adding another retry loop inside native retries, switching models or service
tiers silently, or increasing default retry/idle budgets is not justified by
this audit. The official `-32001` app-server ingress overload belongs to the
WebSocket request boundary; it is not evidence of inference model capacity and
does not authorize replaying an ambiguous mutation. Cafe's provider connection
uses its existing structured stdio client.
[Native retry implementation](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/responses_retry.rs),
[app-server lifecycle](https://learn.chatgpt.com/docs/app-server),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The review therefore preserves the current retry policy. Fresh account, driver,
native generation, failed-root and immutable attempt/receipt proof still precede
each Cafe continuation. Stop, new input, compaction, closed context and uncertain
acceptance revoke or park recovery. These guards prevent duplicate submission;
they cannot manufacture upstream model capacity.

## Smaller collaboration guidance without losing chart features

Codex previously received the complete visualization generation guidance both
in the collaboration-mode instruction value and in the configured
`publish_visualization` tool description. The collaboration value now uses a
compact, stable reminder requiring the agent to discover and read that complete
tool description **before authoring** visualization content, and to preserve the
user's visual requirements. The complete publisher description remains unchanged.
Claude and other provider instructions are not changed by this optimization.

Configured MCP parsing, deferred tool discovery and Code Mode retain the full
description in this native version. This is the configured stdio MCP path, not
the separately truncated plugin-summary path. No preview tool or static poster
is introduced. Inline colorful charts, animation, fonts, responsive layout,
subtle bundled fluid decoration, exact ownership and Full-access restrictions
remain part of the full generation contract.
[MCP tool description mapping](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tools/src/mcp_tool.rs),
[visualization contract](agent-visualizations.md).

The reminder is 903 UTF-8 bytes rather than the duplicated 10,175-byte full
guide: a 9,272-byte reduction in that conditional instruction fragment. The
Default and Plan fragments including the reminder are 1,901 and 8,012 bytes,
respectively; their collaboration-mode rules are unchanged.

Native Codex hashes and diffs collaboration settings, so unchanged instructions
are not necessarily inserted on every turn. The reduction concerns duplicate
instruction bytes and subsequent mode/model/instruction transitions, not a
measured per-turn or billed-token saving. Prompt caching is native-owned; no
cache key, experimental flag, retention policy, context/compaction budget,
model, effort or service tier is changed. Cached input still counts against
token-per-minute limits and is not a remedy for model capacity.
[Native collaboration settings](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/context/world_state/collaboration_mode.rs),
[official prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

## Verification and delivery

Real browser regressions reproduce the old viewport code's missed admission at
a fractional clipped edge and after a clipping ancestor grows through a
stylesheet. The repaired code resamples current clipped geometry on owning
scroll and bounded ancestor resize, retains the same document during partial
scrolling, and unloads it when fully out of view. The loading status covers actual
reservation, source and document readiness; it does not authorize another frame,
source read or offscreen execution. Both regressions fail against the old
visibility effect and pass with the repair. Focused qualification passes 51
browser cases and 229 synthetic provider/metadata cases; these are not live
provider-capacity or native Windows/Linux proofs.

An observed native macOS CI security probe expired at the document-constructed
phase, before its frame-load callback could transfer the one-use port. No parser,
mutation or render phase was observed. The complete Mermaid security file now
has a dedicated sequential macOS/Windows qualification step instead of sharing
the broad file batch. All 114 cases, fresh opaque documents, nonce/port checks,
fixed ten-second allowance, native input contexts and two-worker cap remain
unchanged; Linux retains its complete browser suite. The precise runner delay is
unestablished, and this scheduling partition is not a proven CPU or parser
diagnosis. Only that synthetic fixture's exact screenshot directory is added to
failure diagnostics. See [browser qualification](browser-test-input-isolation.md).

Use the repository-pinned Node/Corepack Yarn toolchain. Focused synthetic
requests must preserve user input, model/effort/tier, approvals and sandbox
parameters; complete tool metadata remains available before chart authoring.
The combined change also qualifies chart viewport admission and loading/readiness
with real browser frames, without source previews, offscreen execution, extra
frame capacity or relaxed owner checks.

Run formatting, extraction/check, lint, repository audit, uncached typechecks,
default tests and the complete browser suite, followed by the forced desktop
build **last** on unchanged source. Local macOS synthetic checks do not prove
live provider capacity or native Windows/Linux behavior. Dev delivery separately
requires the exact push-event CI run's three Quality jobs, native Windows/macOS
artifact jobs, Linux AppImage qualification and four nonempty unexpired release
artifacts. Diagnostic ZIPs are not releases; a dev push does not publish a tag.
