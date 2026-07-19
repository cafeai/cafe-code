# Provider Runtime / WebSocket Decoupling Findings

Date: 2026-07-15
Status: Investigation complete; bounded in-process mitigation implemented on 2026-07-16
Scope: Cafe Code desktop backend, provider daemon event bridge, orchestration subscriptions, and renderer WebSocket recovery

## Purpose

This document preserves the investigation context needed to continue work on intermittent renderer WebSocket hangs and reconnects that appear during provider activity. It separates evidence observed from a live local Cafe instance from risks inferred through source inspection.

No raw prompts, command output, provider credentials, bearer tokens, or event bodies were copied into this document. Live journal inspection was limited to timestamps, event types, counts, and encoded byte/character lengths.

## Implementation Outcome (2026-07-16)

The mitigation keeps WebSocket handling in the main backend process and removes the five identified amplification/unbounded-work paths:

1. All provider runtime events are compacted under one finite encoded-byte policy before in-memory or persistent journal insertion. Oversized historical rows are repaired one at a time; incompatible rows become payload-free cursor tombstones backed by a metadata-only quarantine record.
2. Daemon replay is cursor-paged and uses a serialized drain-aware writer with a finite live queue. The backend keeps NDJSON as bytes until complete lines exist, pauses during asynchronous decode/admission, enforces line/pending caps, and yields under record/byte/time budgets.
3. Shell and thread subscriptions now share one durable orchestration tail and bounded replay ring instead of opening one global SQLite poller per retained subscription. Each subscriber has an isolated count/byte-bounded queue and a default-protected coalescing policy.
4. Each authenticated WebSocket connection accounts bulk stream frames at Effect RPC's public Ack/pull boundary, reserves capacity for control/unary traffic, and fails only the saturated subscription with a sanitized resnapshot error.
5. Daemon health and backend runtime diagnostics expose bounded numeric event-loop, compaction, replay, queue, subscription, and WebSocket counters. The diagnostics schema deliberately cannot carry prompts, output, paths, identifiers, tokens, or raw errors.

The original evidence below remains the before-state record. It should not be read as a description of the current source after commit of this mitigation.

## Executive Conclusion

The reported behavior is real and was observed in retained live-instance diagnostics. The backend became unavailable for multi-second periods, causing all WebSocket RPC subscriptions to be interrupted and recreated. Existing reconnect, snapshot, and replay behavior explains why the UI normally recovers.

Ordinary provider RPC failures are already reasonably isolated by the separate provider daemon process, request timeouts, worker fibers, and local error handlers. The incomplete isolation is in the provider **event data path**:

1. Raw provider events can be very large before projection sanitization.
2. Daemon event replay and live NDJSON delivery have no byte-level backpressure or work budget.
3. The backend parses, schema-decodes, and publishes all available NDJSON lines synchronously from Node HTTP `data` callbacks.
4. Every shell/thread WebSocket subscription independently polls and decodes the global orchestration event store once per second.
5. Several internal queues and PubSubs are unbounded.
6. WebSocket liveness shares the same backend event loop as this work.

The evidence proves backend-wide stalls and confirms substantial provider-event/subscription amplification. It does not yet prove which individual mechanism caused every stall because event-loop delay, queue depth/age, NDJSON bytes, and WebSocket buffered bytes are not currently measured.

## Live-Instance Evidence

### WebSocket interruption and recovery

Recent server traces recorded one shell subscription and 11-14 thread subscriptions being interrupted together, followed by replacement subscriptions. A long-lived connection ended at approximately 19:47:44 UTC, followed by repeated shorter connection lifetimes through at least 20:07 UTC.

Representative server-side connection lifetimes:

| Start UTC | End UTC  | Approximate lifetime | Result                               |
| --------- | -------- | -------------------: | ------------------------------------ |
| 18:04:48  | 19:47:44 |            6,176.5 s | All subscription streams interrupted |
| 19:47:44  | 19:56:25 |              520.0 s | All subscription streams interrupted |
| 19:56:25  | 19:57:25 |               60.2 s | All subscription streams interrupted |
| 19:57:25  | 19:58:02 |               37.4 s | All subscription streams interrupted |
| 19:58:12  | 19:59:31 |               78.7 s | All subscription streams interrupted |
| 19:59:31  | 20:02:40 |              188.8 s | All subscription streams interrupted |
| 20:02:40  | 20:03:27 |               47.2 s | All subscription streams interrupted |
| 20:03:27  | 20:05:53 |              145.8 s | All subscription streams interrupted |
| 20:05:53  | 20:06:41 |               47.5 s | All subscription streams interrupted |

