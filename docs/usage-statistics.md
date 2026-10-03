# Usage statistics

Last updated: 2026-10-04 00:42:33 JST (UTC+0900)

Settings → Usage has one date-range selector for its reporting statistics. The default is 30 days. Selecting 7 days, 30 days, 90 days or All updates generated tokens, chats sent, generating time, estimated USD cost, provider/model breakdowns, token composition, cache savings, cost quality and usage charts together. Activity always shows all recorded daily history, independently of this selector. Cost/Tokens changes the graph's measurement without changing the selected period. The shared detailed cost view in Atrium uses the same range semantics; Atrium's ambient lifetime counters remain lifetime counters.

## Calendar and data boundaries

A finite period includes the server's current local day and the preceding N−1 calendar days. It is anchored to `today.day` in the detailed usage response, not the browser's timezone. Quiet days count toward the range and appear as zero activity. All includes all recorded history, including authoritative lifetime counters whose older daily or model detail may be unavailable.

`apps/web/src/components/stats/usageRange.ts` derives the selected view from the existing decoded usage response. It independently sums generating time, chats, input/output and cache/reasoning counters, then aggregates only model observations within the same daily bounds. Cache reads and writes are subsets of input; reasoning is a subset of output and is never added again to processed tokens. Range changes reset period-specific numeric animations and generation-time floors so values from a larger period cannot briefly masquerade as a smaller period's usage. Activity instead uses the unfiltered response and All calendar bounds. Its current-day time floor, colors and scroll position survive range changes; the daily floor resets only when the detailed response advances the server calendar day.

The existing primary-environment shared detail resource single-flights one refresh every five seconds while visible consumers exist, and refreshes after transport reconnection. Counted dashboard figures derive from the same detailed response, including its provider/model observations. The aggregate live stream supplies current generation status, not guessed model/day attribution; aggregate generation time can advance between detailed reads. A fresher detailed response takes precedence over a stale stream event. Date-range presentation adds no polling loop, provider calls, credentials or persistent renderer cache; prospective model timing uses the additive storage and detailed-response dimension described below.

Live numeric changes in the detailed cost view use the same eased ticker as the
headline counts: model cost, exact/compact token counts, recorded generation
duration, reasoning tokens, cache savings and quality/input percentages. All
counters share one animation-frame scheduler and one reduced-motion listener;
there is no per-row timer, added polling or model-time extrapolation. Reduced
motion shows each new value directly. A selected-period change still remounts the
period-specific counters, rather than animating unrelated date ranges into each
other. Unknown, unpriced and “Not recorded” values remain explicit text states.

## Time spent generating per model

The shared Settings/Atrium model table includes time spent generating alongside estimated cost and tokens. It measures recorded interactive active-turn elapsed time from observed start through completion, abortion or session exit, using the same definition as the headline timer. Tool execution and approval waits are included. Concurrent chats contribute independently: two chats active for ten minutes record twenty minutes of combined work, not ten minutes of unique elapsed screen time. This is not pure model inference time, latency per token or an API billing duration.

Migration 79 adds `usage_stats_model_generating_time_days` and stable tracking-start metadata. No existing aggregate or token history is rewritten. The optional `modelGeneratingTime` object on `UsageStatsGetResult` carries the persistent start, provider/model totals and local-day rows; older saved servers can omit it. The service hydrates the numeric ledger once and includes unflushed/current intervals in detailed reads from memory. Reads do not commit or re-add time, and the high-rate aggregate stream does not acquire a model-cardinality payload. No extra provider calls or inference tokens are needed.

The timer settles an elapsed interval before its attribution changes, so a model reroute does not recolor earlier work. Collection toggles settle under the previous enabled value and advance cursors through disabled intervals without counting them. Aggregate, model-time and token deltas flush in the same SQLite transaction; failed batches retain all three for retry. Admitted flushes settle before honoring cancellation, avoiding replay if a transaction committed just before the waiter stopped. Invalid tracking metadata or unsafe summed durations suppress only the optional timing detail rather than guessing a partial value. Only canonical driver and bounded model labels are stored, never account ids, native session/request ids, prompts, output or credentials. With healthy storage, a clean shutdown waits for the admitted flush and performs the final flush; a hard stop or persistently failing storage can lose unflushed intervals and does not reconstruct missing observed work after restart.

Time follows the same 7/30/90/All calendar bounds, independently of token observations. A model can have measured time without reported tokens, for example an in-flight or aborted turn; those rows remain available in the table without inflating token totals or cost quality. Model rows refresh with the existing atomic detail response rather than extrapolating a model share from the headline timer or adding per-row animation loops.

“Not recorded” means no measured duration is available for that model in the selected period, not zero work. This includes older history, older servers and token-only metadata helpers/subagent observations whose interactive durations were not collected. The table identifies when tracking began; even All covers only recorded time since that point. Historical turn projections or token shares cannot truthfully recover discarded model timings, so no retrospective backfill is performed. See the [model-time decision](decisions/model-generation-time.md) for storage, coverage and compatibility rationale.

