# Reactor fixture readiness

Created: 2026-10-14 15:05:10 JST (UTC+0900)
Last updated: 2026-10-14 15:05:10 JST (UTC+0900)

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
existing Windows worker policy, then all default tests and required repository
checks. The forced desktop build remains last after all tests on unchanged source:

```sh
corepack yarn workspace @cafeai/cafe-code test src/orchestration/Layers/ProviderCommandReactor.test.ts --maxWorkers=2
corepack yarn test --force --concurrency=1
corepack yarn build:desktop --force
```

The complete local qualification sequence is maintained in
[visualization CI qualification](visualization-ci-qualification.md). Local macOS
passes do not qualify native Windows or hosted artifact delivery. Hosted delivery
still requires every applicable Quality/artifact/AppImage job and four exact-head,
nonempty, unexpired release artifacts; diagnostics and skipped dependencies do not
qualify releases. No AppImage launch/smoke phase is inferred from build/upload.