Renderer OTLP spans independently showed subscription interruption and recreation during the same period. This establishes that the reconnect behavior was occurring in the live application rather than only being theoretically possible in source.

### Backend-wide health timeouts

The Electron desktop process performs an independent HTTP health request against `/.well-known/cafe-code/environment`. That route returns an already-created in-memory descriptor; it does not need provider RPC, projection replay, or a database query for each request.

Multiple health requests timed out at the configured five-second limit near WebSocket interruptions. Examples include:

- A five-second health timeout ending approximately one second before the 19:47:44 UTC subscription interruption.
- Two five-second health timeouts before the 19:56:25 UTC interruption, the later one ending approximately two seconds before it.
- A five-second health timeout ending approximately two seconds before the 19:58:02 UTC interruption.
- Additional five-second health timeouts near the 20:03 and 20:06 UTC reconnect periods.

Because this is a trivial in-memory route and the backend process remained alive and later recovered, the strongest explanation is backend listener/event-loop starvation or a comparable process-wide scheduling stall. This is stronger evidence than a WebSocket-only close.

Relevant code:

- `apps/server/src/http.ts` (`serverEnvironmentRouteHandler`)
- `apps/server/src/environment/Layers/ServerEnvironment.ts` (`getDescriptor: Effect.succeed(descriptor)`)
- `apps/desktop/src/backend/DesktopBackendManager.ts` (five-second health request timeout and 15-second interval)

### Large live provider events

Aggregate inspection of the retained provider daemon journal showed 8,792 events over roughly 41 minutes. The sample included:

| Canonical/raw event category | Count | Average encoded length | Maximum encoded length |
| ---------------------------- | ----: | ---------------------: | ---------------------: |
| `content.delta`              | 6,836 |                  1,830 |                 19,304 |
| command execution            |   384 |                 25,076 |              2,147,130 |
| `turn.diff.updated`          |   156 |                  9,018 |                  9,036 |
| agent message                |   136 |                  2,545 |                 27,540 |
| file change                  |    30 |                 13,457 |                 45,012 |
| text                         |    23 |                 16,591 |                 85,717 |

The largest recent journal records were completed provider items at these approximate sizes and timestamps:

| Timestamp UTC | Encoded length | Event                              |
| ------------- | -------------: | ---------------------------------- |
| 19:56:07.364  |      2,147,130 | `item.completed` command execution |
| 20:00:18.508  |        720,639 | `item.completed`                   |
| 20:05:24.715  |        553,228 | `item.completed`                   |
| 20:05:40.590  |        382,426 | `item.completed`                   |
| 19:59:26.181  |        260,800 | `item.completed`                   |
| 20:06:35.926  |        135,278 | `item.completed`                   |

The 2.1 MB record was persisted within roughly one second of a renderer subscription interruption. Several other large records clustered around later reconnect periods. This is correlation, not proof that a specific record caused a specific disconnect, but it confirms that the unbounded code paths were processing multi-hundred-kilobyte and multi-megabyte provider events during the incident window.

`turn.diff.updated` records were already compacted to approximately 9 KB. The gap is that other provider runtime events, especially completed command/tool items and their raw payloads, are not compacted at the daemon journal boundary.

Relevant code:

- `apps/server/src/providerDaemon/EventJournal.ts` (`compactTurnDiffEventForJournal` only handles `turn.diff.updated`)
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` (tool data is sanitized later, while building projected activities)
- `packages/shared/src/activityPayloadSanitizer.ts` (existing projection-oriented sanitizer)

### Per-subscription global event-store amplification

Each `orchestration.subscribeShell` and `orchestration.subscribeThread` stream calls `streamReplayableDomainEvents`. That function creates an independent one-second event-store poller. A thread subscription reads and decodes the global sequence first and filters to its thread afterward.

Observed examples from live traces:

| Connection lifetime | Thread streams | Shell streams | Global event queries | Approximate query rate |
| ------------------: | -------------: | ------------: | -------------------: | ---------------------: |
|             520.0 s |             12 |             1 |                5,875 |                 11.3/s |
|             188.8 s |             14 |             1 |                2,338 |                 12.4/s |
|             145.8 s |             14 |             1 |                1,901 |                 13.0/s |
|              78.7 s |             14 |             1 |                  961 |                 12.2/s |
|              60.2 s |             13 |             1 |                  675 |                 11.2/s |

The renderer retains released thread-detail subscriptions for up to 15 minutes and allows up to 32 cached subscriptions. Thus a single client can maintain one shell poller plus many global thread pollers even when only a small portion of the event stream is relevant to each thread.

Relevant code:

- `apps/server/src/ws.ts` (`streamReplayableDomainEvents`, `subscribeShell`, and `subscribeThread`)
- `apps/server/src/persistence/Layers/OrchestrationEventStore.ts` (`readFromSequence`, global sequence read, default limit 1,000)
- `apps/web/src/environments/runtime/service.ts` (`MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS = 32` and 15-minute idle retention)

### Provider daemon RPC errors during incident periods

The backend recorded provider daemon `listSessions` failures with `write EPIPE` around 19:56:22 and 20:06:38 UTC. Historical retained logs also contain repeated daemon event-stream disconnections while the daemon socket was unavailable.

These errors prove that daemon connectivity also failed during some periods. They do not prove the causal direction: daemon failure can trigger replay/load in the backend, while process-wide load can also make adjacent requests fail.

## Confirmed Source-Level Findings

### 1. Synchronous and unbounded daemon event transport

`packages/shared/src/providerDaemonHttp.ts`:

- Accumulates decoded text in `pending` without a maximum byte or character count.
- Processes every complete line in a `while` loop inside a Node HTTP `data` callback.
- Calls `options.onLine(line)` synchronously.
- Does not pause/resume the response based on downstream capacity.
- Does not yield after a record or byte budget.

`apps/server/src/providerDaemon/RemoteProviderService.ts`:

- Synchronously schema-decodes each line.
- Synchronously publishes each decoded runtime event through `Effect.runSyncWith`.

`apps/server/src/providerDaemon/ProviderDaemonServer.ts`:

- Calls `response.write()` without checking its Boolean backpressure result.
- Writes the entire replay array in one synchronous loop.
- Writes live journal events directly from synchronous journal listeners.

This path can monopolize the daemon and backend event loops during large events or replay bursts.

### 2. Malformed-line errors can escape Promise containment

`streamProviderDaemonNdjson` invokes `options.onLine(line)` from an EventEmitter callback without `try/catch`. A synchronous JSON/schema decode failure thrown by `RemoteProviderService` is therefore not reliably converted to rejection of the outer Promise; it can escape as an uncaught exception.

Adding a catch/reject alone is insufficient. If a corrupt persisted record is replayed from the same cursor after every reconnect, it can create a poison-record loop that prevents later events from progressing. The fix needs explicit quarantine and cursor semantics.

No live malformed-record crash was observed during this audit. This is a confirmed code defect, not a confirmed incident cause.

### 3. Unbounded queues and PubSubs

Confirmed unbounded structures include:

- Orchestration command queue.
- Orchestration event PubSub.
- Provider service runtime event PubSub.
- Shared `makeDrainableWorker` transaction queue used by provider runtime ingestion and the provider command reactor.

Effect RPC client acknowledgements slow each subscription stream, but upstream unbounded PubSubs can continue accumulating while a slow stream waits. This exchanges direct producer blocking for unbounded memory, lag, and later catch-up work.

Live queue depth and memory growth were not available, so an actual queue overflow/OOM remains unproven.

### 4. WebSocket byte backpressure is incomplete

Effect RPC waits for a client Ack between stream chunks, which is useful. However:

- Response serialization happens synchronously.
- The underlying WebSocket send path does not expose a bounded byte mailbox to Cafe.
- There is no Cafe-level `bufferedAmount`/drain policy or per-connection byte cap.
- Independent streams compete through the same connection.

No direct live WebSocket-buffer measurement exists, so this is a confirmed missing safeguard and a plausible contributor rather than a proven incident cause.

### 5. Five-second heartbeat sensitivity explains recovery behavior

The pinned Effect RPC client sends/checks a ping on a five-second cycle. When the previous pong has not arrived, it opens the ping-timeout latch. Cafe handles that timeout by clearing tracked requests and recycling the transport session. Renderer subscriptions then resubscribe and receive a fresh snapshot plus replayable events.

This matches the observed “hang, disconnect, then recover” behavior. Extending the heartbeat may reduce reconnect flapping but will not correct event-loop starvation, unbounded buffers, or oversized work.

Relevant code:

- `apps/web/src/rpc/protocol.ts`
- `apps/web/src/rpc/wsTransport.ts`
- Pinned Effect `RpcClient.ts` (`makePinger`, five-second delay)

## Existing Mitigations That Must Be Preserved

1. Provider runtimes execute in a separate authenticated daemon process by default.
2. Daemon transport remains IPC or loopback-only with capability tokens.
3. Provider command and runtime ingestion workers catch ordinary non-interruption failures.
4. Remote daemon unary RPC calls have a 30-second timeout.
5. Effect RPC streams use client acknowledgement flow control.
6. Assistant deltas are already buffered/coalesced.
7. Shell subscriptions filter streaming assistant messages and routine activities.
8. Projected tool activity payloads are sanitized and bounded.
9. Large Codex diff events are compacted in the daemon journal.
10. Durable snapshots, cursors, deterministic command IDs, replay dedupe, and reconnect/resubscribe protect canonical state.

Any implementation must preserve event ordering, cursor durability, terminal and approval events, authenticated local boundaries, and payload-free diagnostics.

## Recommended Target Architecture

```text
provider adapter
  -> canonical raw-event compactor and size validator
  -> durable provider journal
  -> bounded/backpressured asynchronous daemon bridge
  -> bounded priority-aware ingestion lanes
  -> serialized orchestration/projection persistence
  -> one shared durable event tailer and aggregate router
  -> bounded per-connection WebSocket writer
  -> renderer
