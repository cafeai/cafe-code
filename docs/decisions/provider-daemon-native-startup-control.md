# Decision: explicit macOS daemon restart with native generation control

Decision status: Accepted for the user-requested explicit restart action
Implementation status: Implemented; rebuilt application adoption required
Verification status: Native disposable-process and targeted desktop regression checks passed; complete hosted qualification remains required
Created: 2026-11-08 17:05:31 JST (UTC+0900)
Last updated: 2026-11-08 20:19:45 JST (UTC+0900)
Decision authority: The user reports that Restart daemon does not stop the old
runtime and requests an immediate fix and rebuilt bundle.
Partially supersedes: The manual macOS hard-stop limitation in
[startup recovery dialog](provider-daemon-startup-recovery-dialog.md).
Preserves: [automatic startup retirement](provider-daemon-startup-retirement.md)
and [installation retirement](provider-daemon-update-retirement.md).

## Context and decision

An old listener may already be closed while its outer daemon process is still
alive. The uncertain cooperative-stop reservation correctly prevents replay,
but read-only reconciliation alone cannot finish that owner's shutdown. A
PID-only signal would risk stopping a reused or replaced process. Requiring a
live socket for recovery also cannot handle an already closed listener.

The bundled macOS controller captures a task-name audit token without sending
a signal. It admits only the current effective/real user, exact executable and
native birth second matching the private marker creation second; it checks
native birth and the token again before publishing readiness. The token stays
inside that one retained helper across the native confirmation dialog. The
marker's time is admission context, not a retroactive kernel attestation.

Only explicit Restart submits a one-use nonce-bound private-pipe command. The
native audit-token signal API controls the exact kernel process generation,
first with TERM, then with KILL after two seconds if necessary. Exit observation
has a further three-second bound; unknown observations refuse replacement.
There is no process enumeration, task-control port, PID-only signal fallback,
root requirement, permission change or provider installation.

The manager separately rechecks its exact pending recovery identifier,
profile, held private marker/credential and socket directory before and after
native control under the profile singleton and lifecycle mutex. A successful
helper result is insufficient alone: ESRCH and unchanged private namespace
remain required. A leftover Unix socket may be unlinked only once after native
exit, and only when its complete captured identity still matches. Initially
absent, replaced or unknown entries are never removed. The final spawn fence
requires absence and cannot replay socket cleanup.

## Lifetime, failure and privacy

Cancel closes and joins the unforced helper; EOF before the command never
signals its target. After command submission, interruption joins the bounded
native sequence rather than closing its pipe midway. The helper has a minimal
source-owned environment and fixed bounded protocol. Kernel tokens, paths,
credential bytes and native errors never become dialog text or diagnostic
payloads. Fixed control/identity/exit categories provide actionable guidance.
The bridge measures its existing cleanup allowance with a monotonic elapsed
clock, so a wall-clock correction cannot extend that allowance. The exact
captured recovery evidence remains bound across asynchronous logging.

Both the uncertain cooperative request and native force command remain
consumed before asynchronous control. An unknown acknowledgement does not
authorize replay. Later actions may only reconcile that same captured owner.
Layer finalization, successful adoption and a retired pending owner close the
retained helper. Automatic retirement, normal leases, installer confirmation,
Windows generation/FILETIME control and Linux legacy-owner refusal remain
unchanged. When native identity cannot be established, the old owner and its
recovery evidence remain intact.

## Evidence boundary

Disposable native processes qualified cancellation, normal TERM, ignored-TERM
KILL escalation, wrong-birth refusal and an exec replacement surviving control
of the earlier audit-token generation. The helper compiled with warnings as
errors. Existing desktop startup, manager and retirement test owners add
regressions for consent, stale identifiers, cancellation, unknown-ACK
non-replay and exact socket cleanup. Those regression files passed locally
after the strict desktop compiler and repository lint checks; the complete
hosted gate is a separate requirement.
Compilation and disposable-process checks do not prove a real daemon restart,
installed-artifact qualification or running application/provider adoption.
