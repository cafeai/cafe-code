# Decision: bounded default local Node scheduling

Decision status: Accepted for the expressly approved local default change
Created: 2026-10-28 10:42:43 JST (UTC+0900)
Last updated: 2026-10-28 10:51:33 JST (UTC+0900)
Decision authority: the human selected “Use bounded local defaults
(recommended)” for two workspace owners and at most two Vitest workers each,
while preserving all tests, assertions and deadlines and leaving GitHub CI
unchanged. This decision does not claim verification has passed.
Implementation status: implemented; qualification of the resulting source is pending.
Supersedes only the default-local-Node-admission portion of
[CI-matched default local Node scheduling](ci-matched-local-node-scheduling.md).
That earlier decision remains the historical record; its canonical CI plan and
other ownership and evidence requirements remain applicable.

## Decision

`verify:local` defaults to the complete bounded local Node schedule with two
workspace owners and at most two Vitest workers per workspace. It discovers all
required workspaces and preserves server serial isolated execution. The server
and scripts workspaces each hold an exclusive barrier across cache admission,
execution and final rechecks; other workspaces can overlap within the chosen
limit. Discovery order is retained, ordinary failures do not skip later work,
and cancellation fences new admission while already-owned work drains. On POSIX,
the copied-native Codex client tail begins only after the complementary graph
has closed. Native browser groups and the forced desktop build retain their
existing order and limits; typechecking remains three concurrent workspaces.
No test input, assertion, deadline, CI workflow or release gate is changed.

`--test-concurrency=1|2|3` selects a bounded workspace limit. The exact
`--test-concurrency=ci` option runs the unchanged host-specific canonical CI
Node plan fresh, with no local Node receipt reuse. Neither setting claims that
one machine reproduces another host's resources or timing.

When `--fresh` is absent, the bounded mode may reuse an eligible prior local
success only after its existing authenticated exact-input and ownership checks;
each reuse is labelled. Other required tasks execute normally. `--fresh` bypasses
all receipt reads and writes under the selected schedule. It does not itself
select CI scheduling or bypass the exclusive barriers. Unknown or unsupported inputs remain fresh; no partial
workspace result can stand in for the complete graph. The final forced desktop
build remains fresh and last.

## Evidence and limits

The previous unrestricted local CI-style graph repeatedly hit the unchanged
Oxlint test deadlines. A separate self-only instrumented diagnostic observed
low process CPU relative to wall time while many threads were present; that is
an observation from the instrumented run, not proof of every earlier timeout's
cause. A bounded run is separately qualified and must not be called a CI pass.
No accepted decision, old log, optional receipt, isolated success or proposed
schedule is itself evidence of a complete passing graph. GitHub CI and release
remain independently verified through their unchanged workflows.
