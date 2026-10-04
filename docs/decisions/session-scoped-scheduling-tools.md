# Decision: automatic, session-scoped scheduling tools

Status: Implemented; release verification in progress
Last updated: 2026-10-04 23:49:09 JST (UTC+0900)
Decision authority: user requested automatic internal scheduling per Cafe chat/account, without an installer, and explicit review of the account executing and paying for scheduled work.
Partially supersedes: [scheduled follow-ups](scheduled-followups.md), internal MCP connectivity only. Its scheduler, owner approval, delivery and uncertainty policies remain authoritative.

## Context

The optional management installer registers tools in a provider's default user configuration. Custom homes do not necessarily inherit it, and private-file admission can refuse unsafe ancestors. That broad connection is neither a reliable multi-account solution nor an appropriate prerequisite for internal scheduling. Loosening home permissions or silently editing every profile would cross unrelated trust boundaries.

## Decision

The actual provider runtime binds a narrow scheduling capability to each Codex, Claude or Grok session's exact Cafe chat and provider instance. A unique per-session stdio MCP definition launches Cafe's existing executable in Node mode with a standalone bridge and private connection-file path. Credentials never appear in arguments, environment variables, saved provider configuration, renderer state, native event logs or the durable daemon command ledger. No global provider configuration or permission allowlist is modified.

Codex receives complete structured startup `-c` configuration with `required=true`. Claude receives per-query SDK `mcpServers` with `alwaysLoad=true`, without changing `allowedTools` or clearing existing MCP settings. Grok receives ACP stdio configuration alongside its existing management connection. Native resume preserves history while obtaining a fresh capability.

Pending capabilities permit MCP initialization/catalog discovery only. Actual operations require the active durable generation. Grok may stage a replacement while the old session remains authoritative; failed candidates cannot revoke it. Activation compares the captured predecessor and commits the new generation before retiring older credentials. Exact-generation cleanup cannot invalidate a newer replacement. Runtime restart invalidates old durable grants, and hard deletion revokes the chat's capability.

`/mcp/scheduling` is separate from management and desktop MCP. It accepts only a local direct peer with a scheduling capability. The LAN HTTPS proxy marker is rejected; forwarded locality is never trusted. When the main backend binds a specific non-IPv4-loopback interface, a narrow second listener exposes only this endpoint on IPv4 loopback at the same port. It never exposes management APIs or silently switches ports. Daemon authorization uses a bounded authenticated request outside the replayable command ledger, forwarded by a supervisor to the actual runtime owner.

HTTP authentication alone cannot authorize a mutation. Within the operation's SQL transaction, the service takes the writer and rechecks exact chat, instance, capability digest and runtime/session generation. Strict schemas expose only `request_scheduled_followup`, `list_scheduled_followups` and `pause_scheduled_followup`. Inputs omit chat/account/model selectors; identity overrides are rejected rather than ignored. No enable, run or result-report tool is exposed. Proposals remain inert until owner review in Tasks.

Account changes commit a durable review fence, invalidate unattempted runs and revoke old execution approval even for A → B → A between scheduler ticks. Already attempted work keeps its recovery evidence and is not interrupted. Permission-mode changes also require execution review but keep proposal tools usable. Owner UI saves/enables include the reviewed instance, checked under the writer lock. Existing owner clients can omit this additive field; their existing revision fences remain. Profile identity is not immutable billing-credential identity: external credential replacement inside one profile follows ordinary provider authentication semantics.

## Lifecycle and storage

Private OS-minted temporary directories hold connection files and copied single-file bridges independently of broad home-ancestor permissions. Cleanup validates exact directory/file identity and removes only owned entries; namespace uncertainty preserves evidence. No installer policy or home permissions are weakened. Runtime shutdown revokes authority before cleanup; crash-left files cannot regain authority after runtime restart.

The detached provider daemon owns capabilities. Backend/renderer reconnection does not revoke surviving sessions. Schedules still require the backend and an awake host; persistence and coalesced catch-up are unchanged. No OS service is added. Existing old sessions require normal rebuilt-runtime adoption and session restart/resume; deployment never interrupts live work or replays prompts.

## Alternatives rejected

- Broad installer or editing every account home: unnecessarily broad, persistent external changes and conflicts.
- General owner tokens or bearer values in arguments/environment: disclosure and cross-chat authority.
- Revocation on candidate allocation: breaks the original session when staged replacement fails.
- Poll-only account checks: switching away and back can reuse approval without review.
- Paid activation from model prose: no proof of reviewed instructions or paying account.

## Qualification

Use isolated SQLite, actual MCP wire clients, synthetic SDK/ACP/app-server peers, private temporary files and bounded local HTTP. Cover replacement, failure, revocation, restart, custom accounts, cross-chat rejection, account round trips, strict overrides, sanitization, cleanup uncertainty and unchanged permissions. Standalone artifact qualification copies each bridge alone so sibling chunks cannot conceal packaging failures. Browser tests preserve existing color tokens and exercise automatic-tool guidance and paying-account review.

Release gates: formatting, lint, typecheck, complete tests, relevant browser/isolated bridge qualification, then final forced desktop build on unchanged source. Exact hosted native-platform checks are separate from local evidence. No tests invoke paid inference, read real provider credentials or mutate the live database.

Sources: [OpenAI MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [OpenAI one-off configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#one-off-overrides-from-the-cli), [Claude Agent SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp), plus pinned Codex app-server, Claude SDK 0.3.288 and ACP types. Native provider tool permissions remain authoritative; Tasks approval separately authorizes recurring execution.
