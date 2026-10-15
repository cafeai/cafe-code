# Decision: Immutable visualization data and exact Full-access authority

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

Keep schema-only contracts, compact safe references and private immutable source/assets/diagnostics. Exact UTF-8, unknown-field refusal, bounded non-echoing JSON decoding, owner/session commitments, idempotency, quotas and observed native tool completion remain authoritative.

Actual provider launch mode and current persisted thread policy must both be Full access to register/publish. Historical inline loading needs exact authenticated thread/revision ownership and current Full access, not a live provider. Source reads recheck policy after asynchronous assembly. A ready reference proves publication, not successful execution. Raster headers, dimensions, pixels, bytes, integrity and namespace identity remain bounded.

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
