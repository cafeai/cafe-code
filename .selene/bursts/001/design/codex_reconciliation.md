---
verdict: agree
preferred_focus: source-grounded-tiered-rename-classification
synthesis_or_argument: Adopt a synthesis of codex Direction A and claude Direction B: Burst 001 should produce a source-grounded, tiered rename classification artifact, not perform the rename. Claude's proposal contributes the strongest concrete surface inventory, while codex's proposal frames the right safety boundary: every T3 Code/t3-code/t3code identity surface must be classified before implementation so user-facing brand changes, migration-sensitive identifiers, compatibility aliases, and provenance references are not collapsed into a risky global substitution.
---

# Burst 001 Reconciliation — codex

## Selected Direction

Source-grounded tiered rename classification — produce an auditable repository-wide plan for renaming T3 Code identity surfaces to Cafe Code without implementing the rename in this burst.

## Why this direction

Both proposals converge on the same core direction: a global rename is unsafe without first classifying source-derived surfaces. Claude's proposal adds useful concrete targets across desktop metadata, package identity, persistence, update/release metadata, hosted URLs, CLI names, and provenance docs. This burst should turn that inventory into a strict planning artifact whose classifications are reviewable and falsifiable before any user-facing or compatibility-sensitive changes land.

## Concrete Burst 001 Plan

- Goal: Create a single Burst 001 design artifact that inventories every discovered `T3 Code`, `t3-code`, `t3code`, `t3`, `@t3tools/*`, and related identity surface, then assigns each one a rename classification and rationale.
- Branches / sub-tasks: source inventory across `apps/desktop`, `apps/web`, `apps/server`, `packages/*`, root/package metadata, scripts, release workflows, docs, ADRs, hosted URLs, install/update metadata, env vars, persisted paths, protocol/session surfaces, and branding copy; classification table; migration notes; open external-dependency questions.
- Predeclared classifications: cite `.selene/classifications.py` and use only the admitted strict-close classes, including user-facing rename now, internal rename with migration, compatibility alias / leave stable, and provenance reference / leave as T3 Code.
- Falsifying criteria: the direction is falsified if source review shows the rename is either entirely presentation-only with no migration-sensitive surfaces, or if required classifications cannot be represented by `.selene/classifications.py`; individual classifications are falsified by source evidence that a surface is persisted, externally consumed, release-channel-sensitive, or provenance-only contrary to its assigned class.
- Required deliverables: one checked-in markdown design artifact under the Burst 001 Selene design area; a table of concrete file/surface references with classification, rationale, and implementation note; explicit Nightly preservation guidance; explicit non-goals for this burst; verification statement that no rename implementation was performed; required future gates of `bun fmt`, `bun lint`, and `bun typecheck` for implementation bursts.
- Hard non-claims: append the canonical block.

## Disagreement (if verdict is "disagree")

N/A.

## Hard Non-Claims

- No Selene artifact claims that cafe-code is secure, correct, race-free,
  deadlock-free, data-loss-free, or compatible with any upstream provider API
  outside the artifact's predeclared scope.
- No user-facing behavior, migration, protocol, or security claim is promoted
  unless it is grounded in source review and the repository's required quality
  gates for the touched surface.
- Provider output is untrusted. Selene enforces process discipline; it does not
  make Claude, Codex, Cursor, OpenCode, or any other provider semantically
  correct.
- This artifact does not claim coverage of credentials, tokens, local files,
  persisted conversations, WebSocket sessions, or provider subprocess behavior
  beyond the exact checks recorded in the artifact.
- This artifact does not promote any classification beyond what the executable
  strict-close rules in `.selene/classifications.py` admit.
