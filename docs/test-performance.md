# Complete local verification

Last updated: 2026-10-28 10:42:43 JST (UTC+0900)

Use the pinned standalone Node and Corepack Yarn. Dependencies and the native
Chromium test browser must already be installed through the existing locked
setup. This command needs no GitHub runner, cloud service or provider account:

```sh
nice -n 15 corepack yarn verify:local
```

For sustained work on macOS, use `nice -n 15 taskpolicy -b corepack yarn
verify:local`. Windows uses `corepack yarn verify:local` without POSIX priority
commands. Niceness does not bound memory or GPU work. Typechecking defaults to
three workspaces. By default the Node phase uses the complete bounded local mode
with two workspace owners, at most two Vitest workers per workspace, and eligible
exact-input per-workspace reuse. The server and scripts workspaces each hold an
exclusive barrier from cache admission through execution and final rechecks;
other workspaces can overlap within the selected limit. `--fresh` disables
receipt reuse but retains these barriers. This is local scheduling, not CI parity. Select
`--test-concurrency=ci` to run the unchanged host-specific canonical CI Node plan
fresh, including its native runner worker policy. Native browser groups and builds stay
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

To choose one, two or three simultaneous local Node workspaces explicitly:

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
worker limits do not change. CI retains its existing host-specific test scheduling. Use
`--test-concurrency=ci` to select that exact fresh Node plan locally; no option
claims to reproduce another host's resources. See the
[scheduling decision](decisions/bounded-local-node-scheduling.md) for the cache
boundary and qualification limits.
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
With local result reuse enabled, every discovered program must either execute
or reuse an exact admitted prior success, with that distinction printed. The
canonical `yarn typecheck` retains the complete Turbo dependency graph, capped
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

`yarn test` retains its existing complete uncached default meaning. `verify:local`
discovers the complete task set and can reuse qualified local exact-input success
receipts as described below; it is not affected-file selection. Opt-in GPU stress, registry soak,
live providers, native packaged smoke and release signing/notarization remain
separate qualifications, not silently included or claimed by this command.

## Local result reuse and fresh replay

By default `verify:local` can reuse unchanged eligible workspace typechecks, workspace Node
tasks and whole existing browser groups from a private checkout-bound directory
under the canonical OS temporary directory on qualified POSIX storage. OS cleanup
causes a cold run; unsafe home/checkout permissions are never changed to enable
caching. Each hit explicitly says it reused a prior successful
task and did not execute it freshly. It does not restore a browser realm, test
state, provider session or application database. The first run must populate
these receipts by actually completing tasks; old logs are never imported.

For those eligible local POSIX tasks only, the inherited terminal-operation
tracing field `CODEX_TOOL_CALL_ID` is removed from the actual frozen native child
environment before it is fingerprinted. A new terminal tool call must not make
this irrelevant caller identifier defeat otherwise identical local checks.
This is not a hash-only omission: execution and fingerprinting use the same
prepared environment. Explicit browser-step overrides remain literal. No other
field is discarded, including similarly named fields; unsupported hooks/selectors,
disabled/cheap/unknown tasks, `--fresh`, hosted CI/release and Windows retain their
original environment. Caller `process.env`, providers and profiles are untouched.

Fixed local-cache diagnostics distinguish pre-execution, reuse recheck and
post-execution input admission, including content-key versus native-fence drift.
Node failures separately report whether the exact executor fulfilled; a printed
child duration alone is not success proof. Fingerprint refusal categories are
content-free: raw environment, paths, hashes and received errors are not logged.
Diagnostic observers cannot alter admission, equality or cancellation gates.

Repeated producer instances share at most sixty-four process-local native-tool
digests. Each reuse requires the exact canonical path and complete current
native file identity, followed by the ordinary named recheck and final change
fence. Source text, environment, open handles and successful task results are
not shared by this memo; changed tools must be read again. This avoids repeated
byte hashing of an unchanged large Node executable without increasing buffers,
workers, heaps or deadlines. It does not establish a historical timeout's cause
or replace actual cold/warm task-result qualification.

