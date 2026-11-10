# Decision: explicit recovery of a blocked provider-daemon startup

Decision status: Accepted within the user-requested startup recovery dialog
Implementation status: Implemented in source; rebuilt application adoption required
Verification status: Synthetic manager and dialog regression coverage; native qualification remains separate
Created: 2026-11-08 15:50:36 JST (UTC+0900)
Last updated: 2026-11-10 11:39:32 JST (UTC+0900)
Decision authority: The user requested an explicit daemon restart dialog when
startup reports an inconclusive compatibility observation, a rebuilt local
bundle, and tests to run later.
Supplements: [authenticated startup retirement](provider-daemon-startup-retirement.md)
and [visible startup](provider-daemon-migration-startup.md).
Partially superseded: [native macOS startup control](provider-daemon-native-startup-control.md)
adds a kernel-generation-bound explicit force path; the original automatic
retirement, dialog and uncertain-request non-replay decisions remain in force.

## Context

A detached provider daemon can outlive its desktop. A failed adoption or an
uncertain automatic retirement acknowledgement previously ended bootstrap with
an error box and Quit. The user could not retry connection or request a guarded
restart from that surface. In particular, a lost reply does not prove that the
old daemon is still running, and simply launching another process is unsafe.

## Decision

The actual daemon-readiness stage handles a typed, code-owned startup recovery
refusal with a native dialog. Cancel is the default and ordinary dismissal;
Retry connection only repeats connection admission. Restart daemon is offered
only by a manager with startup recovery support. Its dialog explicitly states
that provider sessions and running work will stop. Received error text, paths,
tokens and provider output are never interpolated into this control surface.
Unrelated startup failures retain the ordinary fatal path, and interruption
never becomes a restart request.

The native dialog is asynchronous. A Quit while it is open retires its response;
a late Restart selection must not start work behind a closing application.
Cancel delivers the ordinary shutdown/Quit handoff before startup cancellation
can interrupt that handoff, without displaying a second fatal error.

The manager captures the exact pending owner and private recovery namespace
before the confirmation. A restart rechecks the marker, credential, profile,
socket directory and native owner under its lifecycle mutex. A changed owner
requires a fresh connection observation and fresh user choice. The UI never
passes a PID to a process killer or upgrades a cached label into authority.
Directly owned children retain their bounded native-handle termination path;
adopted POSIX peers retain authenticated, nonce-bound self-retirement. Windows
generation/FILETIME control and installer confirmation are unchanged.

### Explicit reconciliation after an uncertain automatic request

The automatic request remains consumed. A user-confirmed recovery does not
resend it, reset its reservation, delete unknown files, or silently fall through
to ordinary stale-marker cleanup. Instead, a separate read-only reconciliation
may establish that the exact old owner is now conclusively absent (ESRCH), the
previously captured private marker and credential are unchanged, the same private
socket directory remains, and its old socket is absent. Retain this evidence and
recheck it before spawning the replacement. A live/unknown process, changed
credential/marker/directory or newly appearing socket refuses replacement.

This narrowly extends the earlier acknowledgement requirement only for this
explicitly confirmed, independently proved post-exit case. It does not make an
unknown acknowledgement successful or authorize another destructive request.
Ordinary automatic retirement still requires its matching acknowledgement and
all existing exit/namespace checks.

## Retaining a current recovery after verification refuses

A failed Restart can still belong to the same pending startup owner. Its typed
failure retains the manager-issued recovery ID only while the exact pending
object and confirmed ID remain current, including when an asynchronous
verification fails. The dialog can then route another explicit recovery choice
or Cancel to that exact owner. Missing, foreign and retired owners do not inherit
an earlier ID. This presentation binding never bypasses private-file, profile,
native identity, exit or consumed-request checks and never permits another
destructive request after an unknown acknowledgement.

Startup diagnostics record only fixed phase/choice labels, capability booleans
and a cause count capped at 16. They distinguish an unavailable restart method,
a missing typed recovery ID and a failed confirmation without recording IDs,
credentials, private paths or received error contents. The existing Quit check
still runs after the modal and its diagnostic await, before any recovery action.

## Limits and verification boundary

Restart is an ownership-checked recovery operation. A completely unresponsive
or unidentifiable legacy adopted process cannot be safely hard-killed through
a guessed POSIX PID. Such an owner remains preserved, and the dialog explains
that recovery failed while allowing connection retry or cancellation. No
process enumeration, executable matching, profile migration, database deletion,
global exception handler or native permission change is introduced.

Regression coverage is owned by the existing desktop startup, daemon-manager
and native retirement test files. It protects consent, cancellation, retry
separation, stale-owner rejection, private namespace identity, native absence
and unknown-request non-replay. Neither source review nor a successful bundle
build is a test pass, live
daemon restart, installed-artifact qualification or provider-adoption claim.
