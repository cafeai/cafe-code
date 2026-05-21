# Burst 001 Design Proposal — codex

## Terminology

This proposal uses the canonical vocabulary in `.selene/terminology_lock_v1.md`. In particular, `cafe-code` names this fork, `T3 Code` is reserved for upstream lineage or compatibility/provenance references, and `provider`, `provider session`, `Codex app-server`, `WebSocket protocol`, `orchestration domain event`, `projection`, `environment`, `contracts package`, `shared package`, `desktop app`, and `security-sensitive data` retain their locked meanings.

## Candidate Directions

### Direction A: Source-Grounded Rename Classification Matrix

- Goal: Build a repository-wide rename inventory that classifies every `T3 Code` / `t3-code` / related identity surface before implementation.
- Why useful: This directly satisfies the Burst 001 seed by turning the rename into an auditable map instead of a risky global string replacement, with each target classified as user-facing rename now, internal rename with migration, compatibility alias / leave stable, or provenance reference / leave as T3 Code.
- What it would falsify: It would falsify the assumption that the rename is mostly visible copy by exposing any storage keys, package names, bundle identifiers, protocol constants, release metadata, updater channels, desktop paths, or persisted data fields where renaming could break existing installs or sessions.
- Estimated burst size: medium
- Tradeoffs: It delays visible product changes, and it requires careful source review across `apps/server`, `apps/web`, `apps/desktop`, `packages/contracts`, `packages/shared`, docs, scripts, and release metadata. The upside is that it produces the safest implementation plan and a defensible migration boundary.

### Direction B: User-Facing Brand Rename First

- Goal: Prioritize visible product surfaces so the browser UI, desktop UI, window titles, onboarding text, settings, empty states, toasts, screenshots, and docs say `Cafe Code` while leaving internal identifiers stable.
- Why useful: This would create fast user-visible progress and avoid touching high-risk compatibility surfaces during the first implementation pass.
- What it would falsify: It would test whether most product identity is isolated to presentation code and documentation, and whether the Nightly identity can remain intact without conflicting with the new brand.
- Estimated burst size: small
- Tradeoffs: This is lower risk than broad internal renaming, but it may leave confusing mixed terminology in code, package metadata, artifact names, or release scripts. It also does not by itself answer which internal `T3 Code` references are provenance, compatibility, or migration candidates.

### Direction C: Compatibility-First Identity Migration Plan

- Goal: Focus the burst on high-risk identity surfaces such as storage keys, database fields, WebSocket protocol constants, desktop bundle identifiers, config directories, package names, updater metadata, and release artifacts.
- Why useful: These are the places most likely to affect saved sessions, local data, desktop installs, provider sessions, and update behavior, so planning them first reduces the chance of silent compatibility breaks.
- What it would falsify: It would falsify any claim that internal renames are safe without explicit migration or aliases, especially around persisted client storage, SQLite data, auth/session state, package import paths, and release/update channels.
- Estimated burst size: large
- Tradeoffs: This direction gives the strongest migration discipline but is too narrow on user-facing brand completion and may over-invest before the full inventory shows which surfaces actually exist.

## Recommended Direction

I recommend Direction A: Source-Grounded Rename Classification Matrix. Burst 001’s required-reading seed asks for a comprehensive rename plan, not implementation, and Direction A is the best fit because it creates the classification map needed to execute later bursts safely. It should explicitly preserve `Nightly` channel/version identity where appropriate, leave upstream/provenance `T3 Code` references intact, and identify every migration-sensitive surface before any code changes. The resulting plan should include the required verification gates: `bun fmt`, `bun lint`, and `bun typecheck`, with `bun run test` only if the touched implementation surface later needs tests.

## Concerns / Open Questions

- Which desktop identity fields are safe to rename immediately versus requiring a compatibility period for existing installs?
- Are any package names, import paths, storage keys, or protocol constants consumed outside this repository?
- Should `Cafe Code Nightly` be the canonical visible channel string, or should `Nightly` remain visually separate from the product name?
- Which references to `T3 Code` are upstream provenance and should remain permanently unchanged?

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
