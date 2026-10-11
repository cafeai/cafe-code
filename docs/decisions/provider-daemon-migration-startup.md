# Decision: visible, ownership-safe provider daemon startup

Decision status: Accepted within the user-authorized startup repair
Implementation status: Complete; normal rebuilt application adoption required
Verification status: Focused qualification passed; final delivery gates tracked in plan148
Created: 2026-10-11 10:04:45 JST (UTC+0900)
Last updated: 2026-10-11 11:08:36 JST (UTC+0900)
Decision authority: The user's specific yes to fixing daemon migration handling,
startup feedback and pushing this new changeset.
The user also specifically approved a safely qualified replay-throughput fix
in this same push.
Supplements: [persistent WebSocket recovery](persistent-websocket-recovery.md).

## Context

The desktop creates its main renderer after backend HTTP readiness. Backend
startup must first await the final provider daemon's authenticated health and
issued lease; a provisional endpoint can carry a superseded credential. That
ordering is correct but left no visible window during slow daemon preparation.

The daemon runs transactional SQLite migrations before opening its listener.
The previous migration allowance covered only the backend child. Fresh daemon
readiness still expired after30seconds, then awaited Effect child.kill. In the
pinned child-process implementation forceKillAfter bounds signal dispatch, not
the subsequent actual exit wait. A synchronous SQLite statement can delay JS
signal handling, leaving startup and GUI waiting without a bound or feedback.

Read-only evidence established synchronous SQLite work against a50.27GB store,
not a desktop event-loop freeze. The committed migration watermark was91;
the exact active statement was not observed. Later the original daemon exited
and a new generation became ready; this is not evidence that source changes
repaired that live launch.

## Decision

Preserve daemon-ready -> authenticated lease -> backend-start -> main-window
readiness. Show a delayed small auxiliary local startup surface during this
wait, with one short phase label. Its document is inert, without preload,
scripts, provider controls, network access or IPC trust. Fixed labels never
include raw errors, SQL, tokens or paths. The ordinary renderer still receives
trust only through its existing authenticated startup. Programmatic handover
closes the auxiliary view; user closure requests ordinary app quit.

A fresh directly owned daemon receives the same dedicated inherited migration
output pipe and opt-in bootstrap field used for backend progress. Detached
stdout/stderr remain ignored. Validate finite versioned phase/numeric frames
from that exact child only; no CPU, PID, arbitrary output or provider message
is progress authority. A valid start before ordinary expiry permits one
absolute60-minute daemon migration budget measured monotonically from spawn.
Duplicate starts and later migrations cannot renew it. Whole-transaction
commit/rollback ends the migration phase and restores ordinary readiness within
the absolute cap. Invalid progress revokes it. The main backend's10-minute
budget and post-ready daemon watchdog remain unchanged.

Newly owned failed-child retirement bounds the actual exit observation, not
only signal dispatch. Preserve the exact process/generation authority. An
unconfirmed exit is an inconclusive startup failure: retain ownership records,
credentials and socket evidence, and do not spawn a competitor. An adopted
live daemon never gains destructive authority from a failed health probe.

## Alternatives and limits

Increasing every health timeout would leave unbounded cleanup and invisible
startup unchanged. Starting a privileged backend or renderer early would break
the immutable authenticated lease boundary. Treating a live PID as readiness
or deleting uncertain ownership records would create split-brain risk.

The longer migration-only allowance is deliberately finite, not a guarantee
that any database size completes. Shipped92's global live-work backfill and
93's expression index still scale with retained activities. Deferring them
requires a separately qualified bounded hydration/index design preserving
terminal-edge ordering, account/runtime ownership and shipped upgrade lineage.
This changeset does not skip migrations, rewrite their ledger, alter
transactional results, scan live history for diagnostics or promise a faster
historical backfill. Future migrations must remain schema-only or bounded as
required by AGENTS.md.

## Security and verification

