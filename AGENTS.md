# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).
- When a change touches Electron packaging, backend bootstrap, provider daemon startup, or generated bundle boundaries, also run `bun run build:desktop`.
- Rust takes a while to compile. Do not prematurely kill Rust/cargo builds.
- Integration tests that require live provider binaries, real provider credentials, process reaping, or detached daemon handoff should be explicit `*.e2e.test.ts` or documented opt-in commands. Do not silently put flaky external-provider assumptions on the default test path.

## Search Discipline

- Prefer `rg` and `rg --files` for source discovery. Do not run broad `find` searches from `/`, `/usr`, `/opt`, `/Users`, or other high-level roots unless the task absolutely requires it and the reason is stated first.
- Keep filesystem searches targeted to the repository subtree or a specific known parent directory. Exclude generated and dependency-heavy directories such as `node_modules`, `target`, `__pycache__`, `.git`, `.turbo`, `.astro`, `dist`, and `build`.
- When `find` is necessary, use bounded roots plus pruning/exclusion predicates instead of scanning the whole machine.

## Project Snapshot

Cafe Code is a desktop GUI for coding agents such as Codex, Claude, Cursor, and OpenCode. The project is still early and inherited code may be incorrect or overfit to older fork behavior. Prefer evidence-backed fixes, strong diagnostics, and maintainable redesigns over small patches that only hide symptoms.

Core priorities:

1. Performance first.
2. Reliability first.
3. Security first.
4. Keep behavior predictable under load and during failures such as restarts, provider crashes, partial streams, delayed provider wakeups, and reconnects.

If a tradeoff is required, choose correctness, durability, and debuggability over short-term convenience.

## Security Requirements

- Write all code as if it will run in a security-conscious environment where adversaries will constantly try to attack local transports, provider sessions, provider credentials, persisted command ledgers, and debug surfaces.
- Local provider daemon and supervisor transports must be loopback-only or IPC by default, authenticated with high-entropy capability tokens, and must never be exposed on a non-loopback interface without an explicit authenticated design.
- Secrets such as provider daemon tokens, Codex auth, Claude credentials, and app bootstrap credentials must be stored as private files with restrictive permissions where the platform supports them. Never persist secrets in logs, debug JSON, process argv, or user-visible error strings.
- Do not symlink auth files into shadow homes. Copy private auth files when needed, chmod them to `0600`, and reject unsafe symlinked auth material.
- Debug endpoints may expose operational diagnostics but must not expose raw prompts, full model outputs, bearer tokens, cookies, auth JSON, API keys, or unrestricted filesystem paths unless the user explicitly asks for a local forensic dump.
- Any change touching provider process ownership, daemon handoff, provider-home materialization, approval handling, command execution, or debug output needs a quick security audit and tests for the failure mode being addressed.
- Inform the user when security-related behavior changes.

## Maintainability

- Long-term maintainability is a core priority. If you add functionality, first check for shared logic that belongs in a separate module. Duplicate lifecycle or provider-connection logic across files is a code smell.
- Do not write stubs or incomplete code. Finish the behavior, tests, diagnostics, and cleanup needed for the requested change.
- Prefer structured schemas, generated protocol types, durable state machines, and explicit event names over stringly-typed local conventions.
- Add verbose comments for non-obvious code. Lifecycle, provider connection, daemon/supervisor, auth, persistence, and protocol-boundary code should be especially well commented.
- Comments should explain why a state transition, timeout, reconciliation step, security check, or provider protocol workaround exists. Do not leave lifecycle code with unexplained magic constants or unexplained "best effort" branches.
- When implementing Codex, Claude, or other provider protocol behavior, reference official docs and, where available, the provider's current SDK types or open-source implementation. Record important source-derived assumptions in comments near the code that depends on them.
- Keep this file's architecture sections current. Any change that modifies how a provider starts, resumes, streams, retries, falls back, asks for approval, persists session identity, hands off to a daemon/supervisor, or reports diagnostics must update the matching provider section below so future agents inherit the current design instead of stale fork assumptions.

## Package Roles

