# Per-chat Codex context-window override and live account fallback

Decision status: Accepted
Created: 2026-10-12 11:10:24 JST (UTC+0900)
Last updated: 2026-10-12 11:35:59 JST (UTC+0900)
Decision authority: User accepted the Codex-only menu/sidebar design, requested
implementation/testing and this changeset's push to dev, then added a provider
default with per-chat precedence matching subagent-limit inheritance.
Implementation status: Implemented; synthetic qualification below, hosted release evidence separate
Supersedes: None
Superseded by: None

## Context

Codex owns its model catalog, effective context window and automatic compaction.
Cafe forwards the reported usable window instead of imposing a model-name-based
budget. Users nevertheless need explicit numeric context intent for one chat or
an account-level fallback without affecting unrelated accounts or ongoing work.
Changing a displayed meter is not a native configuration change.

## Alternatives and rationale

- A global native configuration write affects other clients and chats and would
  exceed the authority of a chat editor.
- A sticky model option or copying account defaults into each new chat leaks
  preferences into unrelated chats and prevents live fallback changes.
- Reconfiguring at save time can interrupt a root or resident agents and race
  received native notifications. A pending preference is not idle authority.
- Replacing the meter with the requested number falsely reports capacity before
  native clamping/headroom and does not establish account eligibility.

Use dedicated requested metadata and independently recorded materialized session
configuration, with live account fallback and the existing native idle guard.

## Decision

`codexContextWindowOverride` is optional nullable chat metadata with a positive
safe-integer numeric override. Omitted metadata patches are unchanged; null clears
the chat choice. `defaultCodexContextWindowOverride` is a lifecycle-neutral account
preference outside runtime configuration. Resolve the selected Codex chat number,
then the exact selected account default, then native configuration/catalog.
Blank/Reset restores fallback, not a baked-in numeric default. Clearing an account
default affects inherited chats but preserves explicit chat choices. Do not seed
defaults into drafts. Other drivers never consume either setting.
An explicit local Codex choice also survives first chat creation through another
driver as chat metadata only; the non-Codex turn and native configuration omit it.

The existing composer menu gains Context window… beneath Subagent limit… and
above Mode, using a small editor outside the transient menu portal. Bind local
edits and acknowledged overlays to environment/chat/draft/account/model identity.
Canonical committed metadata sequencing defeats stale shell/detail/ACK races.
Settings offers the Codex-only account default with equivalent validation/clear.

Context/Tasks popover and docked rail share a compact requested/current policy
presenter beside subagent-limit details. Matching known numbers show one override;
different known policies show the current-to-saved transition conditionally when
idle. Unknown materialization is saved, not applied. Pending clear retains known
current numeric evidence until native replacement. Source explanation lives in
the accessible tooltip. The native `maxTokens` meter remains unchanged.

Saving changes metadata only. A later ordinary send may reconcile a different
effective policy under the existing exact owner, root/child, ingress and final
lifecycle lock guard. Steers keep the current process. Unknown native child state
or inconclusive retirement never authorizes a competing process or prompt replay.
Context-only and combined subagent/context changes share the native guard; only
typed refusal of a pure policy replacement can preserve the previous process.

At a qualified native start/resume send a numeric `config.model_context_window`;
omit the key for native inheritance. Do not send native JSON null: the reviewed
0.162.1 JSON-to-TOML adapter maps null to an empty string, not deletion. A reset
must defeat Cafe's old materialized fallback and safely resume from baseline
configuration with the account default or native key omitted. It does not erase
a user-owned native config override. Automatic compaction, retention, tool budgets,
permissions and global files remain unchanged.

## Source contract and limits

