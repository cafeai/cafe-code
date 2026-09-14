# Codex 0.154 compatibility

Last updated: 2026-09-10 11:58:47 JST (UTC+0900)

Audited against official release `rust-v0.154.0`, commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340`. Compare exact release trees rather than GitHub's merge-base comparison: patch-release branches can otherwise include unrelated changes.

## Implemented

- Regenerated app-server schemas from the immutable release. The method inventory remains 102 client RPCs, 10 server requests, 83 server notifications and one client notification. New optional account rate-limit flags and metadata, reasoning history configuration, MCP discovery errors and originator metadata decode without requiring older callers to send new parameters.
- Added a nonblocking inline-question panel for completed root `agentMessage.questions`. Suggestions and freeform answers enter Cafe's durable follow-up queue with the ordinary message identity/recovery rules. The main draft and its attachments are independent. A successful local enqueue is not a claim of provider execution; queued answers retain Cafe's normal visible delivery/steering controls.
- Kept existing asynchronous assistant text visible and independent of terminal turn state. Neither inline question arrival nor an answer marks a provider turn complete.
- Refreshed provider-setting guidance for model/backend-dependent agent defaults rather than naming an outdated default model.

The [interaction decision](decisions/codex-inline-questions.md) records bounds, consent, identity, persistence, and deliberate differences from terminal UX.

## Audited and already compatible

The spawned-agent setting is still `agents.max_concurrent_threads_per_session`, with alias `agents.max_threads`, minimum one and upstream `usize` representation. Cafe deliberately limits overrides to 1–64. V1 defaults to six children; V2 defaults to four total threads, or three children. Explicit V2 total wins; Cafe translates public `N` to total `N + 1`. Omission delegates to upstream model/backend/user configuration. OpenAI Astra/Sol/Terra use V2 and Luna uses V1; Bedrock forces V1.

Astra's embedded metadata remains 272,000 normal / 872,000 maximum context, low through ultra effort and priority service tier. Live model metadata remains authoritative. Bedrock strips Fast and Ultra; do not copy OpenAI Astra capabilities onto Bedrock slugs. Sol's newly advertised `ultrafast` tier is distinct from Cafe's existing Fast (`priority`) toggle and is not silently selected or relabelled.

`remote_compaction_v2`, `goals`, and now `compaction_image_budget` are stable/default-enabled. Cafe leaves compaction flags and thresholds to the provider unless explicitly configured. The retained-message budget remains 64,000 tokens; the attempt builds the model-visible tool catalog; image generation still depends on account, model, provider and authorization gates. `update_plan` still needs Cafe's explicit `tools.update_plan.enabled=true` override. No paid live compaction smoke was run in this audit, so account-specific behavior is not claimed verified.

Cafe's durable steer IDs, exact-turn binding and HMAC correlation already cover upstream's retained submission-ID improvements. Callback-based `request_user_input`, approval deadlines, stdin approvals, auth recovery and partial-stream reconciliation retain their existing ownership. Normal start/resume/steer request behavior is unchanged.

## Deliberately not enabled

Provider-native experimental worktrees, provider-native queues and background daemon adoption are not replacements for Cafe's worktree, queue or authenticated daemon. They require a separate ownership/retention design. Terminal Vim keys, copy formatting and dynamic slash commands remain provider UI features. Plugin refresh and MCP OAuth coordination are performed by the installed provider; Cafe must not replay rejected tool calls or take over OAuth secrets.

An externally owned Codex writer continues to fail resume safely, retaining Cafe's transcript and draft for retry; Cafe does not acquire writable authority by opening a provider read-only view. Usage reserve support is not advertised merely because its flags now decode. `configuration_update` is provider history, not a user prompt variant. No global CLI upgrade, credential mutation, live task restart, historical repair or inference call is part of this change.

## Sources

- [Official release notes](https://learn.chatgpt.com/docs/changelog).
- [Immutable app-server protocol](https://github.com/openai/codex/tree/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/app-server-protocol).
- [Inline question delivery](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/tui/src/chatwidget/questions.rs) and [bounded question state](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/tui/src/bottom_pane/async_questions/state.rs).
- [Answer framing](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/context-fragments/src/answered_question.rs).
- [Agent configuration and defaults](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/core/src/config/mod.rs), [feature stages](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/features/src/lib.rs), and [Bedrock catalog](https://github.com/openai/codex/blob/6b9826e3aa83b1a5947db50f4332cb9c65f1b340/codex-rs/model-provider/src/amazon_bedrock/catalog.rs).

## Reproducible verification

Use the repository's pinned standalone Node and Corepack-managed Yarn 4.17.1 with the updated lockfile. The web workspace directly pins the already-resolved `@noble/hashes` 2.2.0 for browser-safe SHA-256 question identity, including clients without SubtleCrypto; no custom cryptographic implementation is added. The registry's publication timestamp is 2026-04-11T17:09:41.131Z, well past the mandatory 24-hour quarantine. Root Yarn install resolves the explicit dependency without changing its existing version. New checkouts use the normal immutable install; no global runtime or provider package upgrade is needed. The generator owns `_generated/*`; regenerate through `yarn workspace effect-codex-app-server generate`.

Focused tests cover optional usage parameters, strict capability types, history-only input rejection, question normalization/Unicode/size limits, bounded root-only question projection, compaction/replay suppression, queue acceptance/rejection, draft isolation, and content-free diagnostics. Run root `yarn fmt`, `yarn lint`, `yarn typecheck` and `yarn test`; run `yarn build:desktop --force` after tests as the final build verification. The build does not replace already-running desktop or daemon processes.
