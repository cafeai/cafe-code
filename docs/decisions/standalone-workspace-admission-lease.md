# Operation-scoped standalone workspace admission

Decision status: Accepted within the authorized standalone-send repair.
Created: 2026-10-11 10:54:53 JST (UTC+0900).
Last updated: 2026-10-11 11:12:11 JST (UTC+0900).
Decision authority: Agent implementation discretion within the user's request to
repair standalone sends and include the repair in the current dev push.
Implementation status: Implemented and independently reviewed; final gates and delivery pending.
Partially supersedes: [Stable volume ownership](standalone-workspace-volume-identity.md)
only the repeated native UUID lookup within one workspace-resolution operation.

## Context and rationale

macOS standalone admission verifies a durable volume UUID and bigint inode while
holding a no-follow directory descriptor and checking its raw device, owner and
namespace. Resolving a leaf previously repeated the root's native metadata
helpers at the final boundary. Under local process-launch pressure, redundant
bounded helpers increase the chance that local preparation fails before any
provider input is delivered. A generic failure is not proof that a directory is
missing or that ownership may be rebound.

Increasing helper or preparation deadlines, caching a device-to-volume mapping
across operations, discarding device identity, and automatically rebinding an
old row are rejected. Retain fresh native evidence but carry its exact held
root through one operation instead.

## Decision

For POSIX resolution, keep the no-follow descriptor for the root that passed
fresh admission alive through leaf preparation and the final root check. The
lease belongs to one operation only. Validate the same held directory's raw
device, bigint inode and owner against the path namespace before and after
permission changes, retain database ownership/replacement checks, and close the
lease on success, failure and cancellation. A root replacement is a refusal,
never authority to mutate its replacement.

Each later resolution still obtains fresh native UUID evidence. No persistent
volume cache, raw-device fallback, legacy rebinding, provider call or message
replay is introduced. Native helper bounds and the local preparation deadline
remain unchanged. Windows retains its existing numeric-device and user-ACL path
without adopting POSIX descriptor or chmod semantics.

## Security, compatibility and verification

Stable volume identity, root/leaf inode binding, no-follow admission, ownership,
same-filesystem restrictions, quarantine, fork references and hard-delete fences
remain mandatory. Unknown native metadata continues to fail closed. In-flight
cancellation must not permit a late descriptor leak or permission mutation.

Fixtures must prove a single native root lookup per operation, fresh evidence on
the next operation, deterministic lease cleanup, raw identity/owner rejection,
root/leaf replacement refusal and cancellation. The explicit native macOS test
uses only a scoped temporary directory and fixed metadata helpers; it does not
qualify a live chat or repair its stored identity. Preserve all existing test
deadlines, assertions and worker bounds, run the required repository checks,
then `corepack yarn build:desktop --force` last.

Focused workspace/identity qualification passed 63 tests with one existing skip;
the explicit scoped native macOS identity fixture passed. Server typecheck and
the independent descriptor/namespace ownership review passed. Sanitized read-only
inspection of the affected live root/leaf matched stored identity at inspection
time, so the earlier generic failure's precise cause is not established.

This repair requires normal rebuilt-backend adoption. An earlier generic send
failure's exact cause remains unknown unless contemporaneous evidence identifies
it. A real stored-identity mismatch still requires the separately authorized,
verified operator recovery described in the original decision; it is not solved
by silently trusting the current path.
