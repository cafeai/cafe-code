# Default unset Codex routing to Standard

Decision status: Accepted for the user-requested Fast Off repair
Created: 2026-10-21 10:00:58 JST (UTC+0900)
Last updated: 2026-10-21 10:00:58 JST (UTC+0900)
Decision authority: The request to fix Fast Off, default unset choices to Off and publish to dev.
Implementation status: Implemented; verification recorded separately.
Supersedes: Only native inheritance for unset ordinary Cafe routing in [model service tiers](codex-model-service-tiers.md) and [legacy Fast parity](codex-legacy-fast-tier-parity.md).
Superseded by: None

## Context and decision

The legacy Fast control renders an absent Boolean as Off, but formerly omitted
that setting from dispatch. Native Codex could then retain priority routing from
its configuration or the preceding turn. Modern tier catalogues likewise had no
explicit Standard default. The displayed choice and actual request could differ.

An ordinary Cafe Codex opening or new turn with no selection now explicitly
requests `serviceTier: "default"`. Explicit legacy Off requests the same value;
On remains `priority`. A saved exact tier continues to take precedence over a
stale legacy Boolean, including conflicting serialized selections. Catalogue
ordering, default markers and cached current values cannot consent to paid
routing. The existing one-shot Codex metadata helpers use the same resolver and
explicit Standard default. No provider configuration file is edited.

Service tiers never use effort-only prompt aliases. A malformed Boolean under
the modern `serviceTier` key remains visibly unavailable: the picker carries a
fixed invalid-syntax marker into the existing server refusal instead of borrowing
cached paid routing. That marker cannot match a native tier identifier and grants
no submission authority. Legacy `fastMode` Booleans retain their separate mapping.

The current [app-server documentation](https://developers.openai.com/codex/app-server/)
describes native opening/turn lifecycle. The repository's generated protocol is
pinned to `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`; its
[`config_types.rs`](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/protocol/src/config_types.rs)
defines `default` as the explicit Standard request sentinel, suppressing model
catalogue defaults, and maps Fast to `priority`. The pinned TUI's
[`service_tiers.rs`](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/tui/src/chatwidget/service_tiers.rs)
uses that sentinel when turning Fast off. Cafe uses the existing structured
request fields rather than inferring routing from a label or changing schemas.

## Preserved boundaries and alternatives

Relabeling the work log would hide actual requests; retaining native inheritance
would contradict the user's requested Off default. Rewriting saved choices or
provider profiles is unnecessary. Exact advertised custom tiers retain their
existing account/model capability validation, visible refusal and precedence.
Another account's selection is never converted into an override for this owner.

An in-flight steer does not change the current turn's routing. Native review
continues to inherit its materialized session settings. A private guarded
failed-root or unchanged-policy continuation retains its exact recorded opening
policy, including legacy omission; it is not an unset composer choice. Cold
recovery's retained policy wins over ordinary opening defaults. Low-level native
runtime omission and native snapshot observation remain unchanged.

## Security, compatibility and evidence

No new entitlement, paid retry, inference probe, provider restart, permission,
credential access, storage migration, timer or dependency is introduced. Explicit
removed tiers still fail rather than silently downgrade. Accepted-turn settings
and native configured-tier snapshots remain distinct from billing or execution
proof. Historical work logs are not rewritten and running turns are untouched.
The generic legacy Fast Boolean used by Claude retains its existing semantics.

Synthetic regressions qualify catalogue/selection serialization, exact-owner
resolver admission, helper argv, adapter opening/send/recovery/review guards,
native protocol fields and the real browser selector. Repository checks and the
forced desktop build qualify source delivery, not live account capacity or
installed-app adoption. The [picker guide](../codex-model-and-skill-picker.md)
documents current user-facing behavior.
