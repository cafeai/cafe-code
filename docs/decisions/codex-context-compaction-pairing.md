# Pair explicit Codex context overrides with native compaction policy

Decision status: Accepted
Created: 2026-10-13 15:54:01 JST (UTC+0900)
Last updated: 2026-10-13 15:59:19 JST (UTC+0900)
Decision authority: User requested diagnosis, any necessary fix, tests and this
context/compaction changeset's push to dev.
Implementation status: Implemented; synthetic fixtures below, hosted release qualification separate
Supersedes: [Context-window override](codex-context-window-override.md), only its
decision to leave automatic compaction independent of an explicit context choice
Superseded by: None

## Context and native source contract

The context override originally sent only `model_context_window`. Codex can retain
a smaller fixed compaction threshold from its model metadata or baseline config,
so increasing the nominal window alone does not necessarily increase that limit.
The usable window in token-usage events is not the compaction threshold.

The [official config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
documents independent context and compaction settings and total/body-after-prefix
accounting. The reviewed immutable native source is Codex 0.162.1 commit
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`:

- `models-manager/src/model_info.rs::with_config_overrides` clamps nominal
  context to the model maximum and applies a supplied compaction setting.
- `protocol/src/openai_models.rs::ModelInfo::auto_compact_token_limit` takes the
  smaller of the metadata/config threshold and 90% of resolved nominal context.
  If no fixed threshold exists, that 90% ceiling supplies the default.
- `core/src/session/context_window.rs` uses that getter for the default total
  scope. A user-selected body-after-prefix scope instead uses the configured
  growth limit, while separately enforcing the native full usable-context cap.
  Native token-budget fallback buffering also participates in the actual trigger.
- `app-server/src/config_manager.rs` appends request overrides after baseline
  configuration. Cold start/resume load those overrides; JSON null is not reset.

For example, if the native maximum permits a nominal 800K window and the native
headroom is 5%, the reported usable window is 760K. Under the reviewed default
total scope, the base automatic threshold is capped at 720K, not 760K. This is an
example of native policy, not a claim about any current account's metadata,
eligibility, timing, buffer or independently observed compaction threshold.

## Alternatives and decision

Leaving the two requests independent preserves a potentially stale lower fixed
threshold and does not fulfill the user's larger-context intent. Computing a
ratio or model-name default in Cafe duplicates evolving native policy. Disabling
compaction, changing scope, retention, buffers or permissions exceeds the request.

At a qualified native start/resume, resolve the requested compaction value as:

`explicit provider autoCompactTokenLimit ?? effective context-window override`

The effective context override still resolves chat number > exact selected
account default > native inheritance. Forward the **nominal number**, not a
Cafe-calculated usable window or ratio, as `model_auto_compact_token_limit`.
The native runtime remains responsible for its model maximum, scope, margin,
buffer and full-context cap. A separately configured Cafe compaction value wins
even when it is lower. The paired request supersedes a baseline native compaction
setting for this thread only; it does not write or delete the user's config file
or bypass higher-priority native managed policy.

Without either explicit value, omit both keys. Resetting a chat may still inherit
an account's numeric context default and therefore its paired request. Clearing
the final effective context override removes the derived compaction request;
a separate explicit compaction setting remains. Never send null as deletion.
Start, resume and a recoverable resume-to-start fallback share this construction.

## Security, privacy and operational consequences

This changes numeric native configuration only at the existing admitted opening
boundary. Preserve validation, stable-runtime capability, exact account/process
ownership, whole-tree idle/ingress guards, noninterrupting saves and steering.
No schema migration, package/runtime installation, profile read/write, native
scope override, tool-output/retention change, permission change or prompt replay.
Other providers never receive either key. Larger histories may consume more
resources and cost; this is not a context-capacity entitlement or a guarantee
that every compaction waits until a particular token count.

Keep `maxTokens` from the native token event. That event has no resolved
auto-compaction threshold; do not echo the paired nominal request into received
usage as though it were a measured threshold. Existing explicit-provider request
evidence remains separate. Normal rebuilt daemon/session adoption is required;
the fix does not reconfigure an already running native session.

## Verification and preserved decisions

Synthetic peers cover omitted/context-only/explicit-only/combined start and
resume configuration, fallback, explicit precedence, reset, no injected scope,
and native-authoritative usage. Existing policy/adapter tests cover safe context
admission, account fallback, invalid/unsupported refusal and other-driver exclusion.
Required repository checks and a forced desktop build last gate publication.
Local tests do not qualify live account capacity or native multi-OS release output.

All metadata, UI, ownership, capability, reset and lifecycle decisions in the
[predecessor](codex-context-window-override.md) remain in force. See the updated
[user guide](../codex-context-window.md) for behavior and adoption limits.