```

### P0: Bound provider events before journal and transport

Create shared compaction logic at the provider daemon boundary, before persistence and transport. It should cover command output, tool data, raw provider fields, diffs, file content, patches, and other unbounded strings/arrays.

For truncated material retain only:

- A bounded preview.
- Original byte and/or character length.
- SHA-256 hash when useful for diagnostics/deduplication.
- A truncation/compaction marker.
- Required provider, thread, turn, item, lifecycle, and status identifiers.

Define a hard maximum encoded event size and fail or compact before inserting into `provider_daemon_events`.

### P0: Replace callback NDJSON with a bounded asynchronous bridge

Client side:

- Use an async iterable or bounded record queue instead of a synchronous `onLine` callback.
- Limit pending undecoded bytes and maximum line bytes.
- Pause the HTTP response when the downstream queue is full and resume below a low-water mark.
- Process a bounded record/byte budget per event-loop turn and yield with an appropriate scheduler boundary.
- Abort/destroy the request exactly once on terminal decoding or transport errors.

Daemon side:

- Use one serialized writer per event-stream client.
- Check `response.write()` and wait for `drain` when it returns `false`.
- Page journal replay rather than materializing and synchronously writing the full retained window.
- Apply explicit queue count/byte caps.
- Disconnect only the lagging bridge client when limits are exceeded; the backend can reconnect from its durable cursor.

### P0: Add poison-record quarantine and forward progress

- Catch JSON and schema failures inside the stream transport boundary.
- Record payload-free diagnostic metadata: cursor, encoded length, schema/error category, and a bounded hash.
- Quarantine or repair the invalid record under an explicit durable policy.
- Do not repeatedly reconnect at the same undecodable cursor forever.
- Never include raw provider content in logs, UI errors, or diagnostics.

### P1: Replace per-subscription polling with one event tailer/router

- Maintain one durable backend event-store cursor/tailer.
- Read and decode each event page once.
- Route events by aggregate kind and thread ID to shell/thread topics.
- Maintain a bounded replay ring or use thread-specific durable queries for race repair.
- Preserve the existing snapshot/live race guarantee by binding the shared cursor around snapshot creation.
- Keep an occasional repair/watchdog read, not a one-second global read per subscription.

### P1: Add bounded priority-aware lanes

Protect and prioritize:

- Turn completion/failure/interruption.
- Approval and user-input requests/responses.
- Session lifecycle and errors.
- User message and steer commands.

Coalesce replaceable high-volume events by thread/item:

- Content deltas.
- Progress updates.
- Token/rate-limit updates.
- Diff updates.
- Repeated status refreshes.

Use fairness between active threads so one noisy provider turn cannot indefinitely delay another thread's lifecycle/control events. The durable journal remains the lossless recovery source; bounded memory queues should have explicit overload behavior.

### P1: Isolate each WebSocket connection's outbound work

- Use one writer fiber/mailbox per connection.
- Bound both queued event count and encoded bytes.
- Prioritize ping/pong, interrupt, Ack, unary responses, and lifecycle/control events over bulk projection data.
- Measure serialization time and largest frame size.
- Close only a lagging client with a sanitized close reason when its limit is exceeded.

This improves isolation between clients but cannot guarantee heartbeat progress during a process-wide event-loop stall.

### P1: Add payload-free diagnostics

Add metrics and diagnostic fields for:

- Event-loop p50/p95/p99/max delay.
- Provider journal event encoded bytes and compaction counts.
- NDJSON pending bytes, largest line, queue depth, oldest age, pause duration, and records/bytes per replay.
- Provider ingestion and orchestration queue depth and oldest age.
- Shared event-tailer cursor lag and page duration.
- Active shell/thread subscription counts.
- Per-connection queued events/bytes, largest frame, Ack latency, and serialization duration.
- Heartbeat RTT, timeout count, and reconnect reason.

Use bounded labels and never include prompts, outputs, tokens, credentials, unrestricted paths, or event bodies.

### P2: Reduce renderer pressure

- Batch shell events as well as thread-detail events.
- Limit events and bytes applied per animation frame.
- Yield between large recovery batches.
- Avoid O(all threads) work for every individual shell update.
- Revisit the 15-minute warm thread-subscription retention and 32-entry capacity.

### P2: Consider a thin gateway only after bounded-work fixes

A separate control WebSocket on the same JS event loop cannot guarantee liveness during CPU/event-loop starvation. If the bounded bridge, shared tailer, queue limits, and writer isolation still miss the liveness objective, move the authenticated WebSocket gateway to a separate process or worker boundary.

The gateway must remain IPC or loopback-only by default, use high-entropy capabilities, avoid secrets in argv/logs, and expose only sanitized operational diagnostics.

## Suggested Implementation Order

### Batch 1: Provider event size and daemon bridge safety

1. Add shared runtime-event compaction and a maximum encoded event size.
2. Cover command execution and raw tool/provider payloads, not only diffs.
3. Add NDJSON maximum line/pending-byte limits.
4. Catch decode errors and implement poison-record quarantine/forward progress.
5. Honor daemon response backpressure and page replay.
6. Add payload-free bridge size/lag metrics.

This batch addresses the clearest provider-action coupling and the multi-megabyte live records.

### Batch 2: Shared orchestration event tailer

1. Replace per-subscription global pollers with one shared tailer.
2. Route by shell/thread aggregate.
3. Preserve snapshot/live dedupe and repair semantics.
4. Add subscription-count-independent query-count tests.

This removes the measured 10-13 duplicate global queries per second for the observed connection shape.

### Batch 3: Bounded priority lanes and WebSocket writer isolation

1. Bound/coalesce provider ingestion and projection notification queues.
2. Protect terminal/control events with priority and fairness.
3. Add per-connection bounded writer mailboxes.
4. Add slow-client isolation and heartbeat-latency load tests.

### Batch 4: Renderer batching and optional gateway evaluation

Only evaluate process-level gateway isolation after measuring the first three batches under representative sustained provider load.

## Required Tests

### Provider compaction

- Multi-megabyte stdout/stderr/aggregated output.
- Nested tool payloads and raw provider fields.
- Large commands, patches, file content, arrays, and Unicode/UTF-8 boundaries.
- Required lifecycle/control fields preserved.
- Preview, length, hash, and truncation markers correct.
- Encoded event always remains below the hard cap.

### Daemon bridge

- Fake response returns `false`; writer waits for `drain` without reordering.
- Slow client, bounded queue, and mid-replay disconnect.
- Replay paging and durable cursor continuity.
- Split UTF-8 code points and split NDJSON lines.
- Oversized line and pending-buffer enforcement.
- Malformed JSON/schema quarantine and later-event forward progress.
- Exact cleanup and no listener/request leaks.

### Event tailer

- One global read per page/interval independent of subscription count.
- Exact snapshot/live race repair without duplicates or gaps.
- Correct shell/thread routing.
- Reconnect and cursor replay convergence.
- Slow subscriber does not block healthy subscribers.

### Load and liveness

- At least 32 retained thread subscriptions.
- Multiple active provider turns and high-rate deltas.
- Large command completions and daemon replay bursts.
- Deliberately slow WebSocket client plus a healthy client.
- Assert bounded RSS/queues, heartbeat/control latency, event-loop delay, ordering, and no loss of terminal/approval/input events.
- Assert the constant HTTP health endpoint remains responsive.

### Security

- IPC/loopback and capability authentication preserved.
- No daemon token, bearer session, prompt, output, or raw quarantined record enters logs, diagnostics, URLs, or argv.
- Lagging-client close reasons and oversize errors are sanitized.

## Verification Baseline

The following focused existing tests passed during the investigation:

1. Server WebSocket snapshot/live cursor dedupe: 1 test.
2. Provider daemon malformed adapter-event containment: 1 test.
3. Provider daemon journal cursor/replay/retention behavior: 11 tests.
4. Renderer heartbeat recovery and explicit reconnect resubscription: 2 tests.
5. Drainable worker semantics: 1 test.

Total: 16 focused tests passed.

Commands used:

```sh
cd apps/server
yarn workspace @cafeai/cafe-code test src/server.test.ts -t "filters thread subscription events already covered by the snapshot"
yarn workspace @cafeai/cafe-code test src/providerDaemon/ProviderDaemonServer.test.ts -t "keeps journaling runtime events after one malformed event"
yarn workspace @cafeai/cafe-code test src/providerDaemon/EventJournal.test.ts

