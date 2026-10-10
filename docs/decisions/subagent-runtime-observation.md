# Decision: bind subagent activity to its observed runtime

Decision status: Accepted within the authorized reconnect repair
Implementation status: Implemented
Verification status: Local macOS checks passed; native cross-platform qualification is reported by CI.
Created: 2026-10-04 03:36:25 JST (UTC+0900)
Last updated: 2026-10-04 04:14:44 JST (UTC+0900)
Decision authority: implementation choice within the user's request to fix stale subagents after restart or provider disconnection.
Supersedes: only the assumption that retained nonterminal lifecycle alone establishes current liveness in [ordered lifecycle retention](subagent-lifecycle-retention.md).
Partially superseded by: [persistent Codex transient recovery](codex-persistent-transient-recovery.md), which separates a failed root from a freshly verified surviving context. Its exact-generation and unknown/closed-runtime overlay remains governing.

## Context

Retaining lifecycle edges across turns preserves history, including quiet workers
and completions that leave the ordinary activity tail. It also exposes historical
workers for which no terminal event was ever recorded. A saved Working status
does not prove that the same native runtime still owns that worker after restart.
Conversely, a renderer or backend reconnect does not prove that a detached native
runtime stopped. Parent-turn completion is not child completion either.

Codex metadata-only `thread/read` observes the reading app-server's live state;
a transient transcript reader is not authority over a different runtime's live
children. Existing bounded newest-turn discovery cannot reconstruct all historical
children and must not be expanded into an unbounded history scan.

## Decision

Give each native Codex/Claude runtime context an opaque, cryptographically random
generation identity. Preserve it across turns and adoption of the same runtime;
mint a new identity when the native context is replaced. Session inventory and
canonical events carry that identity through authenticated provider transport.
Child presentation carries the identity of its originating context, not whatever
runtime currently happens to occupy the same Cafe thread.

Persist the current observed generation with the orchestration session. Native
events from an old generation cannot replace current session evidence or change
its live state merely because they arrived late. Current authenticated provider
inventory and session creation/admission remain the authority for replacement.
Startup also checks saved observation evidence for idle parents, not only
running orphan turns. Exact surviving inventory or qualified detached ownership
preserves it; otherwise only the observation becomes unknown. An unavailable
inventory must not be interpreted as an empty provider or permission to interrupt
parent work. Positive current child metadata can reconfirm the context without
starting another turn or replaying a prompt.

Reject superseded child lifecycle writes before they displace compact latest-kind
edges, with a final generation compare-and-set under serialized admission. The
provider journal retains the original events. Renderer precedence alone would
not protect a reconnect snapshot after a newer terminal pointer was overwritten.

Within one exact child/turn row, confirmed current-generation evidence takes
precedence over delayed foreign-generation edges. A fresh current-runtime active
status can supersede an old runtime's terminal observation; within the same
runtime, late progress still cannot reopen terminal work. A name change alone
must not manufacture liveness evidence. Runtime identity does not become a new
history authorization key or duplicate row identity.
Fresh confirmation in a replacement runtime starts a new observed display
interval; it cannot borrow a many-hour clock from the old context. Same-runtime
reconnects preserve their existing interval.

After canonical lifecycle coalescing, presentation checks a nonterminal
child against the current session's generation. Missing or mismatched evidence,
or a stopped/error session, produces **Status unavailable**, not Completed. Such rows
remain inspectable in historical surfaces but leave active Tasks/rail rosters
and have no ticking or invented duration. Terminal history is unchanged. A fresh
observation from the actual current runtime can establish liveness again.

The overlay does not mutate saved child outcomes, complete native work, change
subagent-limit admission, or confer permission to replace an allegedly idle
runtime. It is deliberately conservative for legacy activity without generation
evidence. Ordinary WebSocket reconnects do not create a generation boundary.

## Alternatives and rationale

- Age thresholds falsely retire long, quiet tasks and cannot prove completion.
- Closing every child when a parent turn completes breaks background work.
- Native process termination on reconnect would interrupt work unnecessarily.
- Re-reading every historical transcript is unbounded and a separate reader can
  mistake another process's work for unloaded history.
- Hiding all historical rows loses useful names, status history and authorized
  transcript access. An explicit unavailable observation preserves that context.

## Security, privacy, and failure consequences

The generation is a correlation key, not a bearer credential or standalone
authorization proof. Existing exact account/root/turn/child/history validation,
authenticated IPC, lifecycle serialization and hard-delete fences remain required.
Do not infer identity from labels, timestamps or arbitrary provider prose. Do not
print these keys, provider payloads or transcript content in diagnostic metadata.

The schema addition is optional for backward decoding. An explicit null current
session generation clears evidence when a legacy runtime is newly materialized;
omitted ordinary same-account lifecycle metadata preserves existing evidence.
Missing legacy evidence
must not be guessed from durable daemon ownership or a saved Working row. New
schema migration work remains schema-only; no global startup history backfill or
additional paid provider request belongs in this change. The implementation must
preserve bounded, indexed lifecycle retention and platform-native launch behavior.

## Verification and operational consequences

Tests must cover native context reuse/replacement, exact event origin, surviving
daemon adoption, stale-generation session mutation, persistence/replay, unknown
legacy rows, fresh confirmations, terminal history, active counts and frozen or
omitted durations. A passing mocked test does not verify a real provider's work.
Repository checks, full tests, focused browser tests and the final forced desktop
build precede publication. A rebuild alone does not restart an existing client or
upgrade already detached native runtimes; old contexts remain unverified until
current evidence is available.

Ordered lifecycle retention, explicit restart authority, immutable historical
ownership and the existing bounded newest-turn discovery remain in force.

Local verification used the repository-pinned Node 24.21.0 and Corepack Yarn
4.17.1 on macOS arm64: `yarn fmt`, `yarn lint`, `yarn typecheck`, `yarn test`
(5,881 passing tests), and the final `yarn build:desktop --force`. The focused
browser command below passed all 79 tests:

```sh
corepack yarn workspace @cafecode/web test:browser src/components/chat/MessagesTimeline.browser.tsx src/components/chat/SessionRail.browser.tsx src/components/chat/ComposerTaskProgress.browser.tsx src/components/atrium/TaskAtrium.browser.tsx
```

These isolated fixtures do not launch live providers, use credentials, or claim
to validate an existing user's native task. CI separately repeats repository
checks and native packaging on its supported Windows, macOS and Linux hosts.
