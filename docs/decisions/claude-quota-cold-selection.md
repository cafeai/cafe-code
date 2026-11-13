# Bounded cold Claude quota selection

Decision status: Accepted — separate bounded metadata phases.
Created: 2026-11-12 16:37:49 JST (UTC+0900).
Last updated: 2026-11-12 16:41:49 JST (UTC+0900).
Decision authority: user request to investigate and fix frequently unavailable Claude limits.
Supersedes only the combined reader deadline and stream/loading envelopes in [Claude subscription allowance reports](claude-account-quota-report.md).

## Problem and evidence

The native quota reader previously spent its four-second deadline on both local login selection and the control-only quota exchange. On a cold macOS instance, the existing selection policy can consult two local auth stores, each with an independent four-second process bound and joined termination. A deterministic credential-free regression reproduces a valid quota response being discarded after three seconds of selection plus two seconds of control work. This establishes a local budget defect, not the cause of any particular historical screenshot.

Installed SDK 0.3.321 and the [public 0.3.322 declarations](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.322/sdk.d.ts) have the same quota request, structured usage-report and rate-limit event shapes. The [2.1.322 CLI changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) adds Vertex fast mode, without an advertised quota change; the [SDK release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.322) lists native CLI parity. There is no demonstrated protocol-shape defect requiring an SDK upgrade, initialize frame or new passive inference source. Native rate-limit warnings are sparse and cannot substitute for a complete account report.

## Decision

Keep login selection and quota control as separate bounded phases. Selection has a nine-second envelope covering the existing two four-second auth-status budgets and joined child retirement. The actual get_usage child retains its four-second allowance,256KiB/128-frame limits, exact random request id, existing argv and 250 ms termination grace. Selection failure or cancellation cannot start the quota child or authorize another login source. Cancellation joins the existing selector’s scoped retirement before the reader returns.

The quota subscription alone has a fifteen-second total envelope for these phases, native retirement and exact authority checks. Only the Claude quota presenter uses a sixteen-second loading allowance on initial subscription and reconnect. Other metadata consumers retain their six-second default. These are bounded metadata envelopes, not changes to chat startup, provider retries, auth-status commands, test deadlines or worker scheduling.

A content-free debug event distinguishes authentication-selection, native-start and native-response phases and fixed deadline/failure/no-response/control-error/reported-unavailable categories. It never contains raw errors, stderr, credentials, paths, account identities or quota values. A native refusal or unavailable report is not classified as authentication failure.

## Preserved authority and failure behavior

The exact configured instance still owns one 60-second single-flight cache, including unavailable/interrupted exits. Only visible subscribers request reads. No extra retry loop, background polling, credential access, private OAuth call, initialize/user/slash command, inference, account fallback or native installation is added. Configuration/runtime/workspace identity and invalidation-generation checks remain unchanged. An unavailable response still clears the view; old reports are neither silently retained nor retimestamped. This is deliberate because the public source binding is not a stable authenticated principal or credential epoch.

## Qualification and limits

The primary fake-clock regression must fail on the combined deadline and pass with independent phase budgets. Source-selection timeout/cancellation tests protect zero quota starts and joined retirement; existing reader tests protect request bytes, bounds, native timeout, cache throttling and instance isolation. Subscription tests retain authority/ABA refusal and bounded recovery. The metadata controller owns its timer/reconnect/disposal regression; existing browser quota owners qualify wiring and scope retirement. Required repository checks and a fresh final forced desktop build apply.

No real provider, credentials or account endpoints are used in these tests. This change cannot guarantee an upstream quota service response, prove native adoption in a running backend or retroactively identify an unobserved historical failure.
