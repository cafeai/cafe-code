# Burst 001 Audit — claude (auditor)

## Terminology

This audit follows `.selene/terminology_lock_v1.md`.

## Scope

Verify the Burst 001 planning artifact at
`.selene/bursts/001/artifacts/rename-classification.md` (mirrored to
`.selene/bursts/001/design/rename-classification.md`) and the implementation
report at `.selene/bursts/001/artifacts/IMPLEMENTATION_REPORT.md` against the
agreed plan at `.selene/bursts/001/design/agreed_plan.md`.

## Method

- Re-read the agreed plan and falsifying criteria.
- Diffed the two matrix copies (artifact vs. design) for byte identity.
- Diffed the trailing Hard Non-Claims blocks of both copies and the
  implementation report against `.selene/nonclaims.md`.
- Enumerated the four admitted class labels and confirmed only those four
  appear in the matrix as row classifications.
- Counted matrix data rows; counted occurrences of each class label.
- Verified every `internal_rename_with_migration` row carries a concrete
  migration technique.
- Verified surfaces tied to Nightly channel identity are
  `compatibility_alias_leave_stable` (or, where copy can rename, carry an
  explicit instruction to preserve Nightly tag/version/dist-tag semantics).
- Spot-checked >25 cited source surfaces in `apps/web`, `apps/desktop`,
  `apps/server`, `packages/shared`, `packages/ssh`, `scripts/`, `.github/`,
  `README.md`, `LICENSE`, and `apps/server/package.json`.
- Verified the manifest hash in `approved.json`:
  `plan_sha256 = 40ec1156936fd7d13b2922a251b250f6623f30450a7b6d9890da47de4b8dec76`
  matches `sha256(.selene/bursts/001/design/agreed_plan.md)`.

## Findings

### Hashes and structural integrity

- `cmp` of the two `rename-classification.md` copies returns exit 0 — the
  artifact and design copies are byte-identical, as the implementation report
  claims.
- `sha256(.selene/bursts/001/design/agreed_plan.md)` matches the
  `plan_sha256` recorded in `.selene/bursts/001/approved.json`.

### Hard Non-Claims block

- The canonical Hard Non-Claims block at `.selene/nonclaims.md` (5 bullets,
  16 lines including heading and blank line) matches verbatim:
  - the trailing block of `.selene/bursts/001/artifacts/rename-classification.md`,
  - the trailing block of `.selene/bursts/001/design/rename-classification.md`,
  - the trailing block of `.selene/bursts/001/artifacts/IMPLEMENTATION_REPORT.md`.
- `diff -u .selene/nonclaims.md <tail>` returns no differences for each.

### Strict-close compliance (classification labels)

- Only the four labels admitted by the Burst 001 agreed plan and cited against
  `.selene/classifications.py` appear in the matrix:
  - `user_facing_rename_now`
  - `internal_rename_with_migration`
  - `compatibility_alias_leave_stable`
  - `provenance_reference_leave_as_t3_code`
