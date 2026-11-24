# Nonblocking subagent-limit preferences

Decision status: Accepted by the user's explicit request to warn and continue when an override cannot be applied.
Created: 2026-11-15 15:21:47 JST (UTC+0900)
Last updated: 2026-11-15 16:01:39 JST (UTC+0900)
Implementation status: Implemented; targeted synthetic owner and browser coverage passed. Final repository checks gate delivery; running-provider adoption remains separate.
Partially supersedes: [Per-chat concurrency](per-chat-subagent-concurrency.md), [live account defaults](live-account-subagent-default.md) and [exact-process continuation](existing-runtime-subagent-policy-continuation.md), only where unavailable numeric-override support would prevent ordinary message delivery.

## Context and rationale

A saved per-chat or account subagent preference could prevent every send when the native owner reported missing or false support. The ordinary failed-turn label concealed that reason. An independent backend status snapshot cannot qualify the daemon's executable, and a failed version probe is not proof that a model lacks subagents. The user explicitly chose continued chat operation with an honest warning over rejection for this optional preference.

## Decision

Keep the selected driver's per-chat override, exact account default, legacy configured fallback and native inheritance precedence. Apply a numeric override only when the authenticated runtime qualifies support. The Codex setting concerns native agent concurrency, not an Astra-specific model feature. Continue using the existing public spawned-agent and root-inclusive resident-agent configuration keys; see the [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

When numeric support is unconfirmed, preserve saved intent and deliver the message using the current provider policy. Keep an existing live owner and its actual recorded controls; do not replace a healthy owner merely to discard an optional preference. A newly materialized fallback explicitly requests native inheritance rather than restoring an old durable or legacy configured numeric override. At the shared driver boundary, explicit null means inheritance while omission can still select legacy configuration.

Emit a bounded durable, server-owned warning for the exact admitted message and intent sequence when its requested override was not applied. The primary chat shows the requested number, unconfirmed support, continued current-provider policy and retained saved preference. Do not claim a numeric native default, applied override, available worker capacity or model-specific incompatibility. Keep the notice outside Work log and preserve a bounded recent notice window through bursts of ordinary activity. Renderer snapshots may describe support, but must not stop submission solely over a saved subagent preference; the authenticated backend chooses application or fallback.

## Security, privacy and failure consequences

The preference is optional, so fallback may permit more native concurrent workers than the saved number. The visible warning says the saved number was not applied; the user guide explains the possible resource-policy consequence. The saved preference is not a universal spending or security cap. No unqualified numeric argv/environment override is issued and no cached status becomes native capability authority. Existing root/child idle locks, exact session ownership, permissions, authentication, Stop, transport acknowledgement and retry/recovery fences remain authoritative. Fallback is a pre-dispatch policy choice, never replay of a rejected or ambiguously accepted prompt. Existing controlled sessions retain their actual policy and native incarnation.

Only validated finite warning metadata reaches the primary notice. Arbitrary provider messages, private errors, prompts, paths and credentials are excluded. Notice rendering grants no control or provider authority. Context-window/compaction settings retain their separate existing qualification policy; this decision changes subagent preferences only.

## Compatibility and verification

No preference migration, global native configuration, provider installation, model change or automatic runtime restart is required. Older backends retain their old refusal behavior until updated; an updated UI alone cannot change a remote server's admission policy. Current source/compiled verification does not prove a running daemon adopted it.

Meaningful tests cover supported numeric application, unsupported/unknown fallback with the original message delivered and saved intent preserved, exact existing-owner retention, null versus legacy configuration, primary-chat warning visibility and validation, and bounded warning/history hydration. Renderer journeys retain routing, Stop and queue ownership while allowing delivery after a capability change. Run repository-pinned formatting, lint, typechecks and targeted owner tests, then a forced desktop build last. Native provider capacity and historical probe failure causes remain outside synthetic proof.

## Preserved decisions

Earlier records retain their original rationale. This successor replaces refusal solely for unavailable subagent-override support and the renderer's matching preflight. It does not weaken the native support requirement for actually applying a numeric override, rewrite saved preferences, change context-window guards, or permit a new process after uncertain retirement.
