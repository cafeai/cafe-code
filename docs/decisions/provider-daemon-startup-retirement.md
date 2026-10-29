# Decision: authenticated self-retirement of incompatible startup daemons

Decision status: Accepted within the user-requested automatic startup repair
Implementation status: Implemented in source; rebuilt runtime adoption required
Verification status: Contract and synthetic retirement regressions passed locally;
exact-source GitHub CI and rebuilt runtime adoption remain separate gates
Created: 2026-10-29 23:00:14 JST (UTC+0900)
Last updated: 2026-10-30 02:41:31 JST (UTC+0900)
Decision authority: User request to automatically stop the obsolete daemon that
blocks bootstrap, followed by explicit authorization to push dev without local tests.
Supplements: [ownership-safe startup](provider-daemon-migration-startup.md).
Partially supersedes only the POSIX startup replacement limitation in
[update retirement](provider-daemon-update-retirement.md); installation consent,
adopted Stop restrictions and all native installer gates remain unchanged.

## Context

Provider daemons survive desktop quits. A newly built desktop cannot adopt an
old daemon whose application version, compiled runtime or backend MCP port
differs. On Windows the existing generation/FILETIME-bound native handle can
already retire a conclusively identified incompatible owner. A new POSIX
desktop has no retained child handle for that old process. An authenticated
health response and PID presence do not provide safe signal authority.

## Decision

Add a separate cooperative retirement protocol, authenticated only by the
private bootstrap root token. Ordinary health, RPC and lease capabilities do
not grant it or allow its delegation. Advertise support only when the actual
profiled local daemon has the enclosing shutdown lifecycle, an exact compiled
build identity and no upstream supervisor. Standalone server fixtures and
legacy daemons omit this optional proof.

Before submission, native desktop startup retains its existing profile-bound
Electron single-instance lock and manager lifecycle mutex. Check coherent old
marker/authenticated health identity, role, protocol, profile, version and build.
Bind the request to that old PID, authenticated start time, build and profile
plus a fresh random nonce. Read private single-link recovery files through
bounded no-follow descriptors and compare their exact credential bytes to the
authenticated root token. Do not send control to a foreign namespace.

The private request and acknowledgement require the producer's canonical
24-character millisecond UTC start time. The retirement-specific codec checks
both shape and a real calendar-date round trip, rejecting normalized impossible
dates, alternate offset spellings, trailing characters and oversized input.
Legacy general health/display timestamps keep their existing compatibility;
their presence alone never qualifies retirement. This validation refines the
existing exact-identity decision and grants no additional shutdown authority.

The daemon strictly validates the bounded request, reserves retirement once,
fences new RPC/lease admission and flushes its matching acknowledgement before
closing its own server/provider lifetime. The desktop sends only one POST. An
unknown acknowledgement, stale receipt, wrong nonce or timeout preserves files
and cannot authorize resend or replacement in that controller, including if a
subsequent generic stale-marker probe sees process absence.

An acknowledgement is not exit proof. Wait within the bounded retirement
allowance for conclusive native absence: only ESRCH qualifies, while EPERM,
presence, invalid PIDs and unknown errors preserve the owner. Recheck recovery
file inode/bytes and the private socket-directory identity. The old daemon must
remove its own socket during shutdown. Repeat these checks before spawning;
never blindly unlink a newly appearing socket in this replacement path. Publish
the new marker/credential only from the new directly owned child.

The profile singleton serializes native desktop instances using the supported
startup path. It does not provide a sandbox against arbitrary same-UID programs
that can already rewrite the application's private data or bypass its launcher.
No process enumeration, executable matching, PID-only signal or compatibility
bypass is introduced. Incompatible process roles/protocols remain refused.

## Compatibility and limits

This protocol cannot retrofit a daemon already running older code. Such a
legacy POSIX owner still needs an explicit stop through its owning Cafe Code
instance before the newer build can start. Files remain preserved and the
bootstrap error explains why automatic replacement is unavailable. A daemon
that cannot complete shutdown or whose exit/namespace cannot be proved also
remains protected. No live stop, app restart or real-profile migration occurs
as part of this source change.

Automatic startup replacement stops that obsolete runtime's provider sessions
and running work; it does not preserve active computation across incompatible
builds. Ordinary Leave Running, in-app update confirmation, adopted runtime
controls, Debug/Production isolation and Windows native ownership are unchanged.

## Evidence boundary

Synthetic coverage exercises root-versus-lease authorization, stale/foreign
identity, strict PID observations, request/receipt binding, namespace drift,
one-use admission and Windows exit-before-replacement ordering. These added
tests were originally delegated to CI at the user's request. The timestamp
validation refinement has since passed the contract workspace and the complete
synthetic daemon-server and desktop-retirement test files locally. Those checks
do not establish full-platform CI or native upgrade success; the dev push's CI
and later rebuilt application adoption remain separate evidence.
