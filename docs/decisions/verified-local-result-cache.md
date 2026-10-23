# Decision: exact-input local verification success reuse

Decision status: Accepted within the explicitly requested local cache scope
Created: 2026-10-22 22:55:23 JST (UTC+0900)
Last updated: 2026-10-23 21:58:14 JST (UTC+0900)
Decision authority: the human explicitly requested caching unchanged local
verification work before the approved dev push.
Implementation status: implemented with qualification requirements below;
decision acceptance does not attest any particular suite run or timing target.
Supersedes in part: [complete local verification](complete-local-verification.md),
only its prohibition on local test/typecheck result reuse.
Superseded by: None.

## Context and alternatives

Uncached repetition makes a browser-fixture repair pay for unrelated complete
Node suites again. Git status, lockfile/version strings alone, or enabling Turbo
remote/local result caching without reviewing inputs cannot establish that those
tests still apply. Affected-file heuristics also miss cross-workspace imports and
filesystem reads. Conversely, retaining no success evidence wastes unchanged work.

Choose a separate, explicit local success-receipt layer rather than changing the
canonical Turbo `cache: false` policies or borrowing hosted/release evidence.
Conservative invalidation is preferable to a falsely green check. Unsupported
input scopes/platform ownership run fresh; they never disappear from coverage.

## Decision

`verify:local` may reuse a completed workspace Node task, exact no-output
workspace type program, or complete existing browser group. Every required task
is discovered afresh. Type programs retain their qualified compiler and queue;
Node tasks use exact single-workspace filters through the original root
`yarn test` entry, with the same aggregate workspace/worker caps. Validate that
the actual test graph has no ordering dependencies before independent admission.
Keep the separate POSIX copied-native Codex tail after its complementary graph.
Native browser groups retain their original context, ordering and action budgets;
no parser realm, render outcome, fixture state or application data is restored.

Cache admission itself has a cost: observing complete installed/tool bytes is
more expensive than several small tasks. The local session therefore applies a
separate conservative reuse-eligibility policy to the expensive server Node,
server/Codex typechecks, ordinary desktop/touch, Mermaid security and Mermaid
family lanes. Short and unknown lanes execute fresh without fingerprint/receipt IO.
This never selects tests out of the complete graph, adjusts workers/deadlines or
infers a task pass. Review eligibility when measured task costs change; this is
not an elapsed-time assertion or a guarantee for every host.
Web types stay fresh: their broad source include overlaps omitted screenshot
output, so reuse cannot assume an unchanged complete compiler program.

Formatting, lint, repository audit, actual Effect compiler diagnostics, private
bridge preparation and copied-artifact qualification stay fresh. The forced
desktop build always executes fresh and LAST. `--fresh` bypasses both result
reads and publication. Canonical CI/release entrypoints stay uncached; no remote
upload/download, new dependency or installation is introduced.

The producer binds task arguments/cwd/selection, the reviewed source and explicit
filesystem-read scope, additions/deletions, actual installed dependency/tool bytes,
compiler configuration/patches, host identity and authenticated effective
environment. Actual producer source is itself an input. Never infer success from
a previous log, Git index, timestamp alone, partial Turbo output or a version
marker. Native file/change fences are separate from reusable content identity:
ordinary edits during a task invalidate it even if the bytes are restored.

Native tool byte observations additionally share a finite process-local memo of
at most sixty-four canonical-name/full-native-identity/digest records between
producer instances. It retains no source text, file handles, environment or
task-success state. A fresh canonical lookup and complete current identity must
match before seeding an otherwise absent per-producer content entry; the normal
file/link/size admission, named recheck and whole-snapshot change fence remain
required. Never replace an existing source/text entry or its memory accounting.
Changed bytes, mode, inode or change metadata require a new byte observation.
Eviction or a new process merely loses this cost reduction. A completed tool
read may survive an unrelated later snapshot refusal, but cannot qualify a
snapshot or publish a successful task on its own. This is not persisted receipt
reuse or evidence that a current task executed.

Eligible local POSIX tasks remove only the calling Codex terminal's inherited
`CODEX_TOOL_CALL_ID` from their actual frozen child environment before computing
the key. That per-terminal-operation tracing identifier otherwise changes an
unchanged task's environment identity on every invocation. It is not merely
ignored in the fingerprint: both the native executor and the producer receive
the same prepared object. Explicit browser-step overrides stay literal, because
the native plan merges them again. Disabled, unsupported, cheap/unknown, hosted,
Windows and `--fresh` paths retain their original environment. All other fields,
including similarly named fields, runtime hooks and credentials, keep their
existing binding/refusal policy. No process-wide environment or provider state
is rewritten; this finite test-execution policy is not generic environment
sanitization or proof that arbitrary external software ignores tracing fields.

Eligible server Node execution uses a finite checked-in Git fixture profile:
an exact include-free global config disables implicit per-user attributes and
ignore files, system config/attributes are disabled, and an exact dot-only
template directory replaces ambient templates. Qualify the native null device
used by those defaults without reading it. The profile files, native tools and
exact frozen execution environment are cache inputs. Never inspect real user
Git profiles to mint reuse authority. Repository-local config, hooks, attributes,
ignore files and explicit per-case overrides remain effective in test-owned
repositories; no forced hooksPath or command-line config overrides are added.
Unknown/conflicting ambient Git selectors or unbound runtime preload/library
hooks refuse reuse and preserve original fresh execution. The ordinary uncached
commands, other workspaces and CI/release environment are not rewritten.
The null character device binds its stable namespace, ownership and device
identity, not timestamps that ordinary device output can change. Source/tool
files retain their complete byte/change fences; held, named and final device
replacement checks remain required.

