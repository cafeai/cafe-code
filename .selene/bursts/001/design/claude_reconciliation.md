---
verdict: agree
preferred_focus: source-derived-classification-matrix
synthesis_or_argument: Both proposals independently converge on the same direction — produce a tiered classification of every rename surface before any implementation, using the four predeclared classes (user-facing rename now / internal rename with migration / compatibility alias / provenance reference). Adopt codex's clean framing for the deliverable shape (a classification matrix) and claude's source-grounded inventory (specific file paths, identifiers, persisted-state surfaces, install registries, and the existing `userDataDirName` migration pattern already in `apps/desktop/src/app/DesktopEnvironment.ts`) as the starting evidence the matrix must cover. Preserve the Nightly channel identity end-to-end. Defer all code changes to later bursts; this burst delivers only the planning artifact and an explicit open-questions list.
---

# Burst 001 Reconciliation — claude

## Selected Direction

Source-grounded rename classification matrix — produce a single planning artifact that classifies every concrete T3 Code rename surface into one of the four predeclared classes, with rationale and a per-surface implementation note, before any code change.

## Why this direction

Both proposals arrived at the same recommendation, which is the direction the Burst 001 seed explicitly asks for. The classification map is what makes later renaming PRs safe, reviewable, and revertible; without it, a global string substitution would silently break installed users, paired remote environments, and the Nightly update path. Synthesizing claude's source-grounded inventory with codex's clean four-class framing gives the matrix concrete starting material (display strings, package identity, bundle ID, persisted dirs, env vars, hosted URL, install registries, ADR provenance) while honoring the seed's deferral of implementation.

## Concrete Burst 001 Plan

- Goal: Deliver a single markdown classification matrix at `.selene/bursts/001/design/rename-classification.md` that lists every `T3 Code` / `t3code` / `@t3tools/*` / `~/.t3` / `com.t3tools.t3code` surface in the repository, classifies each under one of the four predeclared classes, gives a one-line rationale, and names any migration/alias technique to reuse (e.g., the existing legacy `userDataDirName` fallback pattern in `apps/desktop/src/app/DesktopEnvironment.ts`).
- Branches / sub-tasks:
  1. Display-name surfaces: `apps/desktop/src/app/DesktopEnvironment.ts` `APP_BASE_NAME`, `apps/web/src/branding.ts` `APP_BASE_NAME`, About dialog, dock/menu labels, marketing site copy, README, AGENTS.md.
  2. Desktop product/artifact metadata: `apps/desktop/package.json` `productName`, `scripts/build-desktop-artifact.ts` (productName, artifactName, appId, executableName, StartupWMClass, `T3CODE_*` env vars, `t3codeCommitHash`).
  3. Workspace identity: root `package.json` `@t3tools/monorepo` and the eight `@t3tools/*` workspaces; the unscoped `t3` server package with bin `t3`; `oxlint-plugin-t3code`.
  4. Persisted/identity surfaces: Electron `appUserModelId`, `linuxDesktopEntryName`, `linuxWmClass`, `userDataDirName` (already mid-migration), `~/.t3` home, SSH-launch state path, hosted URL `app.t3.codes`, install registries (winget `T3Tools.T3Code`, brew `t3-code`, AUR `t3code-bin`).
  5. Update/release surfaces: `app-update.yml`, GitHub publish `pingdotgg/t3code`, `scripts/notify-discord-release.ts`, Nightly version pattern `-nightly.YYYYMMDD.N`. Preserve Nightly identity end-to-end.
  6. Internal IDs / provenance: `Context.Service` IDs like `"t3/desktop/AppIdentity"`, telemetry span names (already `desktop.appIdentity.*`, safe), ADR-0001, license attribution, upstream lineage references.
  7. For each item, assign exactly one class per `.selene/classifications.py` with a one-line rationale; flag anything ambiguous as an explicit open question rather than guessing.
- Predeclared classifications: cite `.selene/classifications.py` — only the four classes (`user_facing_rename_now`, `internal_rename_with_migration`, `compatibility_alias_leave_stable`, `provenance_reference_leave_as_t3_code`) admitted by the executable strict-close rules may appear in the matrix.
- Falsifying criteria:
  - Matrix is falsified if any surface enumerated in branches 1–6 is missing from the final document.
  - Matrix is falsified if any row carries a class not admitted by `.selene/classifications.py`.
  - Matrix is falsified if any row in `internal_rename_with_migration` lacks a concrete migration technique reference (legacy-dir fallback pattern, `electron-updater` redirect strategy, GitHub repo rename redirect, etc.).
  - Matrix is falsified if any surface affecting Nightly channel identity is classified as anything other than `compatibility_alias_leave_stable` for this burst.
  - Matrix is falsified if it proposes any code change to land in Burst 001.
- Required deliverables:
  - `.selene/bursts/001/design/rename-classification.md` containing the matrix and an open-questions list (GitHub repo rename choreography vs. `electron-updater`, hosted pairing URL future, npm bin `t3` alias scope, install-registry submissions, oxlint plugin scope, ADR append-only handling).
  - No code changes, no package renames, no file moves. Verification gates `bun fmt`, `bun lint`, `bun typecheck` are not exercised this burst because no source is touched; they become gating once Burst 002+ begins implementation on a single tier.

## Hard Non-Claims

- No Selene artifact claims that cafe-code is secure, correct, race-free, deadlock-free, data-loss-free, or compatible with any upstream provider API outside the artifact's predeclared scope.
- No user-facing behavior, migration, protocol, or security claim is promoted unless it is grounded in source review and the repository's required quality gates for the touched surface.
- Provider output is untrusted. Selene enforces process discipline; it does not make Claude, Codex, Cursor, OpenCode, or any other provider semantically correct.
- This artifact does not claim coverage of credentials, tokens, local files, persisted conversations, WebSocket sessions, or provider subprocess behavior beyond the exact checks recorded in the artifact.
- This artifact does not promote any classification beyond what the executable strict-close rules in `.selene/classifications.py` admit.
