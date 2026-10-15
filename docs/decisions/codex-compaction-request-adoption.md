# Bind Codex compaction requests to their actual native opening

Decision status: Accepted
Created: 2026-10-14 00:15:20 JST (UTC+0900)
Last updated: 2026-10-14 00:39:49 JST (UTC+0900)
Decision authority: User requested investigation of unexpectedly early compaction,
necessary repairs, tests and this repair's push to dev.
Implementation status: Implemented; synthetic request/adoption fixtures, hosted and live-account qualification separate
Supersedes: [Context/compaction pairing](codex-context-compaction-pairing.md), only
its absence of materialized compaction-request evidence and existing-session adoption
Superseded by: None

## Context

A context-only session can already record an 800K nominal context override while
retaining a lower native compaction threshold. The pairing repair affects new
native openings. Comparing only the context number allows an older session to
match the same saved 800K choice and be reused without receiving the companion.
The muted ~720K estimate describes saved intent, not this running session's policy.
Neither an observed compaction near 472K nor a 760K usable meter identifies the
native trigger: explicit settings, model caps, post-turn policy and accounting
may also differ. Diagnose those separately; do not manufacture a native threshold.

The reviewed Codex 0.162.1 source at 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d
loads request overrides on cold start/resume. Its already-running native resume
ignores configuration overrides. The [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents separate context and auto-compaction keys. This repair does not change
their native formula, scope, buffering, capacity, or independently configured values.

## Decision and rationale

Record optional nullable `codexAutoCompactTokenLimit` as received Cafe request
evidence after an actual successful native opening. A number is the nominal
request sent, null records omission, and absence remains legacy unknown. Never
derive current proof from saved context, account settings, a model label or an
old context-only durable row. It is not an effective native threshold.

Keep this field in exact-owner session metadata and its durable projection, not
chat preference or public turn-start input. Preserve unknown versus known null
through an additive migration. Existing historical records are not backfilled as
though their native processes received the new request. Forked history does not
attest a child's new runtime; its actual opening produces its own evidence.

On a subsequent ordinary send, compare recorded context and recorded compaction
requests against current exact-account intent. A matching context alone is not
enough. Missing or different compaction evidence with numeric intent requires the
same final exact-native-owner whole-tree-idle/ingress guarded retirement and cold
resume used by existing context changes. Busy steering keeps current policy;
unknown child state never permits interruption, a competitor or prompt replay.
With no current or saved numeric context intent, unknown legacy evidence alone
must not cause an unsolicited inherited reset. Explicit account compaction
retains precedence and its existing standalone configuration path.

Separately authenticate `codexContextCompaction` capability alongside
`codexContextWindow`. An older detached Cafe owner may understand context but
lack pairing/provenance code. Missing, false or malformed capability cannot
qualify a new paired opening; preserve the unsent prompt and refuse clearly.
Fleet presentation is advisory, never a substitute for the exact owner's RPC.
No automatic daemon upgrade, restart or install is authorized by a saved choice.

Alternatives rejected: updating a live native thread is ignored and can falsely
attest application; assuming a context number implies pairing reproduces the
bug; unconditional restarts interrupt work; global config writes broaden scope;
disabling compaction or overriding native buffers/caps duplicates native policy.

## Presentation, security and operational consequences

Keep compact layout and the saved approximate parenthetical. When context
matches but compaction-request evidence differs or is unknown, presentation
marks the compaction change pending rather than implying current 720K enforcement.
Unknown/unsupported owner qualification does not promise idle application.
Current request metadata is content-free; no prompt, auth, profile or transcript
is needed. Native usage remains authoritative and is never rewritten.

Authenticated owner/generation fences and final retirement guards are unchanged.
Only an actual successful native opening mints proof. A local formatter or saved
setting cannot grant process authority. Larger permitted history may increase
resource use/cost. This repair guarantees neither 600K minimum nor 720K exact
timing; native policy and account/model eligibility remain independent.

## Verification and compatibility

Synthetic fixtures cover same-context legacy migration, current-proof reuse,
different/cleared explicit compaction requests, exact account/driver/generation,
busy root/children and uncertain final guard refusal, cold request translation,
known/null/unknown SQLite and snapshot fidelity, authenticated missing/false/
malformed capability refusal, and compact pending labels in English/Japanese/Korean.
Required repository checks and forced desktop build last gate publication.
Scoped local fixtures do not qualify real account capacity or native hosted
Windows/Linux results. Normal rebuilt owner adoption is still necessary.

All original context metadata, reset/inheritance, native caps/scope, privacy,
exact ownership and noninterrupting-save decisions remain in force. See the
[current user guide](../codex-context-window.md) and preserved predecessors.
