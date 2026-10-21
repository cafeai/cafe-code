# Preserve canonical Fast across independently owned catalogues

Decision status: Accepted for the user-authorized Fast-mode repair
Created: 2026-10-18 07:02:17 JST (UTC+0900)
Last updated: 2026-10-18 07:09:03 JST (UTC+0900)
Decision authority: The current request to trace and fix the reported rejection and publish to dev.
Implementation status: Source and synthetic regressions implemented; exact-source publication qualification is recorded separately in task evidence.
Supersedes: Only the blanket modern-descriptor requirement for explicit canonical Fast in [model service tiers](codex-model-service-tiers.md).
Superseded in part: [Standard default](codex-standard-default.md) replaces native inheritance for unset ordinary Cafe requests only; exact-tier precedence and capability admission remain unchanged.

## Context

Backend picker discovery and native daemon status own separate model catalogues.
Refreshing the picker does not refresh the daemon's independently owned snapshot.
The native picker can therefore serialize `serviceTier: "priority"` while the
daemon still represents the same model's supported Fast choice as a Boolean
`fastMode` descriptor. Previously, that exact tier was rejected while equivalent
`fastMode: true` was accepted. Local command receipts demonstrated both outcomes
for the same account, model and effort, without a native request on the refusal.

Codex 0.163.0, immutable commit `83086188ae0614bd882818ff1aa23f3194962012`, retains
`priority` as Fast's canonical request value in `protocol/src/config_types.rs`.
The API's accepted `fast` alias is not a reason to rewrite catalogue identifiers.
Neither static support nor a successful Cafe admission proves account entitlement,
downstream execution or billing. Native authorization remains decisive.

## Decision and boundaries

Admit exact `priority` against the selected owner's exact model when that row has
an existing Boolean `fastMode` capability and **no** modern `serviceTier`
descriptor. This is the same native routing already admitted by legacy Fast on;
it does not grant a new paid tier or trust catalogue data supplied by the caller.
Use one shared predicate for server admission and presentation of saved choices.

Any modern descriptor takes precedence, including an explicitly empty list,
Standard-only list or malformed descriptor kind. Missing model/capability,
another model/account and arbitrary exact tiers cannot use this compatibility
path. Explicit tier choices retain precedence over stale Boolean values. Omission
still inherits native settings; explicit Standard still requests `default`.
No paid default is selected and no saved choice is rewritten merely by rendering.

Other explicit tiers still require the owner's advertised modern capability.
Synchronizing arbitrary new tiers between backend and daemon would require a
separate owner-authoritative discovery design. Copying renderer metadata into
admission, accepting any requested tier or probing during sends is not a solution.

## Failure, privacy and verification

Preserve existing visible Work Log failure and durable input on refusal. Do not
replay a failed message, switch account/model, upgrade to Ultrafast, downgrade to
Standard or interrupt active work. This change adds no providers, calls, timers,
permissions, credentials, catalogue writes or dependency updates. Existing command
debug summaries distinguish exact-tier and legacy-Boolean requests without prompts.

Pure admission/presentation tests cover serialized equivalent choices, explicit
precedence, absent/wrong-model/wrong-type evidence, modern revocation, unknown
tiers and exact-account isolation. Synthetic adapter tests verify exact routing
at startup and send plus zero native calls for refusals. Repository checks and
the forced desktop build qualify publication separately from live account support.
