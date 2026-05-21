# Burst 002 Design Proposal — codex

## Terminology

This proposal uses the vocabulary defined in `.selene/terminology_lock_v1.md`. `cafe-code` names this fork; `T3 Code` is used only for upstream lineage, legal/provenance text, current hosted-domain references, or explicit legacy compatibility.

## Candidate Directions

### Direction A: Single-Pass Repository-Owned Rebrand

- Goal: Rename all repository-owned `T3` / `T3 Code` / `t3code` / `@t3tools` / `T3CODE` surfaces to the required Cafe Code equivalents in one comprehensive implementation burst.
- Why useful: This most directly satisfies the Burst 002 seed by treating visible copy, package metadata, import specifiers, app IDs, docs, scripts, storage keys, env vars, and release metadata as one coherent rename.
- What it would falsify: It would falsify the assumption that any active repository-owned T3 naming can remain unclassified after the burst; remaining matches must be legacy compatibility, current hosted-domain defaults, legal/provenance, or test lineage.
- Estimated burst size: large
- Tradeoffs: Highest chance of finishing the required outcome in one burst, but also the largest review surface. Lockfile churn, package-scope changes, desktop metadata, and release/update compatibility must be handled carefully.

### Direction B: Compatibility-Spine First Full Rebrand

- Goal: First implement deterministic Cafe-first / legacy-second compatibility for env vars, config paths, localStorage keys, git refs, CLI bins, and updater-sensitive identifiers, then complete the source-wide Cafe Code rename.
- Why useful: It puts non-destructive migration behavior before broad textual and package renames, reducing the risk of orphaning existing state or breaking operator automation.
- What it would falsify: It would test whether the project can adopt Cafe Code canonical identifiers while still reading legacy `T3CODE_*`, `t3code:*`, `~/.t3`, `.t3code`, `t3`, and old checkpoint/ref names where required.
- Estimated burst size: large
- Tradeoffs: Better safety posture for security-sensitive data and persisted state, but may add temporary compatibility helpers or naming constants that need disciplined ownership. It still must finish the full rebrand to satisfy Burst 002.

### Direction C: Surface-Clustered Complete Rebrand With Audit Ledger

- Goal: Complete the full Cafe Code rebrand in ordered surface clusters: package/workspace identity, runtime compatibility, user-facing UI/docs, desktop/release metadata, and final `rg` audit plus domain migration checklist.
- Why useful: It preserves the required full implementation while making each class of rename reviewable and auditable against the seed’s falsifying criteria.
- What it would falsify: It would show whether every remaining legacy match can be classified against a written audit ledger as compatibility alias, legacy fallback, current hosted-domain reference, legal/provenance, or test fixture lineage.
- Estimated burst size: large
- Tradeoffs: More process overhead than a pure single-pass rename, but lower risk of hiding an unsafe deletion or unreviewed active T3 surface. The burst cannot close until all clusters and gates pass.

## Recommended Direction

I recommend Direction C. Burst 002 is explicitly a full implementation burst, so a partial visible-copy rename is not viable. A surface-clustered implementation gives the best balance: it keeps the end state comprehensive, preserves legacy reads where dropping them could lose data or break automation, and gives the auditor a concrete map for evaluating remaining `T3` / `t3code` / `@t3tools` / `T3CODE` matches. The implementation should end with `bun fmt`, `bun lint`, `bun typecheck`, targeted `rg` audits, and a domain migration checklist artifact covering DNS, TLS, deploy, redirects, cookies, pairing URLs, and update-channel criteria before any future move away from current `t3.codes` hosted defaults.

## Concerns / Open Questions

- Package scope migration from `@t3tools/*` to `@cafecode/*` may require coordinated package metadata, imports, scripts, TypeScript references, and lockfile updates.
- Desktop app IDs, updater metadata, and release artifacts may have external compatibility constraints that cannot be solved only inside the repository.
- Current `t3.codes` hosted-domain references must not be replaced with invented Cafe domains; they should remain only as current-default or legacy references until the checklist is executed.
- Legacy env vars, paths, storage keys, CLI bins, and refs should be read non-destructively, with Cafe Code names preferred for new writes.
- Focused tests may be useful for migration helpers, but the required completion gates are `bun fmt`, `bun lint`, and `bun typecheck`; do not run `bun test`, use `bun run test` only if needed.

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
