# Decision: recover app connections through prolonged local stalls

Decision status: Accepted within the user-authorized CPU/disconnect repair
Implementation status: Implemented; rebuilt desktop and renderer adoption required
Verification status: Local isolated and repository-wide checks passed; no live restart performed
Created: 2026-10-11 09:01:56 JST (UTC+0900)
Last updated: 2026-10-11 09:36:52 JST (UTC+0900)
Decision authority: The user's request to repair high-load disconnect/reconnect
failures and push that changeset; detailed policy resolved within that scope.
Supplements: [provider/WebSocket decoupling investigation](../provider-websocket-decoupling-findings-2026-07-15.md).

## Context and preserved boundaries

CPU scheduling and disk/swap pressure can delay both a heartbeat and startup.
A failed local connection does not prove that a provider session stopped. The
renderer is a projection consumer; its reconnection must not interrupt, replace
or replay provider work. Existing bounded queues, cursor/snapshot reconciliation,
durable command receipts and independent provider ownership remain unchanged.

The previous Effect retry schedule counted failures across the whole protocol
session while UI counters reset on socket open. It could stop permanently after
historical successful reconnects, or exhaust during one prolonged outage. Async
saved-server socket-token acquisition also used a defect-only Promise boundary,
so network rejection could leave the UI at one attempt without retrying.

Separately, pending startup migrations can exceed the ordinary desktop readiness
window. SQLite migration transactions roll back if startup is terminated. A
repeated kill/restart can therefore repeat the same expensive work indefinitely.
Native stack evidence can identify synchronous SQLite execution without proving
which exact statement or OS resource caused the initial stall.

## Decision and alternatives

Retain the existing heartbeat cadence and socket-open deadline. Raising every
timeout would mask ordinary hung startup and would not fix exhausted retry or
failed URL acquisition. A separate gateway or resumable historical migration is
a broader architecture change, not required for this scoped repair.

Transient connection failures use one persistent schedule with capped exponential
delay. Canonical timing is in `rpc/wsConnectionState.ts`; there is no total attempt
ceiling. Only an active native socket's received Pong resets the failure ramp:
opening a handshake without working heartbeats is not recovery. The actual
schedule publishes its count, delay and next deadline to the primary or exact
saved environment. Counters saturate and diagnostic history stays bounded.

Heartbeat timeout recycles the native socket through the same schedule instead
of immediately replacing the protocol runtime and resetting its backoff. Pending
requests receive a typed transport failure and critical subscriptions reattach
with fresh state. This does not replay ordinary RPC mutations. Indeterminate
orchestration commands remain subject to the existing exact-command/commandId
durable receipt handler. Explicit Retry may replace the protocol session; disposal
closes its scope and cancels retries. Old socket/session callbacks cannot reset
current liveness, errors or retry state.

Saved-server reconnection may request a fresh short-lived WebSocket token using
the existing saved bearer. Only classified network errors and HTTP408/429/5xx
are retryable. Credential rejection, invalid target, malformed response and unknown
failures are terminal until explicit Retry. A local protocol-handler defect is
also terminal, published by a typed local hook rather than by classifying remote
message text. Focus, visibility and network events must not reset an active
backoff or resurrect terminal admission. Pairing/password bootstrap is never replayed,
certificate trust is not bypassed and raw error/URL/token text is not published.
A terminal acquisition latch also settles requests awaiting the initial writer
when a broadcast races request registration.

Desktop migration progress uses a dedicated inherited output pipe from the exact
owned backend child. Its opt-in descriptor travels only through the existing
private bootstrap input. The finite parser admits only versioned phase and numeric
migration identity records, with byte/record/line bounds. Progress is emitted before
synchronous SQL and on completion/failure of the whole transaction, including
commit or rollback; ordinary output cannot grant time.
An observed migration grants one absolute finite startup budget from spawn,
defined in `shared/backendStartupProgress.ts`. Duplicate records cannot renew it.
Completion restores the ordinary startup window within that absolute cap; invalid
progress revokes the allowance. No observed migration retains the ordinary startup
deadline. Post-ready HTTP health checks and provider-daemon protection are unchanged.
This accommodates slow one-time work, not infinite or permanently blocked migration.

## Security, compatibility and resource consequences

Connection recovery uses the existing authenticated socket, environment identity
and capability boundaries. Token failure classification is structural and fail-closed;
no credential, paid prompt or provider process is acquired by this repair. The
startup pipe is local child-handle authority, not a network or provider capability.
Only configured pipe/socket descriptors receive progress; files and ambient fd4
are not accepted. Parsers never evaluate SQL or retain arbitrary child output.

SQL diagnostics now cover non-returning `.run()` statements using the existing
content-free statement fingerprint, duration and outcome reporter, closing the
blind spot for migration work. Heartbeat/retry diagnostics are bounded numeric
counters and timestamps; compact desktop debug excludes socket URLs and errors.

The existing pinned Effect patch additionally retires failed/interrupted request
routing and per-client serialized/pending entries, drops unknown request-scoped
response IDs and clears scoped ownership at finalization. Encoding or writing
failure before registration settles must also retire its exact request. Persistent
retry must not accumulate retired context or fan stale responses out to unrelated
clients. Runtime map-bound tests
qualify the regenerated patch; the dependency version stays unchanged and its
lockfile patch checksum changes explicitly.

No schema migration, process termination policy, provider/runtime permission or
platform-specific authentication policy changes. The inherited pipe
uses the existing structured Node child-process API on every host. Native-host
qualification remains separate from local macOS and synthetic fixture evidence.

## Verification and operational limits

Isolated tests exercise actual Ping/Pong loss, repeated successful cycles, outages
beyond the old ceiling, backoff without healthy Pong, pending ACK rejection,
subscription recovery, terminal acquisition, cancellation and stale callbacks.
Saved-environment tests cover exact owner state and transient/terminal HTTP
classification. Startup tests cover finite phase deadlines, malformed/duplicate
progress, normal startup/health failure and scoped pipe behavior. Required repository
checks and the final forced desktop build gate delivery.

Local qualification on macOS arm64, recorded 2026-10-11 09:36:52 JST (UTC+0900):
repository formatting, lint and typecheck passed; all 7,986 default tests passed
with eight existing skips and one existing expected failure. Sixteen selected
browser tests passed, including connection-chip count/deadline and terminal
admission in light and dark themes. Independent review closed the transport,
ownership, progress-authority and bounded-resource findings. The pinned Effect
artifact was newly materialized and its immutable install replay passed; installed
runtime, declarations and source match the reviewed patch. This is not a clean
full-workspace install or a live CPU-pressure/native provider trial. Delivery must
still run the forced desktop build after these checks; CI/native-host results are
separate evidence.

Restart the rebuilt app to adopt both backend bootstrap and renderer changes.
An already running binary is not patched by a source push. The repair cannot
guarantee continuous connectivity while the OS cannot schedule processes or while
storage remains unavailable; it prevents permanent transient retry exhaustion and
unnecessarily short rollback loops. Very large migrations exceeding the finite
allowance still require investigation. Automatic reconnection is not evidence
that a provider root, child, credential or paid request has recovered.