- `apps/desktop`: Electron main process, desktop bootstrap, debug server, backend process manager, provider daemon manager, and local process reaper. This is where app startup decides whether to adopt, spawn, stop, or leave detached runtime processes alive.
- `apps/server`: Node.js backend and provider runtime host. It serves the web assets, exposes WebSocket/API surfaces, owns orchestration, persistence, provider adapters, the provider daemon HTTP/RPC server, and provider supervisor support.
- `apps/web`: React/Vite Electron renderer. It owns session UX, message timelines, scroll behavior, settings UI, and client-side state. It receives orchestration domain events from the backend and must not invent provider lifecycle state that the backend did not emit.
- `packages/contracts`: Shared Effect Schema contracts for provider runtime events, orchestration events, daemon RPC/health, supervisor metadata, WebSocket/API protocol, desktop bootstrap, settings, and model/session types. Keep this package schema-only; do not add runtime business logic.
- `packages/shared`: Shared runtime utilities consumed by server, desktop, and web. Use explicit subpath exports such as `@cafecode/shared/git`; avoid barrel indexes.
- `packages/effect-codex-app-server`: Typed Codex app-server JSON-RPC client/protocol surface. Keep this aligned with the Codex version we are targeting.
- `packages/effect-acp`: ACP protocol support used by compatible providers.

## Current Runtime Architecture

Cafe Code has three important runtime layers:

- Electron desktop process: starts the UI, starts/adopts the main backend, starts/adopts the provider daemon, exposes a local debug endpoint, and performs process cleanup when the user exits.
- Main backend/server: owns app-level orchestration, event sourcing, projections, settings, WebSocket pushes, HTTP routes, and durable persistence.
- Provider runtime process: a provider daemon, and optionally a persistent provider supervisor, owns long-running provider adapters and live sessions so provider work can survive UI/backend restarts when possible.

Important files:

- Desktop provider daemon bootstrap and adoption: `apps/desktop/src/backend/DesktopProviderDaemonManager.ts`.
- Desktop process reaping: `apps/desktop/src/backend/DesktopProcessReaper.ts`.
- Provider daemon HTTP/RPC/health/events server: `apps/server/src/providerDaemon/ProviderDaemonServer.ts`.
- Provider daemon runtime layer selection: `apps/server/src/providerDaemon/ProviderDaemonRuntime.ts`.
- Provider daemon command idempotency and persistence: `apps/server/src/providerDaemon/CommandLedger.ts`.
- Provider daemon event replay/journal: `apps/server/src/providerDaemon/EventJournal.ts`.
- Remote provider bridge used by the main backend: `apps/server/src/providerDaemon/RemoteProviderService.ts`.
- Provider runtime inventory and diagnostics: `apps/server/src/providerDaemon/ProviderRuntimeInventory.ts`.
- Supervisor process support: `apps/server/src/providerDaemon/ProviderSupervisorProcessManager.ts` and `apps/server/src/providerSupervisor/ProviderSupervisorRegistry.ts`.
- Orchestration command handling: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`.
- Provider runtime event ingestion: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`.
- Projection updates: `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` and `apps/server/src/orchestration/projector.ts`.
- Provider service/session directory: `apps/server/src/provider/Layers/ProviderService.ts`, `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts`, and `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`.

## Lifecycle Model

- The renderer requests intent; it does not own provider truth. User actions become orchestration commands/events, then `ProviderCommandReactor` calls `ProviderService`, which routes to the provider daemon or local adapter.
- Provider adapters emit canonical provider runtime events. `ProviderRuntimeIngestion` records them, and projections turn them into renderer-visible state.
- Distinguish every lifecycle phase explicitly: user requested, command accepted, provider session connecting, provider session ready, provider turn accepted, provider runtime started, first provider message/token/tool event, completion/interruption/failure, post-completion late event, and reconciliation.
- Do not mark a turn as truly running merely because a send call returned. Some providers ACK a request before their runtime starts streaming. Track ACK and runtime-start as separate facts.
- Terminal UI state must come from provider completion, interruption, failure, or a documented reconciliation path. If a provider sends content after a terminal event, preserve the content and emit diagnostics rather than silently corrupting the turn.
- When a turn becomes terminal, projections must close any still-streaming assistant messages for that turn. Providers can stop through completion, checkpoint finalization, interruption, or failure without sending a separate non-streaming replacement for every partial message; stale `streaming=true` rows must not keep the renderer's working marker alive after provider truth is idle.
- Provider runtime replay/backfill content for a completed turn is reconciliation data. Preserve any snapshot-only messages or activity, but do not reopen the thread session, mark the turn running, or restore `activeTurnId` from post-completion content/tool events.
- Steer/follow-up behavior must respect active-turn invariants. Starting a new turn while one is starting or running is a bug unless it is explicitly queued or converted into a provider-supported steer operation.
- Pending approvals and user-input callbacks are provider-runtime state. After restart or daemon handoff, stale callback IDs may be invalid; convert those failures into clear lifecycle events and user-visible recovery guidance.
- Reconciliation after restart must prefer durable provider/session state and command ledgers over UI assumptions. Never automatically resend a user prompt after a crash unless the design cryptographically or durably proves the provider never received it.

