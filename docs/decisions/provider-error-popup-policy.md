# Provider errors stay out of chat popups

Decision status: Accepted by the user's explicit request to remove these popups
Implementation status: Implemented; qualification boundary below
Created: 2026-10-12 18:40:02 JST (UTC+0900)
Last updated: 2026-10-12 19:17:56 JST (UTC+0900)
Supersedes: Only the witness-dependent generic-banner rule in
[Private provider retry/error details](private-provider-error-diagnostics.md).

## Context, alternatives and decision

The prior exact occurrence witness prevented an older private diagnostic from
silencing a newer failure. It also allowed native error prose to reappear while
diagnostic persistence or history hydration was unavailable. That contradicts
the user's requirement that ordinary provider errors never produce chat popups.
Adding more error-text patterns or waiting for the Work Log would retain gaps.

Ordinary provider errors and errors of unknown origin are therefore never shown
in the generic chat error banner. This rule does not depend on a recorded row,
current runtime, latest-turn clocks, history eviction or recovery acknowledgment.
Canonical session failure and existing Work Log diagnostics remain unchanged;
presentation must not acknowledge, clear or classify a provider failure as
recovered. The private reader and its explicit escaped JSON disclosure remain
the inspection path, including honest legacy/unavailable detail state.

Local feedback has explicit renderer-only provenance. Detail/shell snapshots and
session updates replace that provenance with provider origin even for identical
error text. Missing legacy evidence is not local provenance. A duplicate native
session error echoed by a local catch is still hidden. Draft validation is local.
The exact public Codex history-required control and owner-gated Claude response-
limit control retain their existing lifecycle/action checks. Provider status and
approval/input controls remain separate; arbitrary authentication or permission
words inside native prose cannot enable a generic banner.

Dispatch failure presenters use fixed operation feedback instead of arbitrary
RPC/provider error text, including send, steer, compaction, goal, interrupt,
approval/input and implementation-thread actions. Explicit Cafe-authored local
validation crossing asynchronous preparation uses a renderer-owned error class,
not an upstream message pattern or serialized tag. Draft restoration, scoped
local send-failure feedback and existing Stop/queue ownership remain unchanged.

## Security, compatibility and verification boundary

This narrows passive disclosure of private provider prose, paths and request IDs
without changing provider retries, permissions, lifecycle or canonical storage.
The provenance flag is renderer-only presentation metadata, not an authentication
or provider-control capability, and introduces no wire schema or migration.
No dependencies, worker caps, media/input policy or deadlines change.

Source boundaries are `store.ts`, `providerErrorPresentation.ts`,
`ThreadErrorBanner.tsx` and `rpc/transportError.ts` in `apps/web/src`.
Synthetic store, banner, composer/recovery and RPC-presenter regressions qualify
missing metadata, same-text replacement, no dismissal mutation, exact dedicated
controls, local feedback and private Work Log disclosure. Repository checks and
the final forced desktop build are required. Local evidence is not live native
provider or release qualification; normal rebuilt adoption is required and this
change does not manipulate a running session.
