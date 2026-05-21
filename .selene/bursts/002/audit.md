# Burst 002 Manual Recovery Audit

Verdict: `AUDIT_PASS`

The approved Burst 002 implementation worker did not emit close artifacts, so
the final audit was completed manually against
`.selene/bursts/002/design/agreed_plan.md`.

## Checks

- `.selene/bursts/002/artifacts/IMPLEMENTATION_REPORT.md` exists and maps all
  58 Burst 001 matrix rows.
- `.selene/bursts/002/design/domain-migration-checklist.md` exists and records
  the deferred hosted-domain, channel-cookie, pairing, registry, updater, and
  release-destination surfaces.
- Remaining `T3 Code`, `T3CODE`, `t3code`, `t3.codes`, and provider `t3-code`
  matches are classified as compatibility, migration, hosted-domain,
  legal/provenance, or test-lineage surfaces in the implementation report.
- `bun fmt`, `bun lint`, and `bun typecheck` passed after implementation.
- Focused `bun run test` commands passed for env compatibility, storage
  migration, well-known endpoint fallback, desktop identity, release metadata,
  and CLI command-path expectations.
- `selene freeze-invariants` and `selene verify` passed. TypeScript parser
  skips reported by Selene are covered by file-level SHA-256 manifests.

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
