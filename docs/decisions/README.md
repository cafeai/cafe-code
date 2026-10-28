# Verification decision index

Last updated: 2026-10-28 10:42:43 JST (UTC+0900)

This index covers verification decisions; independent feature decisions remain
in this directory.

- [Bounded local Node scheduling](bounded-local-node-scheduling.md): two local
  workspace owners by default, explicit unchanged CI scheduling, and qualified
  exact-input reuse only on eligible local tasks.
- [CI-matched default local Node scheduling](ci-matched-local-node-scheduling.md):
  historical prior default; its explicit canonical CI lane and the rest of its
  ownership and evidence limits remain in force.
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