## Codex Integration

Cafe Code's Codex adapter uses `codex app-server`, which speaks JSON-RPC over stdio by default. Official docs describe the app-server protocol as JSON-RPC-like messages where requests have `id`, responses echo the `id`, and notifications omit `id`. The official app-server websocket listener is experimental/unsupported; Cafe should keep using stdio JSONL for local app-server control unless upstream changes that recommendation.

Codex lifecycle facts to preserve:

- A Codex connection must send `initialize`, then `initialized`, before other requests.
- `thread/start` creates a new thread and emits `thread/started`.
- `thread/resume` reopens an existing thread so later `turn/start` calls append to it.
- `turn/start` accepts input and returns an initial in-progress turn, but the client must keep reading notifications such as `turn/started`, `item/started`, `item/completed`, `item/agentMessage/delta`, `turn/diff/updated`, and `turn/completed`.
- `turn/steer` appends input to the active in-flight turn, requires the expected active turn id, does not emit a new `turn/started`, and does not accept turn-level overrides.
- Cafe must route live follow-up messages through the separate `ProviderService.steerTurn` / provider-daemon `steerTurn` command path, not through `sendTurn`. The request shape must be only thread id, expected active turn id, user input, and attachments; model, effort, sandbox, collaboration/interaction mode, and other `turn/start` overrides must not be forwarded.
- The steer split is based on the official Codex app-server docs and the upstream `openai/codex` app-server implementation: `turn_steer_inner` records the request against `expected_turn_id`, calls `thread.steer_input`, returns the active `turnId`, and rejects missing, mismatched, non-steerable, or empty input. Treat the absence of a new `turn/started` after steer as expected protocol behavior, not a stalled start.
- Upstream Codex TUI treats steer failures as active-turn reconciliation: if there is no active turn, it clears its cached active turn and starts a new turn; if the active turn is not steerable, it queues rejected input. Cafe Code must not infer steerability from whether its projected assistant message is currently streaming. Official app-server docs bind `turn/steer` to the active in-flight turn plus `expectedTurnId`, and upstream schema/code reserve `activeTurnNotSteerable` for non-regular active turns such as `review` and manual `compact`. Keep those rejection reasons visible in the message/activity stream, re-queue the follow-up for automatic later send, and explicitly say whether review or compact blocked live steering.
- `turn/interrupt` must include the exact active provider turn id. Upstream Codex rejects missing or mismatched turn ids, and an interrupted turn is not terminal for Cafe until Codex emits `turn/completed` or `thread/read` reports a terminal status for that turn.
- Approvals are server-initiated JSON-RPC requests and must be answered through the matching request id.

Codex transport behavior to preserve:

- There are two separate transports. App-server control is local JSON-RPC over stdio. Model streaming inside Codex may use the Responses WebSocket transport when the resolved Codex model provider has `supports_websockets = true`.
- Upstream Codex decides whether Responses WebSockets are enabled with provider capability plus a session-scoped fallback flag. Once `try_switch_fallback_transport` activates, later model requests in that Codex session use HTTP Responses.
- Upstream Codex does not treat `Reconnecting... N/5` as fallback. It retries according to the provider stream retry budget, then emits a warning like `Falling back from WebSockets to HTTPS transport...` when fallback actually activates.
- Cafe may persist that official fallback decision across Cafe/app-server restarts so repeated local restarts do not pay the same broken WebSocket retry cost, but it must only persist the official fallback warning, not an inferred retry count.
- When Cafe observes that official fallback inside an app-server session that was launched before the persisted policy existed, preserve the active turn, then retire that app-server after a terminal turn event so the next turn resumes through a fresh process with Responses WebSockets disabled.
- Codex built-in provider IDs are reserved and cannot be overridden directly. When Cafe needs to start a future app-server with WebSockets disabled, use a Cafe-scoped OpenAI-compatible provider that preserves OpenAI/ChatGPT auth and the Responses API while setting only `supports_websockets = false`.
- Keep Codex turn diagnostics explicit: `turn/start` ACK latency, `turn/started`, first assistant delta/item, retry warnings, fallback warning, stream disconnects, and `turn/completed` are separate facts and should be visible in debug output.
- Codex snapshot backfill is reconciliation data, not a second authoritative assistant stream. If delayed snapshot `agentMessage` items repeat assistant text that the live stream already projected for the same turn, keep the live `msg_*` message and suppress the snapshot `item-*` duplicate while still preserving snapshot-only messages.
- After `turn/start` and `turn/steer`, delayed `thread/read` polling may backfill missed Codex terminal events, but only when upstream returns a terminal turn status. Upstream documents `turn/diff/updated` as a diff snapshot, so Cafe must not treat provider-diff placeholders or completed items as authoritative turn completion. If polling still sees `inProgress`, emit `codex.turnProgress/stillInProgressAfterSnapshotPolling` diagnostics and keep the turn running until Codex emits `turn/completed`, `turn/interrupt` finishes, or `thread/read` reports a terminal status.

