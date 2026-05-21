# Burst 002 Design Proposal — claude

## Terminology

This artifact follows `.selene/terminology_lock_v1.md`. `Cafe Code` is the project's new user-facing product brand; `T3 Code` survives only as compatibility alias, legacy fallback, persisted-state migration source, provenance reference, or legal/copyright text. `Nightly` is a channel/stage label whose identity (version pattern `vX.Y.Z-nightly.YYYYMMDD.N`, npm `nightly` dist-tag, updater channel) must remain end-to-end stable.

## Inputs Reviewed

- `.selene/bursts/002/design_seed.md` (required reading; supersedes Burst 001 default)
- `.selene/bursts/001/design/rename-classification.md` (58-row source-grounded matrix)
- `.selene/bursts/001/design/agreed_plan.md`
- `.selene/terminology_lock_v1.md`
- `.selene/classifications.py`
- `.selene/nonclaims.md`
- `.selene/adrs/0001-adopt-selene-strict-close-methodology.md` (append-only; not edited)

## Candidate Directions

### Direction A: Matrix-Driven Full Sweep with Tiered Compatibility

- Goal: Execute every rename surface in the Burst 001 matrix as one comprehensive implementation burst, reclassifying compatibility-only rows where the seed now demands action, while preserving aliases/dual-reads/legacy fallbacks where deletion would cause data loss, broken automation, or updater breakage.
- Why useful: The Burst 001 matrix already enumerates the 58 known rename surfaces with file paths, evidence, and migration notes. Reusing it as the work breakdown gives the auditor a one-to-one checklist instead of an open-ended grep sweep, and inherits the Nightly-identity guardrail from the agreed plan.
- What it would falsify:
  - Any matrix row whose Burst 002 outcome is not one of: `user_facing_rename_now` (renamed in code), `internal_rename_with_migration` (renamed plus dual-read/migration tested), `compatibility_alias_leave_stable` (alias added or stable), or `provenance_reference_leave_as_t3_code` (left intact with rationale).
  - Nightly channel identity drift (any change to version pattern, npm `nightly` dist-tag, or `latest*.yml`/`nightly*.yml` schema).
  - Any repository-owned visible `T3 Code`/`T3 Server` string outside legal/provenance/quoted-testimonial contexts.
  - Absence of the domain migration checklist artifact at `.selene/bursts/002/design/domain-migration-checklist.md` (or equivalent path under `.selene/bursts/002/`).
  - `bun fmt`, `bun lint`, or `bun typecheck` failing on the final tree.
- Estimated burst size: large.
- Tradeoffs: Single comprehensive sweep is the highest blast radius the project can take in one burst, but the matrix bounds it. The reclassification step requires careful judgement for rows the seed wants reclassified out of `compatibility_alias_leave_stable` (e.g., `@t3tools/*` workspace scope, `t3` CLI bin, env vars, well-known endpoint, persisted browser storage keys, VCS config path, checkpoint refs, worktree branch prefix), each of which now needs an alias plan implemented rather than deferred. Adds an implementation-report artifact mapping each matrix row to its Burst 002 disposition.

### Direction B: Layered Rebrand by Blast Radius

- Goal: Implement the full Cafe Code rename in one burst but order the work in distinct layers from lowest to highest external-contract risk: (L1) visible product strings; (L2) package/workspace identity with `@cafecode/*` rename and `@t3tools/*` deprecation alias; (L3) CLI/server bin with `t3` alias retained; (L4) env vars with `CAFE_CODE_*`-first/`T3CODE_*`-fallback precedence; (L5) persisted state (`localStorage`, `.t3code/`, `~/.t3`) with dual-read migration; (L6) well-known endpoint, checkpoint refs, worktree prefix, observability defaults — added as aliases without retiring old names; (L7) domain migration checklist artifact.
- Why useful: Orders work so each layer is independently bisectable and revertable. Visible-copy layer can land first and be validated cleanly before touching package identity or persisted state. Forces explicit acknowledgement of which surfaces are alias-only versus rename-now.
- What it would falsify:
  - Any layer skipped entirely, or any layer not closing with `bun fmt`/`bun lint`/`bun typecheck` clean before the next layer begins (treated as in-burst soft gate, not separate close).
  - Persisted-state layer landing without an in-code dual-read path (e.g., legacy fallback in `apps/desktop/src/app/DesktopEnvironment.ts` `resolveUserDataPath` pattern extended to new surfaces) or without a focused `bun run test` covering the migration.
  - Updater-affecting surfaces (electron app IDs, artifact filenames, GitHub publish repo, `latest*.yml` schema) modified without a documented updater choreography in the implementation report.