- No hyphenated, legacy, or extra labels are present.
- Matrix has 58 data rows. Label distribution across rows (excluding the
  legend listing):
  - `compatibility_alias_leave_stable`: 34
  - `user_facing_rename_now`: 17
  - `provenance_reference_leave_as_t3_code`: 4
  - `internal_rename_with_migration`: 3
  - Total: 58 (matches the implementation report's claim).

### Falsifying-criteria check (agreed plan section "Falsifying criteria")

1. Branch coverage (1–6) — PASS.
   - Branch 1 display-name surfaces: rows 1 (web `branding.ts`), 2 (desktop
     `DesktopEnvironment.ts`), 3 (`DesktopAppIdentity` About panel), 4
     (dev launcher), 5 (web boot/splash), 10 (marketing copy), 12
     (`README.md` / general docs), 14 (`AGENTS.md`).
   - Branch 2 desktop product/artifact metadata: rows 19 (desktop
     `package.json` `productName`), 20 (`scripts/build-desktop-artifact.ts`
     productName), 21 (`artifactName = "T3-Code-${version}-${arch}.${ext}"`),
     24 (`t3codeCommitHash`), 25 (Electron `appId = "com.t3tools.t3code"`),
     26 (Linux desktop identity incl. `StartupWMClass`), 42 (`T3CODE_*`
     env vars).
   - Branch 3 workspace identity: rows 15 (`@t3tools/monorepo`), 16
     (`@t3tools/*` workspaces — 10 in actual repo, all enumerated), 17
     (server `t3` package and bin `t3`), 18 (`@t3tools/oxlint-plugin-t3code`).
   - Branch 4 persisted/identity surfaces: rows 25 (`appUserModelId`), 26
     (`linuxDesktopEntryName`/`linuxWmClass`), 27 (`userDataDirName`), 28
     (`~/.t3` + `T3CODE_HOME`), 29 (SSH-launch state), 30 (askpass internals),
     32 (`app.t3.codes`), 13 (install registries `T3Tools.T3Code`, `t3-code`,
     `t3code-bin`).
   - Branch 5 update/release surfaces: rows 36 (release workflow), 37
     (Nightly version/tag/dist-tag), 38 (`latest*.yml` / `nightly*.yml` /
     `app-update.yml`), 39 (`pingdotgg/t3code`), 41 (Discord release script).
   - Branch 6 internal IDs / provenance: rows 45 (`t3/...` service IDs), 46
     (`desktop.appIdentity.*` spans), 57 (ADR-0001 and methodology), 56
     (license attribution).
2. Only admitted classes used — PASS (see label scan above).
3. `internal_rename_with_migration` rows carry concrete migration technique —
   PASS.
   - Row 21 (artifact filename): "updater-manifest validation, old asset
     retention or redirect, and release smoke tests".
   - Row 31 (browser persisted storage keys `t3code:client-settings:v1` and
     `t3code:saved-environment-registry:v1`): "dual-read old/new keys,
     write-through to new key after successful decode, and tests for
     old-key migration".
   - Row 54 (asset filenames): "Create Cafe assets, update
     `scripts/lib/brand-assets.ts`, keep or redirect old filenames until all
     build refs are updated".
4. Nightly channel identity surfaces are `compatibility_alias_leave_stable` —
   PASS (with notes).
   - Row 20 (`T3 Code (Nightly)` display in build script):
     `compatibility_alias_leave_stable`.
   - Row 37 (`vX.Y.Z-nightly.YYYYMMDD.N`, npm `nightly`):
     `compatibility_alias_leave_stable`.
   - Row 38 (`latest*.yml` / `nightly*.yml` / `app-update.yml`):
     `compatibility_alias_leave_stable`.
   - Row 32 (`nightly.app.t3.codes`): `compatibility_alias_leave_stable`.
   - Rows that touch Nightly only via copy (Row 1 web brand fallback,
     Row 41 Discord notification) are `user_facing_rename_now` but each
     carries an explicit instruction to preserve Nightly stage/tag/version
     semantics. The channel identity (tag pattern, dist-tag, manifest
     endpoint, updater config) remains in compatibility-alias rows.
   - Row 21 (desktop artifact filename) is `internal_rename_with_migration`,
     not `compatibility_alias_leave_stable`. The artifact filename is
     consumed by `electron-updater` manifests for all channels including
     Nightly. The migration note "old asset retention or redirect, and
     release smoke tests" preserves Nightly channel identity end-to-end by
     keeping prior filenames resolvable. Reading the agreed-plan criterion
     as "Nightly channel identity itself" (tag/dist-tag/manifest endpoint),
     this classification is acceptable. Reading the criterion strictly as
     "any surface whose rename affects Nightly artifact resolution" would
     argue for `compatibility_alias_leave_stable`. Flagging as borderline,
     not falsifying — see Advisory 1.
5. No code change proposed for Burst 001 — PASS. The matrix's
   "Burst 001 Non-Implementation Boundary" section explicitly states
   "Burst 001 lands planning artifacts only. It does not rename packages,
   move files, change release channels, alter persisted paths, or modify
   source behavior."

### Source-citation spot checks (sampled)

All checks below confirm the matrix row's source surface exists at the cited
location with the cited content.

- `apps/web/src/branding.ts:18` —
  `export const APP_BASE_NAME = ... ?? "T3 Code";` (matches Row 1).
- `apps/desktop/src/app/DesktopEnvironment.ts:83` —
  `const APP_BASE_NAME = "T3 Code";` and the
  `appUserModelId`/`linuxDesktopEntryName`/`linuxWmClass`/`userDataDirName`
  bindings around lines 66–205 (matches Rows 2, 25, 26, 27).
- `apps/desktop/package.json:35` — `"productName": "T3 Code (Alpha)"`
  (matches Row 19).
- `scripts/build-desktop-artifact.ts` — `appId: "com.t3tools.t3code"` (line
  571), `StartupWMClass: "t3code"` (line 607), `t3codeCommitHash` (lines 213
  and 785), `T3CODE_DESKTOP_*` env-var Config bindings (lines 241–251),
  `artifactName: "T3-Code-${version}-${arch}.${ext}"` (line 573), all
  matching Rows 20, 21, 24, 25, 26, 42.
- Root `package.json:2` — `"name": "@t3tools/monorepo"` (matches Row 15).
- `apps/server/package.json` — `"name": "t3"`, `"bin": { "t3": "./dist/bin.mjs" }`,
  `repository.url = "https://github.com/pingdotgg/t3code"` (matches Rows 17,
  39).
- `apps/server/src/vcs/GitVcsDriver.ts:611–614` — git author/committer
  configured as `T3 Code` with email `t3code@users.noreply.github.com`
  (matches Rows 8 and 9).
- `packages/shared/src/git.ts:13` — `WORKTREE_BRANCH_PREFIX = "t3code"`
  (matches Row 48).
- `packages/ssh/src/auth.ts:61` and surrounding — `SSH_ASKPASS_DIR_NAME =
"t3code-ssh-askpass"`, `T3_SSH_AUTH_SECRET` env var (matches Row 30).
- `scripts/dev-runner.ts:166, 483–484` and `dev-runner.test.ts:50–67` —
  `T3CODE_HOME` env var, default `~/.t3` (matches Row 28).
- `apps/web/src/components/chat/ProviderModelPicker.browser.tsx` — uses
  `t3code:client-settings:v1` localStorage key (matches Row 31).
- `apps/web/vercel.ts:3,5,6,36,46` — `ROUTER_HOST = "app.t3.codes"`,
  `latest.app.t3.codes`, `nightly.app.t3.codes`, `/__t3code/channel`
  (matches Rows 32, 33).
- `apps/web/src/environments/primary/context.ts:13` —
  `SERVER_ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/t3/environment"`
  (matches Row 35).
- `apps/server/src/orchestration/projector.test.ts` and `ProjectionPipeline.test.ts`
  reference `refs/t3/checkpoints/...` (matches Row 47).
- `apps/server/src/provider/Layers/CodexProvider.ts:241–242, 280–281` —
  `name: "t3code_desktop"`, `title: "T3 Code Desktop"`; `CursorProvider.ts:427` —
  `clientInfo: { name: "t3-code-provider-probe", ... }` (matches Rows 51, 52).
- `apps/server/src/cli/config.ts:106` — default service name `t3-server`
  (matches Row 44).
- `scripts/resolve-nightly-release.ts:59` — Nightly version pattern
  `${baseVersion}-nightly.${date}.${runNumber}` (matches Row 37).
- `LICENSE` — `Copyright (c) 2026 T3 Tools Inc.` (matches Row 56).
- `.selene/adrs/0001-adopt-selene-strict-close-methodology.md` exists
  (matches Row 57).

### Method-signature invariants

This burst was planning-only. No code was modified by the implementer's
recorded work, so no public method, function, schema, or context-service
signature changed. Confirmed by `git diff --stat` on tracked files (no
changes in app/package/lib paths; see Advisory 2 below for an unrelated
working-tree note on `AGENTS.md`).

### `.selene/classifications.py` citation

The agreed plan instructs that the four rename classes be "admitted by the
executable strict-close rules" of `.selene/classifications.py`. The project
file re-exports only `Classification`, `DEFAULT_TOLERANCE`, and
`classify_pair` from `selene.discipline.classifications`, whose runtime
classifier currently emits numeric-distance-series labels
(`coincides-pair`, `distinguishes-pair`, etc.) — not the four rename labels.
The four rename labels are predeclared in the agreed plan itself. The
matrix's wording "constrained by the Burst 001 agreed plan and cited against
`.selene/classifications.py`" is the agreed plan's chosen citation, so the
implementer is following the plan as written. No matrix rows use any label
outside the four predeclared ones. No action required for Burst 001;
auditor note for future ADR work — see Advisory 3.

### Open questions list

The matrix carries an explicit "Open Questions" section with 8 numbered
items: CLI alias scope (Q1), Cafe icon availability (Q2),
`pingdotgg/t3code` GitHub repo rename (Q3), Cafe hosted domain (Q4),
`CAFE_CODE_*` env var precedence (Q5), `@t3tools/*` workspace scope (Q6),
legal/author entity (Q7), and electron-updater choreography (Q8). These
overlap with the agreed plan's enumerated topics (GitHub repo rename
choreography vs. electron-updater, hosted pairing URL future, npm bin `t3`
alias scope) and add three further open items. Three agreed-plan topics
(install-registry submissions, oxlint plugin scope as a standalone item,
ADR append-only handling) are present in the matrix as decided rows
(Rows 13, 18, 57) rather than open questions. The agreed plan's wording
is "open-questions list (… install-registry submissions, oxlint plugin
scope, ADR append-only handling)"; reading this as a suggested coverage
rather than a strict membership requirement, the deliverable is satisfied
because each topic has a row with rationale and a per-surface
implementation note. See Advisory 4.

