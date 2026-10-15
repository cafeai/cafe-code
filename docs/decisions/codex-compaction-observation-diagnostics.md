# Observe Codex compaction without inferring its native trigger

Decision status: Accepted
Created: 2026-10-15 01:56:23 JST (UTC+0900)
Last updated: 2026-10-15 03:07:23 JST (UTC+0900)
Decision authority: User requests early-compaction diagnosis, additional debug
tracing and any demonstrated repair in the current dev push.
Implementation status: Implemented; synthetic local qualification, hosted and live-account trigger evidence remain separate
Supersedes: None; supplements actual-opening request adoption and debug attribution
Superseded by: None

## Context

An 800K context request and the muted approximate 720K label are not observations
of a native trigger. A compaction item beside current token usage can be misleading:
usage may already be post-compaction, the item may belong to a child, or either
receipt may come from an older runtime/account. The native item does not report
its trigger reason, effective threshold or accounting scope.

The [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents separate context/automatic-compaction limits and total versus
body-after-prefix accounting. [Reasoning documentation](https://developers.openai.com/api/docs/guides/reasoning)
states that reasoning consumes context capacity. This does not establish a
specific Codex reserve, explain an individual early compaction, or authorize
adding reasoning tokens again to native total usage.

## Decision and alternatives

Carry a small schema-defined diagnostic observation on the existing admitted
compaction lifecycle event. Capture the last reported same-source usage before
the observed start, then retain that immutable sample on completion. This is
received-order evidence, not the exact internal counter at the trigger. A
completion without a retained start has no pre-start sample; never substitute
newer usage. Duplicate edges cannot replace the captured sample.

Maintain a bounded per-native-runtime tracker with limits defined in
`packages/contracts/src/codexCompactionDiagnostics.ts`. Separately retain native
input, cached input, output, reasoning output, last total, lifetime total and
usable window without recomputing the meter. Observe routed child usage only
inside its existing source admission and before the existing parent suppression;
child samples must not become parent usage events. Root and exact child identity
are distinct keys. Root actual-opening nominal requests remain labeled root
requests, not proof of an unreported child policy. Null opening requests means
unknown; a known object containing null limits records omission.

Bind debug observations to the received native account, exact driver and runtime
generation. Stale, malformed or legacy records cannot become current-owner proof.
Finite eviction counters explain lost diagnostic history rather than allowing
unbounded bookkeeping. Existing runtime close retires the tracker. No new timer,
subscription, provider request, history hydration or global provider cache exists.

Reject alternatives that poll native history, derive trigger counts from lifetime
usage, mix child and root accounting, backfill opening evidence from saved intent,
or change compaction policy without a demonstrated policy defect. A larger nominal
number cannot guarantee account/model capacity or minimum compaction timing.

## Security, privacy and failure behavior

Observations contain only finite counters, timestamps and exact lifecycle/source
identifiers already admitted by the runtime. No prompt, reasoning text, tool data,
native history, credentials, profile/configuration object or raw error is copied.
Boundary readers reconstruct allowlisted own data properties without invoking
getters or accepting inherited fields. Malformed, oversized and ambiguous
diagnostics are omitted without changing native admission, task liveness, recovery,
configuration, input delivery or paid execution.

The renderer and desktop compact endpoint independently validate/reconstruct the
bounded diagnostic shape. Native reason and accounting scope say `unreported`;
resolved threshold remains null. A nominal request must not be labeled a resolved
threshold. Debugging is observational, not a capability or policy authority.

## Compatibility, qualification and preserved decisions

All new event fields are optional; historical omitted records remain unknown.
Synthetic fixtures must cover exact root/child separation, received ordering,
duplicates, missing starts, bounded eviction, retired runtimes, malformed/getter
input and exact current account/generation projection. Normal rebuilt runtime
adoption is required to receive new observations; no active chat is restarted.
Local fixtures do not qualify native account trigger timing or hosted delivery.

[Actual-opening request adoption](codex-compaction-request-adoption.md),
[context/compaction pairing](codex-context-compaction-pairing.md) and the
[user guide](../codex-context-window.md) remain governing. Native scopes, buffers,
capacity, usage and existing idle/ingress/child ownership fences are unchanged.