- Estimated burst size: large.
- Tradeoffs: More structure makes review easier and reduces the chance of a half-applied rename, but layer ordering introduces sequencing overhead and the burst still has to close as a single audit. Cross-cutting surfaces (env vars used by docs and runtime) sit in multiple layers and risk being split or duplicated.

### Direction C: Owner-Domain Rebrand Organised by Package

- Goal: Group renames by code owner — `apps/web`, `apps/desktop`, `apps/server`, `apps/marketing`, `packages/contracts`, `packages/shared`, `packages/oxlint-plugin-t3code`, `scripts/`, root metadata, repository docs — and sweep each owner exhaustively before moving on. Cross-cutting surfaces (env vars, well-known endpoint, observability defaults) get a final "shared identifiers" pass.
- Why useful: Maps to how the repo is structured for review and code ownership. Each owner sweep can be verified by `bun --filter <pkg> typecheck`/`lint` locally before moving on. Easier to assign mental ownership when reviewing the final diff.
- What it would falsify:
  - Any owner left with repository-owned `T3 Code`/`T3 Server` visible copy.
  - Cross-cutting alias surfaces (env vars, `/.well-known/.../environment`) implemented inconsistently across owners.
  - Missing implementation report keyed by owner.
  - Domain migration checklist artifact absent.
- Estimated burst size: large.
- Tradeoffs: Owner-by-owner sweeps are easy to reason about per package but make it harder to ensure cross-cutting symbols (e.g., `T3CODE_HOME` referenced from server, docs, scripts, and dev runner) move together. Risks the audit finding "the rename is done in web but inconsistent in server" if the shared pass is rushed. Lockfile regeneration after the package-scope rename concentrates risk at the end.

## Recommended Direction

**Direction A — Matrix-Driven Full Sweep with Tiered Compatibility.**

The Burst 001 matrix is already the explicit, source-grounded enumeration of every rename surface in the repository, and the auditor expectations in `.selene/bursts/002/design_seed.md` line up with running targeted `rg` checks against the same identifier set (`T3 Code`, `T3 Server`, `t3code`, `@t3tools`, `T3CODE`, `t3.tools`, `t3.codes`, `t3`). Using the matrix as the implementation checklist gives Burst 002 a deterministic completion test: every row resolves to one of the four predeclared classes admitted by `.selene/classifications.py`, and the auditor verifies row-by-row rather than chasing a moving grep. Direction B's layering and Direction C's owner-grouping are mostly _execution-order_ refinements that can be applied inside Direction A by working through the matrix in roughly layered/owner order; they do not change the closure criterion. The seed's superseding policy — which reclassifies many former `compatibility_alias_leave_stable` rows into `internal_rename_with_migration` (with aliases) — is most cleanly tracked when the implementation report is itself a matrix delta against Burst 001.

Concretely, the Burst 002 implementation should produce:

- Renamed source/docs/config/package metadata wherever the seed admits a rename, with compatibility aliases on persisted state, env vars, CLI bin (`t3` retained), `@t3tools/*` (read seed: scope rename now to `@cafecode/*` with lockfile regeneration), well-known endpoint, observability service names, checkpoint refs, and worktree branch prefix.
- Preserved Nightly identity across version pattern, npm `nightly` dist-tag, `latest*.yml`/`nightly*.yml`, and updater channels; visible Nightly copy renamed to "Cafe Code Nightly".
- A new artifact `.selene/bursts/002/design/domain-migration-checklist.md` listing the precise later work required before `app.t3.codes`, `latest.app.t3.codes`, `nightly.app.t3.codes`, hosted pairing URL `https://app.t3.codes/pair`, channel route `/__t3code/channel`, channel cookie `t3code_web_channel`, well-known T3 endpoint retirement, install registry IDs (`T3Tools.T3Code`, `t3-code`, `t3code-bin`), `pingdotgg/t3code` publish repo, updater publish config, and Discord/release notification destinations can be migrated to Cafe Code domains. The checklist must enumerate DNS, TLS, deploy, redirect, cookie, pairing, and update-channel criteria per surface.
- An implementation report `.selene/bursts/002/implementation_report.md` mapping each Burst 001 matrix row ID (1–58) to its Burst 002 outcome: renamed (with diff anchor), aliased (with alias precedence and test reference), migrated with dual-read (with migration code anchor), or left as provenance (with reason).
- Quality gates: `bun fmt`, `bun lint`, `bun typecheck` pass on the post-rename tree. Use `bun run test` (not `bun test`) only for focused tests covering migration paths (e.g., persisted-key dual-read, env-var precedence, well-known endpoint alias).

