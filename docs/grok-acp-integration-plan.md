# Grok Build via ACP: implementation plan

Status: implemented for the Early Access scope
Prepared: 2026-08-15
Scope: first-party Grok Build provider for Cafe Code, driven through ACP over stdio

## 1. Executive decision

Cafe Code can support Grok in a realistic way through ACP without reducing it to a text-only provider. The integration should not be a direct copy of T3 Code's Grok patch, however. T3 is a valuable protocol and failure-mode reference, but Cafe has stricter provider lifecycle, resume, live-steer, security, diagnostics, packaging, and long-running-session requirements.

The proposed design is:

1. Add a reusable, typed `effect-acp` workspace package pinned to an exact ACP schema release.
2. Add a generic ACP session runtime to the server.
3. Run one Cafe-owned `grok agent stdio` child process per materialized Grok session.
4. Keep the process scoped to the adapter context and resume with ACP `session/load` using a durable Grok session ID.
5. Map standard ACP updates and requests into Cafe's canonical provider runtime events.
6. Use xAI extensions only behind separately validated schemas and capability probes.
7. Implement actual mid-turn steering through `x.ai/interject`; do not serialize another `session/prompt` and call it steering.
8. Ship the provider as Early Access until real-binary macOS and Linux tests prove resume, cancellation, prompt settlement, model selection, sandboxing, and authentication.

The implemented release supports normal, Plan, and Auto conversations, streaming text/reasoning, structured tool activity, permissions, questions, images, interruption, live steering, resume, process-wide configuration switching, discovery, usage, Cafe MCP, native conversation rewind, and Grok goals. Rich subagent visualization remains a later slice.

## 2. Source baseline

This plan was checked against the following upstream sources on 2026-08-15:

- [T3 Code's merged Grok ACP pull request](https://github.com/pingdotgg/t3code/pull/2809)
- [T3 Code's current generic ACP package](https://github.com/pingdotgg/t3code/tree/main/packages/effect-acp)
- [T3 Code's current provider implementation](https://github.com/pingdotgg/t3code/tree/main/apps/server/src/provider)
- [xAI's Grok Build repository](https://github.com/xai-org/grok-build)
- [xAI's headless/ACP documentation](https://docs.x.ai/build/cli/headless-scripting)
- [ACP protocol release v0.11.3](https://github.com/agentclientprotocol/agent-client-protocol/releases/tag/v0.11.3)
- [Official ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [xAI's `x.ai/interject` implementation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/interject.rs)
- [xAI's rewind extension](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/rewind.rs)
- [xAI's usage extension](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/extensions/usage.rs)

Important source-derived constraints:

- `grok agent stdio` speaks JSON-RPC over stdin/stdout.
- ACP's protocol version is currently `1`; the schema artifact/package release is separately versioned.
- xAI recommends disabling background update checks in ACP/headless use.
- Grok sessions are durable and can be loaded in another process.
- xAI advertises supported authentication methods and a preferred/default method during initialization. Cafe must consume that advertisement instead of guessing from environment variables alone.
- Several important Grok behaviors are xAI extensions rather than stable ACP methods. Those extensions need independent schemas, tests, and degradation behavior.
- The xAI CLI's sandbox is process-scoped. Because Cafe will use one process per session, this is compatible with per-thread runtime modes, subject to a live resume/mode-change compatibility gate described below.

## 3. What to reuse from T3, and what to change

### Reuse as design evidence

T3 has already identified and tested several non-obvious ACP failure modes that Cafe should carry forward:

- a prompt RPC may remain open after the logical turn completed;
- xAI's `x.ai/session/prompt_complete` notification is needed as a completion fallback;
- final update notifications can arrive just after prompt completion, so a queue barrier/drain is needed before emitting Cafe's `turn.completed`;
- `session/load` can replay old notifications, which must not be re-persisted into Cafe's projection;
- cancelled prompt RPCs and late notifications must not consume or mutate a later turn;
- permission option IDs are provider-owned and must be returned exactly;
- stopping a session must unblock a silent or hung prompt and close the process scope;
- structured question response shapes are not safely handled as ad hoc strings.

T3's adapter and test suite are therefore a useful behavioral checklist.

### Do not copy unchanged

Cafe should deliberately differ in these areas:

1. **ACP package compatibility.** T3's current package targets a newer Effect beta than Cafe. Recreate the package against Cafe's pinned Effect toolchain and local generated-protocol conventions instead of importing source blindly or upgrading Effect as part of this feature.
2. **Live steering.** T3 currently treats another serialized prompt as steer-like input. Cafe has an explicit live-steer contract, and xAI exposes `x.ai/interject`; use the real extension and bind it to Cafe's expected active turn.
3. **Authentication status.** T3 reports Grok authentication as unknown even when ACP startup succeeds. Cafe should classify successful authentication, missing credentials, known auth rejection, and ambiguous transport failure separately.
4. **Capabilities.** T3 accepts compromises such as unsupported rollback and conservative model-change handling. Cafe should expose a truthful capability matrix and phase features in only after live tests.
5. **Lifecycle.** Cafe's provider service, session directory, reaper, command reactor, durable resume cursor, and detached runtime behavior are different. Grok must participate in those mechanisms rather than create a parallel orchestration model.
6. **Security and logs.** Cafe MCP bearer headers, API keys, prompts, outputs, and raw extension payloads must not enter native logs or debug JSON. Generic JSON-RPC logging is not automatically safe.
7. **Long sessions.** Cafe treats 16-hour turns as normal. Timeouts may bound startup, health probes, graceful shutdown, and disposable text generation, but must not impose a normal turn deadline.

## 4. Goals and non-goals

### Goals for the first Early Access release

- Discover and validate a system-installed Grok Build CLI.
- Authenticate through a previously cached Grok login or a sensitive `XAI_API_KEY` instance environment entry.
- Start and load sessions through ACP.
- Stream assistant text, reasoning, plans, and tool activity.
- Support permission requests and Cafe's three runtime modes without weakening the selected sandbox.
- Support Grok structured questions and plan approval.
- Support prompt images and steer images within Cafe's existing limits.
- Support real mid-turn live steering through `x.ai/interject`.
- Interrupt a running turn and reject late events safely.
- Persist a versioned resume cursor and suppress load replay.
- Discover available models from the connected CLI.
- Feed Cafe's authenticated per-thread MCP endpoint to Grok without leaking the bearer credential.
- Provide Grok-backed title/branch/commit/PR text generation through a disposable, constrained ACP session.
- Produce actionable health/auth diagnostics.
- Remain correct through server restart, provider crash, cancellation races, and delayed completion notifications.

### Remaining non-goals

- Bundling or automatically installing Grok Build.
- Starting interactive browser authentication from the background backend.
- Sharing a Grok leader/daemon between sessions.
- Claiming Windows support before the official CLI and real process path pass on Windows.
- Rendering the full Grok subagent/task topology in the initial UI.
- Supporting arbitrary user-supplied CLI argument strings containing secrets.

## 5. Target architecture

```text
ProviderCommandReactor
        |
        v
ProviderService / ProviderAdapterRegistry
        |
        v
GrokAdapter  <---- approvals, questions, plan approval, interrupt, steer
        |
        +---- GrokAcpSupport (spawn/auth/model/sandbox/xAI schemas)
        |
        v
AcpSessionRuntime (one instance per materialized Cafe thread)
        |
        v
effect-acp typed JSON-RPC client
        |
        v
grok --no-auto-update --sandbox <profile> --permission-mode <mode> [--reasoning-effort <level>] agent --no-leader stdio
        |
        +---- standard ACP session/update + permission requests
        +---- x.ai/* and _x.ai/* validated extensions
        +---- Cafe /mcp over authenticated loopback HTTP
```

The provider adapter owns a thread-keyed context containing:

- the Cafe provider session record;
- the Grok ACP session ID and versioned resume state;
- an Effect scope that owns the child process, protocol connection, queue fibers, and cleanup;
- current model, interaction mode, runtime mode, and sandbox profile;
- the active Cafe turn ID and upstream prompt ID;
- a monotonically increasing context generation used to reject events from replaced processes;
- pending permission, question, and plan-approval responders;
- cancelled/interrupted turn tombstones;
- prompt-completion de-duplication state;
- synthetic Cafe item IDs and active text/reasoning segments;
- replay/load-gate state and an event-drain barrier;
- the last reported token usage.

No mutable Grok session state should live in the renderer, the generic driver, or the JSON-RPC package.

## 6. Architecture decisions

| Decision              | Choice                                                                   | Reason                                                                                  |
| --------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Protocol transport    | ACP JSON-RPC over stdio                                                  | Official xAI integration surface; no local port or new bearer transport required.       |
| Process topology      | One direct Grok child per materialized Cafe session                      | Gives exact cwd, sandbox, environment, auth home, ownership, and failure isolation.     |
| Leader behavior       | Pass `agent --no-leader stdio`                                           | User config must not silently move Cafe's session into an unowned shared leader.        |
| Updates               | Pass global `--no-auto-update`                                           | Background self-update must not mutate a running ACP provider.                          |
| Protocol types        | Generated `effect-acp` workspace package                                 | Matches Cafe's Effect error/schema conventions and existing Codex protocol package.     |
| Protocol pin          | Exact ACP schema release plus recorded digest                            | Prevents generated protocol drift.                                                      |
| Grok pin              | Minimum tested CLI version plus capability probes                        | Standard ACP and private extensions can change independently.                           |
| Resume                | Versioned cursor plus `session/load`                                     | Keeps upstream context without replaying duplicate Cafe events.                         |
| Steer                 | `x.ai/interject`                                                         | Correct mid-turn semantics and image support.                                           |
| Completion            | Race prompt response with xAI prompt-complete signal, then drain updates | Handles the known hanging/late-update behavior without truncating output.               |
| Auth                  | Advertised method selection                                              | Follows the agent's declared availability and preferred method.                         |
| MCP                   | Existing per-thread authenticated Cafe MCP server                        | Reuses Cafe's control plane and authorization boundary.                                 |
| Default install model | External/manual CLI                                                      | Avoids a new installer, updater, and credential bootstrap surface in the first release. |
| Logs                  | Redacted structured lifecycle facts only                                 | Raw JSON-RPC can contain prompts, output, credentials, paths, and MCP headers.          |

## 7. Capability matrix

| Capability                   | Early Access                      | General availability gate                     | Later work                                   |
| ---------------------------- | --------------------------------- | --------------------------------------------- | -------------------------------------------- |
| New session                  | Yes                               | Mock and real CLI tests                       | —                                            |
| Resume after backend restart | Yes                               | Replay suppression and long-load tests        | Cross-machine/session import                 |
| Text streaming               | Yes                               | Ordering, Unicode, empty-chunk tests          | —                                            |
| Reasoning streaming          | Yes                               | Separate reasoning item mapping               | —                                            |
| Tool calls and plans         | Yes                               | Stable create/update/complete mapping         | Rich native task UI                          |
| Permission requests          | Yes                               | Every Cafe runtime mode tested                | Managed policy presentation                  |
| Structured questions         | Yes                               | `x.ai/ask_user_question` shape tests          | Non-blocking/snooze if xAI supports it       |
| Plan mode                    | Yes, via native restart-resume    | `x.ai/exit_plan_mode` real-binary canary      | Rich plan diff/file presentation             |
| Images                       | Yes                               | MIME/size/path validation                     | More ACP content types                       |
| Interrupt                    | Yes                               | Hung prompt and late-event tests              | —                                            |
| Live steer                   | Yes                               | `x.ai/interject` real-binary test             | Standard ACP method if one replaces it       |
| Model discovery              | Yes                               | Cached/single-flight probe                    | Rich model metadata                          |
| Same-thread model switch     | Yes, via atomic restart-resume    | Multi-turn live test preserves native context | Live setter if ACP advertises one            |
| Token usage                  | Yes where extension exists        | Monotonicity/reset semantics tested           | No provider-specific cost surface            |
| Native rewind                | Yes, conversation-only            | Real-binary destructive canary                | Rich conflict presentation                   |
| Provider thread goals        | Yes, no token budgets             | Structured-state and mutation canary          | Budget control when Grok exposes it          |
| Subagents                    | Flatten into tool/work-log events | No event loss or turn-liveness bugs           | Native hierarchy/status UI                   |
| Text generation              | Yes                               | Disposable constrained-session tests          | Dedicated upstream generation API if exposed |

Any unavailable xAI extension must degrade the matching capability, not make the whole provider unusable. Standard chat should still work if usage or interject is absent; the UI must simply stop advertising the absent feature.

## 8. Detailed implementation phases

### Phase 0: protocol and CLI compatibility spike

Purpose: remove the highest-risk assumptions before wiring Cafe's runtime.

Tasks:

1. Record an exact Grok Build release/commit and exact ACP schema release used for development.
2. Run a small opt-in probe against a real `grok` binary that:
   - spawns `grok --no-auto-update --sandbox read-only --permission-mode default agent --no-leader stdio`;
   - initializes ACP and records only nonsensitive capability names;
   - selects an advertised noninteractive auth method;
   - creates a session and enumerates modes, models, and config options;
   - sends a no-tool prompt;
   - receives standard updates and xAI prompt completion;
   - cancels a running prompt;
   - loads the session in a second process;
   - verifies whether a session created under one sandbox profile may be loaded into a process using another explicitly selected profile;
   - probes `session/set_model`, `x.ai/interject`, both observed xAI session-usage method spellings, `x.ai/exit_plan_mode`, and rewind methods independently.
3. Confirm supported operating systems from the upstream release artifacts and by executing the binary. Do not infer Windows support from Rust source alone.
4. Save a redacted protocol fixture for unit tests. Fixture review must confirm it contains no prompts, outputs, API keys, cached tokens, user paths, or MCP headers.

Exit criteria:

- Every method Cafe plans to advertise has an observed wire shape.
- The minimum Grok version is known.
- Sandbox/load behavior is known.
- Unsupported platforms are explicitly identified.

If sandbox-changing resume is refused, add a product constraint before implementation: runtime mode is locked for a materialized Grok thread, and the UI/reactor must require a new thread to change it. Do not silently create a context-free Grok session. A bounded, projection-sourced context-bootstrap contract can be designed later if preserving history across such a transition is required.

### Phase 1: create the typed `effect-acp` package

Files and boundaries:

- New `packages/effect-acp/package.json`
- New `packages/effect-acp/src/schema.ts`
- New `packages/effect-acp/src/protocol.ts`
- New `packages/effect-acp/src/rpc.ts`
- New `packages/effect-acp/src/client.ts`
- New `packages/effect-acp/src/stdio.ts`
- New `packages/effect-acp/src/errors.ts`
- New `packages/effect-acp/scripts/generate.ts`
- Package tests and redacted protocol fixtures

Tasks:

1. Follow `packages/effect-codex-app-server` conventions for exports, generation, Effect errors, JSON-RPC request correlation, and tests.
2. Pin the generator input to an immutable ACP release asset. Store the expected content hash and fail generation when it changes unexpectedly.
3. Generate schemas with Cafe's pinned Effect and `@effect/openapi-generator` versions. Do not introduce a repository-wide Effect upgrade.
4. Keep generated standard ACP types separate from hand-written extension types.
5. Implement an stdio transport with:
   - newline-delimited, bounded input buffering;
   - a maximum individual message size;
   - strict JSON-RPC response/request/notification discrimination;
   - unique request IDs;
   - pending-request cleanup on EOF, process exit, interruption, and scope close;
   - reverse request dispatch;
   - notification subscription;
   - backpressure so an unbounded agent stream cannot exhaust memory;
   - protocol stdout isolation from diagnostic stderr;
   - errors that preserve safe category/code facts but not raw sensitive payloads.
6. Add protocol tests for fragmented lines, multiple messages per chunk, invalid JSON, oversized messages, duplicate response IDs, unknown IDs, reverse requests, EOF with pending calls, write failure, and cancellation races.
7. Add the package to:
   - `apps/server/package.json`;
   - the internal bundle prefixes in `apps/server/tsdown.config.ts`;
   - desktop staged workspace manifests;
   - release smoke workspace manifests;
   - clean/build policy lists as required.

Exit criteria:

- The generated package compiles against Cafe's pinned Effect version.
- A fake ACP agent can drive requests, notifications, reverse requests, cancellation, and shutdown deterministically.
- The built server contains the ACP client without requiring an unstaged workspace source tree.

### Phase 2: generic ACP session runtime

Files:

- New `apps/server/src/provider/acp/AcpSessionRuntime.ts`
- New `apps/server/src/provider/acp/AcpRuntimeModel.ts`
- New `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts`
- New `apps/server/src/provider/acp/AcpAdapterSupport.ts`
- New `apps/server/src/provider/acp/AcpNativeLogging.ts`
- Focused unit tests next to each module

Responsibilities:

1. Accept a provider-supplied spawn specification, initialization metadata, auth strategy, session setup metadata, extension handlers, and event mapper.
2. Spawn the process through Cafe's existing shell-free command-resolution abstraction.
3. Initialize, authenticate, then create or load a session.
4. Expose typed operations for prompt, cancel, load/new, model/mode/config selection, extension request, and shutdown.
5. Maintain a bounded event queue and explicit barrier operation.
6. On `session/load`, open a replay gate before the request and discard replayed content/tool/plan updates until load completion plus a bounded idle gap. Continue accepting requests that must be answered during load.
7. Treat process exit, stdout EOF, protocol decode failure, initialization failure, auth failure, session failure, and user cancellation as distinct error categories.
8. Provide no default turn timeout. Startup/load/shutdown have bounded timeouts; a normal running prompt does not.
9. Implement prompt settlement as a state machine rather than nested promises:

```text
idle -> preparing -> running -> draining -> completed -> idle
                     |    |
                     |    +-> interrupted -> draining -> idle
                     +------> failed -> draining -> idle
```

10. Bind every notification to a context generation and upstream session ID before it can mutate adapter state.
11. Make native logging opt-in per event category and redact payloads before any persistence. Default logs should contain method name, direction, request ID class, duration, byte count, and result category—not params/results.
12. Make scope finalization idempotent: attempt ACP session close when advertised, close stdin, wait a short grace period, then terminate the owned process group.

Essential tests:

- close the process when startup fails midway;
- unblock a silent prompt on stop;
- tolerate a late prompt response after cancellation;
- prevent a cancelled prompt response from completing a later turn;
- drop stale notifications from an old context generation;
- drain updates before completion;
- resume without replaying prior text or tool events;
- continue after a diagnostic logger failure;
- withstand at least a simulated 16-hour logical prompt without a timer firing;
- cap queue/message memory under a fast fake producer;
- reject session updates for a different session ID.

Exit criteria:

- The runtime is provider-neutral; no `grok` or `x.ai` strings appear outside provider hooks/tests.
- A mock agent passes the lifecycle and race suite.

### Phase 3: Grok-specific protocol support

Files:

- New `apps/server/src/provider/acp/GrokAcpSupport.ts`
- New `apps/server/src/provider/acp/XAiAcpExtension.ts`
- New extension schema/tests and an opt-in `*.e2e.test.ts` or documented probe command

Tasks:

1. Resolve the configured binary path or `grok` from PATH without a shell.
2. Spawn with explicit arguments:

```text
grok --no-auto-update --sandbox <profile> --permission-mode <mode> [--reasoning-effort <level>] agent --no-leader stdio
```

Add `--client-identifier cafe-code` only if the tested CLI version accepts it on the stdio path. Also send Cafe's identity in ACP initialization metadata where supported.

3. Never pass credentials, MCP bearer tokens, prompts, or user-provided secret-like settings in argv.
4. Set `GROK_HOME` only for an explicitly configured Grok home. An empty setting must preserve the user's normal Grok home so an existing `grok login` is reusable.
5. Set `GROK_OAUTH2_REFERRER=cafe-code` if xAI documents or accepts that integration identifier.
6. Authentication selection:
   - parse advertised methods and initialize metadata;
   - if a sensitive `XAI_API_KEY` exists and the matching API-key method is advertised, choose it;
   - otherwise prefer the agent-advertised default noninteractive method;
   - otherwise choose an advertised cached-token method;
   - otherwise return a typed unauthenticated result with instructions to run `grok login` in a terminal;
   - never start an interactive web login from the backend health probe.
7. Standardize sandbox mapping after the Phase 0 gate:

| Cafe runtime mode   | Grok process sandbox | Native Grok permission mode | ACP/xAI approval setup                                                                                                                               |
| ------------------- | -------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval-required` | `read-only`          | `default`                   | Surface all permission requests.                                                                                                                     |
| `auto-accept-edits` | `workspace`          | `acceptEdits`               | Cafe's compatibility fallback auto-accepts only edit/move/delete requests and surfaces execute/read/unknown.                                         |
| `full-access`       | `off`                | `bypassPermissions`         | Ordinary requests bypass prompts; surface any residual request because it may represent an explicit ask/deny rule, hook, or managed provider policy. |

Managed xAI policy remains authoritative. Cafe must not convert an explicit provider denial or required-human-decision policy into approval.

8. Map Cafe interaction modes:
   - `default` to ACP `default`;
   - `plan` to ACP `plan`, but advertise it only after plan approval is implemented;
   - do not map Cafe's Claude-specific `auto` mode to Grok's permission or planning behavior. Normalize it to `default` with a visible diagnostic or prevent selecting it for Grok.
9. Add strict schemas for:
   - `x.ai/interject`;
   - `x.ai/ask_user_question` and `_x.ai/ask_user_question` wrappers;
   - `x.ai/exit_plan_mode`;
   - `x.ai/session/prompt_complete` and the private wrapped form used by current stdio builds;
   - `_x.ai/session/usage` with a method-not-found fallback to `x.ai/session/usage`;
   - notification envelopes needed for usage/tasks/goals;
   - rewind methods, even if initially unused, so later work does not parse them ad hoc.
10. Feature-detect extension behavior. Unknown/malformed optional extension messages should produce a bounded safe diagnostic and disable that feature; malformed turn-critical completion or interaction messages should fail the active turn safely.

Exit criteria:

- The spawn command cannot be redirected to a shared leader by user config.
- Authentication and sandbox choices are explicit and testable.
- Every xAI payload used by Cafe is schema-decoded.

### Phase 4: settings, driver, health, model catalog, and provider registration

Contract changes:

- Add `grok` to `ProviderDriverKind` and provider/model schemas.
- Add `GrokSettings` to legacy settings compatibility and provider-instance config.
- Add settings patch schemas and client-redacted settings shapes.
- Add defaults and migrations that do not disturb existing Codex, Claude, or OpenCode records.

Recommended Grok instance settings:

```ts
interface GrokSettings {
  enabled: boolean;
  binaryPath?: string;
  homePath?: string;
  customModels?: ReadonlyArray<string>;
}
```

Use the existing provider-instance sensitive environment mechanism for `XAI_API_KEY`; do not add a parallel plaintext key field. Avoid free-form launch arguments in the first release. If advanced arguments are later needed, model them as structured, validated fields.

Driver work:

- Add `apps/server/src/provider/Drivers/GrokDriver.ts`.
- Add the Grok provider layer/service and register it in `builtInDrivers.ts`.
- Build the continuation identity from driver kind, resolved instance, and resolved Grok home. Two instances with different homes must never share a resume cursor.
- The live-qualified adapter now advertises restart-and-resume model selection:

```ts
{
  sessionModelSwitch: "restart-resume",
  liveSteer: extensionProbe.interject ? "supported" : "unsupported",
  threadGoals: "unsupported"
}
```

Health and model discovery:

1. Run `grok --version` with a short bounded timeout and no shell.
2. Single-flight concurrent health/model requests per provider instance.
3. Start a disposable ACP process with a bounded initialization/auth timeout.
4. Read model state from initialize metadata when present; otherwise create a disposable session and read standard session model state.
5. Preserve upstream model IDs and option identifiers. Do not maintain a large static Grok model list. A minimal `grok-build` fallback may be used only when the connected compatible CLI omits a catalog.
6. Cache successful catalog results briefly, preserve the last known catalog through transient probe failure, and surface staleness.
7. Classify status:
   - unavailable: binary missing or unsupported platform;
   - unhealthy: binary exists but protocol cannot initialize;
   - unauthenticated: protocol reached and no usable auth succeeds;
   - healthy/authenticated: initialize, auth, and model read succeed;
   - unknown auth only for genuinely ambiguous transport failures.
8. Do not leave probe-created processes or sessions running.
9. Provider maintenance is manual-only initially. Surface install/update documentation; Cafe does not self-update Grok.

Exit criteria:

- Settings round-trip and redact secrets.
- Multiple Grok instances with different homes/environments do not share credentials or sessions.
- Missing binary, nonzero version, protocol failure, missing auth, auth rejection, and healthy catalog each have distinct tests.

### Phase 5: Grok adapter and canonical event mapping

Files:

- New `apps/server/src/provider/Services/GrokAdapter.ts`
- New `apps/server/src/provider/Layers/GrokAdapter.ts`
- New `apps/server/src/provider/Layers/GrokProvider.ts`
- Comprehensive `GrokAdapter.test.ts`

Session startup:

1. Validate provider instance, cwd, additional directories, runtime mode, and resume cursor schema.
2. Resolve the per-thread Cafe MCP server and include it as an ACP HTTP MCP server with its Authorization header.
3. Treat the MCP Authorization header as a secret: exclude `session/new` and `session/load` params from raw protocol logging and error strings.
4. Create the scoped process/runtime and install reverse-request handlers before starting the session.
5. Load a valid cursor or create a new session.
6. Persist a cursor such as:

```ts
{
  schemaVersion: 1,
  sessionId: string,
  model?: string,
  sandboxProfile: "read-only" | "workspace" | "off",
  grokVersion?: string
}
```

7. Emit connecting/ready state and durable session identity only after the context can receive notifications and answer reverse requests.

Turn handling:

1. Validate non-empty text or attachments.
2. Load attachments from Cafe's attachment store, revalidate declared size/MIME, enforce existing count/byte limits, and encode ACP image blocks. Never accept arbitrary client-provided filesystem paths.
3. Apply the requested interaction mode and model before the prompt when allowed.
4. Emit Cafe turn start, call ACP prompt, race the standard response with the xAI completion signal, and de-duplicate by prompt/turn identity.
5. Insert an event-queue barrier and bounded idle drain before completing the turn.
6. On prompt error, restore the session to ready unless the process/session itself is unusable.
7. Preserve the transcript and resume cursor when cancellation races with a successful upstream completion.

Event mapping:

| ACP/xAI source       | Cafe event                                                    |
| -------------------- | ------------------------------------------------------------- |
| agent message chunk  | assistant item/content delta (`assistant_text`)               |
| agent thought chunk  | assistant item/content delta (`reasoning_text`)               |
| tool call            | tool item started                                             |
| tool call update     | tool item updated/completed/failed                            |
| plan update          | canonical plan/work-log update                                |
| current mode update  | provider state/diagnostic update, not renderer-invented state |
| available commands   | safe provider metadata when Cafe has a consumer               |
| token/usage update   | `thread.token-usage.updated`                                  |
| task/subagent update | bounded work-log/tool updates in the initial release          |
| session error        | turn or session error according to scope                      |

Tool mapping must preserve upstream tool call IDs and map known ACP kinds to Cafe's canonical execute/read/edit/delete/move/search/fetch categories. Unknown kinds remain visible as unknown/general tools rather than being mislabeled as harmless reads.

Permissions:

1. Create a pending responder keyed by Cafe request ID and upstream request identity.
2. Classify request kind conservatively from ACP tool kind/content.
3. Preserve all provider option IDs and labels.
4. In `approval-required`, always emit the Cafe request.
5. In `auto-accept-edits`, automatically choose an allow-once/allow option only for clearly edit-like operations; emit all other requests.
6. In `full-access`, prefer xAI yolo mode; if a permission request still arrives and provider policy allows client choice, choose the least persistent valid allow option unless Cafe explicitly requested session-wide acceptance.
7. Map Cafe accept/accept-for-session/decline/cancel to the exact available provider option. If no semantic option exists, cancel/deny rather than guess.
8. On interrupt/stop/process exit, settle all pending requests exactly once.

Structured questions:

1. Handle both direct and wrapped xAI reverse-request method shapes.
2. Validate question IDs, headers, choice counts, multi-select flags, and custom-answer policy.
3. Emit Cafe's canonical user-input request with the tool call association.
4. Convert Cafe answers back to xAI's expected response without dropping arrays or custom values.
5. Cancel outstanding questions on turn/session cancellation.

Plan approval:

1. Decode `x.ai/exit_plan_mode` as a separate reverse request, not a generic command approval.
2. Emit Cafe's proposed-plan event/UI data using the provided plan content.
3. Return approve/decline/abandon semantics exactly as xAI defines them.
4. Keep the session in plan mode on disconnect or cancelled UI response unless the upstream contract explicitly says otherwise.
5. Do not advertise Grok plan mode until this path has unit and real-binary coverage.

Live steer:

1. Require an active context and exact `expectedTurnId` match.
2. Build `x.ai/interject` with the Grok session ID, Cafe steer command/correlation ID as `interjectionId`, text, and validated image content blocks.
3. Send it outside the serialized prompt-operation lock so it can reach a running turn.
4. Accept only a decoded `queued` response.
5. Return the existing active turn ID; do not create a new Cafe turn.
6. If the extension is absent, advertise `liveSteer: unsupported` so the command reactor uses its normal durable follow-up/recovery behavior.

Interrupt and stop:

- Verify the optional Cafe turn ID matches the active turn before cancellation.
- Mark the turn interrupted before sending cancel so racing notifications are rejected.
- Send standard ACP `session/cancel`.
- Settle pending permission/question/plan requests.
- Drain already accepted events, then emit one terminal outcome.
- `stopSession` additionally attempts session close and always closes the owned process scope.

Model selection:

- Linux live qualification against Grok `1.0.4` preserved the same native session ID and earlier message across both a reasoning change (`high` to `low`) and a model change (`grok-4.6` to `grok-4.5`). Grok's persisted session summary and per-turn metadata confirmed the requested effort/model handled the resumed turn.
- Advertise `sessionModelSwitch: restart-resume`. The command reactor must retain the native resume cursor for any model-selection change, including reasoning options.
- Stage the replacement while the prior session is idle and authoritative. Start the new child with the requested reasoning flag, load the existing session, call `session/set_model`, and swap only after all steps succeed. A failed candidate is closed without stopping the prior child; a successful swap closes the old child without emitting a stale exit event.
- Keep direct adapter sends fail-closed when orchestration has not performed the required replacement. Do not inject TUI `/model` or `/effort` strings into the model prompt.

Required adapter tests include the useful T3 cases plus Cafe-specific cases:

- process closes on stop and on partial startup failure;
- status is running only while a prompt is active;
- preparation/prompt failure restores ready state;
- xAI prompt completion settles a hung prompt RPC;
- omitted/invalid xAI stop reason is not invented;
- stop unblocks a silent prompt and a waiting follow-up;
- a late cancelled prompt cannot settle a later prompt;
- late notifications after cancellation or process replacement are dropped;
- final notifications are persisted before turn completion;
- resume suppresses content/tool replay;
- provider/instance mismatch and empty input fail before spawn;
- provider-supplied permission IDs round-trip;
- every runtime mode uses the correct sandbox/approval behavior;
- structured single/multi/custom questions round-trip;
- plan approval round-trips;
- live steer is rejected for a stale expected turn ID;
- interject images are rewritten and encoded without source paths;
- MCP bearer data never appears in captured logs/errors;
- a logger failure cannot kill the stream;
- usage reset after process resume is handled as a new upstream ledger baseline, not negative usage.

Exit criteria:

- Cafe can run, steer, interrupt, resume, and interact with a mock Grok session under all runtime modes.
- Provider failure cannot resurrect or mutate a completed/interrupted turn.

### Phase 6: Grok text generation

Files:

- New `apps/server/src/textGeneration/GrokTextGeneration.ts`
- Register in `TextGeneration.ts`
- Focused tests using a fake ACP agent

Design:

1. Use a disposable, scoped Grok ACP process per text-generation request.
2. Do not attach Cafe MCP or user project MCP servers.
3. Run with the safest usable sandbox and no auto-approval.
4. Ask for the existing strict JSON output contract and collect assistant text chunks.
5. Use a bounded timeout appropriate for metadata generation, currently 180 seconds maximum.
6. Interrupt and terminate the child process on timeout, cancellation, invalid output, or scope close.
7. Never reuse a chat session or persist the disposable session ID.
8. Do not treat partial JSON or explanatory prose as success.

Exit criteria:

- Grok can be selected for Cafe's title/branch/commit/PR generation paths.
- A hung or tool-seeking generation cannot leak a child process.

### Phase 7: renderer and settings UX

Files likely affected:

- provider driver metadata and icons;
- provider settings navigation/forms;
- provider instance editor;
- model picker and provider filters;
- interaction/runtime mode controls;
- status/auth/install diagnostics;
- tests for every conditional control.

UX requirements:

1. Add Grok as an Early Access provider with a distinct icon and `Grok Build` display name.
2. Settings expose binary path, optional Grok home, sensitive environment configuration, health, discovered version, auth state, model refresh, and install/login instructions.
3. Do not echo the resolved API key, auth token, full Grok home, raw stderr, or protocol failure body.
4. Model picker uses the provider snapshot catalog and shows stale/fallback state honestly.
5. Hide or disable interaction modes that the adapter does not support.
6. Show live-steer affordances only when the actual instance capability probe reports support.
7. Do not show provider-owned goal controls or native rewind controls in the initial release.
8. If model or runtime-mode changes require a new thread, say so before mutation and do not let the generic restart silently discard native context.
9. Browser clients receive the same backend-authoritative provider state; no renderer-only Grok capability table.

Exit criteria:

- A user can install/login externally, configure an instance, diagnose it, select a model, start a thread, answer interactions, steer, interrupt, and resume without needing hidden settings.
- Unsupported controls are absent rather than failing after selection.

### Phase 8: packaging, platform, observability, and documentation

Packaging:

- Bundle `effect-acp` into the built server exactly like the existing Codex protocol package.
- Add its manifest to staged Yarn project files and release smoke fixtures.
- Do not package the Grok binary in the first release.
- Verify packaged desktop startup can locate the same explicit/system binary as source mode.
- Ensure process-group termination and command resolution work without a shell on each supported platform.

Windows:

- First confirm an official usable Grok Build Windows binary and ACP stdio behavior.
- If supported, test `.exe`/`.cmd` resolution with Cafe's existing Windows-safe spawn rules and `shell: false`.
- If unsupported, return a clear unavailable status and do not attempt WSL or a global install automatically.
- Any Windows-only workaround discovered during implementation must be documented only in the Windows section of `AGENTS.md` and must not change macOS/Linux behavior.

Observability:

Recommended metrics/counters:

- process startup and initialization latency;
- authentication outcome category;
- session new/load latency and replay-suppressed event count;
- active process/session/prompt counts by instance;
- notification queue depth/high-water mark;
- prompt completion source: standard response, xAI notification, cancellation, process exit;
- completion-drain latency;
- stale/late event drop count;
- pending permission/question/plan counts;
- interject request latency/result;
- graceful versus forced process termination;
- catalog cache hit/staleness/probe failures.

Diagnostics may include method names and safe state-machine status. They must exclude raw prompts, assistant output, tool input/output, environment values, auth material, MCP headers, cookies, and unrestricted filesystem paths.

Documentation:

- Add a `Grok Build Integration` architecture section to `AGENTS.md` when code lands.
- Document install, `grok login`, API-key instance environment configuration, supported platforms, sandbox/runtime mode behavior, resume, and known limitations.
- Record the tested Grok and ACP versions and the source-derived assumptions next to workaround code.

Exit criteria:

- Source and packaged desktop paths behave consistently.
- Process and session diagnostics are useful without exposing content or secrets.

### Phase 9: real-provider qualification and rollout

Keep live-provider tests opt-in and separate from the default Vitest path, following repository policy.

Real-binary qualification matrix:

| Scenario                          | Required result                                              |
| --------------------------------- | ------------------------------------------------------------ |
| cached login                      | health reports authenticated and a prompt succeeds           |
| API key                           | advertised API-key auth succeeds without key leakage         |
| missing auth                      | actionable unauthenticated status, no browser launched       |
| new/load                          | second process resumes context without duplicate Cafe events |
| 30+ minute tool turn              | no turn timeout; stable memory/queue behavior                |
| server restart during idle        | session reloads and next turn succeeds                       |
| server restart during active turn | defined interruption/recovery; no duplicate terminal events  |
| cancel during streaming           | one interrupted result; late chunks dropped                  |
| stop during completion drain      | final accepted chunks ordered before terminal state          |
| permission in each runtime mode   | correct sandbox plus exact decision handling                 |
| structured question               | single, multi, and custom answer round-trip                  |
| plan approval                     | approve and decline preserve upstream mode semantics         |
| text and image steer              | same active turn receives `x.ai/interject`                   |
| process crash                     | session becomes failed/closed and process is reaped          |
| model probe failure               | last known catalog remains visibly stale                     |
| MCP tool call                     | authenticated Cafe tool works; token absent from logs        |
| packaged desktop                  | binary resolution, prompt, cancel, and cleanup work          |

Rollout stages:

1. Hidden developer flag with mock-agent suite.
2. Opt-in Early Access setting after macOS/Linux real-binary qualification.
3. Default-visible Early Access after packaged desktop smoke and restart testing.
4. General availability only after extension/version degradation, resume, runtime-mode, and long-turn soak gates pass.

## 9. Failure and recovery matrix

| Failure                         | Expected behavior                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| Binary missing                  | Instance unavailable; no repeated spawn loop.                                          |
| Version incompatible            | Unhealthy with minimum-version guidance.                                               |
| Initialize timeout              | Kill process scope; safe protocol timeout diagnostic.                                  |
| Authentication rejected         | Unauthenticated; no secret/raw provider body shown.                                    |
| Session load fails              | Do not silently create a context-free replacement. Surface recovery/new-thread choice. |
| Stdout invalid/oversized        | Fail protocol/session and reap process; do not log raw frame.                          |
| Stderr flood                    | Bounded capture/ring buffer with redaction; never block stdout protocol.               |
| Notification flood              | Bounded queue/backpressure; fail safely before memory exhaustion.                      |
| Prompt response hangs           | Complete from validated xAI completion signal after drain.                             |
| Completion notification missing | Complete from standard prompt response after drain.                                    |
| Both completion paths arrive    | De-duplicate by upstream prompt/active turn identity.                                  |
| Cancel races with success       | One terminal Cafe outcome; preserve already accepted transcript.                       |
| Permission UI disappears        | Cancel/deny pending request according to provider contract.                            |
| Renderer reconnects             | Pending interactions remain backend-owned and are projected again.                     |
| Process exits mid-turn          | Fail active turn once, settle responders, close session.                               |
| Old process emits late event    | Context generation mismatch drops it.                                                  |
| Usage ledger resets on resume   | Establish new baseline; never emit decreasing/negative totals.                         |
| Optional xAI method missing     | Disable only its capability; standard chat remains healthy.                            |

## 10. Security review checklist

Before merge, verify:

- Grok is always a Cafe-owned direct child for this design; `--no-leader` prevents implicit shared process ownership.
- No process argv contains an API key, cached token, MCP bearer, prompt, or output.
- Sensitive environment values are handled through the existing redacted provider-instance environment path.
- `GROK_HOME` is resolved/canonicalized and never symlinked or copied by Cafe merely to share auth.
- Cafe never writes or logs Grok auth files.
- MCP stays on Cafe's authenticated loopback/IPC boundary, and its bearer header is excluded from protocol logging.
- Attachment bytes come only from Cafe's validated attachment store and respect count/size/MIME limits.
- ACP message and queue sizes are bounded.
- Unknown permission kinds are never auto-approved in `auto-accept-edits`.
- Full access is explicit; it is not selected as a fallback after sandbox failure.
- Failure to apply the selected sandbox fails session startup for protected modes rather than continuing unsandboxed.
- Raw prompts, outputs, tool payloads, auth errors, and unrestricted paths do not appear in event logs, debug endpoints, telemetry, or user-visible errors.
- Session IDs and continuation keys cannot cross provider instances or Grok homes.
- Stop/restart cannot orphan a provider process or leave an interaction responder open.
- Private xAI extensions are schema-validated and version/capability gated.

## 11. Pull request sequence

Keep the work reviewable and avoid one provider-sized mega-PR:

1. **PR 1 — ACP protocol package.** Generated types, stdio JSON-RPC client, tests, package/bundle staging.
2. **PR 2 — generic ACP runtime.** Process scope, lifecycle state machine, replay gate, event queue/barrier, safe logging, fake-agent tests.
3. **PR 3 — Grok driver and probes.** Settings/contracts, xAI schemas, spawn/auth/sandbox support, health/model catalog, built-in registration.
4. **PR 4 — core Grok chat.** New/load/resume, streaming text/reasoning/tools/plans, prompt completion, interrupt, usage, process cleanup.
5. **PR 5 — interactions and steering.** Permissions, runtime modes, structured questions, plan approval, images, `x.ai/interject`.
6. **PR 6 — product surface.** Text generation, settings UX, model picker, icons, diagnostics, docs.
7. **PR 7 — qualification/hardening.** Opt-in real-binary e2e, packaged desktop smoke, long-turn/restart soak, Early Access flag.
8. **Later PRs.** Proven in-session model switching, native rewind, provider goals, and subagent/task topology.

Every PR that changes generated bundles, provider process startup, or desktop packaging must run the full required verification rather than deferring it to the last PR.

## 12. Verification commands and gates

For every code-changing PR:

```text
yarn fmt
yarn lint
yarn typecheck
yarn test
```

For ACP bundle/staging, Grok process startup, backend bootstrap, or desktop packaging changes:

```text
yarn build:desktop
```

Add targeted commands for:

- `effect-acp` protocol tests;
- generic ACP fake-agent lifecycle tests;
- Grok adapter tests;
- provider settings/registry/model catalog tests;
- renderer provider-settings/model-picker tests;
- an explicit environment-gated Grok ACP e2e probe;
- packaged desktop smoke on every supported platform.

The default `yarn test` path must never require a Grok binary, real xAI credentials, detached process handoff, or network access.

## 13. Definition of done for Early Access

The initial integration is done only when all of the following are true:

- Grok is a registered first-party provider instance with redacted settings and truthful health/auth state.
- The packaged server contains and can load the typed ACP implementation.
- A Grok session can start, stream, use tools, request approval, ask questions, propose a plan, accept images, and report usage.
- A live turn can be steered through `x.ai/interject` and interrupted through ACP cancellation.
- Server restart can load the Grok session without duplicating prior activity.
- Prompt completion is correct whether the standard response, the xAI notification, or cancellation wins the race.
- Process exit and stop always settle pending interactions and reap owned children.
- Runtime modes select the intended sandbox and approval behavior, with no unsafe fallback.
- MCP works without exposing its bearer credential.
- Unsupported model-switch, goal, rewind, platform, or extension behavior is absent/disabled in the UI.
- Source tests, formatting, lint, typecheck, unit tests, desktop build, opt-in real-binary qualification, and packaged smoke all pass.
- `AGENTS.md` and user-facing documentation describe the actual lifecycle, security boundaries, versions, and limitations.

## 14. Post-Early-Access roadmap

### Native rewind

Use `x.ai/rewind/points` to correlate Grok prompt indices/response IDs with Cafe turns. Before calling `x.ai/rewind/execute`, define whether the mode rewinds conversation only, files only, or both; pause the session; reconcile Cafe's checkpoint/worktree state; execute the rewind; suppress replay; update the resume cursor; and prove a subsequent turn sees the expected conversation and filesystem. Until that atomicity story is complete, Cafe's own checkpoint revert remains the safer user-facing mechanism.

### Provider-owned goals

xAI currently exposes goal behavior and notifications, but Cafe's contract requires direct durable get/set/clear semantics. Do not implement those methods by secretly injecting slash commands into the user's conversation. Add goal support only when a stable extension or a rigorously isolated command-control path can provide exact state, idempotency, persistence, and cancellation semantics.

### In-session model switching

After a real multi-turn test proves `session/set_model` keeps context and correctly applies model-specific options, advertise `in-session`, update model state from ACP notifications, and remove the new-thread restriction. Include resume-after-switch and option-change tests.

### Subagent and task topology

Map xAI task/subagent notifications into a canonical provider-neutral hierarchy only after contracts exist for parent/child identity, status, usage folding, cancellation, and replay. The initial flattening into work-log/tool activity must preserve information needed for later migration without exposing raw provider payloads.

## 15. Final realism assessment

ACP is sufficient for a serious Grok integration. Cafe will not be missing the core coding-agent experience if the plan above is followed. The main risk is not ACP itself; it is falsely treating xAI's private extensions, process-scoped sandbox, prompt-completion workaround, and session replay as simple request/response plumbing.

The implementation is medium-to-large: roughly seven reviewable PRs, a reusable protocol/runtime foundation, and real-binary qualification. That investment is justified because it yields a maintainable ACP layer that could support additional ACP agents later while keeping Grok-specific behavior isolated and truthfully capability-gated.
