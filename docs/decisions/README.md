# Verification decision index

Last updated: 2026-10-24 03:09:06 JST (UTC+0900)

This index covers verification decisions; independent feature decisions remain
in this directory.

- [CI-matched default local Node scheduling](ci-matched-local-node-scheduling.md):
  unchanged canonical CI Node steps by default; explicit bounded local mode
  retains per-workspace reuse, while type/browser reuse remains available.
- [Complete local work reduction](complete-local-verification.md): active except
  for its superseded typecheck scheduling/default, CI-exclusion and local
  result-cache prohibition and default Node scheduling portions.
- [Exact-input local result reuse](verified-local-result-cache.md): local-only
  authenticated success receipts, explicit fresh replay and conservative
  source/tool/environment invalidation; default Node scheduling is separately
  superseded as above, with no CI/release reuse.
- [Three-slot typechecking](three-slot-typechecking.md): current local and
  CI/release typecheck admission policy, with per-platform qualification limits.
- [Provider daemon update retirement](provider-daemon-update-retirement.md):
  exact-owner preparation, explicit active-work consent and native exit before
  installing a different app build; adopted/unknown owners remain protected.