On macOS, the fixed `xcrun --find git` metadata observation joins its exact native
child's `close`, including when Node reports its abort/error callback earlier.
Preserve the original callback result/error and the existing command, signal,
output bound and deadline. A requested signal or rejected callback alone is not
native retirement evidence; no PID lookup, replacement child or retry is added.

Directory fences use stable native identity and bounded relevant-name membership,
not timestamps changed by declared generated outputs. Known test screenshot and
tool-temporary namespaces are excluded before inventory admission, including on
their first creation; selecting an excluded output as an actual input refuses
reuse rather than silently omitting it. This is not a transactional
history of every transient filesystem write. An eligible fresh type miss retires
only recognized default build-info before running the unchanged compiler command;
custom or unrecognized semantic metadata cannot mint reusable success.

The same customary workspace-output roles drive source omission and ancestor
overlap refusal, including before those output directories exist and in observed
workspace-shaped source directories without manifests. A broad compiler include,
ambient type root or source-directory alias can expose those descendants even
when the current compiler has no `outDir`; a filtered inventory is not proof of
that larger program. Such scopes execute fresh. Installed dependency payloads
remain a separate complete input inventory, not generated source outputs.

The installed `node_modules/.vitest-cache` namespace is Vitest's generated
module-transform output, not a locked dependency payload. Exclude that exact
installed role before inventory and membership admission, including its first
creation. Same-named source/dependency-owned data and custom paths remain inputs.
This preserves the pinned runner's existing trusted-local transform cache; the
authenticated success receipt does not independently authenticate transformed
cache payloads or prove their provenance. `--fresh` bypasses result receipts,
not Vitest's internal transform reuse.

Only a completed successful native close with unchanged admitted inputs and no
observed cancellation can publish. A hit rechecks current inputs and is labelled
as prior successful evidence, NOT a fresh execution. Earlier completed tasks may
remain reusable when a later task fails; that does not make the complete graph
green. A cancellation after an already committed success cannot retroactively
revoke that earlier completed task. Unknown native completion is never cached.
After awaiting publication, recheck admitted inputs before reporting the current
task as qualified, even if optional receipt storage failed. Source/key/fence drift
during that await refuses the current result; an already committed prior receipt
is not deleted or relabelled as evidence for the changed inputs.

## Security, privacy and failure consequences

The POSIX store uses a private checkout-bound namespace beneath the canonical OS
temporary directory, not a permission change to a shared home or checkout. OS
cleanup is a miss. It requires bounded canonical signed
receipts, a private random authentication key, no-follow held/named file identity,
exclusive no-overwrite publication and finite admission. Environment values are
HMAC input only, never persisted or logged. A qualified owner-controlled,
non-group/world-writable temporary Yarn shim directory can be represented by
its complete current shim-byte identity rather than its random pathname; all
other environment/PATH components remain bound. These read-only forwarding
scripts contain only reviewed tool paths/arguments; public read/execute
permissions are not receipt-store privacy authority.
The exact qualified `yarn` and `node` entries also supply stable identities for
Yarn's temporary `npm_execpath` and `npm_node_execpath` fields. Tool-key identity
uses the complete qualified directory digest plus the selected entry name,
while native byte reads and change fences retain the actual paths. An arbitrary
alias resolving to that entry cannot borrow this normalization. All other
environment fields, including lifecycle and working-directory metadata, remain
literal authenticated inputs after the finite actual-child tracing preparation
above; no executed field is silently omitted only from the fingerprint.
Invalid or incomplete evidence is a miss. Corrupt/foreign/unknown files are not
repaired, overwritten or deleted. Full/stale/unsafe namespaces lose cache
eligibility; actual successful checks remain successful if an auxiliary cache
write fails. Windows has no POSIX-mode privacy proof here and executes fresh.

Operational diagnostics use fixed task-lane, snapshot-phase, refusal-category
and key/fence equality fields only; they never print hashes, paths, environment
values or received error text. A private nominal-error lookup avoids invoking
getters or proxies. Exact executor fulfillment is tracked separately from a
child's printed timing line. Observers are bounded and non-authoritative;
diagnostic delivery failure cannot abandon remaining workspace qualification.

This is trusted local developer evidence, not defense against malicious code
already running as the same user, a replacement verifier, hostile hardware,
universal arbitrary JavaScript filesystem observation, or changed external
services. Unknown source/tool/read contracts must run fresh. A native browser
hit is not a current GPU/focus/host-health check, provider qualification, installer
test, release attestation or evidence for another operating system. No provider,
credential, application database, permission, sandbox or process-control authority
is added. No failed/cancelled/partial task may mint success authority.

## Compatibility, evidence and supersession

The prior decision's coverage, source setup, compiler diagnostic, resource,
cancellation, native-context and final-build requirements remain in force.
Only local result reuse is superseded. Existing canonical `yarn test`, canonical
`yarn typecheck`, CI/release gates and hosted platform selection keep their
meaning. Do not claim ten-minute completion from the design or synthetic tests.

Qualification requires cold/warm real task execution counters, mutation and
addition/deletion/config/dependency/environment invalidation, corrupt/unsafe
storage negatives, actual native close/cancellation controls, complete required
local qualification and its fresh forced final build. Report fresh/reused work
separately and preserve failures. Replay and operational limits are documented
in [test performance](../test-performance.md); the implementation's input policy
is canonical, not an inventory frozen by a documentation test.