## Concerns / Open Questions

1. **`@t3tools/*` workspace scope.** Burst 001 row 16 classified scope rename as `compatibility_alias_leave_stable`. Burst 002 seed's preferred scope is `@cafecode`. Renaming the scope forces import migration across the monorepo, lockfile regeneration, and re-resolution of any external consumer (oxlint plugin rule prefix `t3code/*` and root `@t3tools/monorepo` identity). Direction A treats this as `internal_rename_with_migration` with `@t3tools/*` retained only where an external consumer is provable; please confirm.
2. **CLI bin.** Seed says rename to `cafe-code` with `t3` as a temporary alias. Need to confirm whether `t3 serve`/`t3 auth` invocations in docs become `cafe-code serve`/`cafe-code auth` while `t3` bin stays installable, and whether SSH remote-launch (`~/.t3/ssh-launch`, `t3@latest`, `t3@nightly` package specs in row 29) follows or trails.
3. **GitHub repository identity.** Active publish repo `pingdotgg/t3code` (row 39) and seed-stated new URL `https://github.com/cafeai/cafe-code`. Until a real GitHub rename/redirect exists, references to active release URLs must remain `pingdotgg/t3code` to avoid breaking downloads/updates; please confirm the Cafe URL is documented as "future" only, not switched in update manifests or marketing CTAs.
4. **Updater choreography for desktop.** Renaming `productName` (row 19) and visible build display (row 20) without changing electron app IDs (row 25), `userDataDirName` (row 27), artifact filenames (row 21), or `latest*.yml`/`nightly*.yml` schemas (row 38) is the safe envelope. Need confirmation that artifact filenames stay `T3-Code-${version}-${arch}.${ext}` for this burst, with rename deferred to the domain/updater migration checklist.
5. **Asset filenames and icons** (rows 54, 55). If Cafe Code artwork is not yet available, the burst should keep inherited T3 visual assets (with a rename of asset map keys only if no path reference breaks) and explicitly flag art replacement as a follow-up. Please confirm.
6. **Legal metadata.** `LICENSE` copyright (row 56), git author email `t3code@users.noreply.github.com` (row 9), and staged desktop author (`"T3 Tools"`, row 23). These remain `provenance_reference_leave_as_t3_code` unless legal/operator confirms otherwise; the burst should not touch them.
7. **Test fixtures and provenance quotes** (rows 11, 40, 53). Marketing testimonials, historical upstream URLs in tests, and `t3code-*`/`t3-*` test prefixes remain provenance/compat. The auditor's `rg` sweep must accept these matches as justified.
8. **`CAFE_CODE_*` env var precedence.** Seed requires reading Cafe first, T3 second. Confirm the precedence implementation belongs in a single shared helper rather than per-call-site `??` chains, and that observability defaults (row 44) honour the same precedence.
9. **Scope of test changes.** Burst 002 seed forbids `bun test` and only allows `bun run test` for focused tests. Migration/precedence tests likely need to be added (or existing tests updated) for the persisted-state dual-read paths and env-var precedence; this needs explicit acknowledgement so the auditor does not flag added tests as scope creep.
10. **Risk of partial rename.** A burst this large risks landing visible copy without the corresponding migration code on a persisted-state surface. The implementation report's per-row mapping is the auditor's only practical defence against partial completion; the report itself must be falsified-by-completeness, not free-form.

## Hard Non-Claims

- No Selene artifact claims that cafe-code is secure, correct, race-free, deadlock-free, data-loss-free, or compatible with any upstream provider API outside the artifact's predeclared scope.
- No user-facing behavior, migration, protocol, or security claim is promoted unless it is grounded in source review and the repository's required quality gates for the touched surface.
- Provider output is untrusted. Selene enforces process discipline; it does not make Claude, Codex, Cursor, OpenCode, or any other provider semantically correct.
- This artifact does not claim coverage of credentials, tokens, local files, persisted conversations, WebSocket sessions, or provider subprocess behavior beyond the exact checks recorded in the artifact.
- This artifact does not promote any classification beyond what the executable strict-close rules in `.selene/classifications.py` admit.
