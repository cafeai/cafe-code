# Burst 001 Implementation Report

## Terminology

This report follows `.selene/terminology_lock_v1.md`.

## Summary

Implemented Burst 001 as a planning-only rename classification artifact. No
application source, package names, release configs, ADRs, or invariant files were
edited. The implementation classifies Cafe Code rename surfaces using only the
four labels admitted by the agreed plan and cites `.selene/classifications.py`.

Security-related note: no security behavior was changed. The matrix explicitly
keeps persisted state, browser storage, auth-bearing paths, update channels,
provider client IDs, and external env vars stable unless a later burst adds a
tested migration or compatibility alias.

## Artifacts

- `.selene/bursts/001/artifacts/rename-classification.md`
- `.selene/bursts/001/design/rename-classification.md` mirrored to match the
  artifact required by the agreed plan.
- `.selene/bursts/001/artifacts/IMPLEMENTATION_REPORT.md`

## Self-Checks

- Confirmed artifact/design matrix files are byte-identical:
  `rename matrix artifact/design cmp exit=0`.
- Confirmed no old hyphenated or extra classification labels remain in the
  matrix files.
- Confirmed canonical Hard Non-Claims block matches `.selene/nonclaims.md` by
  diffing the tail of both created/updated markdown artifacts.
- Confirmed the matrix has 58 data rows and the three
  `internal_rename_with_migration` rows each name a concrete migration
  technique.
- Confirmed `git diff --stat` outside `.selene` is empty after checks.
- Confirmed no ADR or invariant file was edited.

## Smoke and Gate Output

Direct `bun` was not on PATH, so gates were run with transient Bun 1.3.11 via
`npm exec --yes --package=bun@1.3.11 -- bun ...`, matching `packageManager`.

- `bun fmt`: passed. Output included `Finished ... on 1101 files using 16 threads.`
- `bun lint`: passed with warnings only. Output: `Found 9 warnings and 0 errors.`
- `bun typecheck`: passed. Output: `Tasks: 13 successful, 13 total`.
- `bun run release:smoke`: passed. Output: `Release smoke checks passed.`
- `bun run test` was not run because this burst touched only Selene planning
  artifacts and no source behavior.

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
