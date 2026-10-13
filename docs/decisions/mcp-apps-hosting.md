# Decision: Configured-origin Apps and one-use browser-frame consent

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

Capture only a successful exact Cafe-owned Codex native tool result and the UI resource named by that current configured server/tool catalogue. Bind provider instance, root/child/native thread/turn/call, source/replay and session generation. Account-hosted targets, other providers and unsupported native methods fail without fallback.

Publish immutable source and original bounded input/result privately without preview execution. Load through the same Full-access ordinary-frame path. The stable2026-01-26 protocol initializes before replaying input then result; supports bounded ping, presentation context and inline/fullscreen.

A server-minted short action grant identifies exact thread/artifact/revision/browser frame/token and current Full access. Legacy wire leaseId means that frame ID, not a native process. Configured-origin tool/resource/link/message operations require one-use30-second consent, consume it before dispatch, and recheck current provider/catalogue/schema/ownership. readOnlyHint grants nothing. Replacement/expiry/access loss and lost acknowledgements never authorize another operation.

Strict JSON bounds are128KiB actualUTF-8/depth16/4096lexicaltokens; private outer-envelope/HTTP bounds remain separate. Frame routing checks exactWindowProxy/srcdoc; it is not protection against the admitted same-origin code using parent authority. Private original JSON remains outside ordinary history/debug. No general network/MCP proxy or App permission to install/change OS settings is added.

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