## Estimates and missing history

The cost table's tokens are **processed tokens**: recorded input plus output.
Input already includes cache reads/writes, and output already includes reasoning;
neither subset is added again. **Output tokens by provider and model** instead
measures only recorded generated output, matching the headline Tokens generated.
Its percentages therefore need not match processed-token or estimated-cost shares.

Models with recorded input but zero recorded output remain visible in the output
breakdown with their processed volume. Provider groups with zero recorded output
also display **No output recorded**. Input-only models contribute zero to output
totals and percentages. This does not mean the model generated nothing: Claude
can publish a known input/cache lower bound before validated
terminal model totals become available. Missing/inconclusive results or an
unavailable resumed cumulative baseline can retain that input-only observation.
Cafe does not guess missing output, reconstruct it from cost/input shares, retry
inference, or rewrite historical usage to make the tables match. A later detailed
response with confirmed output replaces the zero-output explanation normally.
Aggregate usage rows cannot identify which of these causes affected one historical
observation; diagnosing a missing terminal event requires separate evidence.

Settings Activity adapts to the available card width: square cells grow within a
readable cap, shorter calendars are centered, and the color legend stays aligned
with the calendar rather than the card's far edge. Very short calendars remain
compact instead of stretching a handful of days into huge squares. Long or
overflowing calendars keep compact cells and horizontal scrolling. The default
heatmap layout remains compact for other consumers; this is presentation only,
with no fabricated history, added polling or changed collection/accounting.

Long activity histories retain their complete scrollable extent while rendering only visible week columns plus a small overscan. This bounds page content even for an unusually old calendar, without imposing a historical date cutoff or hiding older records.

Money is an API-equivalent USD estimate using the shared pricing table or explicit user overrides, not a subscription invoice. Long-context and speed-tier adjustments cannot be reconstructed from aggregate counters and remain excluded. Unknown model rates and missing model attribution remain unpriced; the priced/unpriced percentages include the recorded unattributed gap. The output breakdown identifies unattributed output separately.

“Model not reported” means the provider is known but the effective serving model is absent from the recorded observation. One-shot Codex `exec --json` helpers report terminal token counts without authoritative model attribution; requested model settings and generic reroute text cannot reliably assign aggregate usage. Older ordinary records can also lack a model. Both the token breakdown and cost table explain this category on hover. Its tokens stay counted and unpriced by default, unless the user explicitly supplies a custom rate for that category; the UI never hides them or relabels historical usage with a guessed model. The [pinned Codex exec event definitions](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/exec/src/exec_events.rs#L36-L68) and [terminal/reroute mapping](https://github.com/openai/codex/blob/ff6aec96948b70d94983af2641a6b67c94faeff5/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L473-L514) document this attribution limitation.

Older servers may omit daily model attribution. Finite ranges still show their recorded aggregate counters, but cannot assign costs by borrowing lifetime model shares. Similarly, old history may contain output without input/cache/reasoning measurements. Missing dimensions are not fabricated or backfilled. All's lifetime total can exceed the daily graph when historical daily detail is unavailable; the graph remains a daily-ledger view rather than inventing dates or rates for that difference. Interrupted requests may not report complete usage, so cost-quality percentages cover recorded counters only.

## Verification and replay

Use the repository-pinned Node and Corepack Yarn versions, existing lockfile and synthetic fixtures. No authenticated provider is needed:

```sh
corepack yarn workspace @cafecode/web test src/components/stats/usageRange.test.ts
corepack yarn workspace @cafecode/web test src/components/settings/usageStatsPresentation.test.ts
corepack yarn workspace @cafecode/contracts test src/usageStats.test.ts
corepack yarn workspace @cafeai/cafe-code test src/persistence/Migrations/079_UsageStatsModelGeneratingTime.test.ts src/persistence/Layers/UsageStats.test.ts src/usageStats/Layers/UsageStatsService.test.ts
corepack yarn workspace @cafeai/cafe-code test src/textGeneration/auxiliaryUsage.test.ts
corepack yarn workspace @cafecode/web test:browser src/components/settings/UsageStatsPanel.browser.tsx src/components/stats/ActivityHeatmap.browser.tsx
corepack yarn fmt
corepack yarn lint
corepack yarn typecheck
corepack yarn test
corepack yarn build:desktop --force
```

The focused checks exercise inclusive date boundaries, sparse calendars, absent attribution, historical lifetime gaps, range-wide statistics changes with independent full-history Activity, multi-year scroll persistence, missing-model explanations and responsive layouts. Model-time checks cover additive old-server decoding, migration without historical fabrication, stable metadata, atomic storage, live/flush/restart behavior, model transitions, collection toggles, concurrent turns, day boundaries, missing measurements and time-only table rows. Run the forced desktop build after the tests as the final software verification step. Public usage diagnostics retain numeric/account-aggregated metadata only; this feature does not introduce prompt, output or account-identity logging.
