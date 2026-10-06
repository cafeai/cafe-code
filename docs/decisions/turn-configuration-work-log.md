# Decision: freeze a configuration sanity check for each accepted turn

Decision status: Accepted
Created: 2026-10-03 12:47:48 JST (UTC+0900)
Last updated: 2026-10-03 22:14:03 JST (UTC+0900)
Decision authority: implementation choice within the user's explicit request to show the model, settings and account at each turn start.
Implementation status: Implemented with acceptance, lifecycle-isolation, retention and rendering regression tests; qualification procedure and limits are listed below.
Supersedes: None. Supplements existing provider-switch work-log notices without changing provider execution authority.

## Context and decision

The composer describes the next selected configuration, not necessarily the configuration of an earlier turn. A provider account or model can change after submission, during streaming or before historical activity is loaded. Reconstructing an accepted turn from the current renderer selection or current registry would therefore provide a misleading sanity check.

Capture one bounded, versioned configuration snapshot at the existing server submission boundary and persist it only after the provider accepts that delivery. Use the exact routed account's configured display name, the submitted model selection or the materialized session configuration, and only the recognized presentation settings: effort, Fast, runtime mode and interaction mode. When the request omits model selection entirely, retain known same-account session options; an explicit new selection does not merge old options. Submitted settings may therefore include known session-inherited model settings alongside explicitly submitted mode settings. A frozen model display label may come from already available inventory; no provider refresh or inference is performed to obtain it. Preserve source attribution so selected/submitted configuration is not advertised as independent model-execution or billing telemetry.

Missing effort remains **provider default**. Codex Fast uses a separate optional `resolvedServiceTier` frozen at native turn admission: preserve the experimental start/resume response field and root-only settings updates, then resolve explicit turn overrides against that runtime-bound snapshot. Native null routing means Standard; an absent field from an older runtime or invalid tier remains unknown. Submitted Fast/tier options stay separate. The work log and Atrium show Fast on/off plus Standard, Fast or Ultra fast where known; future native tier ids stay exact without assumed speed semantics. Historical rows without routing or explicit options say **Fast status not recorded**. This records configured routing rather than independent billing or downstream execution confirmation. A send reconciled into an already-active steer preserves the original turn's configuration rather than publishing a newer composer selection that was never applied to it. ProviderService's optional `deliveryKind` result distinguishes actual start/steer delivery even when a provider has no steer correlation token; older results remain decodable, with existing positive steer identities used as a fallback. Rejected deliveries have no accepted-configuration record. Enqueue configuration recording only after the existing accepted-turn reconciliation and critical receipt writes, then detach it in a service-owned fiber. It shares the existing persistence engine, not an independent SQLite actor; placing it before accepted bookkeeping could block that bookkeeping despite the fork. A failed presentation write cannot consume the caller's provider timeout or authorize a second provider request.

The authenticated work log displays the frozen summary on every new accepted turn, including consecutive turns on the same account. Where the existing Codex acknowledgment is present for that exact turn, the renderer folds it into the configuration summary rather than displaying redundant rows. Old activities without a snapshot retain their existing text; no startup backfill, transcript scan or speculative rewrite of past turns is added. Provider-switch notices remain separate and retain their existing behavior.

Example compact row (labels wrap rather than truncate in narrow panes):

```text
Turn accepted · GPT-6.1 Sol · Effort: Ultra · Fast on
Account: Codex Personal · Build · Full access · Submitted settings
```

## Security, privacy and compatibility

This is authenticated transcript metadata, not a new operational diagnostic payload. Account means the user-configured provider-instance label, not an auth email, ChatGPT account identifier or credential. Never copy the entire model-option list, instance configuration, environment, auth response, prompt, filesystem path or raw provider diagnostics into this record. Bound and validate individual fields; labels are inert escaped text, not HTML or a command channel. Do not add these user-authored labels to trace/debug output.

The existing generic activity persistence stores the additive versioned payload; no new table or historical-data migration is necessary. Legacy events and older servers remain readable. UI history uses only saved metadata and must not borrow live model/account settings. Retain at most one latest-turn configuration beyond the ordinary bounded activity tail in compact snapshots and renderer pruning, so long-running work does not lose its sanity check. The accepted-turn identity and existing delivery/lifecycle fences remain authoritative: the summary does not start, finish, restart or otherwise control provider work, and late configuration activity cannot extend a terminal turn's completion timestamp. Windows, Linux and macOS use the same portable metadata and rendering path; launch, sandbox, permission and process-ownership behavior is unchanged.

The snapshot is the configuration Cafe submitted or knew for the active session. It is not proof that an upstream routing service executed a particular backend model or billed a particular tier. Omitted settings without native routing evidence stay explicitly unknown. Additional model requests, auth probes or paid work solely for a display check were rejected.

The record remains bound to the exact accepted result's turn ID. Existing ingestion may later adopt a different concrete ID from an authoritative provider start; this feature does not speculate about rebinding the earlier acceptance snapshot to that ID. Old or unconfirmed settings are not backfilled from today's composer. Provider adapters may also normalize a requested option; the summary identifies the submitted selection rather than claiming independently verified native execution settings.

## Atrium card projection

Atrium cards reuse this accepted-turn record beneath their provider header: model, effort and Fast on the first line, then configured account label and interaction/runtime modes. They use the same schema decoder and presentation helper as the work log. Selection is limited to the exact latest turn and rejects a differing active session turn or known provider/account binding; neither a future record nor the predecessor of a replacement session may describe the current card. Missing, legacy and not-yet-hydrated metadata display **Turn settings unavailable** rather than guessing current selections. The existing bounded detail hydration and retained current-turn activity supply the data without extra subscriptions or provider calls.

Immutable activity objects key a weak decoding cache, and card memo equality includes the validated configuration reference. This preserves inexpensive clock-only polls while allowing late accepted-turn metadata to repaint a running or terminal card. Long labels wrap as escaped plain text inside the card. These portable presentation changes do not alter provider execution, lifecycle or native platform behavior. Unit and Atrium browser regressions cover exact-turn/account binding, freshness, late metadata, honest absence, malformed/private fields and narrow-card layout.

## Verification

Use the repository-pinned Node and Corepack Yarn toolchain and existing lockfile. Synthetic contract/helper/reactor tests cover field bounds, explicit/default settings, immutable account/model labels, repeated same-account turns, failed deliveries, accepted-send/steer identity, stalled metadata/Stop ordering and replay protection. Projection/store fixtures verify late metadata cannot extend terminal timestamps and that one latest-turn summary survives more than 500 activities and reconnect. Work-log unit and browser checks cover legacy/malformed metadata, preservation of provider-switch notices, exact-turn acknowledgment folding and wrapping in narrow split panes without horizontal overflow.

Run `yarn fmt`, `yarn lint`, `yarn typecheck`, `yarn test`, the focused chat browser suite, then `yarn build:desktop --force` after tests. This feature requires no dependency or provider binary update and no live credentials. Local synthetic tests do not establish new native provider or installer qualification; pushed CI supplies the existing cross-platform source/build checks.
