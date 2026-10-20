# Decision: three-slot workspace typechecking locally and in CI

Decision status: Accepted
Created: 2026-10-20 14:15:56 JST (UTC+0900)
Last updated: 2026-10-20 14:15:56 JST (UTC+0900)
Decision authority: the human explicitly requested three concurrent workspace
typechecks going forward, including CI/CD.
Implementation status: Implemented policy; qualification applies separately to
each resulting source and platform. Acceptance does not establish a passed run.
Supersedes: the typecheck scheduling/default and CI-exclusion portions of
[complete local verification](complete-local-verification.md) only.

## Context and alternatives

The complete local coordinator previously defaulted to one compiler, optionally
two. CI explicitly used one, while the canonical Turbo command had no explicit
cap. The human chose a three-workspace limit for both local and hosted work.
Keeping the prior default would not implement that choice; increasing test
workers or removing dependency/ownership boundaries is unrelated and rejected.

## Decision

The canonical `yarn typecheck` owns one explicit three-task Turbo concurrency
limit. CI invokes that command without a duplicate option, and release reuses
the same CI workflow. The complete-local direct coordinator also defaults to
three, admitting every discovered exact no-output program, with finite local
one/two/three overrides. Multiple slots retain the stable expensive-program
priority hint; discovery, diagnostic policy and exact compiler identity remain.
The Turbo graph retains its dependencies, so three is a maximum, not a promise
of three busy compilers at every point.

Keep the existing 4 GiB heap ceiling per compiler, scoped to typechecking.
Do not increase Node/browser test workers, build concurrency, deadlines or
permissions. Keep ordinary failures distinct from cancellation, veto queued
admission when cancelled and join every held compiler close, even a late zero
exit. Preserve the separate POSIX native-client test tail and final forced build.

## Resource, security and failure consequences

Three 4 GiB heap ceilings can reach 12 GiB plus native and OS allocations.
This is not an aggregate 12/16 GiB RAM bound or proof that a smaller hosted
runner cannot exhaust memory. No larger runner, cost increase, OS tuning or
automatic retry is authorized. Use the finite smaller local override under
pressure; any further CI resource-policy adjustment requires review.
No provider data, app process, credential, network permission or result-cache
authority changes. An interrupted run never qualifies success.

## Compatibility and evidence

Turbo rejects duplicate concurrency options. Use the canonical command as-is;
for a smaller complete Turbo run, invoke `yarn exec turbo run typecheck
--concurrency=1` or `=2` with the documented scoped heap. Local verification has
its own exact option and unchanged full coverage. No dependencies change.

Policy tests cover defaults, finite overrides and CI/release reuse without
filtering the graph. Held-child tests cover three-slot admission, exactly-once
execution, cancellation, joining every close and refusing queued work after
late successful exits. Complete type/test/browser/build verification remains
required on the resulting source. Local macOS evidence cannot qualify hosted
memory use, native Windows/Linux behavior or a speed target.

## Preserved decisions

The predecessor's full coverage, no-result-cache policy, isolated native
contexts, byte-bound compression input reuse, compiler diagnostic equivalence,
owned cleanup and forced desktop build LAST remain active. No hosted sharding
or release publication policy changes.