Fingerprint fixtures retire new IO admission and drain their exact admitted
observations before removing private files or resetting native-observation
mocks. Native Git fixtures likewise join their owned children. The fixed macOS
`xcrun --find git` lookup also joins its exact native `close` after the original
callback result, including abort/error paths, under its unchanged invocation
limits. A callback rejection does not prove that child has retired. Failure-only
phase ledgers retain bounded fixed categories and finite counts/times, not paths,
argv, environment, output or received errors. Independent invalidation, template
and hook contracts have independent fixtures; their per-case deadlines and real
native controls remain in force, not a single shared aggregate time guarantee.
Input-policy fixtures do not depend on an installed Xcode metadata service. On
macOS they bind a fixture-owned developer tree and route only that owner's exact
fixed metadata request to `/usr/bin/printf` with a fixed `%s\n` format, retaining
the original environment, abort signal, limits and actual child-close join. The
synthetic path remains data, including percent signs; exact bytes and close counts
are checked for valid and malformed metadata. This avoids repeatedly starting Node
only to print that inert path. The production lookup remains unchanged. Native file,
selected-tool and null-device identity checks still run; malformed or foreign
metadata must refuse without authenticating or publishing a receipt. This is
synthetic metadata qualification, not evidence about the host's selected SDK.
The fixture also routes only its live owner's exact
`/var/db/xcode_select_link` observations to a real private temporary symlink,
modeling only the root-owner uid scalar. A valid default macOS toolchain need
not have that global selector entry. Missing, unowned and regular-file selector
negatives still refuse before the metadata child starts; native bigint/type,
selected-tool byte, held-descriptor, null-device and lifetime checks remain in
force. The host selector is never created or changed. Production selection
admission is unchanged and falls back to fresh verification when unsupported.
The independent fixed-command/argument/options and callback-versus-close
controls retain the real production lookup contract unchanged.
Independent synthetic output writes use small fixed batches, with every native
write individually owned and the whole batch joined before the next real input
snapshot. This changes only fixture IO scheduling: no observation is fabricated,
and a rejected batch still drains its admitted writes before private-root cleanup.
Qualified Yarn-wrapper fixtures overlap only their two independent preparation
chains. Each chain retains its original directory, file-write and mode-change
order; both whole chains and every native metadata operation are owned and
drained before root removal, including the later executable-mode mutation.
Entry-name and mode controls retain both real snapshots within their original
per-case deadline. Fixed failure-only phases distinguish base setup, wrapper
preparation and snapshots without attributing an unobserved historical delay.
Null-device timestamp invariance is checked through the canonical pure identity
policy and a full native input-admission control; device replacement negatives
retain the actual held/named/final checks. This is policy-plus-consumer evidence,
not a claim of two complete end-to-end inventory executions in that one case.

The eligible server Node lane uses exact checked-in Git defaults so a result
cannot silently depend on changing global/system config, default templates or
per-user attributes/ignore files outside the input scope. Its frozen prepared
environment is both fingerprinted and executed. The producer independently
requires the finite include-free config, dot-only template and actual native
null-device identity. Repository-local settings/hooks and explicit per-case
overrides remain effective in synthetic repositories. Unknown ambient Git
selectors or runtime preload/library hooks run unchanged and fresh; no real Git
profile is read, copied or changed. Other workspaces, `--fresh` and canonical
CI/release keep their original environment.
The null-device identity excludes ordinary I/O timestamps, which can change
without replacing the device; held/named/final namespace and device checks still
apply. This does not weaken ordinary source/tool file-change detection.

Input admission is not free. The local session limits reuse to the expensive
server Node task in bounded local mode, server/Codex typechecks, ordinary desktop/touch group and the two
Mermaid security/family groups. Short and unknown task lanes run fresh without
fingerprinting or receipt IO, because conservative input validation can cost
more than executing them. All discovered programs/files/groups remain required;
this policy never removes coverage or changes native inputs, workers or budgets.
The eligibility policy is separate from input validity and should be reviewed
when observed costs change, not tuned through elapsed-time test assertions.
Web types bypass reuse rather than paying input admission for a known conservative
miss: their broad source include overlaps omitted screenshot output namespaces.
The explicit `--test-concurrency=ci` Node graph runs fresh; a server-only receipt
cannot attest that graph or silently remove a workspace from it. Type/browser
receipt policy is unchanged. The bounded local default may reuse an eligible
server result only after its exact input and ownership checks pass.

```sh
nice -n 15 taskpolicy -b corepack yarn verify:local --fresh
```

Omit `taskpolicy -b` outside macOS. `--fresh` bypasses result reads AND writes,
can be combined once with either concurrency option, and retains the complete
uncached Node graph under the selected schedule. Formatting, lint, audit, actual Effect compiler
qualification, private bridge preparation/copied-artifact checks and the final
forced desktop build always execute fresh, even when every eligible task hits.
CI/release entrypoints never enable this cache; hosted environments refuse it.
Standalone `test:browser:local` remains fresh unless the explicit
`--reuse-local-results` option is supplied.

Keys bind actual source/configuration/dependency/tool bytes, task arguments,
workspace/root, selected group, platform and effective environment. Source
inventories include relevant new/untracked files and deletions, not just Git
status. The input policy lives in `scripts/lib/local-verification-inputs.ts`:
cross-workspace imports and explicit filesystem-read contracts matter. Browser
inputs are deliberately conservative because global CSS/compiler dependencies
can cross test-file boundaries; changing one browser file may invalidate other
browser groups. A browser-only repair can still reuse unchanged Node workspaces.
Changing input-policy/runner code, lockfiles, installed tools, patches or relevant
configuration invalidates affected results. Known generated Yarn shim paths are
represented only after binding their complete current bytes in an owner-controlled,
non-group/world-writable directory; read-only public tool wrappers do not relax
private receipt-storage permissions. Arbitrary environment or PATH changes are
never discarded. No raw environment values enter receipts.
This includes the exact qualified `yarn`/`node` entries referenced by
`npm_execpath`/`npm_node_execpath`, not just `BERRY_BIN_FOLDER` and `PATH`.
Their complete forwarding bytes, literal arguments and file modes remain bound;
entry names remain distinct and external aliases do not normalize. Actual native
paths remain change-fenced. Lifecycle and working-directory metadata stays
literal, so a direct subcommand is not automatically an equivalent warm replay
of the full `verify:local` invocation.

