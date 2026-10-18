# Debug data is a complete startup profile

Created: 2026-10-18 18:13:32 JST (UTC+0900)
Last updated: 2026-10-19 01:24:06 JST (UTC+0900)
Decision status: accepted for implementation by the user's explicit request.
Implementation status: source implemented; local synthetic feature checks passed.
Verification scope: local synthetic feature checks; complete default/CI and native/live qualification are not claimed.
Supersession: supplements existing startup and native ownership decisions; does
not relax their authentication, permission, process-identity or resource bounds.

## Context and decision

Diagnostic logging previously did not select separate storage. A renderer dev
URL provided only a partial `dev` directory split, while caches, provider homes,
some daemon derivation and process cleanup could still be shared. Changing only
the SQLite filename would leave those collisions intact.

All non-packaged desktop and repository development launches select Debug before
foundation-layer IO. Packaged releases select Production even with diagnostic
logging. Production paths/identity remain unchanged. Debug has the configured
root's `.debug` child and one `userdata` leaf across built/watch source modes.
Public standalone server deployments retain their defaults unless an explicit
finite profile is selected. Profiles are not inferred from Git branches,
version suffixes or the diagnostics endpoint.

Configured and effective roots are separate typed startup facts. Private child
bootstrap carries the effective home in its legacy field, plus a paired profile
and configured parent. New children verify the pair and reject ambient conflicts
before opening profile files. Half-pairs cannot reinterpret an effective Debug
home as its Production parent. The legacy effective home also keeps an older
child inside Debug if it ignores newly added metadata. This is defense in depth,
not support for pre-feature outputs: source desktop/server builds must also
have bounded, versioned capability receipts that bind their exact emitted
JavaScript chunks. Missing or mismatched receipts refuse before profile IO or
provider startup and require an explicit rebuild. The receipt is a local build
compatibility binding, not authentication against a same-user source editor.

The user's follow-up separately requires stable preferred listener separation:
Production retains HTTP `3773`, while Debug prefers `13773` with upward fallback.
Explicit overrides remain exact and cannot authorize endpoint adoption. Debug
headless web mode is loopback by default too; phone/browser access uses only the
selected profile's explicit network exposure and existing authenticated access
flow. TLS keys and auth sessions remain profile-local. Explicit Debug HTTP/HTTPS
cookie names are distinct and port-qualified, avoiding standalone web cookie
overwrites without changing Production or legacy deployment names. Port/cookie
names are routing/selection facts, not a sandbox or authentication proof. Native
bind refusal remains authoritative after a preflight; no listener is silently
adopted on a race.

Desktop startup and watchdog readiness require an independent, fresh per-child
HMAC key passed only through private bootstrap and a fresh random challenge for
each HTTP probe. The environment route returns only a finite domain-separated
proof header, never that key; its public descriptor and browser authentication
are unchanged. Mere successful public HTTP responses, proofs from another child
and replayed challenges do not establish readiness. The proof authenticates the
launched child at that endpoint, not an OS sandbox or a broader data-ownership
claim. Existing native-child exit and lifecycle budgets remain authoritative.

Electron userData/sessionData and native single-instance identity are established
before settings/logging/certificate layers. Debug source runtime caches and app/
helper identifiers are separate; release signing identities and native storage
permissions are not weakened. Scoped native instance-control requests have a
finite exact shape and profile/directory match, bounded early capture and no
arbitrary command payload.

Debug initialization is fresh, persistent and non-importing. DB/WAL/SHM,
settings/secrets, assets, browser state, caches, workspace allocation and runtime
ownership follow the same selection. Startup refuses unsafe aliases and fixed
state-file multi-links without copying/reading Production content, repairing
permissions, unlinking evidence or selecting Production as a fallback.

Provider setup is independently admitted. Fresh Debug defaults are disabled;
disabled or unsupported/unconsented entries cannot construct a driver and probe
global credentials. Supported native homes and every helper use the same
profile policy. Inherited auth/home variables are removed even through process
launch APIs that otherwise merge the parent environment. Unsupported/external
state requires explicit shared-state consent; no claim of private native state
is inferred from a Cafe account row. Claude's custom launch arguments and
external cloud/profile selectors require deliberate sharing because private
home relocation does not qualify those extra state-selection mechanisms.
Cafe maintenance cannot mutate shared
provider installations in Debug.

## Lifecycle consequences

Executable-path orphan scans are removed: matching a binary is not exact profile
or process ownership. Owned child handles retain termination/exit responsibility;
native exit, not signal completion, admits a replacement writer. Unknown native
ownership remains a refusal, not permission to delete credentials or start a
competitor. Windows retains its authenticated generation, FILETIME and same-
handle native guard controller, now also bound to the exact paired opening
profile, effective-root namespace and authenticated native receipt.

The native desktop lock alone does not exclude an orphaned backend after a
desktop crash. Every explicitly profiled backend therefore acquires a dedicated
private SQLite guard before building runtime layers, holding `BEGIN EXCLUSIVE`
with zero busy wait until those layers and their finalizers drain. The guard is
not the main DB and is not taken by the intentionally shared provider-daemon
role. Its finite format binds the exact canonical profile/root, and unsafe or
unknown records are preserved. Process exit releases native locks even if the
desktop cannot run a finalizer; an existing live backend keeps its lock and a
new launch refuses, with no PID lookup/deletion or parent-loss timer authority.