cd apps/web
yarn workspace @cafeai/cafe-code test src/rpc/wsTransport.test.ts -t "recycles the websocket session when heartbeat recovery is requested|re-subscribes live stream listeners after an explicit transport reconnect"

cd packages/shared
yarn workspace @cafeai/cafe-code test src/DrainableWorker.test.ts
```

These tests validate existing recovery and durability mechanisms. They do not cover multi-megabyte command events, NDJSON backpressure, queue bounds, event-loop liveness, or subscription-count-independent polling; those are required additions above.

## Current Evidence Classification

| Finding                                                                   | Classification                                                 |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Repeated live WebSocket interruption/reconnect                            | Observed                                                       |
| All shell/thread subscriptions interrupted together                       | Observed                                                       |
| Independent five-second backend health timeouts near interruptions        | Observed                                                       |
| Multi-megabyte command completion events in live daemon journal           | Observed                                                       |
| 10-13 duplicate global event queries per second with 11-14 thread streams | Observed                                                       |
| Provider daemon `EPIPE` during incident windows                           | Observed                                                       |
| Backend process-wide unresponsiveness rather than only WebSocket failure  | Strongly supported by health endpoint behavior                 |
| Specific 2.1 MB event caused a specific disconnect                        | Correlated, not proven                                         |
| NDJSON synchronous work/replay caused some stalls                         | Plausible and strongly supported by code plus live event sizes |
| Global subscription pollers caused some stalls                            | Plausible amplifier; duplicate work directly observed          |
| Unbounded queues caused GC/OOM                                            | Not proven; queue depth and event-loop metrics absent          |
| Malformed daemon record crashed a live backend                            | Not observed; source-level defect only                         |
| Socket buffered bytes caused a disconnect                                 | Not proven; missing metric/safeguard                           |

## Resume Notes

- Start implementation with Batch 1, not with heartbeat relaxation.
- Preserve current durable journal, cursor, replay, deterministic command ID, and projection ordering semantics.
- Reuse or generalize `activityPayloadSanitizer` where appropriate, but compaction must happen before daemon journal persistence and transport.
- Keep diagnostics payload-free and transports authenticated/IPC-or-loopback-only.
- The repository already contained unrelated in-progress server/provider/telemetry and release-readiness changes during this audit. Do not overwrite or attribute those changes to this investigation.
- No production source was modified by the investigation that produced these findings.

The more detailed execution plan used during the audit is in `.plans/26-provider-websocket-decoupling-audit.md` when the local ignored plans directory is available.