Important local files:

- Runtime process and raw Codex protocol handling: `apps/server/src/provider/Layers/CodexSessionRuntime.ts`.
- Canonical event mapping and provider service adapter: `apps/server/src/provider/Layers/CodexAdapter.ts`.
- Cross-provider turn routing and live-steer command handling: `apps/server/src/provider/Layers/ProviderService.ts`, `apps/server/src/providerDaemon/ProviderDaemonServer.ts`, `apps/server/src/providerDaemon/RemoteProviderService.ts`, and `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`.
- Codex provider settings and effective home resolution: `apps/server/src/provider/Drivers/CodexDriver.ts`.
- Codex shadow-home materialization: `apps/server/src/provider/Drivers/CodexHomeLayout.ts`.
- Generated/typed Codex protocol package: `packages/effect-codex-app-server`.

Codex home rules:

- Do not let Cafe Code, Codex CLI, and Codex.app share mutable runtime SQLite databases.
- Default Cafe Code Codex runtime state belongs under `~/.cafe-code/codex-homes/<provider-instance-id>`.
- Share stable user/session/config material intentionally, but keep runtime-local files such as SQLite DBs, WAL/SHM/journal files, tmp/log/memory directories, and auth copies isolated.
- If Codex behavior is unclear, compare against the installed Codex CLI/app-server source or generated schema for the exact version in use, then cross-check the official Codex app-server docs.

## Claude Integration

Cafe Code's Claude adapter uses `@anthropic-ai/claude-agent-sdk`.

Claude lifecycle facts to preserve:

- The TypeScript SDK `query()` API returns an async generator that streams `SDKMessage` values as they arrive.
- `query()` can take an `AsyncIterable<SDKUserMessage>` prompt, which Cafe Code uses as a prompt queue for long-lived sessions.
- The returned `Query` supports operations such as `interrupt()`, `setModel()`, `setPermissionMode()`, and `setMaxThinkingTokens()`.
- Permission mode has two distinct paths in upstream Claude Agent SDK: initial `query()` options and `Query.setPermissionMode()` for an already-active streaming session. Cafe Code must bind the first turn's interaction mode into `query()` when starting a Claude session and must not send a redundant pre-prompt `setPermissionMode()` for default/full-access sends, because current Claude Code can reject that control request before it has a transcript message/conversation to attach it to.
- Fresh Claude sessions should let upstream `query()` allocate the session id. The official SDK docs mark `sessionId` as optional/default auto-generated and recommend capturing the durable id from `system` init or result messages before passing it back through `resume`; Cafe Code should therefore only pass `resume` and optional `resumeSessionAt` when it has a durable resume cursor from a real Claude transcript. Do not generate arbitrary `sessionId` values for new long-lived AsyncIterable sessions, because current Claude Code can reject the first queued turn with "No conversation found with session ID" before the transcript exists.
- Claude `resume` loads a local transcript from the resolved Claude home project directory for the active cwd, not from Cafe's UI state alone. Before passing a durable Cafe cursor through SDK `resume`, verify that `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` exists in the resolved Claude home or can be copied from another Claude project directory. If the transcript is missing, drop the stale cursor and start a fresh upstream Claude session rather than sending a doomed `--resume` that fails before the user's turn starts.
- Claude permissions flow through SDK permission callbacks such as `canUseTool`; respect the supplied abort signal, tool-use id, suggested permission updates, and deny/allow semantics.
- Claude Agent SDK sessions persist by default unless configured otherwise. Resume/session identifiers must be treated as durable provider state, not UI state.
- Claude can emit delayed messages or wake back up after apparent quiescence. UI and projections must tolerate late provider events and should expose diagnostics when a provider speaks after a terminal-looking state.

Important local files:

- Claude SDK adapter and canonical event mapping: `apps/server/src/provider/Layers/ClaudeAdapter.ts`.
- Claude home/environment handling: `apps/server/src/provider/Drivers/ClaudeHome.ts`.
- Claude provider settings/model capability mapping: `apps/server/src/provider/Layers/ClaudeProvider.ts`.

