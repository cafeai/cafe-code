# Grok Build in Cafe Code

Grok Build is available as an Early Access first-party provider. Cafe connects to an external Grok CLI over the Agent Client Protocol (ACP); Cafe does not bundle, install, update, or launch interactive login for Grok.

## Install and sign in

1. Install Grok Build by following the [official xAI installation guide](https://docs.x.ai/build/overview).
2. Confirm `grok --version` reports `1.0.4` or newer.
3. Run `grok login` in a terminal and complete authentication.
4. Start Cafe Code and open Settings → Providers → Grok Build. Set a binary path only if `grok` is not on the backend process `PATH`.

An optional Grok home may be configured per provider instance. Leave it blank to reuse the normal Grok home and cached login. Different configured homes are isolated continuation/auth domains and do not share Cafe resume state.

For API-key authentication, add `XAI_API_KEY` as a sensitive environment entry on the Grok provider instance. Cafe selects it only when the connected CLI advertises `xai.api_key`; otherwise it uses an advertised cached noninteractive login method. Secrets remain server-side and redacted from settings responses.

## Runtime behavior

Cafe starts one owned Grok process per materialized thread using ACP stdio, disables Grok's background updater, and disables Grok leader sharing. The process ends when Cafe stops that provider session. A durable ACP session ID lets Cafe load the same Grok conversation after a backend/provider restart while suppressing replayed historical updates.

Grok's ACP `session/prompt` call stays open until the model finishes, including for multi-hour turns. Cafe acknowledges the turn to its provider daemon as soon as the turn id is allocated, then keeps the blocking ACP call in the owned session scope while runtime events stream progress and completion. This prevents Cafe's short control-plane request timeout from becoming a Grok turn timeout. Stop first delivers standard ACP cancellation, then retires the owned child after publishing the cancelled turn; the next explicit send loads the same native conversation in a fresh process, so a delayed provider loop cannot keep editing or poison the next turn.

The model, reasoning level, access policy, Plan mode, and Auto mode can change between turns without creating a new Cafe thread. Cafe starts a replacement Grok child with the selected process flags, loads the same native Grok session, and transfers ownership only after the replacement is ready. If startup, sandbox enforcement, or resume fails, Cafe closes the candidate and leaves the prior idle process authoritative. Plan combines Grok's native `plan` policy with Cafe's read-only sandbox; Auto combines native `auto` with the workspace sandbox.

Grok CLI 1.0.4 does not advertise the standard ACP session-mode/configuration capability, so Cafe does not send speculative mode writes. Plan and Auto use Grok's documented process-native permission modes through restart-resume, and `x.ai/exit_plan_mode` handles plan approval. Model-specific reasoning choices advertised by Grok use Cafe's existing Reasoning selector.

Cafe access modes map to Grok's process sandbox:

| Cafe access mode  | Grok sandbox | Grok permission mode | Cafe approval behavior                                                                                                                                              |
| ----------------- | ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approval required | `read-only`  | `default`            | Grok uses its normal ask policy; mutating work also remains blocked by the read-only process sandbox.                                                               |
| Auto-accept edits | `workspace`  | `acceptEdits`        | File edits proceed without prompting; execute/read/unknown requests and any provider-retained ask rule still require a decision.                                    |
| Full access       | `off`        | `bypassPermissions`  | Ordinary tool calls proceed without Cafe prompts. Any request Grok still emits may represent an ask/deny rule, hook, or managed policy and remains visible in Cafe. |

Cafe passes the native permission mode explicitly, so a persisted Grok UI default cannot silently weaken the selected Cafe access mode. Grok's deny rules, hooks, and managed policy remain authoritative.

Grok documents that a built-in sandbox may warn and continue if the host cannot enforce it. Cafe detects that startup warning for protected modes and stops the session instead of continuing unsandboxed. On Linux, Grok uses Landlock; on macOS it uses Seatbelt. Network restrictions differ by platform, so the sandbox should not be treated as a VM or as a boundary around Grok's own in-process model/web traffic. See xAI's [sandbox documentation](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/18-sandbox.md) for the upstream details.

## Supported features and limits

The Early Access adapter supports streaming text and reasoning, structured tool/work events, permissions, native Plan and Auto, structured questions, plan approval, prompt images, interruption, real mid-turn steering through `x.ai/interject`, resume, model/reasoning/access switching, model discovery, slash commands, user-invocable skills, provider-native conversation rewind, durable Grok goals, context-window percentage, inferred compaction notices, token usage where advertised, shared subscription usage remaining/reset time, and Cafe's authenticated per-thread MCP tools. Stable Grok 1.0.4 can report terminal prompt state through `_x.ai/session/update` instead of resolving the standard prompt request; Cafe accepts that exact terminal variant and, when standard last-call token metadata is absent, reads only bounded numeric inference counters for the matching session/prompt from Grok's non-symlinked unified log. Cumulative multi-call usage is never substituted for context occupancy. Grok data is projected only through Cafe's existing generic surfaces; provider cost is not exposed. Title, branch, commit, and pull-request text generation uses a separate disposable read-only Grok session without Cafe MCP access.

Cafe feature-detects Grok's official `x.ai/billing` ACP extension during provider health checks. Stable Grok 1.0.4 currently returns method-not-found on agent stdio, so Cafe falls back to the same fixed HTTPS CLI-proxy billing endpoint used by Grok itself. The fallback reads the current regular `GROK_HOME/auth.json` login credential without modifying or refreshing it, rejects symlinked auth material, and sends the bearer only in the request header. Only the unified usage percentage and period timing enter the provider snapshot; balances, on-demand usage, product cost breakdowns, top-up settings, credentials, and raw responses are discarded. Account usage refreshes on the existing provider cadence and through a throttled background usage-only refresh after a prompt completes, fails, or is interrupted.

Current limitations:

- Process-wide model, reasoning, access, Plan, and Auto changes briefly restart and resume the owned Grok process between turns; Grok ACP does not expose negotiated live setters for all of them.
- Grok goal token budgets are rejected because CLI 1.0.4 does not expose a reliable budget argument. Rich subagent topology is still flattened into the existing work log.
- Cafe does not start browser login or manage Grok updates.
- Optional private xAI extensions can vary by CLI version. Failure of usage or another optional extension does not stop standard ACP chat; unavailable behavior is not treated as a standard ACP guarantee.
- Text-only live steering uses Grok's legacy-compatible `x.ai/interject` shape. If Grok rejects an interjection, Cafe preserves it in the existing follow-up queue and delivers it after the active turn is ready.
- The implementation is qualified as Early Access. The development canary currently targets Grok `1.0.4 (d846eb93d9)` and ACP schema package `0.11.3`. Linux is covered by the local real-binary canary; macOS and Windows require their own native release canaries before Cafe makes a stronger support claim.

## Diagnostics and real-binary canary

Provider settings report whether the CLI is missing, outdated, timed out, unauthenticated, protocol-incompatible, or ready. Raw provider stderr, prompts, outputs, tool payloads, credentials, MCP headers, and full Grok-home paths are not included in user-visible diagnostics.

### CLI works, but Cafe reports a sandbox failure

Cafe's provider check defaults to a **read-only** sandbox. An ordinary
terminal `grok` session defaults to sandboxing off, so a working interactive CLI
does not prove that protected ACP startup works on the same machine.

Grok 1.0.34 refuses read-only startup when a container-runtime socket endpoint is
a symbolic link. Docker Desktop's optional `/var/run/docker.sock` link on macOS
can trigger this before ACP initialization or authentication. Cafe identifies
this as a sandbox failure, keeps authentication unknown, and reports the safe
reason instead of telling you to log in again. Other enforcement failures retain
a generic sandbox-specific message. Probe logs record only the fixed startup
phase, error tag/code, and classified reason; raw stderr and socket targets are
discarded. A fast child exit does not discard a warning already in its stderr
pipe, and Cafe never retries with weaker protection.

This endpoint refusal is present in the upstream
[runtime-socket resolver](https://github.com/xai-org/grok-build/blob/482711333c7195dc16a272777f86086d615e2afb/crates/codegen/xai-grok-sandbox/src/runtime_sockets.rs).
It cannot safely be repaired by silently switching to `off`, `workspace`, or a
custom profile that removes container-socket protection. Review your container
socket configuration or use a provider version that supports it. On Docker
Desktop for Mac, Settings → Advanced controls the optional default socket link;
disabling it is a **user decision**, since other Docker clients may depend on
that path. The Docker CLI itself can use its active context. See
[Docker's permission requirements](https://docs.docker.com/desktop/setup/install/mac-permission-requirements/).
Cafe does not delete or modify Docker's socket, login state, or configuration.

### Explicit Full access connection checks

If you want to use Grok without changing Docker, open **Settings → Providers →
Grok Build → Use without sandbox** and read the confirmation. This saves consent
for that specific provider instance to run its connection checks outside the OS
sandbox. Checks still use Grok's native default/ask approval policy, do not send
a model prompt, and do not register Cafe's per-thread MCP tools. Missing consent
keeps protected checks; Cafe never switches automatically after a failure.

After a successful check Grok becomes selectable, with a notice that sandbox
support was **not checked**. In the chat, select the existing **Full access** mode
to run normally without a sandbox. Full access also bypasses ordinary approval
prompts; it is not equivalent to sandbox-off with approvals enabled. The check
preference does **not** change a chat's selected access mode. Plan, protected
chat modes and title/branch/commit/PR helpers still require their existing
sandboxes and may remain unavailable on the affected host.

Choose **Use protected checks** to revoke the connection-check consent. Make
provider configuration changes between sessions because saving can reload the
instance. Revocation does not itself change a chat's Full access selection.
These controls apply to the selected Grok instance only, not to other providers
or other Grok installations. See the [qualification decision](decisions/grok-explicit-full-access-qualification.md)
for the security boundary and failure behavior.

The normal test suite uses a mock ACP agent and needs no Grok credentials. Maintainers can run the explicit credentialed canary without adding it to the default test path:

```bash
CAFE_CODE_GROK_E2E=1 \
CAFE_CODE_GROK_BINARY_PATH=/absolute/path/to/grok \
yarn workspace @cafeai/cafe-code test:e2e:grok-acp
```

The canary uses a fixed read-only, no-tool prompt and does not print the prompt or model response. It is still a real provider request and may consume account quota.
