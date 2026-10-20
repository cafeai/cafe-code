# Complete local verification

Last updated: 2026-10-20 17:54:42 JST (UTC+0900)

Use the pinned standalone Node and Corepack Yarn. Dependencies and the native
Chromium test browser must already be installed through the existing locked
setup. This command needs no GitHub runner, cloud service or provider account:

```sh
nice -n 15 corepack yarn verify:local
```

For sustained work on macOS, use `nice -n 15 taskpolicy -b corepack yarn
verify:local`. Windows uses `corepack yarn verify:local` without POSIX priority
commands. Niceness does not bound memory or GPU work. Typechecking defaults to
three workspaces; the Node test graph defaults to two independent workspaces,
with at most two Vitest workers in each. Native browser groups and builds stay
sequential under their existing context, heap and deadline policy. The runner
does not stop an existing app or provider.

Use a smaller typecheck admission limit on a constrained development machine:

```sh
nice -n 15 corepack yarn verify:local --typecheck-concurrency=1
```

Exact values `1`, `2` and `3` are accepted once. This override changes only local
typechecking, not Node/browser test workers or build concurrency. The default is
three in both the local coordinator and canonical `yarn typecheck` used by CI
and release. Each compiler retains its 4 GiB JavaScript heap ceiling; three
ceilings can reach 12 GiB plus native/OS allocations, not an aggregate memory
guarantee. Smaller runners still need native hosted qualification. A larger heap
alone does not add CPU parallelism, and no option guarantees a timing target.
See the [scheduling decision](decisions/three-slot-typechecking.md).

Node tests can separately use one, two or three simultaneous workspaces:

```sh
nice -n 15 corepack yarn verify:local --typecheck-concurrency=3 --test-concurrency=3
```

Both options may appear in either order, once each. Use `--test-concurrency=1`
on a constrained host. Two workspaces permit up to four Vitest workers in total;
three permit up to six, plus runner/coordinator processes. These are scheduling
limits, not an aggregate RAM ceiling. Leave memory headroom for the operating
system, Cafe and providers, and reduce concurrency if the host shows pressure.
The server keeps isolated forks and serial file execution inside its workspace;
this option does not permit sharing database connections, ports or mutable
fixture state. Browser and build stages do not overlap the Node stage, and their
worker limits do not change. CI retains its existing host-specific test scheduling.
On macOS/Linux, the canonical copied-native Codex client phase still runs alone
after all other Node workspaces close. The local concurrency option applies to
the preceding complete complementary graph, not across this isolation boundary.

## Compiler setup

After installing the pinned dependencies, run `corepack yarn prepare` to apply
the repository's existing Effect compiler patch. Dependency lifecycle scripts
remain disabled; the verification command does not install tools or enable
arbitrary install scripts. The local compiler preflight qualifies an actual
Effect-only error and a clean control through both installed TypeScript API and
CLI behavior before typechecking; upstream `check` returning zero alone is not
proof that the compiler is patched.
CI explicitly runs the same supported `corepack yarn prepare` and actual
`scripts/qualify-effect-compiler.ts` API/CLI probe before its canonical complete
typecheck; release reuses that gate. Yarn's install lifecycle does not run
`prepare`, so `install --immutable` alone cannot attest Effect injection.
Dependency install scripts remain disabled. The probe retains its sequential
4 GiB/30-second child limits, and canonical typechecking retains three-task
admission with the existing step-scoped heap setting.
The preflight also binds both full installed compiler entries to the reviewed
same-version FIFO injection; stale or partly injected entries refuse before
compilation even if an older diagnostic probe would still pass.

The pinned language service has a reviewed same-version Yarn patch replacing
append-only AST queues' repeated array shifts with an indexed FIFO. Ordering,
pruning, early returns and diagnostic rules are unchanged; consumed references
are released. Its explicit qualification command is:

```sh
nice -n 15 taskpolicy -b corepack yarn exec node scripts/qualify-effect-language-service-queues.ts
```

Omit `taskpolicy -b` outside macOS. The command constructs private original and
patched compiler copies, compares complete ordered API diagnostics and actual
CLI output on bounded inert wide/deep inputs, and retains failures. It never
patches the installed compiler or launches a provider. Timings are informational,
not diagnostic-equivalence assertions. `corepack yarn prepare` uses the supported
`patch --force` operation, which reverses existing injection metadata before
reapplying the pinned implementation to both compiler entries. This also handles
same-version patch updates; an existing version marker alone is not adoption
proof. The explicit equivalence qualifier compares both complete installed
compiler hashes with its independently rebuilt indexed copies before success.