Before a POSIX local type program launches freshly, including `--fresh` and an
unavailable receipt store, retire only recognized default
`tsconfig.tsbuildinfo` through held-file checks and a fresh private quarantine.
This prevents old semantic metadata from hiding changed Effect diagnostics.
Unknown, malformed or uncertain files are preserved and qualification refuses;
custom build-info locations are not granted reusable success or automatically
removed. `--fresh` bypasses the new result receipts, not every compiler-internal
optimization. Actual compiler arguments and diagnostic rules stay unchanged;
Windows retains its existing launcher. Ignored generated outputs do not
change a source-directory fence, including when test screenshots or tool-temp
directories are first created. Only the producer's explicit known output paths
are omitted; selecting an excluded output as an import, type root or source-link
target refuses reuse. The same declared workspace-output roles qualify ancestor
envelopes before outputs exist: broad compiler includes, ambient roots and
directory aliases overlapping them run fresh rather than attest a smaller
filtered program. This also covers observed workspace-shaped source directories
without manifests; installed dependency payloads remain bound separately.
Bounded relevant-name inventories still bind
additions/deletions, and selected files retain native content/change checks.
These observations are not an atomic filesystem snapshot or a defense against
malicious same-user transient edits while verification is running.

Vitest's installed `node_modules/.vitest-cache` is a declared generated
module-transform output, including when first created or rewritten by a parallel
workspace. Same-named ordinary source/dependency data and custom cache paths
remain bound. Result-receipt authentication does not authenticate Vitest's
transformed cache payloads or prove their provenance; this retains the pinned
runner's existing trusted-local behavior. `--fresh` bypasses result receipts,
not Vitest's own transform reuse.

Failed, cancelled, partially completed or uncertain tasks do not publish. Input
drift during qualification refuses its result; corruption, unsafe ownership,
unsupported input scopes or cache IO failures cause fresh execution, not skipped
coverage. Prior completed tasks may survive a later graph failure. A reused
result is prior local evidence, not a fresh host-health/GPU/installed-provider or
release check. To diagnose nondeterminism, use `--fresh`.

Receipts are bounded, private, authenticated, immutable and never remotely shared.
The cache does not defend against malicious same-user code replacing the verifier
or reading its key. Unknown/stale namespaces and crashed writer leases are not
automatically deleted; they disable writes rather than authorizing lock stealing.
Windows deliberately falls back to fresh execution until equivalent native ACL
admission is qualified. No timing guarantee is implied. See the
[partial successor decision](decisions/verified-local-result-cache.md).

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

## Compiler responsiveness during native input

Babel's asynchronous entrypoint still runs synchronous React compiler passes on
the Vite coordinator. Cold compilation for one file must not occupy another
file's native input deadline. Each active browser project's awaited global setup
prepares the actual selected specifications in that same client environment,
following its public import graph to a bounded complete closure. Transform errors
propagate; Vite's failure-swallowing convenience warm-up and one-shot idle finder
are not completion receipts. The preparation does not evaluate modules.

Only inert compilation moves before test bodies. Fixture mounting, provider
opening, native acquisition, locator queries, input and lifecycle readiness stay
in their original scopes. There is no native utility warm-up, new worker,
persistent cache, compiler/filter change, test-selection change or longer action
deadline. The original application Vite/compiler configuration is unchanged.
Preparation uses ordinary current in-memory transform results, never cached test
success. A fresh graph walk owns each invocation and fails on missing results or
finite-bound overflow. Initial-run qualification does not promise that watch-mode
edits or runtime-computed imports cannot introduce later cold compilation.
Cancellation received after setup registers fences further admission and joins
the current transform; Vitest's public observer does not replay cancellation
already issued before registration. Walk bounds do not cap allocations inside
the existing compiler or Vite's own background preprocessing. Real Vite fixtures retain held
transitive loading, cycles, changed-source failure and owned server retirement;
native/full qualification remains required.

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
output and pre-parser allocation responsibilities. Complete local qualification
serializes these files with `--fileParallelism=false`, retaining the two-worker
cap, all files and unchanged native budgets. macOS CI also serializes only this
family group; Windows/Linux CI and all other groups retain their scheduling.
This bounds overlapping startup without establishing a historical timeout's
cause. Each actual probe still mints its own nonce, invocation, opaque document,
port and parser realm. Only
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