The progress channel grants only bounded local waiting time, not auth or
provider I/O authority. Reuse the strict descriptor admission and bounded
parser; no ambient fd4 file can become a reporter. Static startup content is
separate from provider-capable web contents and cannot become a main-window
fallback. Scoped cancellation must dispose subscriptions/timers/view without
affecting detached provider sessions.

Qualify ordinary/slow/malformed startup, transaction settlement, stale records,
absolute cap, cancellation, actual exit escalation and inconclusive ownership
using isolated credentials/process peers. Verify theme, scale, narrow layout
and reduced motion. Full formatting/lint/typecheck/default tests and a forced
desktop build LAST gate delivery. Local fixtures are not live provider,
large-database or native foreign-host qualification. A source push requires
normal rebuilt application adoption; the current live launch is untouched.

The exact inherited-descriptor admission remains fail-closed for file-like,
console and unknown handles. CI exposed a host-native reporter admission
failure; its corrected platform policy and separate native qualification
boundary are recorded in AGENTS.md's Windows-Specific Notes. Eight focused
reporter tests, including real isolated Node-child pipe delivery on macOS,
passed; native Windows delivery remains a CI requirement. This does not alter
the authenticated bootstrap grant, progress parser or migration budgets.
The diagnosis is grounded in the pinned
[Node type predicates](https://github.com/nodejs/node/blob/v24.21.0/lib/internal/fs/utils.js#L509-L515)
and [libuv descriptor stat implementation](https://github.com/nodejs/node/blob/v24.21.0/deps/uv/src/win/fs.c#L2108-L2133).

Startup-close admission must not await daemon health behind the mutex held by
readiness. Before backend readiness, native Quit requests scoped shutdown and
leaves provider ownership running; the established post-ready Leave/Stop/Cancel
policy is unchanged. Fresh child acquisition/reservation/recovery publication
is cancellation-fenced, so a quit cannot strand an unpublished detached child.
The subsequent readiness wait remains interruptible. An integrated synthetic
lock-held lifecycle fixture qualifies this ordering.

The actual owned-child exit fixture is opt-in and isolated:
`CAFE_CODE_DAEMON_STARTUP_E2E=1 corepack yarn workspace @cafecode/desktop test src/backend/DesktopProviderDaemonStartup.e2e.test.ts`.
It uses a scoped copy of the pinned Node executable and no provider/profile.
Its existing30-second test budget covers real15-second TERM and3-second KILL
observation, rather than mocking process exit or changing production budgets.

## Bounded replay repair

Read-only diagnostics showed a retained-event ingestion backlog with zero
projection lag. The durable ingestion cursor continued advancing, so this was
catch-up work, not proof of a permanently disconnected renderer. Source review
found that every eight-event replay page scanned and repaired the entire
remaining journal suffix. Even already-small events incurred quadratic repeated
SQLite length predicates, competing with live ingestion under CPU pressure.

Replay now first selects only indexed cursor metadata for its finite page,
then binds the existing one-row historical repair and body fetch to that exact
owner and cursor interval. The eight-event/two-MiB policy, event schema,
quarantine digest/tombstones, captured high-water/live barrier, accounting and
durable ingestion settlement are unchanged. No retained event is skipped and
no prompt is replayed. Historical size admission uses SQLite BLOB length, not
TEXT character length, so multibyte stored UTF-8 events cannot bypass the
existing byte boundary. This is a byte-policy correctness/security correction,
not an increased limit. If concurrent retention removes a probed range, replay
continues through only that now-absent interval rather than falsely reporting
the entire bounded replay exhausted. Global post-readiness maintenance remains
separate; this does not accelerate historical migrations or every ingestion
operation.

Actual isolated SQLite regressions count bounded predicate evaluations across
256 retained events, preserve oversized/malformed future and foreign-owner
rows until their own admissible page, verify cursor order and live high-water
delivery, and inject real deletion between cursor probe and fetch. They avoid
timing-based pass thresholds. A separate actual SQLite eight-row multibyte
fixture proves compaction when each JSON string is below the character limit
but exceeds the byte limit. This proves the repaired query work boundary,
not live adoption or a universal catch-up latency guarantee.
