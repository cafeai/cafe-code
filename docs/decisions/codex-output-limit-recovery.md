# Decision: classify the exact Codex output-limit terminal failure for guarded recovery

Decision status: Accepted within the user's failed-root recovery repair request
Implementation status: Implemented; running-runtime adoption is separate
Verification status: Exact-source qualification is recorded separately; the checks below define requirements, not reported passes
Created: 2026-11-02 10:01:53 JST (UTC+0900)
Last updated: 2026-11-02 10:01:53 JST (UTC+0900)
Decision authority: the user requests repairing an abruptly ended Codex root that
did not enter Cafe recovery, then publishing the verified current set to dev.
Supplements: [persistent transient recovery](codex-persistent-transient-recovery.md)
with one narrowly defined `response-limit` classification. The existing
[failed-root restart](codex-failed-root-session-restart.md),
[proven unsubmitted retry](codex-failed-root-unsubmitted-retry.md) and
[phased recovery](codex-phased-failed-root-recovery.md) ownership and submission
rules remain in force.

## Context and evidence boundary

Bounded retained diagnostics for the reported chat contain the exact message
`Incomplete response returned, reason: max_output_tokens` under `codexErrorInfo:
"other"`, with null additional details. These observations identify a classifier
omission, not a proved historical ending time, recovery attempt, native retry
count or installed-source identity.

At immutable upstream commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`,
[`ResponseIncompleteError`](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/protocol/src/error.rs#L78-L86)
formats an incomplete response using its reason. The
[Responses SSE handler](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/codex-api/src/sse/responses.rs#L427-L458)
treats content filtering and explicit interruption separately before constructing
that error for other incomplete reasons. This supports recognizing this exact
output-limit message; it does not make arbitrary incomplete responses retryable.

## Decision

Add `response-limit` to Cafe's closed Codex transient-failure categories only when
the existing strict, bounded error admission accepts both:

- The structured `codexErrorInfo` is exactly `other`.
- The message is byte-for-byte
  `Incomplete response returned, reason: max_output_tokens`.

Additional details may be absent, null, an empty string or that same exact
message. Other detail text refuses this classification. Preserve the existing
record-shape, own-data-field, proxy/accessor and size guards.

Do not trim, case-fold, strip prefixes or accept a remote-compaction wrapper for
this new category. `content_filter`, interruption, unknown reasons, another
structured category, policy, authentication, quota, history errors and arbitrary
prose remain outside this addition. The predecessor's separately qualified
processing-error wrapper rule is unchanged.

This category makes the exact definitive failure eligible for the existing
guarded short-continuation path. It does not assert that repeating the same
response would succeed, increase an output/context budget, change reasoning
effort or bypass a native refusal. Never replay the original prompt, attachments
or tool commands.

## Preserved ownership, controls and privacy

Classification alone cannot start recovery. Keep the definitive native terminal
outcome, immutable failure time, exact account/root/runtime generation and
same-history proof. Preserve the existing one-use claims, capability-qualified
preparation, final native admission fences, capped backoff and authoritative
acceptance/reconciliation rules. Missing or uncertain acknowledgment never grants
another paid submission.

Stop, newer user input, changed configuration, archive and deletion retain their
existing precedence. Do not infer retry authority from live children, a footer,
an elapsed deadline, a persisted error string or a display marker. Native child
work and terminal root truth remain separate.

Any added diagnostic classification exposes only the fixed category and bounded
lifecycle observations. Do not add raw errors, prompts, provider history,
credentials or private owner capabilities to public work-log/debug payloads.

## Qualification and delivery limits

Qualify the actual classifier through its existing public behavior: the exact
message under `other` with each permitted additional-details form, plus refusal
of wrappers, changed bytes, other reasons/categories, conflicting details and
unsafe record shapes. Retain the existing native terminal-proof, exact-history,
one-use, Stop/new-input, uncertain-ACK and recovery-worker tests; this category
must not create a second recovery owner or paid-send loop.

Record the current source's required checks and final forced desktop build
separately. Documentation, synthetic passes, a source push or a rebuilt bundle do
not establish adoption by the running provider, repair the historical event or
prove future provider capacity. No app/provider restart or live inference probe
is part of this decision.
