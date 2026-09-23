# Provider compatibility, usability and token efficiency — September 23, 2026

Created: 2026-09-23 10:42:20 JST (UTC+0900)
Last updated: 2026-09-23 10:55:31 JST (UTC+0900)
Status: implemented and verified.

Scope: September 16–23 releases, extending the [September 18 audit](provider-updates-2026-09-18.md). This document supersedes its current-version conclusions, not its historical test evidence. No live inference, account credentials, global provider installations or running sessions are changed by this update.

## Qualified versions

| Component             | Decision and evidence                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex protocol        | Regenerated from the [0.156.0 release](https://github.com/openai/codex/releases/tag/rust-v0.156.0), immutable commit `fe74a774532af67b5a4a3dec03ce9469e17f89af`, published September 22 at 19:51:01 UTC. Source inspection/generation does not install the new runtime or bypass package quarantine. Existing 0.155 runtime fixtures remain supported. |
| Claude SDK            | All three exact pins move together from 0.3.274 to **0.3.278**. The wrapper and eight platform tarballs passed SHA-512 verification and all 18 npm registry signatures at `2026-09-23T01:19:46.174Z`. The youngest package, Linux arm64 musl, cleared the 24-hour gate at `2026-09-20T01:50:22.564Z`.                                                  |
| Newer Claude SDK      | **0.3.280 is deliberately deferred**: its complete package set clears quarantine at `2026-09-23T15:51:11.813Z` (September 24, 00:51 JST). Recheck integrity/signatures and compatibility when adopting it; age alone is not approval. The changelog's 0.3.279 heading did not identify a published registry package during this audit.                 |
| Configured Claude CLI | Cafe still uses the user's configured executable, independently of SDK version. Already-installed CLI 2.1.280 can expose Opus 5.5 and its native fixes without installing SDK 0.3.280 or altering that executable.                                                                                                                                     |

Claude wrapper SRI: `sha512-hXfjyiGraqYul6gq7R7+WmktxJfy9S29Yrx1WK6jQpsYcipf1CYIoYSh22SpGOR3FGiEmeuzXg5U9ncOk19Fww==`. Registry evidence: [immutable 0.3.278 metadata](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.278), [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md), [CLI releases](https://github.com/anthropics/claude-code/releases). Platform packages add no lifecycle scripts or dependencies. The repository lockfile records exact resolutions and checksums.

## Changes implemented in Cafe

### Codex protocol and rewind

Codex 0.156 deletes `thread/rollback`. Paginated native histories now use supported `thread/revert` before an exact native turn. Cafe reads bounded descending turn metadata with `itemsView: "notLoaded"`, verifies the requested identity and idle state, refuses goals that can continue autonomously, and rechecks the latest turn before mutation. A single preflight deadline covers all reads; no transcript bodies are needed. Older legacy histories keep a narrow explicit rollback path outside the current generated RPC map. Unsupported legacy histories fail visibly rather than guessing a destructive boundary.

The new native operation can commit before a later reload reports an error. Therefore an ambiguous response must never authorize a second rewind or ordinary filesystem compensation: read-only reconciliation may prove the result, otherwise Cafe preserves its private recovery checkpoint and reports the uncertainty. This is an explicit recovery boundary, not silent success. Active user work is never stopped implicitly to enable rewind.

Generated schemas also retain image URL/file-id alternatives and their shared discriminants, nullable model-access metadata, MCP app metadata, optional resume collaboration mode and per-turn disabled-plugin lists. These are backward-compatible protocol surfaces, not permission to upload files or render arbitrary MCP UI resources. Existing native attachment privacy filters, finite protocol lines and bounded resume pages remain unchanged. See the [official app-server contract](https://learn.chatgpt.com/docs/app-server).

### Claude restored usage

Claude Code 2.1.277+ can restore saved `modelUsage` on resume/fork. Cafe's per-query accounting epoch previously treated restored lifetime totals as new usage. The fix subtracts a bounded, private numeric baseline before settling current results, using the actual CLI initialization version rather than the imported SDK version. Raw model aliases map only through matching live `canonicalModel` metadata, with row-level monotonicity checks before aggregation.

The baseline reader inspects only the exact session's last `cost-state` metadata: at most 4 MiB, 64 KiB chunks, 128 KiB per line and one second. It rejects unsafe symlinks/ownership, partial records and changed filesystem identity; prompts and outputs never enter diagnostics or accounting state. No metadata is backfilled. Missing/untrusted evidence leaves explicitly incomplete observed primary input plus later proven deltas, rather than inflating costs or inventing child/output totals. Fresh sessions, explicit resets and proven metadata absence start at zero. The public SDK fork used by Cafe currently omits `cost-state`; the native CLI fork path can preserve it, so not every fork inherits a baseline.

This is a new security-sensitive read boundary, reviewed and regression-tested. It does not add transcript polling, an experimental usage network request, provider credential access or paid inference. External native writes after the final identity check cannot be transactionally locked to CLI launch; no unsupported provider lock is invented. See the [decision and fallback policy](decisions/claude-resumed-usage-baseline.md) and [official cost contract](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

### Models, helper default and cost presentation

- GPT-6 Sol and Luna have cold-start/custom model controls matching the [Codex model guide](https://learn.chatgpt.com/docs/models): Medium default; Sol through Ultra, Luna through Max. Live `model/list` remains authoritative. Embedded 0.156 does not include these new rows, so Cafe does not invent a larger context window or force their availability on an account.
- Opus 5.5 is selectable with CLI 2.1.280+, 1M context, Medium default effort, Fast and Auto controls. Moving `opus` aliases follow upstream, while explicit Opus 5 selections stay pinned. Cafe keeps Sonnet 5 as its new-task default. See [Claude model configuration](https://code.claude.com/docs/en/model-config).
- Unset metadata-helper selection now uses the already-qualified GPT-5.6 Luna instead of retired GPT-5.4 Mini. Explicit user selections are unchanged. No additional probe, model call, retry or global setting is introduced.
- Pricing uses explicit rows rather than incorrect broad family fallbacks. **Net cache savings now subtract cache-write premiums**, including negative warmup costs in the UI.

Standard USD per million tokens, verified September 23 from [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing):

| Model            | Input | Cached input | Cache write | Output |
| ---------------- | ----: | -----------: | ----------: | -----: |
| GPT-6 Sol        |     2 |         0.20 |        2.50 |     10 |
| GPT-6 Luna       |  0.10 |         0.01 |       0.125 |   0.50 |
| GPT-5.6 Sol      |     4 |         0.40 |           5 |     20 |
| GPT-5.6 Terra    |     2 |         0.20 |        2.50 |     12 |
| GPT-5.6 Luna     |  0.20 |         0.02 |        0.25 |   1.20 |
| Opus 5.5         |     4 |         0.20 |           5 |     20 |
| Opus 5 / 4.5–4.8 |     5 |         0.50 |        6.25 |     25 |
| Sonnet 5         |     2 |         0.20 |        2.50 |     10 |
| Haiku 4.5        |     1 |         0.10 |        1.25 |      5 |

GPT-5.6 rates are also confirmed by their individual official model pages; Sol's current promotional rates are promised through at least November 21, 2026. These are standard-rate estimates, not subscription bills. The ledger cannot infer per-request long-context premiums, service tiers, regional rates or one-hour cache writes from lifetime totals. Fable 5.1's distinct cache rate was already correct. Unknown models remain explicitly unpriced.

## Native improvements deliberately not duplicated

| Area                         | Upstream change / Cafe decision                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex cache and compaction   | 0.156 preserves parent cache affinity for ephemeral forks, estimates history tokens from content rather than serialized envelopes, and includes executed Code Mode metadata in compaction. After-final compaction is new but opt-in; Cafe does not force it. Keep native sessions, cache keys, truncation budgets and native compaction authority. |
| Codex usability              | The 0.155.1 TUI reasoning-summary default and 0.156 TUI fullscreen/search/themes/voice/worktree presentation are not app-server requirements. Native Plan resume, partial-stream preservation, OAuth and sandbox fixes apply with the chosen CLI; Cafe does not reproduce native retry or process ownership logic.                                 |
| Claude cache / delivery      | 2.1.277–2.1.280 fixes model-switch and resumed-fork tool-list cache reuse, restored attachment/thinking behavior, queued delivery and startup work. Retain the stable `claude_code` prompt preset, native prompt snapshots and existing input correlation; no dynamic suffixes, keepalive inference or forced cache TTL.                           |
| Claude SDK optional controls | `pasted_content` needs true paste provenance; don't stamp all files/messages as pasted. `projectConfigRoot` changes settings/trust scope and stays unset. `updateSettings` effort persistence must not silently change user defaults. Cafe sends no deprecated TaskOutputMaxChars setting.                                                         |
| New Claude 0.3.280 surfaces  | Global `verbatimPrompts` would change slash/@ behavior, MCP Apps metadata is alpha and lacks a Cafe UI-resource host, and scheduled `fireReason` requires host authority. These are not silently enabled. Existing elicitation cancellation/approval callbacks remain authoritative.                                                               |

The latest `dev` already contains manual compaction, earned usage-reset confirmation, queued-input handling and UI reliability changes; this audit preserves those implementations instead of adding competing paths. Attachment manifests remain bounded read-on-demand pointers, metadata helpers honor explicit Fast off and restricted tools, and quiet reasoning is not an automatic resend trigger.

These are source-derived safeguards, not measured account-specific cache-hit gains or guaranteed dollar savings. Pricing accuracy and avoiding double counting do not themselves reduce a provider's bill. Native optimizations require the configured runtime version that contains them.

## Concurrent-agent re-audit

Codex 0.156 retains `agents.max_concurrent_threads_per_session`, alias `max_threads`, positive `usize`, spawned-only counting and no upstream numeric maximum. V1 defaults to six spawned children; V2 defaults to four total/three children. Public `N` plus V2 total `N+1` remains necessary because explicit V2 configuration wins. Bedrock selects V1. Omission remains upstream-controlled; Cafe's optional 1–64 bound remains a local safety policy.

Verified Claude 2.1.278 native artifacts and the configured 2.1.280 retain `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, positive digit-only integer parsing and default 20. This gates local Agent-tool admission, with native feature/ultracode exceptions, not every manual fork, remote agent or workflow. No invented SDK property or universal process cap is added.

## Reproduction and verification

Use Node 24.19.0 and repository Corepack Yarn 4.17.1. Dependency provenance was verified before updating pins. A clean `git archive` checkout with only the three updated manifests and lockfile copied in passed `yarn install --immutable --mode=skip-build`; this isolates resolution/linking without existing dependencies. Native build scripts are skipped only for this install replay, not for final desktop verification.

Run `yarn fmt`, `yarn lint`, `yarn typecheck`, `yarn test`, the focused usage browser test, then **`yarn build:desktop --force` last**. Generated protocol, old/new provider fixtures, numeric usage baselines/aliases, model controls, pricing and negative cache savings have focused coverage. Rewind tests include bounded reads, exact identities, goals, changed history and ambiguous mutation reconciliation, plus checkpoint retry fencing.

Verification on September 23: full `yarn test` passed all ten workspace tasks (4,505 tests passed, three existing opt-in/platform cases skipped), full typecheck passed ten tasks, lint passed with existing warnings, and formatting passed. The focused Chromium usage UI passed seven tests; generated protocol tests passed 23 tests. The forced desktop build passed all three build tasks without cache reuse. Tests are credential-free fixtures, not a claim of live paid-provider or long-duration production qualification.