When deliberately updating TypeScript or the language service, review whether
the FIFO patch is still needed before porting it. Update the qualifier's exact
upstream/version/patch bindings from reviewed package bytes, install the locked
dependencies with scripts still disabled, and run explicit prepare. Require the
paired API/CLI equivalence and installed-adoption check before refreshing the
normal preflight's full compiler hashes from that receipt. Never copy a hash
merely to silence a refusal. Retire old generated build-info, run fresh compiler
behavior probes and the complete type/test/build qualification. Keep previous
failure/equivalence evidence; a new version marker is not proof of equivalence.

Local complete typechecking uses the same discovered workspace programs, exact
`tsc --noEmit` arguments and qualified installed TypeScript entry. It schedules
one, two or three direct compiler children without Turbo's unnecessary dependency
ordering for these no-output programs. Unsupported or missing workspace/compiler
contracts fail explicitly instead of omitting coverage. Cancellation fences the
queue before signalling only held children, then joins their native close;
ordinary compiler failures continue collecting the remaining diagnostics.
With multiple slots, the known expensive Codex and server programs are admitted first;
all other programs retain discovery order. These are scheduling hints only, not
stored timings, results or a selection rule. Every discovered program still runs,
and a hint does not guarantee faster execution on a different machine.
The canonical `yarn typecheck` retains the complete Turbo dependency graph, capped
at three tasks. Turbo dependencies may keep fewer than three compilers busy.
Do not append another concurrency flag to that package script: Turbo refuses
duplicates. To run that same graph serially, use `corepack yarn exec turbo run
typecheck --concurrency=1` with the same scoped heap setting.
Manifest reads require a bounded regular file. On POSIX, no-follow and
nonblocking descriptor admission prevent a substituted named pipe from stalling
before the file-type check; Windows retains its existing native path. This is
invalid-input handling in a source-owned checkout, not a hostile same-user
sandbox. The opt-in native fixture checks actual FIFO refusal in a disposable
Node child, so a regression cannot block the test runner's filesystem workers.

Server typechecking no longer roots `scripts/lib/*.test.ts` a second time; the
scripts workspace still checks every one of those tests with the same compiler
options. Server source, integration tests and imported production helpers remain
covered. Compiler output prefixes each line with its owning workspace and reports
monotonic completion times, including failing workspaces; a bounded streaming
line buffer preserves UTF-8 across native output chunks.

The direct coordinator's native cancellation qualification uses only inert,
test-owned Node children and is explicit opt-in:

```sh
CAFE_CODE_LOCAL_TYPECHECK_E2E=1 nice -n 15 taskpolicy -b corepack yarn exec vitest run --config vitest.config.ts scripts/local-typecheck.e2e.test.ts --maxWorkers=1
```

It waits for exact authenticated readiness before cancelling, joins both child
closes and rejects queued work and a late zero exit. It does not launch providers
or interrupt user processes. Omit `taskpolicy -b` outside macOS.

After changing TypeScript, Effect/compiler-patch versions or their diagnostic
configuration, retire the corresponding generated `.tsbuildinfo` files and do
a fresh typecheck. Preserve them if needed for diagnosis; these are generated
compiler metadata, not app data. A fresh compiler probe does not attest the
provenance of older semantic caches. Existing TypeScript incremental behavior
and Turbo's uncached typecheck policy otherwise remain unchanged.

Do not enable incremental checking for additional programs merely as a speed
shortcut. A real compiler experiment found that changing only an Effect
diagnostic's severity could retain the older severity in a warm semantic cache,
while a fresh program reported the new configuration. The existing explicit
metadata-retirement requirement is therefore meaningful; exit zero from a
separate compiler probe cannot qualify unrelated cached diagnostics.

## What executes

The runner checks formatting, lint/interface-language consistency and repository
policy, checks the complete type graph, runs the complete default Node test
graph, then runs complete local browser qualification. The forced desktop build
is last. Any failed or cancelled child stops the sequence; process exit alone
does not admit the next step before its stdio closes. A cancelled child returning
zero still fails verification.

`yarn test` retains its existing complete default meaning. Neither command uses
affected-file selection or cached test results. Opt-in GPU stress, registry soak,
live providers, native packaged smoke and release signing/notarization remain
separate qualifications, not silently included or claimed by this command.

For browser-only iteration:

```sh
nice -n 15 corepack yarn test:browser:local
```

