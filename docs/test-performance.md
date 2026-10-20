# Complete local verification

Last updated: 2026-10-20 09:06:20 JST (UTC+0900)

Use the pinned standalone Node and Corepack Yarn. Dependencies and the native
Chromium test browser must already be installed through the existing locked
setup. This command needs no GitHub runner, cloud service or provider account:

```sh
nice -n 15 corepack yarn verify:local
```

For sustained work on macOS, use `nice -n 15 taskpolicy -b corepack yarn
verify:local`. Windows uses `corepack yarn verify:local` without POSIX priority
commands. Niceness does not bound memory or GPU work. Typechecking defaults to
one workspace; the Node test graph defaults to two independent workspaces,
with at most two Vitest workers in each. Native browser groups and builds stay
sequential under their existing context, heap and deadline policy. The runner
does not stop an existing app or provider.

On a larger development machine, opt into two simultaneous workspace compilers:

```sh
nice -n 15 corepack yarn verify:local --typecheck-concurrency=2
```

This changes only local typechecking, not Node/browser test workers, build
concurrency or CI. Each compiler retains its 4 GiB JavaScript heap ceiling;
native allocations are additional, so this is not a total 8 GiB process budget.
Keep the serial default on memory-constrained machines. A larger heap alone
does not add CPU parallelism, and neither option guarantees a timing target.

Node tests can separately use one, two or three simultaneous workspaces:

```sh
nice -n 15 corepack yarn verify:local --typecheck-concurrency=2 --test-concurrency=3
```

Both options may appear in either order, once each. Use `--test-concurrency=1`
on a constrained host. Two workspaces permit up to four Vitest workers in total;
three permit up to six, plus runner/coordinator processes. These are scheduling
limits, not an aggregate RAM ceiling. Leave memory headroom for the operating
system, Cafe and providers, and reduce concurrency if the host shows pressure.
The server keeps isolated forks and serial file execution inside its workspace;
this option does not permit sharing database connections, ports or mutable
fixture state. Browser and build stages do not overlap the Node stage, and their
worker limits do not change. CI retains its existing host-specific scheduling.

## Compiler setup

After installing the pinned dependencies, run `corepack yarn prepare` to apply
the repository's existing Effect compiler patch. Dependency lifecycle scripts
remain disabled; the verification command does not install tools or enable
arbitrary install scripts. The local compiler preflight qualifies an actual
Effect-only error and a clean control through both installed TypeScript API and
CLI behavior before typechecking; upstream `check` returning zero alone is not
proof that the compiler is patched.

After changing TypeScript, Effect/compiler-patch versions or their diagnostic
configuration, retire the corresponding generated `.tsbuildinfo` files and do
a fresh typecheck. Preserve them if needed for diagnosis; these are generated
compiler metadata, not app data. A fresh compiler probe does not attest the
provenance of older semantic caches. Existing TypeScript incremental behavior
and Turbo's uncached typecheck policy otherwise remain unchanged.

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

The command-reactor fixture supplies a stateless non-repository identity
resolver for its synthetic project. Snapshot reads therefore do not spawn
unrelated Git discovery commands. Actual repository-identity and checkpoint
tests keep their real filesystem/Git qualification; fresh databases and reactor
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
