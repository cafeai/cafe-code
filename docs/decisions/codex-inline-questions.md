# Decision: inline questions use ordinary durable message delivery

Status: Accepted
Date: 2026-09-10
Last updated: 2026-09-10 12:05:22 JST (UTC+0900)

Decision authority: implementation choice within the user's authorized Codex provider capability update. The original creation record retained only the date above; no more precise historical timestamp is assumed. Implementation is present in the shared question normalizer, runtime ingestion and composer panel. Verification is tracked separately in [compatibility and replay guidance](../codex-154-compatibility.md); acceptance alone does not establish passing tests or live-provider behavior.

## Context

Codex 0.154 renders optional questions attached to a completed assistant item. These are model-authored suggestions, not approval callbacks and not the legacy `request_user_input` protocol. Cafe already has authenticated transcript activities, durable follow-up delivery and independent composer drafts. Creating another provider request type or answering a callback would conflate unrelated lifecycles.

## Decision

Project valid root-only question metadata as a bounded `provider.async-questions` activity. Persist only item identity and normalized questions, not raw provider payloads. Completion replay uses a deterministic activity identity; routed child metadata and compacted/altered payloads cannot create actionable root suggestions. Existing assistant text still renders, even when structured metadata cannot safely be promoted.

Use a separate collapsible editor above the main composer. Show complete option labels as plain text; a click selects but does not send. Require explicit Send answer or Skip. Always support a freeform response. Send the upstream-compatible quoted question prefix plus answer through the existing queue, not slash-command parsing, a shell, or a permission callback. Failed local acceptance retains the answer. After durable acceptance, immediately attempt native steering for a running turn or start delivery for an idle chat. Existing capability, Stop, admission and uncertain-ACK safeguards still apply; when steering is unavailable, the accepted queue owns delivery/recovery.

Question identity is scoped to environment, Cafe thread, canonical activity identity and question index. The backend activity digest already binds provider instance and native thread/turn/item, so reused item IDs cannot collapse questions across sessions. Browser-safe SHA-256 from the pinned `@noble/hashes` dependency works without secure-context SubtleCrypto. The authenticated `thread.async-questions.resolve` command merges bounded handled question indexes into the original activity. Existing activity projections persist that state and broadcast it to other clients; provider completion replay cannot reopen it. Skip waits for server acknowledgement. Legacy browser markers contain bounded opaque identities only and migrate to this server record without sending an answer. A stable queue/message/command identity plus exact-payload checks guards uncertain acceptance and repeated submission. A separate main draft, including attachments and queue edits, is never consumed by answering a question. Handled state synchronizes across clients while preserving a different unsent answer for copying or explicit dismissal. This remains optional question presentation state and grants no provider permission.

Normalize at most the first 16 questions, reject titles over 4,096 UTF-8 bytes, and inspect at most the first 32 options. Reject options over 512 UTF-8 bytes instead of shortening their displayed meaning. Reject malformed Unicode and concealed control/bidi metadata; preserve accepted wording exactly. Frame the answer with the first 512 UTF-8 bytes of title on a scalar boundary, flatten CR/LF, and enforce the existing total user-message size limit including framing. No implicit answer is sent and no new provider authority is granted.

Diagnostics retain only bounded question/option counts. They must not serialize titles, suggestions, answers or unknown metadata, including in detailed renderer snapshots.

## Alternatives and consequences

- Reusing `request_user_input` was rejected: it has native callback IDs, expiry and response semantics that do not apply here.
- Replacing the main composer was rejected: it risks losing the draft or attaching unrelated files to an answer.
- A new SQL question ledger was unnecessary: transcript activities and durable message delivery already supply the required ownership. Handled indexes use the existing activity record, not a provider-blocking queue.
- The TUI's 30-second collapsed expiry is not copied. Cafe leaves questions optional and manually dismissible, avoiding silent loss in a background desktop window. Bounded recent-activity selection and handled-ID retention prevent unlimited UI state; historical transcript text remains the fallback when metadata is outside the retained tail.
- Experimental provider queues and background daemon ownership remain out of scope. No migration, provider restart, automatic historical transcript rewrite or paid inference is required.

Regression tests must verify exact acceptance, failure retention, repeat/replay isolation, explicit consent, safe text bounds and main-draft independence. Re-audit this decision when upstream changes question delivery or answer framing.