The [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents the optional numeric setting; [app-server](https://learn.chatgpt.com/docs/app-server)
supports thread start/resume configuration overrides. The immutable reviewed
source is Codex 0.162.1 commit
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`:

- `app-server/src/config_manager.rs::load_with_cli_overrides` reloads baseline
  plus request overrides.
- `utils/json-to-toml/src/lib.rs::json_to_toml` maps JSON null to an empty string.
- `app-server/src/request_processors/thread_processor.rs` cold resume loads
  baseline/request configuration. Its persisted metadata merge restores model,
  provider and reasoning effort; `persisted_resume_settings.rs` restores only
  approval/reviewer/permission metadata, not the previous context override.
- `models-manager/src/model_info.rs::with_config_overrides` clamps requested
  context to native `max_context_window` where present.
- `protocol/src/openai_models.rs::ModelInfo` owns usable headroom and compaction;
  `core/src/session/turn_context.rs::model_context_window` reports usable capacity.

Cafe qualifies explicit numeric intent using the configured owner-local stable
runtime version, not a model label or package pin. Unknown/prerelease/older owners
and absent authenticated capability remain unsupported. No new health probe is
introduced. A requested number is not independently verified model capacity or
permission to bypass upstream policy.

## Security, privacy and failure consequences

Validate numeric intent at renderer, contract and runtime boundaries. Keep exact
account/driver/process ownership separate from saved settings. No credentials,
profiles, transcripts or raw provider errors are read or copied for the editor.
Metadata and numeric capability/configuration evidence are content-free. Existing
authenticated command identities and durable publication ordering govern writes.
An execution-affecting context metadata edit, including Reset, invalidates an old
unattended recovery authority through the existing indexed control ledger. It
does not synthesize fresh input or historical continuation consent.
Failed saves preserve local edits; unsupported admission preserves the prompt or
queue row rather than silently ignoring intent or automatically resubmitting.
No new provider calls on render/save, OS policy, permission, launch or native
platform ownership behavior is introduced.

## Compatibility and verification impact

Additive contracts and a deterministic migration preserve old snapshots and
distinguish unknown materialized evidence from known absence. Chat request intent
survives reload/recovery/fork/duplicate; new unrelated chats remain inherited.
Old daemon capability omission cannot qualify a new numeric override. Normal
rebuilt daemon/session adoption is required; this does not repair live sessions.

Synthetic contracts, isolated SQLite/projections, resolver/admission/native peer
and browser tests must cover precedence/clear, omitted/native numeric translation,
busy root/children/ingress races, safe reset, unknown legacy evidence, exact owner
switches, stale metadata, draft promotion and no leakage. Browser tests retain
existing workers/deadlines and native-host subset discipline. Required repository
checks and the forced desktop build last gate publication. Local fixtures do not
prove a real account's context availability or native multi-OS release success.

## Synthetic qualification

Focused qualification covers numeric/Reset durable projection and recovery
cancellation; same-ID driver replacement and generation-only adoption; combined
native idle refusal; live account precedence/clear; local draft bootstrap through
Codex, Claude and Grok; independent canonical ACK ordering; and keyboard,
locale/theme/scale/reduced-motion dialog and Tasks presentation. The last two
Ingestion regressions reproduced incorrect numeric/null carry before correction.
Only exact-account, exact-Codex-driver and compatible-generation observations
retain materialized configuration; unchanged legacy unknown generations retain
recorded configuration but never acquire ownership or idle authority.

Use the repository-pinned Node and Corepack Yarn, without live provider/profile
assumptions, for targeted reproduction:

```sh
corepack yarn workspace @cafecode/contracts test src/codexContextWindow.test.ts
corepack yarn workspace @cafeai/cafe-code test src/persistence/Migrations/094_CodexContextWindowOverride.test.ts src/orchestration/Layers/SubagentLimits.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.test.ts src/orchestration/Layers/ProviderCommandReactor.test.ts src/provider/codexContextWindowPolicy.test.ts src/provider/Drivers/CodexContextWindow.test.ts
corepack yarn workspace @cafecode/web test src/codexContextWindow.test.ts src/storeCodexContextPolicy.test.ts src/composerDraftStore.test.ts src/store.test.ts
corepack yarn workspace @cafecode/web test:browser src/components/chat/CodexContextWindowControl.browser.tsx src/components/chat/useCodexContextWindowOverride.browser.tsx src/components/chat/CodexContextWindowControl.motion.browser.tsx src/components/chat/ContextWindowDetails.browser.tsx src/components/settings/ProviderInstanceCard.layout.browser.tsx src/components/ChatView.standalone.browser.tsx
```

The motion-only file runs after the existing desktop/touch groups in its own
native provider-owned reduced-motion context, not a media mutation on a reused
worker. CI includes all new browser files in the existing macOS/Windows focused
selection; Linux retains the full suite and all worker caps/deadlines are unchanged.

See the [user guide](../codex-context-window.md),
[live subagent fallback decision](live-account-subagent-default.md) and
[original subagent safety boundary](per-chat-subagent-concurrency.md).
