# Decision: CI-matched default local Node scheduling

Decision status: Accepted for the explicitly requested local scheduling change
Created: 2026-10-24 03:09:06 JST (UTC+0900)
Last updated: 2026-10-24 03:09:06 JST (UTC+0900)
Decision authority: the human explicitly required leaving CI scheduling unchanged
and making local scheduling match it.
Implementation status: implemented; resulting-source qualification is required.
Acceptance is not evidence of a passing local or hosted run.
Supersedes in part: the default Node admission/per-workspace reuse portions of
[complete local verification](complete-local-verification.md) and
[exact-input local result reuse](verified-local-result-cache.md). Explicit
bounded local overrides and all other cache, ownership and coverage rules remain.

## Context and alternatives

The bounded local Node queue admitted fewer workspace processes and imposed a
different Vitest worker policy than canonical POSIX CI. A passing local run could
therefore miss a failure under CI's overlapping workspace load. Emulating an
implicit Turbo default with a guessed constant would create another policy that
can drift when the installed runner changes.

The human declined tightening CI and instead requested matching local scheduling.
Choose the existing canonical host-specific Node plan directly, rather than
changing CI, inventing defaults, or asserting that one machine reproduces
another machine's CPU, storage or timing behavior.

## Decision

With no explicit `--test-concurrency` option, `verify:local` uses the unchanged
`nodeTestPlan(platform)` shared by canonical CI. This preserves the complete
Windows graph and the POSIX complementary graph followed by the separately
owned copied-native Codex tail. No local worker/concurrency flags are appended
to those canonical steps. Run each step to actual native closure before
admitting the next; failure and cancellation cannot qualify an unrun tail.

The default canonical Node phase executes fresh. A server-only success receipt
does not attest the whole canonical graph and must not replace that graph or
silently remove one workspace from it. Type and complete browser-group reuse
remain independently available under their existing exact-input policy.

An explicit `--test-concurrency=1|2|3` still selects the previously qualified
bounded local mode: its complete discovered per-workspace queue retains at most
two Vitest workers each and may reuse the eligible server Node result. With
`--fresh`, the same explicit override uses the existing bounded canonical Node
plan without receipt reads or writes. It is a deliberate resource override,
not a claim of CI scheduling parity. There is no new selection/skip option.

Typechecking retains its existing three-compiler default and optional smaller
limit. Browser contexts/groups, server file isolation, diagnostics, deadlines,
private artifact ownership and the fresh forced desktop build LAST are unchanged.
Canonical CI/release files, arguments and cache policy are not changed.

## Security, resources and qualification

No receipt gets broader authority. Unknown/unsupported task shapes execute
fresh; default Node qualification cannot borrow a prior per-workspace pass.
No result is seeded from an old log, a saved intent or a different runtime.
Observe and report default fresh work separately from explicit-mode reuse.

Canonical native defaults can admit more processes on a larger local machine.
Low scheduling priority is not an aggregate memory bound. Monitor headroom and
use the explicit smaller local override on constrained machines; label that
verification accurately rather than claiming it reproduced CI admission.

Qualification requires all-host plan controls binding default steps to the
actual shared canonical function, explicit-override and refusal controls,
complete relevant local checks and the final fresh forced desktop build.
Native Windows/Linux CI remains separate evidence. A timeout's historical
blocking operation cannot be inferred from scheduling overlap alone.
