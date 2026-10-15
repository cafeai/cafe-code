# Decision: Subtle supplied fluid with bounded visible motion

Decision status: Accepted current design; implemented
Last updated: 2026-10-14 22:13:47 JST (UTC+0900)
Decision authority: the user explicitly requests direct chat embedding, enables
visualization MCP only under Full access, asks that earlier feature decisions be
rewritten to this model, and authorizes pushing this current changeset.
Implementation/evidence status: current code implements this design; repeat the
canonical qualification commands for the exact source. Decision acceptance and
historical evidence are not current release or live-adoption proof.
Current authority: [Full-access embedding](agent-visualization-inline-access.md).

## Context and decision

Reuse the actual supplied WebGL solver/shaders, shading, palette and orbit/splats through the fixed generated-only canvas[data-cafe-fluid] helper. Preserve its complete MIT notice and reviewed template SHA-256 e67688917b113eff12c54425e5a903e54e96a2512cb2f326c1c92f94b6b572ac. No runtime read of Downloads, remote engine, marketing copy or images is used.

Set display gain 1.1 and static alpha .132 (original plus 10%). Cap only the exact opted-in decorative canvas opacity at .15; guide a local 65% theme veil. Keep foreground untouched/crisp. Authored veils vary; this is not a universal pixel-ratio promise.

Retain one 30fps-bounded RAF, 512px longest physical side, eight finite simulation/dye targets, 16MiB logical target payload, finite resize admissions, passive coalesced pointer input, reduced-motion/static/context-loss fallback and exact disposal. Allow CSS width up to 4096 pixels without increasing physical canvas, target or memory bounds. Logical bytes are not hard driver/process memory. Existing source is immutable; external Apps receive no generated helper.

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

### Size-admission exhaustion clarification

The eight lifetime size admissions remain unchanged. A later valid CSS size
does not grant another allocation and does not end visible animation: retain the
last complete admitted drawing-buffer/target generation. Its private completion
dimensions and expected payload are minted only after all eight framebuffers
succeed and invalidated before target retirement. Both unchanged-size and
exhausted-budget reuse require those exact dimensions, all solver roles, eight
textures/framebuffers and the bounded matching payload. Invalid geometry is
validated before reuse; a replaced or incomplete buffer still fails closed.

This is a resource-exhaustion handling repair within the accepted bounds, not a
new trust boundary or increased budget. Only decorative CSS sampling can scale
after exhaustion; authored foreground layout, source and interaction remain
unchanged. Ordinary motion/pointer/visibility continue on retained targets;
reduced motion keeps its solved static output without another warm-up or RAF.
Context loss, removal and partial allocation failure retain exact cleanup.

Native-click regressions retain the original first-seven replacement accounting
and then prove no more allocation. Separately, real WebGL RGBA observations at the
same retained canvas/context/dimensions prove continuing pixel motion after
trusted controls; the GL recorder alone is not that proof. Synthetic Chromium
pixels do not establish physical GPU memory, the recording's absent live flags,
hosted platform delivery or current user-app adoption.

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