## Advisories (non-blocking)

1. Row 21 borderline classification. Desktop artifact filename
   `T3-Code-${version}-${arch}.${ext}` is `internal_rename_with_migration`
   with an updater-manifest-validation migration. A stricter reading of
   "any surface affecting Nightly channel identity" could argue this row
   should be `compatibility_alias_leave_stable`. The implementer's
   classification preserves Nightly identity end-to-end via the named
   migration technique and is defensible, but a follow-up ADR could pin
   the interpretation explicitly.

2. `AGENTS.md` working-tree note. `git status` at audit time shows
   `AGENTS.md` modified outside `.selene/`. The file's mtime
   (`May 21 09:38:49 2026`) is after the implementation report's mtime
   (`May 21 09:33:34 2026`), and the diff adds a `## Search Discipline`
   section about restricting broad `find` scans. This modification post-dates
   the implementer's `git diff --stat outside .selene is empty` check and
   appears to be a session-side or hook-side artifact unrelated to the
   burst's classified surfaces. Not a Burst 001 defect; flagged so the
   project owner can decide whether to revert or keep the addition.

3. `.selene/classifications.py` does not currently declare the four
   rename-class labels as executable strict-close categories. The
   agreed plan and matrix treat the four labels as predeclared by the
   plan and "cited against" classifications.py. A future ADR that codifies
   these labels (either as exported names or as a declarative project
   policy) would make the citation phrase literal rather than indicative.
   Out of scope for Burst 001.

4. Open-questions list coverage. The agreed plan's parenthetical
   enumeration of suggested open questions includes "install-registry
   submissions, oxlint plugin scope, ADR append-only handling". These
   appear as decided matrix rows (13, 18, 57) rather than as items in
   the Open Questions section. Surfaces are covered; the categorization
   is more decisive than the plan suggested. A follow-up burst could
   surface remaining triggers (e.g., "when do we submit a winget alias?")
   as explicit open questions if those decisions are still pending.

## Verdict

- All five falsifying criteria are satisfied.
- Hard Non-Claims block is present and canonical in all required artifacts.
- Only the four predeclared rename classes appear in the matrix; no
  unallowed label is present.
- Source citations spot-checked against actual files all match.
- Manifest hash `approved.json:plan_sha256` matches the agreed plan file
  on disk.
- No method signatures changed; no source modified by the burst.

Burst 001 is complete as a planning-only deliverable.

AUDIT_PASS

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
