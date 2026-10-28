# Claude cache-write duration accounting

Claude reports cache creation as an input subset. An assistant response can
also report separate five-minute and one-hour write counts. These duration
counts are disjoint subsets of the same aggregate cache-write count; they are
never additional input tokens. The [published standard rates](https://platform.claude.com/docs/en/about-claude/pricing)
price five-minute writes at 1.25 times fresh input and one-hour writes at twice
fresh input. Other pricing modifiers, including request-size, regional and
service-tier adjustments, cannot be inferred from the model/day ledger.

Only bounded, valid, observed duration counts are classified. Missing detail and
legacy data remain unknown. A cumulative result's split can classify new child
writes only in a fresh scope whose previous writes are all already known and
whose full split fits the new increment. A restored or partially unknown history
cannot supply that proof. Repeated response IDs and cumulative results must not
count the same write twice. Existing scope
and revision checkpoints advance atomically with the per-day model increments.
Each new snapshot preserves nonnegative deltas for both known subsets and the
remaining unknown write count, so later data cannot reclassify older writes or
move their cost to another day. Legacy checkpoint and daily records start with
zero _known_ counts, not a claim that historical writes were five-minute.

The standard-rate estimate prices verified one-hour Claude writes at the
published one-hour rate. Unknown writes retain the ordinary cache-write rate as
an explicitly disclosed estimate; this does not assert their actual duration.
Existing user-defined cache-write rates remain authoritative for every write,
regardless of duration. Provider-reported costs take precedence over estimated
rates and are not surcharged. Cache savings and daily/model cost calculations
must use the same duration-aware calculation as the overall cost.
Claude's native cost can apply provider-side managed pricing, and its SDK does
not apply the one-hour rate to fallback responses after a refusal. The ledger
does not retain either condition, so the bundled-rate estimate cannot reproduce
those billing distinctions and must disclose that limitation.

Synthetic tests must cover malformed or missing detail, duplicates, cumulative
settlement and child-only residuals, resumed and legacy baselines, monotonic
checkpoint validation, day boundaries, rollback/replay, custom pricing,
provider-reported costs and non-Claude providers. No test needs a real provider,
credential or user's conversation. This accounting is observational; it does
not change provider calls, cache policy, or existing context-window accounting.
