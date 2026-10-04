# Decision: prepared Claude conversation rewinds

Decision status: Accepted within the user's high-priority provider-parity implementation request.
Created: 2026-10-04 20:59:22 JST (UTC+0900)
Last updated: 2026-10-04 21:35:58 JST (UTC+0900)
Implementation status: implemented; focused synthetic qualification passed. Release verification requirements and replay boundaries are below.
Supersedes: no earlier ADR. Supplements [verified runtime recovery](verified-runtime-recovery.md), [subagent runtime observation](subagent-runtime-observation.md), and [Claude resumed accounting](claude-resumed-usage-baseline.md).

## Context and alternatives

Cafe previously removed Claude turns from its local array while retaining the same native resume identity. That changed the displayed conversation without removing the native history used by the next request. The SDK's `rewindFiles` restores files, not conversation history. The qualified public SDK has no conversation-rewind RPC. Its supported `forkSession` operation can instead create a new session through an exact inclusive message boundary while retaining the original.

Using the last assistant UUID is insufficient: tool-result carriers, structured output and steering messages can follow it within the same Cafe turn. Reconstructing history from displayed text would lose provider semantics. Silently truncating every ordinary resume or editing private native transcript chains is rejected. We use the public SDK fork with a bounded immutable source and its own graph rewriting/remapping.

## Decision and identity

The first removed Cafe turn supplies its original user-message UUID. A partial rewind resolves that prompt in the exact account/cwd/session and retains its immediate native parent, including all messages that belong to the preceding turn. Public SDK history confirms that the selected prompt belongs to the current chain. Compacted-away, synthetic, ambiguous and unbound legacy boundaries fail clearly instead of selecting a guessed leaf. A baseline rewind intentionally starts the next user request with no native resume cursor; it does not require an already-compacted oldest prompt to survive.

SDK forks remap UUIDs. A bounded durable correspondence in Cafe's private resume cursor preserves original prompt identity through successive rewinds and restarts. Titles and display text are never authority. Ordinary follow-ups still omit `resumeSessionAt`. The original native session is never truncated or deleted. After an empty-baseline rewind, only the exact finished closed candidate and unchanged rewind binding authorize the next explicit send to start fresh; an ordinarily missing cursor still fails recovery. The fresh start consumes this exception by publishing a new runtime generation.

Preparation requires an already-established, idle Claude runtime; it must not cold-start a query to discover whether native work will resume. The synchronous reservation includes pending input/approval callbacks, accepted prompt lifecycles, tool calls, received-but-unprocessed frames, tracked background descendants and uncertain task visibility. The public process-spawn hook observes the exact primary child handle. `Query.close()` alone is not an exit acknowledgement. Preparation awaits that child's exit, then checks that the bounded source snapshot has not changed. Primary-process exit is not by itself a proof that arbitrary OS descendants ended; the independent whole-tree task guard and before/after transcript checks remain mandatory.

## Cross-store ordering

1. Compare-and-set a durable reservation against the exact account, runtime generation, native cursor and latest user-control sequence. Every new provider mutation is fenced. Ordinary binding writers are also blocked by SQLite guards.
2. Retire the idle query and produce a verified, closed candidate session without activating it. Keep both the original history and the candidate available for recovery.
3. Drain already-running backend ingestion before changing files. Once preparation proves native retirement, old-generation records are rejected in both ingestion and checkpoint processing, including journal replay after restart. While preparation may still refuse without mutation, exact original-generation events remain admissible; another thread advancing the shared cursor must not discard them. A bounded drain timeout preserves the reservation rather than hanging forever.
4. Capture Cafe's private filesystem recovery checkpoint, then restore the selected checkpoint. A definite native-commit refusal compensates files only if restoring the recovery checkpoint succeeds.
5. Atomically switch the durable native cursor and mark the reservation committed. No replacement query or model request is started by this transaction.
6. Publish Cafe's revert completion only if the original control sequence is still current, checked under the same SQLite writer transaction as the destructive event. A newer user prompt, settings change or Stop must not be truncated by a delayed completion. Release the reservation only against the exact accepted completion-command receipt and matching reverted event; then prune stale refs and remove recovery evidence.

Unknown provider, transport, persistence, filesystem or projection outcomes retain the reservation and available recovery evidence. A crash never expires this fence or authorizes a competing query. Failed compensation must not delete the recovery snapshot. Stable per-phase daemon command IDs are bound to the exact request, not merely to a user-supplied ID. Lost acknowledgements are not treated as definite refusal or permission to repeat native mutation. A lost commit compare-and-swap re-observes the exact operation: a concurrent successful commit is not permission to compensate files. Explicit provider-runtime restart checks every affected reservation before side effects and excludes concurrent rewind preparation throughout teardown.

## Security and operational consequences

- Migration 85 is schema-only. One bounded private rewind row per Cafe thread retains the original/candidate cursor and exact ownership, not copied transcripts. Completed rows continue to fence retired-generation replay. Permanent thread deletion retains its existing tombstone authority.
- Reads are byte/entry/line bounded, reject symlinks and invalid identity, and compare held-file identity plus a domain-separated SHA-256 commitment. A live SDK session ID must be an admitted UUID before any transcript path is constructed; validation of an earlier persisted cursor cannot authorize later provider metadata. SDK messages remain untrusted; only narrowly validated identity fields are interpreted by Cafe.
- The qualified native and SDK JSONL writers create new POSIX transcripts with `0600` permissions. Append does not repair an existing weaker mode: imported or manually changed nonprivate files are deliberately refused, not silently chmodded. Existing platform-specific ACL behavior is documented in AGENTS.
- Publication uses an exclusive, server-minted inert filename. It validates the empty held file and directory identity before writing transcript bytes, writes through that descriptor, synchronizes, and revalidates. Unexpected namespace changes never justify overwriting, following another file, or pathname-based cleanup. Same-user namespace relocation cannot be fully prevented by portable Node filesystem APIs; this is not a claim of a native `openat` sandbox.
- Existing account credentials, environment, permission modes, cwd and structured spawn arguments remain provider-owned. The process hook retains Cafe's stderr callback but not the SDK's additional raw stderr tail. No live provider, paid inference, global CLI installation or production database rewrite is needed for tests.
- A newer explicit control invalidates preparation/commit. Rewind does not become an implicit Stop. Unsupported/legacy/cold states fail before filesystem changes rather than pretending to succeed.
- An unresolved reservation deliberately blocks later provider work across restarts. Inspect the exact original/candidate history and the private recovery checkpoint before a deliberate repair. Do not clear the journal, remove the recovery ref or resend a prompt merely to dismiss the error; ambiguous external state needs operator-directed recovery, not an automatic timer.
- Codex and Grok retain their native rewind APIs. Shared checkpoint cleanup now preserves evidence through successful compensation and projection completion; no new provider-native semantics are inferred for them.

## Verification requirements

Credential-free fixtures must cover public SDK chain/UUID rewriting, first/middle/baseline and compacted boundaries, multiple messages per turn, successive forks, stale/active descendants, late appends, exact exit acknowledgement, unknown outcomes, SQL admission/restart/replay, lost daemon replies, and real scoped Git compensation/projection ordering. Full repository formatting, lint, typecheck, default and browser tests precede the final forced desktop build. Hosted results must identify the exact published source; local synthetic evidence does not claim foreign-platform native or live paid-provider qualification.
