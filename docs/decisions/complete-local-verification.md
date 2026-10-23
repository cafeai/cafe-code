# Decision: complete local work reduction without result-cache authority

Decision status: Accepted within the authorized local implementation scope
Created: 2026-10-20 08:25:58 JST (UTC+0900)
Last updated: 2026-10-22 22:55:23 JST (UTC+0900)
Decision authority: implementation discretion under the human's request to focus
on local test-performance improvements; no hosted or publication-policy change.
Implementation status: Implemented; the qualification procedure and evidence limits
below apply to each resulting source state. Acceptance alone does not attest a pass.
Supersedes: None. Existing isolation, required coverage and final-build rules remain.
Superseded in part by: [three-slot typechecking](three-slot-typechecking.md),
only for typecheck default/allowed admission and its CI scope. The historical
one/two-compiler rationale below is retained. Also superseded in part by
[exact-input local result reuse](verified-local-result-cache.md), only for the
prohibition on local test/typecheck success caching. Historical rationale below
is preserved; CI/release, resource, coverage and final-build rules remain active.

## Context and alternatives

Long local runs pay for repeated full preparation, conditional mega-module
imports and single-file native qualification bottlenecks. More hosted shards do
not help a contributor's machine. Unbounded local workers or sharing mutable
server/browser state would conflict with existing memory/ownership guarantees.
Affected selection and cached success would require a separate input-closure
and policy review and would not reduce the complete suite's actual work.

## Decision

Provide an opt-in complete local orchestrator. Keep all required local Node and
browser domains, bounded independent workspace admission, existing native context
boundaries and a forced final desktop build. Use disjoint positive browser file selection
derived from canonical declarative policy rather than CLI exclusions that nested
projects may not inherit. Prepare only the real shipping bridge configurations
needed by copied-artifact tests in an exclusively owned temporary namespace.

Split large test modules semantically without removing their assertions or
sharing mutable state across isolated files. Reuse immutable test document
instrumentation, never parser realms, ports, sources or render outcomes.

Keep feature-database seed reuse in memory and per isolated module. Build it
from actual current migrations, bound it to 16 MiB and committed supported
schema state, then deserialize a separate native database for each runtime
before statements exist. Restore connection-local PRAGMAs, preserve exact
scope-owned close, and retain real migration and independent fidelity tests.
No connection, transaction, disk snapshot or passed outcome is shared. Explicit
policy-only ChatView fixtures may retain just the original target and tail
pairs; full-history journeys remain the default and all original actions and
assertions still execute.

Permit optional bounded local reuse of public-asset compression input. Raw-byte
identity, actual runtime/codec versions and unchanged compression settings bind
the cache key. Every hit must reproduce the current raw bytes through bounded
decompression. Do not cache test/typecheck/native/security success. A forced
build still compiles current source.

## Security, failure and resource consequences

Unsafe/corrupt/missing input-cache entries are misses, not acceptance. Cache
publication is exclusive and ownership-checked; uncertain namespaces are not
removed. Quotas bound growth, expired/full caches lose write eligibility, and
unavailable platform ownership evidence falls back to fresh compression.
No remote content, private provider data or arbitrary received errors enter
the cache/timing reports. Failed/cancelled browser callbacks retain artifacts;
successful scopes retire them into a fresh private quarantine and verify the
transferred inode before cleanup. This source-owned namespace does not claim
defense against a malicious same-UID actor rewriting source/private artifacts.
No installed provider, production profile, permission,
sandbox, process ownership or release trust boundary changes.

Child completion joins direct-command stdio close and retains parent cancellation
even when a child exits zero. It does not attest arbitrary descendant-tree
retirement. No failed/cancelled run advances to the final build. The
compiler's existing qualified heap ceiling stays scoped to typechecking.
Following the human's request to consider higher local concurrency, an explicit
bounded option permits two workspace compilers at that same per-compiler ceiling
on a suitable development host. Typechecking defaults to one workspace. The
human subsequently explicitly requested two-to-three concurrent test workspaces
where independent: the local Node graph now defaults to two, with an explicit
one/two/three option. Each workspace retains at most two Vitest workers; server
files remain serial in isolated forks. This can admit four or six test workers
in total, plus coordinators, and is not a hard aggregate memory guarantee.
Browser providers/media groups remain sequential, builds stay at concurrency
one, and no stage overlaps the next. CI and all test deadlines are unchanged.
The established POSIX copied-native Codex test tail remains an isolated final
Node phase, never overlapping the other workspaces.

For local no-output type programs, discover the same workspace metadata through
pinned Corepack Yarn, reject unsupported scripts/aliases/compilers, and schedule
direct pinned Node/TypeScript children at the finite chosen limit. This removes
unnecessary dependency ordering without trusting a Yarn wrapper to fence queued
work on cancellation. The canonical Turbo typecheck remains unchanged. Refuse
unsupported future workspace contracts rather than silently losing programs.
Remove duplicate scripts/lib test roots from the server program only; scripts
retains their complete coverage under the same compiler options. Imported server
helpers and every server/integration test remain server roots. Prefix direct
compiler diagnostics with exact workspace ownership and retain bounded UTF-8
streaming output plus all failure status, not only successful durations.

The same-version language-service dependency patch changes only audited
append-only AST FIFO implementation, preserving breadth-first visitation and
clearing consumed references. Require original-versus-patched actual API/CLI
diagnostic equivalence on bounded private copies; no rule is disabled and no
diagnostic success is cached. Narrow documented native API exceptions preserve
existing no-follow/bigint filesystem and native callback lifetime semantics where
Effect services do not provide equivalent operations.
Force the supported patch reinjection during explicit prepare so an old
same-version marker cannot leave stale implementation code installed. The paired
qualifier must compare both installed entries to independent rebuilt indexed
entries, not merely demonstrate equivalence between two private copies.

The local preflight must prove actual installed Effect API/CLI diagnostic
behavior, not accept a successful plain-TypeScript run or the upstream patch
check's exit code. Retire pre-patch generated semantic metadata before fresh
qualification. The probe does not attest old build-info provenance or promote
any new semantic-result cache policy.

## Compatibility, evidence and rollout

The existing default test graph and host-specific CI runner remain available
with their original meaning. Hosted sharding, CI YAML, release artifact gates,
affected selection and result reuse are not changed. No ten-minute guarantee is
established merely by this accepted design or by synthetic policy tests.

Verification must include selection/namespace/cancellation and corruption
negatives, native feature suites, the complete local graph and the final forced
build on unchanged source. Report measured wall time and warm/cold state
honestly. Local Chromium fixtures do not qualify other OSes or packaged/live
provider behavior. Replay and operational limits are in
[complete local verification](../test-performance.md).
