# Qualified October Claude and Codex maintenance

Created: 2026-10-22 04:49:25 JST (UTC+0900)
Last updated: 2026-10-23 15:31:43 JST (UTC+0900)

## Selected versions and consumers

The October 23 recheck selects Codex **0.164.0** and Claude Code **2.1.308** /
Claude Agent SDK **0.3.308**, superseding the initial October 22 selection of
0.163.0 / 2.1.305 / 0.3.305 before that source was published. Qualification
freezes these exact versions, not moving `latest` tags. The generated Codex
protocol advances from 0.162.1 to immutable commit
`6aaac694803004a63c6f393d153c96d22521a6b9`; the separately managed Windows
CLI bundle advances from Codex 0.160.0. Claude's server, scripts and staged
desktop SDK declarations remain identical and exact, with their lockfile.

The Windows manifest records the generic launcher and both native architectures
with independently checked registry URLs and SHA512 integrities. Its existing
archive bounds, platform checks and installation controls are unchanged. Updating
source or building a bundle does not prove adoption by an already running
provider or upgrade an independently installed CLI. No global installation,
provider restart or migration of user profiles is part of this maintenance.

Node 24.21.0, Electron 42.11.15, TypeScript/Effect and the direct Anthropic API
SDK remain unchanged. In particular, Anthropic API SDK 1.0 is a separate breaking
API migration, not an incidental Agent SDK update.

## Codex protocol and security boundary

Codex 0.164.0 adds a valid file-backed `imageGeneration` reference alongside
legacy inline `result`. Cafe must decode both, including transitional records
with both fields, without losing progress or completion presentation. Native
deserialization prefers the file reference; a file ID is not a path, URL or
download capability. The ordinary app-server still uses the inline store and
the stable RPC surface has no attachment-store file-ID resolver. Existing
independently authorized `savedPath` publication remains separate.

The new `inputImages` paths/digests and generated `fileId` are omitted from
observational native logs, canonical activity/raw copies, public history and
protocol diagnostics. A shared bounded own-data-property projection refuses
accessors, proxies, cycles and excessive structures without executing received
code or rendering its errors. Keep the original wire for strict decoding and
native control: a projected file-only item is intentionally not a wire schema.
This does not remove provider-owned context or fetch additional data.

New `sci`/`sci_plus` plan names receive fixed provider-sourced display labels,
not entitlement, model availability or pricing inference. Stable additions such
as `feedback/save`, MCP metadata and storage requirements remain inert unless
an existing consumer needs them; experimental `thread/sample`, child-environment
and wake-agent controls are not enabled.

The frozen stable protocol adds `thread/readState/changed`, optional response-item
metadata, a thread-list exclusion filter and optional tool-output retention.
The root schema also adds realtime voice values. Canonical generation retains
those declared additions without adding experimental RPCs absent from the stable
client method union. Existing error-envelope preservation, unknown-message
handling, approval validation and public/private message filtering remain in
place. Read-state metadata does not imply that a turn completed or a child is
active.

The initial 0.163.0 increment includes DNS authorization and credential-alias protections,
cold-resume permission fixes, and incomplete-response / finishing-turn handling.
These are reasons to advance the managed native version, not evidence that a
particular historical Cafe failure had that cause. Cafe does not replace native
retry behavior or relax its own ownership and no-duplicate-submission guards.

Native 0.164.0 additionally repairs compaction history, compressed-rollout resume
and restored model settings, with metadata-alias, executable-symlink and hook
content-binding protections. Source pins do not establish that an installed
user CLI contains these changes. New child environments, wake-agent,
MCP-tool-list-changed and WebSocket compression flags remain off. Cafe does not
enable them or `subagent_default_context_limits`, nor change context/compaction
intent, inherited child settings, service tier or model.

The target's concurrency policy was re-audited: canonical
`agents.max_concurrent_threads_per_session`, alias `max_threads`, minimum one,
V1 default six children, V2 default four resident slots including root, explicit
V2 precedence and canonical child-count-to-root-inclusive translation are
unchanged. Omission still delegates to the native backend/model. V2 residency
can unload idle instances; this is not active-child cancellation authority or
a reason to replace Cafe's finite bounds.

