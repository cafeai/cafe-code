---
verdict: agree
preferred_focus: matrix-clustered-rebrand
synthesis_or_argument: Both proposals converge on a single large implementation burst with the same end-state contract — full repository-owned rebrand with compatibility aliases for persisted state, env vars, CLI bin, scope, well-known endpoint, checkpoint refs, and worktree prefix; Nightly channel identity preserved; legal/provenance/test-lineage left intact; `bun fmt`/`bun lint`/`bun typecheck` as gates; `bun run test` only for focused migration tests (no `bun test`); and a domain migration checklist artifact deferring `t3.codes`/`pingdotgg` switches. The two proposals differ only on the work-breakdown lens: claude proposes the 58-row Burst 001 matrix as the falsification checklist (Direction A); codex proposes ordered surface clusters with an audit ledger (Direction C). These are complementary, not competing — clusters are an execution ordering, the matrix is the row-by-row completion test. Synthesize by treating the matrix as the falsifier and executing the work in surface clusters: package/workspace identity → runtime compatibility (env vars, persisted state, CLI bin) → user-facing UI/docs → desktop/release metadata → cross-cutting shared identifiers → final `rg` audit. The implementation report at `.selene/bursts/002/implementation_report.md` doubles as the audit ledger, keyed by Burst 001 matrix row ID (1–58) with per-row outcome (renamed / aliased / migrated-with-dual-read / provenance-preserved) plus a cluster tag.
---

# Burst 002 Reconciliation — claude

## Selected Direction

Matrix-Driven Cluster-Ordered Rebrand — execute the full Cafe Code rebrand in surface-clustered order, with the Burst 001 58-row matrix as the row-by-row completion test and the implementation report serving as the audit ledger.

## Why this direction

The Burst 001 matrix is already an exhaustive source-grounded enumeration of every known rename surface, which gives the auditor a deterministic falsifier: every row must resolve to one of the four classes admitted by `.selene/classifications.py`. Codex's cluster ordering is the right execution discipline because it forces cross-cutting consistency (one shared env-var precedence helper, one persisted-state dual-read pattern) instead of scattering related changes across the diff. Combining them preserves both proposals' end state and gates while giving the auditor both a per-row completion map and a per-cluster review structure. The two proposals already agree on the alias policy, Nightly preservation envelope, deferred domain work, gate set, and provenance/legal preservation — there is no substantive disagreement to resolve.

## Concrete Burst 002 Plan

- Goal: Land the full repository-owned Cafe Code rebrand in one implementation burst — every rename surface admitted by `.selene/bursts/002/design_seed.md` renamed, with compatibility aliases or dual-reads on surfaces whose deletion would lose data or break automation, and with Nightly channel identity, legal/provenance text, and current `t3.codes`/`pingdotgg` hosted references untouched pending a separate domain migration burst.
- Branches / sub-tasks (executed in cluster order; each cluster lands `bun fmt`/`bun lint`/`bun typecheck` clean before the next cluster begins, as an in-burst soft gate, not a separate close):
  - **C1 Package & workspace identity**: `@t3tools/*` → `@cafecode/*` scope rename across `package.json` files, imports, TS project references, scripts; root `name`/`description`; `oxlint-plugin-t3code` rule prefix with `t3code/*` alias retained; lockfile regenerated.
  - **C2 Runtime compatibility spine**: single shared env-var precedence helper (`CAFE_CODE_*` preferred, `T3CODE_*` fallback) consumed by every call site, including observability defaults; CLI bin `cafe-code` with `t3` alias bin retained; persisted-state dual-read for `localStorage` keys, `.t3code/` config dirs, `~/.t3` user dir; checkpoint ref alias; worktree branch prefix alias; `/.well-known/.../environment` alias.
  - **C3 User-facing copy**: visible strings in `apps/web`, `apps/desktop`, `apps/marketing`, `apps/server` UI output, READMEs, docs, error messages, telemetry display names.
  - **C4 Desktop & release metadata**: `productName` and visible build-display rename to "Cafe Code" / "Cafe Code Nightly"; electron app IDs, `userDataDirName`, artifact filename pattern `T3-Code-${version}-${arch}.${ext}`, `latest*.yml`/`nightly*.yml` schema, GitHub publish repo `pingdotgg/t3code`, and updater channel left at current values per the seed envelope.
  - **C5 Cross-cutting shared identifiers**: observability service names, telemetry namespaces, log prefixes — through one source helper consistent with C2 precedence.
  - **C6 Final audit & artifacts**: targeted `rg` sweeps for `T3 Code`, `T3 Server`, `t3code`, `@t3tools`, `T3CODE`, `t3.tools`, `t3.codes`, `t3`, with every remaining match classified; implementation report and domain migration checklist written.
