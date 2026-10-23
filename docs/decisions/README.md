# Verification decision index

Last updated: 2026-10-22 22:55:23 JST (UTC+0900)

This index covers verification decisions; independent feature decisions remain
in this directory.

- [Complete local work reduction](complete-local-verification.md): active except
  for its superseded typecheck scheduling/default, CI-exclusion and local
  result-cache prohibition portions.
- [Exact-input local result reuse](verified-local-result-cache.md): local-only
  authenticated success receipts, explicit fresh replay and conservative
  source/tool/environment invalidation; no CI/release reuse.
- [Three-slot typechecking](three-slot-typechecking.md): current local and
  CI/release typecheck admission policy, with per-platform qualification limits.
- [Provider daemon update retirement](provider-daemon-update-retirement.md):
  exact-owner preparation, explicit active-work consent and native exit before
  installing a different app build; adopted/unknown owners remain protected.