If Claude behavior is unclear, check the official Claude Agent SDK docs, the installed `@anthropic-ai/claude-agent-sdk` package types, and the SDK changelog before changing lifecycle assumptions.

## Observability And Debugging

- Every provider lifecycle change must leave enough debug breadcrumbs to answer: what command was sent, when it was accepted, when the provider emitted the first runtime event, when the first token/content/tool event arrived, when it completed, and what process owned it.
- The debug endpoint should include provider daemon health, provider supervisor health, process diagnostics, RPC metrics, command ledger summaries, recent failures with stack traces where available, runtime event method counts, recent lifecycle warnings, stale active turns, provider home paths, and provider process ownership.
- Add new debug fields when fixing new failure classes. Do not rely on logs alone when a compact health/debug summary would make future diagnosis faster.
- Runtime event names should be specific enough to grep, such as `codex.turnStart/accepted`, `codex.turnStart/noRuntimeEventYet`, provider stream disconnect warnings, snapshot backfill markers, and post-completion late-event diagnostics.
- Prefer structured error diagnostics with cause chains and stack traces. If an exception crosses a daemon/RPC boundary, preserve its type, message, stack when safe, and structured context.
- For performance issues, instrument before guessing. Track send-to-ACK latency, ACK-to-runtime-start latency, runtime-start-to-first-token latency, tool-call duration, database wait/busy time, projection latency, WebSocket push latency, and renderer receipt timing.

## Persistence And SQLite

- Keep provider command ledgers idempotent. Mutating provider daemon RPCs must carry command IDs when replay or retry is possible.
- Avoid long SQLite transactions around provider I/O, process startup, network calls, or stream consumption.
- Do not load entire chat histories or event stores on every token/tool call. Use bounded queries, projections, cursors, and summary snapshots.
- SQLite `database is locked` is a real lifecycle/performance signal. Add diagnostics for the writer, SQL operation, busy timeout, and affected command path instead of only increasing timeouts.
- Migrations must be deterministic, backward-safe where possible, and covered by tests. Reconciliation migrations should explain the exact stale state they repair.

## Performance Rules

- Provider token streaming must stay streaming. Do not batch tokens behind expensive projection work, full-history reads, synchronous filesystem scans, or renderer-only timers.
- Keep hot paths allocation-conscious and query-bounded. Any per-token or per-tool-call code should be reviewed as a performance-critical path.
- Do not perform broad process scans, recursive filesystem traversal, or source-control operations inside message send or provider event ingestion paths unless explicitly debounced and instrumented.
- When comparing performance to Codex CLI or Claude CLI, identify the comparable phase first: process startup, session resume, prompt submission ACK, provider runtime start, model first token, tool execution, or UI projection.

## Frontend Lifecycle Rules

- The renderer should display backend/provider truth and should not synthesize terminal, running, or active-turn state that can conflict with orchestration projections.
- Scroll-follow behavior should be tolerant of small gaps from the bottom and must not jump to the top when steer messages, late messages, or terminal markers arrive.
- Message timelines must handle late provider events after completion without duplicating terminal banners or losing streamed content.
- Per-thread detail subscriptions must apply snapshots and events monotonically by orchestration sequence. Events at or below the detail snapshot sequence are stale for that subscription and must not regress focused-thread session or turn state.
- Live steer UI must distinguish queued follow-ups from accepted in-flight steers. Once Cafe dispatches a provider-supported steer into an active turn, show a non-cancelable steering state until provider output, terminal turn state, or an explicit steer failure/requeue proves the handoff is resolved; otherwise users cannot tell whether Codex/Claude received the follow-up or the renderer lost it.

## Reference Sources

Use these as implementation references when designing protocol handling, UX flows, lifecycle behavior, and operational safeguards:

- Official Codex app-server docs: `https://developers.openai.com/codex/app-server`
- Official Codex SDK docs: `https://developers.openai.com/codex/sdk`
- Open-source Codex repo: `https://github.com/openai/codex`
- Official Claude Agent SDK overview: `https://code.claude.com/docs/en/agent-sdk/overview`
- Official Claude Agent SDK TypeScript reference: `https://code.claude.com/docs/en/agent-sdk/typescript`
- Codex-Monitor reference implementation: `https://github.com/Dimillian/CodexMonitor`

Provider integrations change frequently. Before implementing or changing Codex/Claude lifecycle behavior, check the current official docs plus the version-pinned local package/source used by this repository, then document the relevant assumption in code comments and tests.
