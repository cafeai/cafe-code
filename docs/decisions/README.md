# Verification decision index

Last updated: 2026-11-06 12:50:28 JST (UTC+0900)

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
- [Provider daemon startup retirement](provider-daemon-startup-retirement.md):
  root-only cooperative self-retirement of supported incompatible POSIX owners,
  with exact acknowledgement, confirmed exit and preserved legacy-owner limits.

Related provider lifecycle decisions:

- [Glide catalogue admission](glide-catalogue-admission.md): bounded inert
  catalogue resources, explicit desktop opt-in and finite startup guidance,
  separate from executing kernels and provider retry authority.

- [MCP pending questions](mcp-pending-questions.md): owner-only question
  discovery and exact responses, atomic inline handling, canonical native
  settlement and visible question/answer receipts in the primary chat.

- [Phased Codex failed-root recovery](codex-phased-failed-root-recovery.md):
  private zero-paid preparation, exact joined ownership and one-use paid
  submission; unknown paid acknowledgments never permit resend. This accepted
  successor keeps source implementation, exact-source qualification and
  live-runtime adoption separate from the preserved predecessor evidence.
- [Codex output-limit recovery](codex-output-limit-recovery.md): the exact
  `max_output_tokens` incomplete-response message under `other` adds one guarded
  classification; native proof, one-use submission, Stop and uncertain-ACK
  restrictions remain unchanged.

- [Claude provider metadata advisories](claude-provider-metadata-advisories.md):
  volatile native-owner sign-in expiry observations and bounded invalid-config
  guidance, separate from authentication, recovery and execution authority.
