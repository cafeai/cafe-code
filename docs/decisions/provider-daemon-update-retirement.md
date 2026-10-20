# Decision: retire the qualified provider daemon before installing an update

Decision status: Accepted within the user-requested updater startup repair
Implementation status: Implemented; rebuilt application adoption required
Verification scope: Synthetic manager/updater regressions and exact-source CI;
real installed-app upgrade and native foreign-host control are separate
Created: 2026-10-20 22:11:35 JST (UTC+0900)
Last updated: 2026-10-20 22:29:56 JST (UTC+0900)
Decision authority: Agent implementation choice within the user's request to fix
the auto-updater bootstrap failure and push the verified repair.
Supplements: [ownership-safe daemon startup](provider-daemon-migration-startup.md)
and [Windows native process identity](windows-daemon-process-identity.md).

## Context

The provider daemon deliberately survives ordinary desktop quits. Startup admits
an existing daemon only when its authenticated identity, profile, protocol,
application version, runtime build and Cafe MCP port match the new desktop.
The runtime build includes application version, backend path and bundle bytes.
An ordinary application update therefore cannot assume the old daemon remains
compatible. Previously the updater stopped only the main backend, destroyed the
windows and invoked the installer, leaving that persistent daemon to block the
new app's bootstrap.

Authentication and PID liveness do not grant destructive process ownership.
In particular, a POSIX adopted daemon has no retained native child handle.
Weakening version/build checks or killing the marker's PID would conceal the
upgrade conflict by weakening existing security invariants.

## Decision

Reserve one update attempt and explicitly warn through the native dialog that
updating stops all provider sessions, including work still running. Cancel is
the default. Do not infer consent from a cached zero-session count or the
renderer-only restart prompt.

Before stopping the backend, qualify the manager's existing control authority
and fresh authenticated owner health. A missing preparation implementation,
adopted/unproved POSIX owner, foreign profile, changed identity, upstream owner
or unavailable observation blocks installation before any shutdown mutation.
Preparation is read-only; it grants no new process-control capability.

After consent and preparation, stop the backend, retire the provider daemon
through its existing exact-owned native Stop path, and require confirmed exit
before destroying windows or invoking the installer. The final Stop repeats
its existing ownership fences. A refusal, defect or uncertain termination must
not fall through to installation. Keep the downloaded update and actionable
failure status for retry, release the install reservation, and retain windows
when retirement did not complete. Do not start a competitor to repair a failed
stop or use an unrelated available port as evidence of exit.

The backend's ordinary bounded Stop remains best effort. Update installation
opts into confirmed exit without increasing that budget; a timed-out close
retains its exact owner and refuses installation. The qualified pinned Node
spawner's signal-exit error is delivered only after its native `exit` event,
so normal and signal exits both remain actual closure evidence.

Reserve the exact downloaded version/channel and install attempt across awaited
native dialogs, health checks and shutdown. Late updater events can invalidate
that attempt, never release another attempt's admission. Once the native
installer has been invoked, its return or error does not prove that handoff
never began: retain the no-replay reservation until teardown, including after
later error events. Raw event errors remain opaque and produce only fixed
localized stage feedback, never received text or object coercion in UI/logs.

## Alternatives and limits

Accepting any protocol-version-one daemon is not a cross-build compatibility
proof, and would leave newly released daemon fixes unapplied. Deleting recovery
files or signalling a PID loses exact ownership. A cooperative cross-version
retirement/handoff protocol would be a separate design and native qualification,
not an incidental bypass in this updater fix.

An already installed older controller cannot gain this preparation step from a
source push. If it has already stranded an adopted incompatible daemon, that
runtime still needs a deliberate separately authorized stop; the new code
preserves it instead of claiming transparent recovery. Ordinary Leave Running
and profile isolation remain unchanged. This repair prevents an unsafe in-app
installation when retirement cannot be proved; it does not promise every legacy
owner can be updated automatically.

## Security and verification

No new endpoint, token, credential format, PID-control permission, provider
request, profile mutation or daemon-adoption authority is introduced. All
negative paths preserve recovery evidence. Known compatibility mismatches get
finite content-free reason labels, not received secrets or executable recovery
commands. Native Windows guarded termination remains independent of synthetic
macOS fixtures.

Qualify read-only preparation and refusals, explicit consent/cancellation,
concurrent attempts, exact stop/install ordering, failed or interrupted native
retirement, unchanged downloaded retry state, and realistic old marker/old
authenticated health against a newer app. Complete repository verification and
the forced desktop build remain required; those tests do not establish a real
installed-app upgrade or live repair.
