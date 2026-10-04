# Stable standalone workspace ownership and bounded startup

Decision status: Accepted implementation choice within the user's startup-repair request.
Implementation status: Implemented; release verification recorded separately.
Created: 2026-10-04 16:30:50 JST (UTC+0900).
Last updated: 2026-10-04 16:30:50 JST (UTC+0900).
Supersedes: Only the assumption in [standalone chats](standalone-chats.md) that a
macOS device number is durable across restarts. All other workspace, fork,
cleanup and permission boundaries remain in force.

## Evidence and decision

A standalone first-send was rejected before provider startup because the saved
root inode still matched but macOS had assigned a different mount device number.
The first-message metadata path let this preparation error escape to logging,
leaving the durable provisional session displayed as Starting indefinitely.

On macOS, persist `darwin-volume:<VolumeUUID>` and the bigint inode in the existing
text identity fields. Read native volume metadata through fixed shell-free
`/bin/df` and `/usr/sbin/diskutil` commands, each limited to five seconds and
64 KiB. Admit only a strict disk device path, verify its block-device `rdev`
against the held directory's `dev`, require one exact UUID and matching device
node, and recheck the device. Helpers receive a fixed minimal environment.
There is no persistent device-to-volume cache.

Raw device/inode observations still bind the path and no-follow held descriptor
before and after metadata lookup and before chmod. A leaf must remain on its
admitted root's filesystem. Stable volume identity does not weaken inode,
owner, symlink, quarantine, fork-reference or final root-recheck requirements.
Cancellation is checked before subsequent permission or cleanup mutations.

Legacy root and same-device leaf rows upgrade transactionally only after exact
legacy device/inode admission. The transaction rechecks ownership before any
leaf update. A legacy mismatch is inconclusive: never silently rebind it using
inode alone. Operator-assisted recovery must back up the exact rows, verify the
root and every affected leaf on the intended current volume, and compare-and-swap
only those identities. It must not delete directories, replay messages or change
provider ownership. An older running binary still requires numeric identities;
upgrade to UUIDs only with the new code.

The legacy scheme remains unchanged on other hosts; macOS-tagged identities are
not silently adopted there. Native compatibility notes are maintained in the
repository's Windows-specific instructions.

## Startup behavior

Optional first-message title/branch preparation runs entirely in its best-effort
fiber. Required local standalone workspace preparation has a 15-second deadline.
Preparation failures produce a sanitized visible start failure, fenced against
newer input, Stop, changed lifecycle, and authoritative active native work.
Unknown inventory is not proof that no provider is running.

Codex's owning adapter bounds native acquisition to 60 seconds, including process
construction, initial descriptor, event bridge, initialization and thread open.
Failed acquisition retires only its exact runtime/scope before returning; late
completion cannot publish ownership. Preflight and desktop binding are outside
this particular native-acquisition budget. Neither deadline measures model
silence or authorizes retrying a paid prompt. Existing accepted-turn handling and
[verified runtime recovery](verified-runtime-recovery.md) remain authoritative.

## Alternatives and verification

Discarding device identity or trusting a copied marker would weaken replacement
protection. Raising a generic timeout would not expose an already-failed local
preparation, and token-silence timeouts would interrupt legitimate reasoning.
These alternatives are rejected.

Default fixtures cover malformed/native-helper responses, cross-platform policy,
remounts, replacement, legacy migration races, startup cancellation/deadlines and
current lifecycle protection. Run the pinned repository checks and full tests,
then `yarn build:desktop --force` last. Native macOS metadata qualification is
explicit and uses only a temporary directory:

```sh
corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/StandaloneFilesystemIdentity.e2e.test.ts
```

No live provider credentials or inference are required. A successful rebuild is
not evidence that an already-running desktop/backend has adopted the new code.
