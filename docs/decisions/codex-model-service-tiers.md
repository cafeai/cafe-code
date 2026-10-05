# Codex advertised model service tiers

Decision status: Accepted within the user's provider-parity implementation request
Created: 2026-10-05 06:18:59 JST (UTC+0900)
Last updated: 2026-10-05 16:58:09 JST (UTC+0900)
Implementation status: Implemented and released; integrated local and exact-head platform CI gates verified on 36c64874.
Supersedes: None; extends the existing Fast selection without changing its meaning.

## Decision and authority

Preserve `model/list.serviceTiers` as an exact, bounded model/account capability,
not a Boolean. The existing generic model-option selector displays those choices
plus Standard (`default`, the native explicit-standard sentinel). No paid tier is
selected by default. An omitted choice continues to delegate to native settings.
Older Fast on/off selections retain their existing `priority`/`default` mapping;
an explicitly selected tier takes precedence. Native deprecated `additionalSpeedTiers`
may establish only the legacy Fast/priority capability when the new field is absent.

The selected instance's cached catalogue validates an explicit new tier before
native start/resume/turn submission. A removed or unadvertised tier fails visibly,
without automatic substitution, probing, paid retry, or rewriting a saved choice.
The renderer preserves such a choice as unavailable until the user changes it.
This is admission against observed catalogue metadata, not an entitlement or price
guarantee; native authorization remains authoritative.

## Protocol and compatibility

Codex `rust-v0.160.0`, immutable commit
`a956835d020762cb2b570053af06f643a11c0ecc`, keeps service-tier ids as open strings.
Its `tui/src/chatwidget/service_tiers.rs` forwards the selected catalogue id and
uses `default` to select standard routing. The protocol's deprecated Fast alias
maps to `priority`; `ultrafast` and other advertised ids are distinct choices.
Cafe bounds and validates identifiers and inert labels, preserving exact wire ids.
Custom models do not inherit another model's advertised service-tier eligibility.

The existing versioned accepted-turn snapshot gains an optional bounded tier id.
Work logs and Atrium use that frozen submitted setting, never today's selection.
It is explicitly not proof of the effective paid routing or billing. Older Fast
snapshots remain readable. No storage migration, credential/configuration edit,
provider restart, permission change, or new dependency is introduced.

## Verification

Use the pinned Node/Corepack Yarn toolchain. Synthetic model-discovery, option
migration, adapter wire/admission, configuration snapshot and browser selector
tests must cover legacy Fast, missing/hostile metadata, exact account/model
binding, removed tiers, serialized selections and explicit Standard after Fast.
Required repository checks and the final forced desktop build remain release
gates; source-level evidence does not claim live account entitlement testing.

Focused macOS arm64 qualification on the pinned Node 24.21.0/Corepack Yarn 4.17.1
toolchain: the combined skill-discovery/service-tier server selection passed 241 tests (one existing
platform-specific skip), web presentation/composer selection passed 76, shared
model selection passed 17, owner/context RPC selection passed 3, and the skill/tier
browser selection passed 9. Server and web typecheck passed. The integrated
release at `36c64874fce05cb037d69737b4833ccf7c37f52d` subsequently passed formatting,
lint, typecheck, 6,599 default tests, 934 browser tests, two isolated native
fixtures and the final forced desktop build. [Exact-head CI](https://github.com/cafeai/cafe-code/actions/runs/37258417302)
passed all seven applicable quality/artifact jobs with four nonempty platform
artifacts. Later changes require fresh release verification.
The [picker guide](../codex-model-and-skill-picker.md) describes user-visible behavior.
