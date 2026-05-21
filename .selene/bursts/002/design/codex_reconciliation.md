---
verdict: agree
preferred_focus: matrix-driven-full-sweep
synthesis_or_argument: I agree with Claude's Matrix-Driven Full Sweep as the preferred close criterion, with my audit-ledger emphasis folded in as the implementation report and final `rg` classification pass. The Burst 001 matrix is the strongest available source-grounded checklist, while clustered/layered execution can still be used internally to reduce risk. Burst 002 should not close on a visible-copy rename alone; it must rename repository-owned Cafe Code surfaces, preserve legacy reads where state or external contracts require it, and classify every remaining legacy match against `.selene/classifications.py`.
---

# Burst 002 Reconciliation — codex

## Selected Direction

Matrix-Driven Full Sweep with Tiered Compatibility — complete the Cafe Code rebrand against the Burst 001 rename matrix, with migration aliases and an auditable row-by-row close report.

## Why this direction

The existing 58-row Burst 001 matrix gives Burst 002 a concrete completion boundary instead of an open-ended textual sweep. It also handles the seed's stricter stance cleanly: rows previously left as compatibility-only must now either be renamed with migration, retained as aliases with precedence, or justified as provenance/legal/current-hosted-domain references. Layered or package-clustered execution remains useful as an implementation order, but the reconciliation focus should be matrix closure plus strict final audit.

## Concrete Burst 002 Plan

- Goal: Rename repository-owned `T3` / `T3 Code` / `t3code` / `@t3tools` / `T3CODE` surfaces to Cafe Code equivalents where the seed requires action, while preserving non-destructive compatibility for persisted state, env vars, CLI/package aliases, updater-sensitive identifiers, and current hosted-domain defaults.
- Branches / sub-tasks: execute the Burst 001 matrix in reviewable clusters: package/workspace identity, CLI and runtime aliases, env/config/storage migration, web/server/desktop visible copy, docs/scripts/release metadata, hosted-domain checklist, then final audit/report generation.
- Predeclared classifications: cite `.selene/classifications.py` and classify each remaining or changed row as `user_facing_rename_now`, `internal_rename_with_migration`, `compatibility_alias_leave_stable`, or `provenance_reference_leave_as_t3_code`.
- Falsifying criteria: any matrix row lacks a Burst 002 disposition; any active repository-owned visible T3 naming remains outside admitted classifications; Cafe-first/T3-second migration precedence is missing where required; Nightly channel identity drifts; current `t3.codes` hosted defaults are replaced without the required migration checklist; or `bun fmt`, `bun lint`, or `bun typecheck` fails.
- Required deliverables: source changes, regenerated lockfile/package metadata where needed, focused `bun run test` coverage for migration helpers if added, `.selene/bursts/002/implementation_report.md` mapping matrix rows 1-58 to outcomes and anchors, `.selene/bursts/002/design/domain-migration-checklist.md`, final targeted `rg` audit, and passing `bun fmt`, `bun lint`, `bun typecheck`.
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