Sources: [stable release](https://github.com/openai/codex/releases/tag/rust-v0.163.0),
[complete source comparison](https://github.com/openai/codex/compare/rust-v0.162.1...rust-v0.163.0),
[frozen protocol](https://github.com/openai/codex/tree/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/app-server-protocol),
[feature defaults](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/features/src/lib.rs),
[child configuration](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/agent/child_config.rs).

October 23 sources: [0.164 stable release](https://github.com/openai/codex/releases/tag/rust-v0.164.0),
[immutable incremental comparison](https://github.com/openai/codex/compare/83086188ae0614bd882818ff1aa23f3194962012...6aaac694803004a63c6f393d153c96d22521a6b9),
[image reference contract](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/ext/items/src/image_generation.rs),
[ordinary inline store](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/thread_manager.rs),
[feature defaults](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/features/src/lib.rs),
[concurrency configuration](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/config/src/config_toml.rs).

## Claude compatibility boundary

The 306–308 increment brings native model-switch, MCP retry/background-task and
compaction/subagent fixes through existing Cafe controls. SDK 307 adds optional
`wakeup_source`/`scheduled_for` lifecycle metadata; the Node declarations do not
specify those extension fields. An opaque-extra-metadata regression must protect
exact known/foreign UUID ownership without inventing a new wakeup queue or native
field grammar. Browser-dialog SDK options are unused and are not enabled.

The latest observed 309 pair is excluded by the mandatory complete-family
24-hour hold. Its native sandbox, symlink, MCP/permission protections and SDK
`managedSettings`/temporary-extraction fixes are **not** claimed as shipped in 308. Cafe does not use those SDK managed-settings or browser-dialog APIs; the
hold is not silently bypassed for a general security recommendation.

The selected pair includes native image/pipe protections, transcript and compacted
resume fixes and headless Stop/ended-input lifecycle corrections. Version 305
also repairs the 304 ToolSearch gateway regression and MCP name collision
behavior. Cafe keeps its explicit permission
mode, matched-Ask-rule restrictions, quota-only control path and existing
Stop/resume/task accounting. No automatic nested-user-namespace sandbox opt-in,
new prewarm call or behavior recommendation is enabled.

The native Agent tool's default fork-subagent behavior is distinct from the SDK's
offline `forkSession()` API. Cafe's publication store remains root-only. New
synthetic tests call the actual imported SDK with an exclusively test-owned
in-memory store and empty temporary directory: complete and inclusive-cutoff
forks must preserve source data, remap lineage and publish only a new root;
missing cutoffs and child-subpath reads must refuse without publication. They do
not invoke `query()`, a native CLI, credentials, user history or paid inference.

Sources: [official Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md),
[SDK 0.3.305 release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.305),
[Code 2.1.305 registry metadata](https://registry.npmjs.org/@anthropic-ai%2fclaude-code/2.1.305),
[SDK 0.3.305 registry metadata](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/0.3.305).

October 23 sources: [SDK 308 release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.308),
[SDK 307 changes](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.307),
[frozen native changelog](https://github.com/anthropics/claude-code/blob/65823ec0034ed0aa0266bc43903fefd3ff94a327/CHANGELOG.md),
[excluded SDK 309](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.309).

## Model pricing recheck

The required October 23 pricing/alias recheck found a pre-existing estimate gap:
`gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest` and `gpt-5.6-cyber` fell
through to generic GPT rates. Their specific standard-rate entries now reflect
the documented current Blue → Sol 5.6 and Red → Cyber 5.6 mappings. This does
not restore deprecated aliases in pickers, remap native requests, grant access,
rewrite usage counters or reconstruct past invoices. User overrides still win.
The shorter cache-write baseline is used; 12-hour writes, speed tiers and
per-request context premiums cannot be inferred from aggregate totals.

Sources: [official standard pricing](https://developers.openai.com/api/docs/pricing),
[Blue alias](https://developers.openai.com/api/docs/models/gpt-daybreak-blue-latest),
[Red alias](https://developers.openai.com/api/docs/models/gpt-daybreak-red-latest),
[Cyber model](https://developers.openai.com/api/docs/models/gpt-5.6-cyber).

## Admission and replay

Before installation, all selected platform metadata was checked: seven Codex
packages and nine packages in each Claude family. The complete SDK 308 set's
24-hour hold cleared at `2026-10-23T04:23:02.595Z`; Code 308 cleared at
`2026-10-23T04:24:07.912Z`. No Claude quarantine exception is added. Codex's
manual managed-manifest admission requires exact stable source, signatures and
archive integrity, not a claim that its new packages have elapsed 24 hours;
ordinary Yarn resolution keeps its existing age policy.
Official npm ECDSA signatures bind the selected package names, versions and
integrities. All 25 selected archives passed actual SHA512 SRI, published SHA1
and embedded-manifest comparison, including every platform sibling in both
Claude families and Codex. This was bounded serial streaming inspection, without
extracting or executing native binaries. The installed SDK's two public
declarations match the verified wrapper bytes. The registry key comes from official npm
HTTPS: this is not an independent publisher trust root, native functionality
proof, or verified source-to-binary reproducibility. Advertised Codex provenance
was not independently DSSE-verified.

Replay with the repository-pinned Node/Corepack Yarn toolchain:

1. `corepack yarn install --immutable`, then explicit `corepack yarn prepare`.
2. `corepack yarn workspace effect-codex-app-server generate` resolves only the
   committed immutable upstream ref. Review resulting changes rather than
   treating a generated header as protocol evidence.
3. Run the actual-SDK history tests, complete Codex protocol/client tests and
   synthetic Claude adapter/permissions/Stop/resume/task tests.
4. Run `corepack yarn fmt`, canonical `corepack yarn typecheck`, and complete
   `corepack yarn verify:local`; its forced desktop build is last. Preserve the
   qualified compiler diagnostics, worker caps, sandbox, input and deadlines.

Local synthetic/macOS checks are not live provider or native Windows/Linux
qualification. Hosted CI and installed-provider adoption are separate observations;
neither a source pin nor an archive hash establishes them.
