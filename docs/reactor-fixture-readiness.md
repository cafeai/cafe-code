# Reactor fixture readiness

Created: 2026-10-14 15:05:10 JST (UTC+0900)
Last updated: 2026-10-22 12:42:30 JST (UTC+0900)

An orchestration dispatch receipt proves durable intent acceptance, not provider
session opening, turn acceptance or completion of the later projection writes.
The reactor consumes the event asynchronously. Its worker drain covers admitted
work, not the subscriber's next scheduling turn or detached ACK bookkeeping.

The isolated `ProviderCommandReactor.test.ts` fixtures use the existing Effect
Deferred pattern to observe the exact fake operation's successful effect. Install
the one-use wrapper before dispatch, retain the original synthetic implementation,
and signal only after it succeeds. Then retain exact call counts and request/policy
assertions. A mock invocation alone is not the successful opening/acceptance edge.
Before manufacturing a terminal ready edge, observe that exact accepted turn's
committed running marker; a late bookkeeping write must not reopen fake idle state.
Negative admission cases still observe their exact failure activity and no calls.

An external observation fiber needs its own retirement boundary even when the
provider effect belongs to the harness. Register the exact fixture scope's
cleanup before dispatch; abort and join only its tracked observation promises
before teardown. Refuse late admission and retired continuations. Retirement
must never succeed a pending Deferred, invent provider acceptance or cancel
provider work as a substitute for observer cleanup. A refusal test closes the
real fixture scope with an uncompleted receipt, checks that the observer rejects
without completing it, and proves a later observation cannot execute its payload.

Explicit-recipient steering may fork after the outer worker drains. Positive
fixtures therefore await the original exact steer effect's successful receipt,
including thread/message/priority/native-session/turn identity, before checking
counts. Replaced-recipient negatives keep their held preparation gate and zero
provider calls; an outer drain is not proof of detached positive completion.

The same boundary applies to accepted direct steer, start-routed steer and
failed-start fallback cases. Observe the successful fake steer with its exact
thread, message, turn and numeric-policy process tuple before starting the
unchanged acceptance-activity poll. Refusal branches never await a successful
receipt; their original errors, zero/once counts and no-recovery checks remain.
When the refusal actually reaches the fake steer, observe that exact failed
effect without handling or replacing its error. Earlier owner/generation
refusals must not await a provider operation that they intentionally reject.

Control-only goal fixtures likewise observe completion of the original goal
effect before draining admitted work and starting their unchanged projection
poll. First-set and replacement operations have separate receipts; the first
cannot attest the later ordered clear/set. A subsequent unsupported turn still
requires its own capability-preparation receipt, not the completed goal's proof.
Shared send helpers route their Deferred observations through the same owned
abort/join boundary, so hard-timeout cleanup cannot leave an external observer
waiting in a retired fixture. Retirement never completes a provider receipt.

An unlocalized enclosing timeout is not evidence of a particular slow phase or
production defect. The identical-policy continuation fixture retains at most 32
fixed phase names with monotonic elapsed times and reports them only on failure.
Registration retires before later cases can append observations; no transcript,
native state, filesystem path or received error is included. These observations
do not change readiness, timers, input, retry behavior or any assertion.

When a particular refusal path requires a successful selected-account capability
read before deciding policy, its fixture may install a one-use receipt around
that exact original fake effect. Observe its successful result and exact account
first, then drain the now-admitted worker before the unchanged failure-activity
poll. Drain alone can return before asynchronous event admission, while a
capability invocation alone need not have completed successfully. This boundary
belongs only to paths that actually reach that read, not a blanket prerequisite
for failures that can reject earlier. A held exact capability gate proves zero
provider opening/submission before release and retains the original refusal
assertions afterward. It does not identify which phase caused a historical
timeout or grant a longer observer, preparation budget or enclosing deadline.

A held fixture-owned preparation gate separately proves that durable acceptance
does not open or send a provider request while preparation is blocked. Always
release that exact gate in a finalizer, then observe real fake opening/acceptance
and retain all no-competitor/no-replay/count assertions. No real provider, account,
profile or inference is used; real isolated local filesystem/SQL admission remains.

These are causal readiness boundaries, not slower-host retries or a promised
startup latency. The generic two-second state poll, server enclosing test/hook
deadlines, production preparation budgets, worker limits and native ownership
policy remain unchanged. The existing scheduled-delivery fixtures already use
this boundary; control-policy and reuse fixtures share it where they require
successful opening/acceptance before testing subsequent behavior.

The retained Windows CI failures were in initial positive mock-call polls, before
goal edits or the second reuse request. They did not identify the actual count,
failed phase, scheduler/filesystem cause or a production goal/reuse defect.
Do not infer those causes from an absent screenshot or a later generic timeout.

Use the pinned Node and Corepack Yarn to run the complete reactor file with the
existing worker policy, then all default tests and required repository checks.
POSIX agent runs use low priority (on macOS add `taskpolicy -b` after `nice -n 15`
for sustained work); Windows retains its native bounded-worker policy. The
forced desktop build remains last after all tests on unchanged source:

```sh
nice -n 15 corepack yarn workspace @cafeai/cafe-code test src/orchestration/Layers/ProviderCommandReactor.test.ts --maxWorkers=2
nice -n 15 corepack yarn verify:local
```

The complete local command defaults to three typecheck workspaces and two Node
test workspaces. It preserves the isolated POSIX Codex test tail, complete
native browser groups and the forced desktop build last; do not build it again
as redundant fixture preparation. Reduce the explicit concurrency options on a
pressured host. See [local verification](test-performance.md) for resource limits.

The complete local qualification sequence is maintained in
[visualization CI qualification](visualization-ci-qualification.md). Local macOS
passes do not qualify native Windows or hosted artifact delivery. Hosted delivery
still requires every applicable Quality/artifact/AppImage job and four exact-head,
nonempty, unexpired release artifacts; diagnostics and skipped dependencies do not
qualify releases. No AppImage launch/smoke phase is inferred from build/upload.

Preparation-backoff integration tests observe the original controlled clock sleep registering before advancing it. The exponential schedule/cap is a separate pure decision table; integration tests cover actual retry and Stop without replaying the whole cap table through SQLite. Checkpoint fixtures subscribe to their exact engine before dispatch and await its ordered event queue, rather than rescanning all historical events every polling turn.
