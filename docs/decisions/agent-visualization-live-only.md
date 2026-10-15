# Decision: Inert publication and live-only display

Decision status: Accepted current design; implemented
Last updated: 2026-10-13 22:28:00 JST (UTC+0900)
Decision authority: the user explicitly requests direct chat embedding, enables
visualization MCP only under Full access, asks that earlier feature decisions be
rewritten to this model, and authorizes pushing this current changeset.
Implementation/evidence status: current code implements this design; repeat the
canonical qualification commands for the exact source. Decision acceptance and
historical evidence are not current release or live-adoption proof.
Current authority: [Full-access embedding](agent-visualization-inline-access.md).

## Context and decision

Both generated charts and external Apps publish immutable source/assets/replay without running code, creating previews or requiring native raster capture. Generated MCP advertises publication only. Exact observed native tool completion still precedes durable history admission; source/request/manifest/private/quota/idempotency checks remain.

Chat cards never fetch/display old poster images. They are either actual live Full-access browser frames or truthful stopped/waiting/unavailable reservations. Root-native PNG snapshot is not an activation or publication dependency. Old optional poster metadata remains decodable, with no migration or deletion of stored history.

Copy/Save current PNG uses bounded inert snapshot rasterization of the actual current frame, including canvas/image pixels. Script/events/network/actions are excluded; cancellation/decode/serialization have finite bounds. Unsupported content fails clearly rather than becoming a fake preview. Explicit private JSON and executable HTML export stay behind the quiet menu.

## Security, compatibility and failure consequences

This is deliberately privileged same-origin code. Full access does not make
source trustworthy or establish resource containment. Ordinary browser frames,
offline presentation and source commitments cannot prevent use of parent
authority. Current policy/ownership loss denies future reads/actions and removes
current documents; no restricted-mode fallback is admitted.

Preserve exact source/provenance/private ownership, finite data/resource work and
fresh configured App-operation consent. Generic attachment/Mermaid/provider and
native file-save policies are unchanged. No dependency/runtime/lock refresh,
installation, OS change, provider/profile access or live runtime reset is needed.
Existing owned history remains immutable and no saved poster is deleted.

## Verification and supersession

The user explicitly replaces the prior feature architecture and requests rewriting
these public decisions. Private historical evidence remains historical, not a
pass for the current browser path. Verify authoritative Full-access gates, real
interaction/layout/partial-scroll identity, offscreen teardown, font/fluid/private
data and App consent as relevant. Run required repository checks and the final
forced desktop build on unchanged source.

See [the guide](../agent-visualizations.md) and
[replay/CI qualification](../visualization-ci-qualification.md).
Local synthetic checks do not prove user-owned live adoption, installed OS
dialogs/IME/accessibility or hosted native-platform release delivery.