- Predeclared classifications: cite `.selene/classifications.py`. Every Burst 001 matrix row (1–58) and every surviving `rg` match must map to exactly one of `user_facing_rename_now`, `internal_rename_with_migration`, `compatibility_alias_leave_stable`, or `provenance_reference_leave_as_t3_code`. No other class is admissible.
- Falsifying criteria:
  - Any Burst 001 matrix row absent from the implementation report or mapped to a class outside the four predeclared.
  - Any repository-owned visible `T3 Code`/`T3 Server` string outside legal/provenance/quoted-testimonial/current-hosted-domain contexts after C3.
  - Nightly channel identity drift: any change to version pattern `vX.Y.Z-nightly.YYYYMMDD.N`, npm `nightly` dist-tag, `latest*.yml`/`nightly*.yml` schema, electron app IDs, `userDataDirName`, or artifact filename pattern.
  - Persisted-state surface renamed without an in-code dual-read path and a focused `bun run test` covering the legacy-fallback branch.
  - Env-var precedence implemented at call sites instead of through one shared helper, or observability defaults not honouring the same precedence.
  - `@t3tools/*` scope rename landed without lockfile regeneration or with broken import resolution.
  - Active release / pairing / update URLs (`pingdotgg/t3code`, current `t3.codes` domains, updater publish config, `/pair`, `/__t3code/channel`, `t3code_web_channel` cookie) switched to Cafe domains in this burst rather than deferred to the checklist.
  - Legal/provenance text modified (`LICENSE` copyright, git author email `t3code@users.noreply.github.com`, staged desktop author `"T3 Tools"`, upstream lineage references, marketing testimonials, historical upstream URLs in tests, `t3code-*`/`t3-*` test fixture prefixes).
  - `bun fmt`, `bun lint`, or `bun typecheck` failing on the final tree.
  - `bun test` invoked anywhere in the burst (only `bun run test` permitted, and only for focused migration / precedence tests).
  - Implementation report or domain migration checklist artifact absent, or not falsifiable-by-completeness against the matrix and the seed's deferred-surface list.
- Required deliverables:
  - Rebranded source tree (renames plus alias/migration code).
  - `.selene/bursts/002/implementation_report.md`: row-by-row table keyed by Burst 001 matrix row ID (1–58), with columns for matrix row, cluster tag (C1–C5), Burst 002 classification, diff anchor / file paths, and alias-or-migration test reference where applicable.
  - `.selene/bursts/002/design/domain-migration-checklist.md`: per-surface deferred work for `app.t3.codes`, `latest.app.t3.codes`, `nightly.app.t3.codes`, `https://app.t3.codes/pair`, `/__t3code/channel`, `t3code_web_channel` cookie, well-known endpoint retirement, install registry IDs (`T3Tools.T3Code`, `t3-code`, `t3code-bin`), `pingdotgg/t3code` publish repo, updater publish config, Discord/release notification destinations — each with DNS, TLS, deploy, redirect, cookie, pairing, and update-channel criteria.
  - Final `rg` audit log embedded in the implementation report, with every remaining match classified.
- Hard non-claims: append the canonical block below.

## Disagreement (if verdict is "disagree")

N/A — verdict is agree.

## Hard Non-Claims

- No Selene artifact claims that cafe-code is secure, correct, race-free, deadlock-free, data-loss-free, or compatible with any upstream provider API outside the artifact's predeclared scope.
- No user-facing behavior, migration, protocol, or security claim is promoted unless it is grounded in source review and the repository's required quality gates for the touched surface.
- Provider output is untrusted. Selene enforces process discipline; it does not make Claude, Codex, Cursor, OpenCode, or any other provider semantically correct.
- This artifact does not claim coverage of credentials, tokens, local files, persisted conversations, WebSocket sessions, or provider subprocess behavior beyond the exact checks recorded in the artifact.
- This artifact does not promote any classification beyond what the executable strict-close rules in `.selene/classifications.py` admit.
