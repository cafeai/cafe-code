# Codex 0.157 compatibility, update reliability and token efficiency

Audit date: 2026-09-25. Review window: September 18–25, 2026.

## Target and actual startup failure

The current stable target is Codex **0.157.0**, release commit `00c972ed5d6ff6499317fd41b7f23605b8e6850d`. The prior generated protocol targeted `fe74a774532af67b5a4a3dec03ce9469e17f89af` (0.156.0). This source-level refresh does not change repository dependencies or automatically install a provider. [Official release](https://github.com/openai/codex/releases/tag/rust-v0.157.0)

The reported immediate exit was an incomplete local installation, not an incompatible turn protocol or invalid account credentials. Official registry publication times establish the release window:

| Artifact/event                             | September 25 UTC |
| ------------------------------------------ | ---------------- |
| Main 0.157.0 package published             | 02:35:19.752     |
| User's update started                      | 02:35:49         |
| macOS ARM64 0.157.0 native alias published | 02:39:39.490     |

The installer exited zero after installing the launcher without its missing optional executable. Cafe's post-update version probe correctly classified the installation as broken, but its updater incorrectly treated the absence of an “outdated” advisory as success. Account-specific instances sharing this executable then failed at process startup. No credential failure was established. [Official package/version metadata](https://registry.npmjs.org/@openai/codex)

## Implemented changes

- Regenerate the typed app-server schemas from the immutable target. Preserve older payloads while adding gateway account RPCs, item-history timestamps, MCP resource targeting/origins and plugin extension metadata. Parameterless gateway methods explicitly map to their upstream response schemas.
- Before existing package-managed Codex updates execute, resolve fresh official wrapper and host-native alias manifests. Require exact identities, stable version, OS/architecture, fixed registry tarball locations and SHA-512 descriptors. Bound each metadata response to 256 KiB and both requests/body reads to one eight-second deadline. If the native package is not published, do not run the installer.
- Pin the existing structured update command's package argument to that exact verified version; a moving `latest` tag must not change the admitted target. Preserve existing executable selection and update serialization. Other providers and native package-manager update actions retain their existing paths.
- After installation, require a usable fresh runtime observation, a parseable version and conclusive current-version evidence. For a preflighted update, also require the actual version to equal the admitted target. A zero installer exit, unknown/null version, disabled instance, failed/timed-out probe or stale cached advisory cannot establish success. A healthy unauthenticated CLI is not mistaken for an installation failure merely because the user has not logged in.
- Bound version-advisory connection, headers, JSON body and decode together to four seconds, so a stalled metadata body cannot retain the update lock indefinitely.
- Keep new gateway authorization URLs/errors out of logs, durable events and child-liveness accounting. Drop unsupported gateway login notifications before publication and again at the adapter boundary for injected runtimes/replay; sanitize both method-aware decode failures and methodless malformed JSON diagnostics. Do not opt into gateway-login UI ownership or launch URLs automatically.

The preflight is **metadata admission**, not an archive/signature verifier or a transactionally atomic installer. An artifact, registry mirror or network failure after admission can still break an installation; the post-update probe must report that failure rather than claim success. No automatic reinstall, binary substitution or credential rewrite was added.

## Compatibility decisions

The stable thread start/resume and normal turn start/steer/interrupt request contracts did not require a Cafe lifecycle rewrite. Automatic daemon startup in this release belongs to eligible interactive TUI sessions; explicit `codex app-server` still launches directly. Conditional interruption and `invalid_prompt` handling are native implementation changes, not new required Cafe RPCs; the latter maps to the existing public `other` error classification. Experimental MXC hosting remains disabled. [Immutable CLI entrypoint](https://github.com/openai/codex/blob/00c972ed5d6ff6499317fd41b7f23605b8e6850d/codex-rs/cli/src/main.rs)

New plugin/MCP metadata remains descriptive, not authorization to call tools, fetch resources or host plugin UI. Item-history timestamps do not become terminal turn evidence. Existing attachment delivery, permission callbacks, Stop barriers, native resume identity and uncertain-ACK protection remain unchanged. [Immutable protocol source](https://github.com/openai/codex/tree/00c972ed5d6ff6499317fd41b7f23605b8e6850d/codex-rs/app-server-protocol/src/protocol)

### Concurrent subagents

Re-audit confirmed the canonical `agents.max_concurrent_threads_per_session` and legacy `max_threads` alias, positive `usize` minimum one and no further upstream numeric maximum. V1 defaults to six spawned agents. V2 defaults to four resident threads including the root (three spawned); an explicit V2 total takes precedence, otherwise public spawned count `N` translates to `N + 1`. Idle children may be unloaded, so this is not a historical-thread count. Cafe retains optional 1–64 validation and emits both public `N` and V2 total `N + 1` only when configured. Omission and backend selection stay native. The Bedrock catalog selects V1. [Configuration resolution](https://github.com/openai/codex/blob/00c972ed5d6ff6499317fd41b7f23605b8e6850d/codex-rs/core/src/config/mod.rs), [configuration keys](https://github.com/openai/codex/blob/00c972ed5d6ff6499317fd41b7f23605b8e6850d/codex-rs/core/src/config/config_toml.rs), [Bedrock catalog](https://github.com/openai/codex/blob/00c972ed5d6ff6499317fd41b7f23605b8e6850d/codex-rs/model-provider/src/amazon_bedrock/catalog.rs)

## Last-week token and cache audit

| Upstream change                                                                       | Effect and Cafe decision                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.157 descendant channel-post compaction (`c117207a6f1f948ac7fcdd5e784d75fc4e9d13e1`) | Native compaction sees the posts but does not retain them again afterward. A real retained-context reduction; preserve native compaction/resume rather than adding a second summarizer. |
| Resume metadata checkpoints and newest-complete-compaction replay                     | Native state correctness, local I/O and startup efficiency. Do not claim measured token savings or reimplement replay in Cafe.                                                          |
| Cloud-skill catalog caching                                                           | Fewer discovery operations until authentication/resource-generation invalidation; not evidence of a smaller billed prompt.                                                              |
| 0.156 parent cache affinity and content-based history token estimates                 | Already provided by the CLI through native sessions/forks. Cafe must not replace cache identities or serialized transcripts.                                                            |
| Shared developer-message recommendations / model Code Mode descriptions               | Native prompt/tool layout. Do not copy these prompts into Cafe or advertise shorter prompts without measurements.                                                                       |
| Astra reasoning-effort-update capability                                              | Native feature remains under development/default-off; capability metadata alone does not justify enabling it.                                                                           |
| After-final compaction and cache TTL                                                  | Keep upstream/user choices. No forced compaction, TTL override, reasoning/quality reduction or model substitution.                                                                      |

Relevant immutable sources: [channel-post compaction change](https://github.com/openai/codex/commit/c117207a6f1f948ac7fcdd5e784d75fc4e9d13e1), [native client/cache behavior](https://github.com/openai/codex/blob/00c972ed5d6ff6499317fd41b7f23605b8e6850d/codex-rs/core/src/client.rs), [feature defaults](https://github.com/openai/codex/blob/00c972ed5d6ff6499317fd41b7f23605b8e6850d/codex-rs/features/src/lib.rs).

Cafe already keeps stable helper prompts, combined title/branch generation, bounded read-on-demand attachment manifests, explicit Fast-off handling and native session reuse. No additional proven token-saving override was missing in this release. No paid inference or token benchmark was run, and no percentage savings are claimed. Cafe's API-price usage estimates are not subscription bills: Codex credit billing has no separate cache-write charge, while API-key billing follows API pricing. [Codex pricing](https://learn.chatgpt.com/docs/pricing)

## Authorized local repair and verification

With explicit user approval, restored only the missing 0.157.0 macOS ARM64 dependency inside the existing selected launcher installation. Downloaded official artifact integrity:

```text
sha512-mcaLbR+tTizMr7nzxBscNfPpGrdxmsyyDqXnpPPd2419YXorDiLGpF5QmtA29gUUFg9ppjhZjM854R4tXNHzVQ==
```

Both registry signatures and the artifact checksum verified before extraction with repository-pinned Yarn and install scripts disabled. The wrapper and credentials were unchanged. `codex --version` returned `codex-cli 0.157.0`; an isolated empty-home app-server initialization completed and exited zero with no stderr or inference requests. This proves executable/protocol startup, not a live authenticated model turn. No running Cafe task was restarted.

Verification used Node 24.13.1 and Corepack Yarn 4.17.1. Focused coverage includes 32 publication-preflight tests, 26 updater tests, 18 maintenance tests, 27 generated-protocol tests, and runtime/adapter privacy coverage. The full `yarn fmt`, `yarn lint` and ten-task `yarn typecheck` passed; `yarn test --concurrency=2 -- --maxWorkers=2` passed all ten tasks with 4,759 tests and three existing skips (2m48.628s). Lint retained existing warnings outside the changed code. The subsequent `yarn build:desktop --force` passed all three tasks (24.585s). A read-only execution of the new preflight against the official registry admitted exactly 0.157.0 without running an installer. Independent review covered concurrency, metadata/argv admission, runtime verification, deadlines and private-notification handling. Local check logs are in `/tmp/cafe-codex157-checks.BZ8QQl`; the final committed revision is force-built again before push. Existing uncommitted dictation/mockup work remains outside this provider commit.
