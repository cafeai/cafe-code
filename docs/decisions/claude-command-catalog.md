# Claude commands scoped to the live query

Decision status: Accepted. Implemented with synthetic qualification; shared release gates are tracked separately.
Last updated: 2026-10-05 11:11:51 JST (UTC+0900).
Decision authority: implementation discretion within the user-authorized provider parity work. Supersedes: none.

## Context and alternatives

The account-level status catalog cannot establish which commands belong to a
particular live workspace/query. Restarting discovery would add a separate
provider process and still race the running query. The SDK already provides
full replacement metadata on that query, so the chosen boundary is a volatile,
owner-only subscription. It adds no database cache or command execution API.

## Behavior

Opening `/` in an existing Claude chat subscribes to that query's current command
catalog. Additions, removals and renames replace the previous list while the picker
is open. Choosing a suggestion inserts the exact admitted native name. Built-in
Cafe commands and manual command entry remain available when metadata is loading
or unavailable. A draft without a live query does not borrow another chat's
catalog. Other providers retain their existing command sources.

The picker clears commands immediately on account, environment, workspace or
query-generation changes and while disconnected. Reconnecting or reopening gets
a fresh cached snapshot from the server. Unavailable metadata is labeled visibly,
without showing stale entries as current. No command is executed by discovery.

## Provider contract

The installed, pinned Agent SDK **0.3.288** declares `Query.supportedCommands()`
and `SDKCommandsChangedMessage` in `sdk.d.ts`. Its documented `commands_changed`
contract is a complete replacement list; `supportedCommands()` returns the
latest pushed list. The [official SDK skills and commands guide](https://code.claude.com/docs/en/agent-sdk/slash-commands)
documents session-based command discovery and named dispatch. This implementation
uses the existing running query, its initial cached metadata, and subsequent
pushes. It sends no `reinitialize`, prompt, probe, restart or inference request.
The configured native executable and its launch identity remain unchanged.

Initial metadata waits at most eight seconds outside the turn-start path. A push
advances query-local authority so an older initialization result cannot overwrite
it. Before native initialization, at most one complete push is retained; it stays
unavailable until initialization establishes its matching native session. Missing
or foreign session identities cannot invalidate a good catalog or rebind the
conversation. A changed native conversation invalidates prior metadata.
Pre-init native session identifiers are admitted only within a 1,024-character
bound, before they can advance revision authority or replace the pending level.

## Ownership and resource bounds

The catalog belongs to the adapter's immutable query context. Its volatile
`ProviderSession` inventory carries the catalog and a private SHA-256 commitment
to decoded configured runtime settings and configured environment. The commitment
allows current settings to reject an old query during asynchronous account
reconciliation. It is not an authorization token and is never returned by the
picker API. Presentation-only account names and colors do not affect it.

Owner-only `server.subscribeProviderCommands` accepts a Cafe thread, instance and
query-generation id. It resolves saved thread/project/standalone workspace
authority, rejects archived/deleted/foreign sessions, and compares exact cwd and
configuration before and after a bounded cached inventory read. It never accepts
a client-supplied native session or filesystem path. Standalone resolution remains
read-only and retains its existing volume/inode admission.

Each query coalesces publication into a finite 50 ms window. Canonical runtime
events contain only the `commandCatalogChanged` invalidation Boolean: command
labels, hints and configuration commitments are not added to the durable event
journal or orchestration activity. Session-binding persistence already allowlists
its fields and does not persist this catalog. Explicit native diagnostic logging
retains its pre-existing behavior.

Each open picker has one metadata read and one trailing invalidation slot.
Subscriptions start before the first read. Events during a slow read therefore
request a replacement instead of disappearing in a snapshot/subscription gap.
Reads have a five-second bound and errors become fixed unavailable results. A
renderer also bounds an absent first response to six seconds. Closing the picker
retires only its subscription. There is no persistent catalog cache or polling.

Complete snapshots are limited to 512 commands. Tokens must match the bounded
128-character inert command grammar; invalid tokens are omitted without trimming,
case folding or other executable-identity repair. Description and hint limits are
512 and 256 characters, with control, newline and bidi controls rejected. Unknown
fields such as paths, prompts and plugin internals never enter the public schema.
Oversized or malformed complete lists become unavailable, rather than a partial
list described as current. Provider-owned text remains escaped display metadata.

## Qualification

`claudeCommands.test.ts` covers token identity, hostile metadata, size limits,
case-sensitive names and configuration binding. `ClaudeAdapter.test.ts` covers
replacement/removal, repeated pre-init pushes, slow initialization, foreign native
identity, query replacement and content-free coalesced invalidations.
`providerCommandsSubscription.test.ts` covers account/cwd/config/query authority,
slow reads, bursts, bounded failure and recovery. `server.test.ts` exercises the
owner RPC, paired non-owner rejection and reconnect snapshots. The browser tests
exercise live menu replacements, exact token insertion, account/project/query
changes, disconnection/reconnection, unavailable labels and manual input.

These credential-free fixtures do not assert live plugin execution or paid
provider compatibility. Normal session adoption supplies the new adapter behavior;
existing live providers are not interrupted to apply this change.