This discovers ordinary browser files using the installed Vitest glob engine
and the same declarative include policy as the native browser config. New
ordinary files are included automatically. Specialized touch, ordinary-motion,
reduced-motion, Mermaid security/family, export and inline groups have distinct
owners; missing or overlapping filename selections fail rather than silently
omit or duplicate work. Existing worker limits and separate native contexts
remain unchanged. `test:browser:ci` still selects the existing host-specific CI
domain and performs its existing full fixture build.

Local browser preparation builds only the three shipping MCP bridge entry
configurations into a fresh private temporary directory. The copied-bridge E2E
uses that exact directory. Source-rendered browser tests do not need an earlier
full desktop bundle. Preparation does not substitute a mock bridge or weaken
the required final forced build. Temporary-directory identity is checked before
compilation and retirement; successful scopes atomically transfer it to a fresh
private quarantine and validate its identity before cleanup. Failures or
cancellation retain artifacts at the printed temporary path, because direct
command closure alone does not prove every descendant retired. Observed
replacement is retained instead of deleted. This private source-owned fixture
is not protection against malicious same-user changes to the runner/quarantine.

## Work reduction, not reduced coverage

ChatView feature suites contain their actual journeys instead of importing one
conditional mega-module. Their fixture hooks, live mutable state, input, waits
and assertions remain shared only within each isolated suite.

Policy-only ChatView journeys can explicitly request essential history: the
unchanged target user/assistant pair and unchanged tail pair, in original
chronological order. Full history remains the default for scrolling, geometry,
pagination, history reconstruction and message-count tests. This reduces inert
timeline input; it does not cache a mount or remove native actions/assertions.

SQL feature fixtures build a bounded immutable binary seed from the current
real migrations once per isolated module. Every runtime opens a new in-memory
database and deserializes its own writable copy before creating statements or
client caches, then restores connection-local foreign-key and busy-timeout
policy. Seeds are at most 16 MiB, never persisted, and refuse active source
transactions and unsupported virtual tables. Migration tests still execute real
migrations. Native fidelity tests cover independent writes, generated columns,
hidden rowids, indexes, triggers, views, sequences, metadata, deferred constraints,
rollback and exact scoped close; the logical SQL snapshot remains an independent
comparison path. No mutable database or successful result is shared.

The command-reactor fixture supplies a stateless non-repository identity
resolver for its synthetic project. Snapshot reads therefore do not spawn
unrelated Git discovery commands. The checkpoint fixture also omits only remote
identity decoration from its projection reads; actual checkpoint capture,
restore, refs and worktree operations still execute real Git. Dedicated
repository-identity tests retain the real resolver. Fresh databases and reactor
scopes are not shared or cached.

Mermaid family qualification is split by rendering, transport, parsed data,
output and pre-parser allocation responsibilities. Each actual probe still
mints its own nonce, invocation, opaque document, port and parser realm. Only
immutable engine/receiver instrumentation segments are prepared once per
isolated module; source, admission and render results are never reused.
The complete MermaidSecurity suite remains separate and unchanged.

The final local build may reuse compressed representations of identical public
static assets in `.logs/local-asset-compression`. This is opt-in **input reuse**,
not a previous build success: Vite/backend/desktop compilation still runs with
`--force`. The key binds raw bytes, runtime/codec versions and exact maximum
compression settings. Both representations must bounded-decompress to the
current bytes before reuse. A bad, missing, busy or unavailable cache falls back
to ordinary serial compression; release compression quality is unchanged.

The compression cache is bounded, never stores app/provider data and is not
published in `dist`. Entries are not automatically evicted: stale/full caches
stop gaining entries and misses recompress normally. Uncertain files and stale
writer leases are not deleted automatically. On platforms where private cache
ownership cannot be established, compression runs normally without reuse.
No CI/release workflow enables this local cache.

## Timing and interpretation

Every child prints its wall time. Vitest timing-only reports under
`.logs/test-timings/` retain relative source labels, module/test states, terminal
run reason and error counts, never received error values, console contents,
environment or credentials. Collection and test durations help rank costs;
summed concurrent durations are not wall time. Browser `prepareDuration` can
include reused-page uptime and is deliberately omitted.

The ten-minute complete-local goal is a target, not a guaranteed deadline.
Report the actual complete duration, source/runtime and warm/cold input state.
An installed/warm checkout is not a fresh setup, a cache hit is not executed
test coverage, and an incomplete run is not a speed improvement. Do not add
retries, omit meaningful assertions, raise limits beyond the explicit local
options or weaken isolation to meet a timing budget. See the [local verification decision](decisions/complete-local-verification.md)
and [test-suite policy](test-suite-policy.md).