SQLite's [POSIX advisory-lock warning](https://sqlite.org/howtocorrupt.html#posix_advisory_locks_canceled_by_a_separate_thread_doing_close_)
requires refusing process-local reentry before any guard-file IO and retaining
the raw admission descriptor until after SQLite closes. Separate-process native
fixtures verify that refused reentry cannot accidentally release the first
owner's lock. This is supported-local-filesystem exclusion, not distributed/NFS
locking or retroactive protection from older/unprofiled writers. Guard files
remain on disk; process ownership is the live native transaction, not their
existence.

The steady-state guard transaction is read-only after its finite schema commit.
Preexisting journal/WAL/SHM sidecars are conservatively preserved and refused,
even when private and single-linked: those attributes cannot authenticate their
contents before SQLite attempts recovery. An interrupted first initialization
with a journal therefore requires explicit diagnosis/repair rather than silently
applying or deleting unknown bytes. Ordinary post-admission process crashes have
no such initialization journal and release their OS-held lock normally.

Known typed profile-selection/guard refusals have a reserved native exit result
after the scoped root and its finalizers settle. Only the exact current desktop
run with complete profile proof and no prior authenticated readiness may consume
that result as terminal startup refusal, stop its automatic retries and show one
fixed localized error. Stderr, structural error tags and arbitrary exit-code
metadata cannot mint this result. Unknown, mixed, defect and interruption paths
retain the runtime's default policy (except that the reserved code cannot be
borrowed); normal post-readiness crash recovery is unchanged. Explicit Stop/quit
and retired generations never produce a new startup dialog.

Authenticated profile receipts bind the actual admitted runtime profile and a
domain-separated digest of its effective root; the digest is correlation, not
an authentication capability. POSIX adoption requires matching recovery-file
namespaces and native receipts before issuing a lease. Legacy/missing proof,
inconclusive IO and incompatible owners retain all state. An adopted POSIX owner
has no retained native child handle, so automatic Stop/recovery refuses instead
of signaling a bare PID or admitting another writer. Ordinary desktop relaunch
can still leave its provider runtime alive and reconnect to it.

The prior automatic-supervisor feature gate stays disabled. Its internal POSIX
ensure path now refuses a fresh detached handoff before mutation because the old
PID-only return could lose a live child after marker-publication failure. Exact
existing-owner adoption, direct role startup and the separate Windows native
guard remain supported. A durable POSIX supervisor reservation/handoff protocol
is separate future work, not an unimplemented part silently claimed here.

An already-running pre-feature source controller does not acquire this policy.
Co-existence with that old shared-entry cleanup is unsupported; no automatic
interruption is authorized. Installed releases have distinct artifacts but their
native OS behavior must still be qualified separately. Profile identifiers are
correlation metadata, not capability tokens or a same-user OS sandbox.

## Alternatives and operational limits

- A sibling `state.debug.sqlite` was rejected because it leaves settings,
  secrets, native homes, browser state and cleanup shared.
- Reusing renderer dev URLs as the storage selector was rejected because built
  and watch source must reopen one persistent Debug profile.
- Automatic Production cloning was rejected because live WAL consistency,
  credentials and native owner/session duplication require a separate design.
- Moving Production was rejected to preserve release compatibility and rollback.
- A live Settings profile toggle was rejected: DB/locks/keys/native owners are
  startup choices, not a hot mutation.

Nested Debug storage requires backup/export/maintenance tools to address exact
owned paths rather than recursively treating the entire parent as one profile.
No reset/import/automatic cleanup feature is added. Same remote provider account
quotas and user-selected project files can remain shared. General Settings labels
the selected server's profile; an explicit remote connection is not isolated by
the local desktop badge.

## Verification and evidence boundary

Required deterministic evidence covers path/mode and complete bootstrap pairing,
foundation IO ordering, independent real SQLite histories/WAL/schema versions,
alias refusals, zero unsolicited provider startup, admitted native child env,
explicit shared-state policy, profile-bound lifecycle/control and functional
Settings reporting. Preserve workers, deadlines, encryption and sandboxing.

Run the pinned Node/Corepack Yarn format, lint, typecheck and default tests,
applicable browser/bridge checks, then forced desktop build last on unchanged
source. Local macOS fixtures do not qualify native Windows/Linux process, OS
Keychain/permission, or installed side-by-side behavior. Native evidence remains
separate and no live provider login or inference is required by these fixtures.

Local feature qualification covers the affected server ownership/auth/startup
cases, shared path/build-receipt policies, complete desktop unit tests, functional
Settings browser wiring and all three copied MCP bridges. Static checks and all
package typechecks also passed. Broad default runs retained unrelated Claude
and rule-harness timeouts; they are not relabeled green or attributed to a
network cause. Live OS account selection, native other-host process behavior and
actual phone/LAN access remain separate acceptance work.

This decision supplements [Windows native process identity](windows-daemon-process-identity.md)
and existing migration/readiness policies, preserving their historical rationale.
See [operational behavior](../data-profiles.md) for setup, failures and rollback.
