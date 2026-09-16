# Decision: verified runtime loss permits fenced automatic continuation

Status: Accepted; implemented and regression-tested
Created: 2026-09-16 13:05:41 JST (UTC+0900)
Last updated: 2026-09-16 13:23:46 JST (UTC+0900)
Decision authority: implementation choice within the user's request for automatic reconnect and continuation until explicit Stop.

## Context

Replacing a configured provider scope can drop its last lifecycle notification. A live daemon PID and a persisted running flag then disagree with the actual adapter inventory. Presentation/default edits previously replaced scopes unnecessarily; those edits now retain runtime identity. A quiet high-effort model is not evidence of loss.

## Decision

The runtime owner repairs only its exact missing session generation after successful inventory observations, rechecked under its lifecycle lock. It persists stopped state before emitting a fixed, content-free exit. Ingestion flushes buffered output, rejects stale/different-turn events and writes a deterministic server-authored recovery marker. Duplicate delivery converges on one marker, including crash recovery between the terminal state and marker writes.

Automatic recovery uses the existing orchestration command/receipt path. Its internal envelope binds the source marker sequence, interrupted turn and stopped session timestamp. Browser commands cannot supply this envelope. Engine admission and provider-I/O checks authenticate the durable marker and later user controls. Compact control evidence ensures a Stop racing before the loss marker cannot be overridden. A schema-only completeness fence does not invent consent for historical turns without trustworthy control evidence; new explicit input establishes it.

Resume the native session and preserve model, effort, permissions and interaction mode. If a native turn is already live, reconnect to it without another prompt. Otherwise prefer a definitely unattempted saved steer, or send a short visible continuation asking the provider to inspect existing work before repeating actions. Do not replay the full original request or its attachments merely to resume execution.

Retry failed pre-send session preparation with exponential delay capped at 60 seconds. Timers run outside the shared serial command worker. Revalidate Stop/newer-input barriers after waits and preparation. Before paid submission, persist an immutable attempt marker with a fresh owner nonce and read back the winning owner; a duplicate command receipt alone does not authorize a second backend's external send. A bounded submission remains ordered with Stop; late acknowledgments cannot reopen stopped work.

## Safety and operational consequences

- Auth failures and unsuccessful inventory reads remain inconclusive; they never authorize a duplicate session or turn.
- Explicit Stop, newer input, changed routing/mode, deletion and archival cancel unattended recovery.
- Ambiguous submission acceptance is deliberately not resent automatically. The marker preserves evidence for reconciliation instead of risking repeated external actions or token charges.
- This is recovery for positively verified owned-session loss, not a silence timeout or an unlimited restart policy for every provider error. Provider-native retry/continuation behavior remains authoritative.
- Debug health has an observation timestamp separate from manager/liveness publication time; old inventory cannot look newly observed.
- No prompt, output, credential or unrestricted filesystem path is added to recovery diagnostics. Saved input remains in the existing authenticated message store.
- Already-running desktop/daemon processes do not execute rebuilt code until the normal restart lifecycle applies it. A build alone does not prove recovery on the user's live task.

## Alternatives

Restarting after a fixed interval without tokens was rejected because high-effort reasoning and tools can legitimately stay quiet. Retrying every failed send was rejected because an unobserved ACK can conceal accepted work. Blanket startup transcript scans were rejected because mature tasks must remain responsive. Metadata-only provider changes do not require any reconnect at all.

## Verification

Passing regression suites cover instance retention, stale owner/heartbeat generations, unsuccessful inventory, debug freshness, buffered-output preservation, exact marker identity, durable Stop/newer-input fences, retry/ACK races, and competing-backend attempt ownership. Replay with the repository-pinned Node/Corepack Yarn toolchain: `yarn fmt`, `yarn lint`, `yarn typecheck`, `yarn test`, then `yarn build:desktop --force`. The forced bundle is the final release verification step. Live provider recovery is a separate operational check, not implied by synthetic tests.

No prior decision is superseded; authentication, at-most-once delivery and explicit Stop remain governing constraints.
