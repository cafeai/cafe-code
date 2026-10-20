# Decision: complete local work reduction without result-cache authority

Decision status: Accepted within the authorized local implementation scope
Created: 2026-10-20 08:25:58 JST (UTC+0900)
Last updated: 2026-10-20 09:06:20 JST (UTC+0900)
Decision authority: implementation discretion under the human's request to focus
on local test-performance improvements; no hosted or publication-policy change.
Implementation status: Implemented; integrated verification and timings pending.
Supersedes: None. Existing isolation, required coverage and final-build rules remain.

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
