# Isolate native SQLite execution from backend HTTP

Decision: accepted for implementation under the user's freeze-repair request.
Implementation: implemented; each delivery requires the regression and final repository checks described below.
Created: 2026-11-08 00:38:48 JST (UTC+0900)
Last updated: 2026-11-08 01:32:20 JST (UTC+0900)

## Context

The backend's HTTP readiness handler serves an already-built descriptor and proof without querying SQLite. Nevertheless, synchronously executing a SQLite statement on that same Node event loop can prevent it from serving readiness, WebSocket heartbeats, cancellation and ordinary HTTP traffic. A native sample during the reported freeze caught the backend in StatementSync.all and native file reads; the desktop trace independently recorded failed health checks and repeated backend replacements. Completed SQL spans included waits exceeding fifty seconds, but those spans do not identify the native statement caught by the sample. Database size, memory pressure and relay process counts alone do not prove its query-level cause.

Increasing watchdog budgets would conceal this starvation and delay detection of a genuinely unavailable backend. Targeted query improvements remain worthwhile when a specific unbounded execution plan is demonstrated, but an index is not a general isolation boundary for native file reads or SQLite busy waits.

## Decision and boundaries

Each filename-based production SqlClient owns one worker-thread SQLite connection. The existing Effect SQL compiler, transforms, tracing, transaction service and callers remain on the main runtime. Only native open, prepare, statement configuration/execution and close run in the worker. There is no connection pool, per-statement worker creation, new network listener or change to data roots, journal mode, migrations, busy timeout, daemon authority or watchdog budgets.

An ordinary statement holds its main-runtime permit through native execution and row materialization. It releases that permit before emitting materialized stream rows, so downstream consumers can query the same client. Transactions and reserved connections instead retain a scoped permit and the raw connection for their complete lifetime. A separate worker-operation permit preserves one admitted native operation at a time, including parallel fibers sharing a transaction connection. Admission remains interruptible. Once posted, the operation retains ownership until its exact reply or actual worker failure, before interruption can release the connection, roll back or close it. A cancelled transaction must finish its admitted statement and roll back before another owner obtains the connection.

Worker shutdown queues native close after admitted work and joins the worker's actual exit. Unexpected transport or worker failure makes that connection unavailable; it never reopens the database, restarts a busy worker or replays a write whose outcome is uncertain. The normal client lifecycle and explicit application recovery remain responsible for a replacement runtime.

Prepared and unprepared queries preserve their modes; row arrays, BigInt values, byte arrays, nulls and raw write metadata cross the private in-process structured-clone boundary. Caller-owned byte buffers are copied rather than transferred or detached. Native SQLite error properties needed for existing lock classification are explicitly reconstructed; worker/transport failures must not masquerade as retryable database contention. SQL, bound values and error envelopes are never diagnostic labels.

Explicit layerWithDatabase adoption remains available for owned native handles, notably isolated test database clones. Its scope still closes that exact handle. The lightweight layerMemory fixture path remains native and synchronous; runtime filename-based layers, including their explicit in-memory configuration, use the worker. Tests of injected handles alone do not qualify production worker behavior.

## Packaging and operational diagnostics

The worker entry belongs to the primary server build, so its bytes are covered by the same application-version and source build receipts as the backend. Source execution selects the local TypeScript entry; built execution selects its sibling compiled worker module. An old backend bundle cannot borrow a newly compiled worker.

Existing opt-in SQLite statement diagnostics retain content-free fingerprints, operation classes, counts and timing, without SQL text or parameters. Live worker diagnostics report fixed-cardinality execution and lifetime counters without scanning SQLite or retaining operation payloads. Lightweight daemon liveness and cached rich-health freshness remain separate; an old rich inventory must not be presented as a new observation.

## Security and compatibility consequences

The worker inherits the process's existing private database access rather than a new external capability. Profile guards, authentication, native daemon retirement and exact process ownership stay unchanged. A worker does not grant authorization to stop an unrelated daemon. Data is neither deleted nor rebuilt by this change.

Off-thread execution keeps HTTP responsive while storage is slow; it does not make every database operation fast or guarantee an account-dependent request can complete while its required query is blocked. Very large queries still need bounded plans and payloads. Native statement cancellation remains join-before-release rather than a potentially unsafe forced termination.

## Required qualification

The primary regression holds a real SQLite writer lock, waits for the production client's exact native statement admission, and proves an independent loopback HTTP request remains serviceable before that statement finishes. Releasing the writer must allow the original operation to settle exactly once. Additional boundary coverage verifies cancellation followed by rollback and owner exclusion, native close/reopen, nested ordinary and transactional queries while consuming materialized stream rows, native error classification and structured-clone value/mode compatibility. The original synchronous implementation must fail the responsiveness regression for the intended reason. The forced desktop build and a real compiled-worker query outside the checkout qualify the worker's receipt and runtime dependency boundary; native platform CI remains separate from local evidence.
