# Bounded, account-scoped Codex skill discovery

Created: 2026-10-05 06:47:48 JST (UTC+0900)
Last updated: 2026-10-05 07:12:05 JST (UTC+0900)
Decision status: Accepted within the authorized provider-parity implementation
Implementation status: Implemented; focused qualification passed, integrated release gates pending

## User behavior

Typing `$` opens the existing skill picker and explicitly refreshes the selected
Codex account's skills for this chat's workspace. Further keystrokes filter that
result without additional subprocesses. Closing and reopening refreshes it again.
Selecting a skill inserts Cafe's existing inert `$name` reference, not file contents
or a filesystem path. Codex resolves that named skill when the normal turn runs.
No automatic execution, prompt copying or additional paid model request occurs.

The picker shows loading, empty, disabled/authentication and retryable unavailable
states. Account, project, chat or environment changes hide the previous result
immediately and fence late responses. Workspace moves, configured provider changes
and observed account changes also invalidate results under unchanged public ids.
Their renderer-only revision never becomes RPC cwd authority and excludes periodic
health timestamps, quotas and model-list refreshes. A draft can discover the saved project's
root skills. A not-yet-created worktree or neutral standalone directory must first
be provisioned through normal chat startup; Cafe does not substitute another cwd
or create directories just because the picker opens. Saved worktree chats use
their actual server-owned worktree path.

## Authority and protocol

The authenticated owner-only `server.listProviderSkills` RPC accepts only an
instance id and a saved thread/project id, never a client-supplied cwd. The server
resolves that context before and after discovery. Removed/archived threads and
changed project/worktree authority fail closed. Existing standalone directories
are admitted against the stored root/leaf volume/inode ownership without creating
files, changing permissions or migrating database records.

The registry binds each result to the same immutable provider-instance object,
discarding it after settings/account replacement even if its public id is reused.
The Codex driver checks its cached enabled/authenticated state and uses the existing
private metadata client with that instance's exact executable, home and environment.
After initialize, it issues only `skills/list { cwds: [authorizedCwd], forceReload: true }`.
The callback starts no native thread and reads no account/model catalogue. Startup,
health, rate-limit refresh and generic provider badges remain on their cheap paths.

The configured native executable remains responsible for skill permissions,
precedence, deduplication and file resolution. Source evidence is Codex
`rust-v0.160.0`, immutable commit `a956835d020762cb2b570053af06f643a11c0ecc`,
`app-server/src/request_processors/catalog_processor.rs::skills_list_response`.
Its explicit-cwd and force-reload behavior matches the existing generated protocol;
no executable installation or schema regeneration is needed.

## Resource and privacy limits

At most one metadata discovery runs per instance, with a 15-second driver budget
and a 20-second RPC budget, including semaphore wait. The existing metadata child
release policy remains responsible for bounded TERM/KILL cleanup. No retry loop,
global snapshot publication, persistent cache or background polling is introduced.

Public mapping requires exactly one matching cwd entry, bounds the native entry
list to 16 and skills to 512, and rejects partial-error responses. Only enabled
skills with the supported bounded `$name` grammar are exposed. Names are deduplicated
in native order; labels reject control and bidi characters and have finite bounds.
The dedicated transport schema cannot serialize native paths, icon paths, prompts,
dependencies or raw provider errors. Scope and optional plugin provenance remain
inert presentation metadata. Ordinary browser escaping still applies.

The disposable metadata client explicitly disables protocol payload logging,
including malformed-response diagnostics. The protocol's default decode-failure
logger otherwise retains rejected wire JSON even when normal incoming logging
is off. Picker failures retain only the caller's fixed phase/outcome diagnostics;
private paths and account metadata must not enter logs or tracer annotations.
`CodexMetadataPrivacy.test.ts` drives the actual decoder with an isolated in-memory
child and a private sentinel; restoring the old logger behavior makes it fail.

## Qualification

Synthetic mapper/protocol tests cover exact cwd, reference injection, disabled and
duplicate names, partial failures, entry/count/label bounds and path-free decoding.
RPC fixtures cover exact instance/worktree dispatch, missing threads, non-owner
rejection before provider access and context replacement during discovery. Registry
fixtures cover replaced/disabled/incapable instances without native processes.
Standalone fixtures verify no directory/SQL/permission mutation and replacement
identity rejection. Browser fixtures cover gesture-only reads, explicit refresh,
environment/account/project stale-response fencing, completed and slow results
after same-id workspace/configuration changes, no periodic metadata-triggered
reprobes and redacted unavailable states.

These tests do not claim live account permission/skill execution qualification.
The combined release must still pass formatting, lint, typecheck, the full tests
and the final forced desktop build, followed by exact-head platform CI.
