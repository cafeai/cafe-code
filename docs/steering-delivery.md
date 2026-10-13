# Steer delivery status

Created: 2026-10-14 01:33:41 JST (UTC+0900)
Last updated: 2026-10-14 02:27:29 JST (UTC+0900)

Live follow-ups keep their delivery status beside the saved message above the
composer. Sending means the provider has not yet confirmed acceptance. Accepted
means the exact provider call returned successfully; it does not mean the model
has processed the message. A correlated delayed-pickup observation may change
that status to Waiting. When active context compaction blocks delivery, show
Waiting for compaction and retain the message and attachments.

The Work log also exposes the concise saved **Steer delivery attempted** and
**Steer accepted** observations. They are available through the same bounded
current and historical readers as other work. A former density cleanup filtered
acceptance out of both readers and left it only in the shelf; the restored
confirmation does not require replaying old input or rewriting stored history.
Duplicate native progress, delayed-pickup polling and periodic still-running
observations remain in diagnostics rather than adding repetitive visible rows.

The orchestration command ACK is not provider acceptance. A terminal turn alone
does not remove or resend pending input. Pending state is bound to its exact
saved message and intent generation; sibling acceptance, an older same-ID retry
or unrelated work cannot settle it. Only exact provider processing or an explicit
correlated recovery/failure/requeue settles the in-flight generation. Compact
rejection transfers the same message to the automatic retry queue, preserving
its identity and attachments. Unknown transport ACK retains the existing
same-command reconnect policy, never an independent renderer resend. If that
bounded reconnect window ends without a known result, the direct-send row and
optimistic message remain pending instead of restoring a duplicate-send draft.
The exact admitted composer content is consumed even if processing already
settled its pending row before that error; a newer edited draft is never cleared.
Full page reload restores the durable Work log, not the volatile pending shelf;
this change does not introduce a new pending-message persistence mechanism.

This is presentation, not delivery authority. Existing authenticated receipt,
native correlation and recovery guards continue to own provider operations.
Canonical intent sequences and per-dispatch command identity prevent retained
older rows or late command responses from clearing a newer retry. Native legacy
processing metadata correlates the message, not a unique retry attempt; where no
explicit intent witness exists, canonical post-intent activity order remains the
legacy fallback. It is not proof against every possible delayed native same-ID
notification. No latest-intent proof is fabricated from that message token.
Collapsed work-log rows show fixed public status; private input, raw JSON and
identifiers remain behind explicit inspection. No additional provider calls,
permissions, process restarts, subscriptions or history expansion are introduced.

Credential-free unit, real SQLite and browser fixtures cover visible receipt
history, message/generation isolation, pending command ACK, compaction and
terminal-before-acceptance ordering, stale retry reconstruction and the final
unknown-ACK presentation boundary after the existing reconnect window. Use the
pinned Node/Corepack Yarn setup,
required repository checks and the forced desktop build after tests. Synthetic
fixtures do not qualify a live provider's acceptance latency or native capacity.
