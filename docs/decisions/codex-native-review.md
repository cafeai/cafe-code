# Decision: native Codex reviews use Cafe-owned inline turns

Decision status: Accepted within the authorized provider-parity implementation
Implementation status: Implemented; focused verification passed, integrated release gates remain open
Created: 2026-10-05 06:18:21 JST (UTC+0900)
Last updated: 2026-10-05 06:54:00 JST (UTC+0900)
Supersedes: None

## Decision and authority

Expose a deliberate Native review action for Codex chats, with uncommitted changes,
base branch, commit and custom-instruction targets. Carry the validated target as
structured data through the ordinary authenticated, durable turn-intent/receipt
path. The displayed user message is a description, not an instruction parser.
Ordinary natural-language requests to review code remain ordinary messages.

Send `review/start` with `delivery: "inline"` on the exact native thread owned by
the selected Cafe chat/account/runtime. Reuse native-start reservation, ambiguous
acknowledgement fencing, cancellation, reconnect and authoritative turn events.
A review is never converted into a steer. An active or starting native turn must
reject it without interrupting that turn. Schedule/recovery commands cannot
silently become native review requests.

The generated qualified protocol explicitly deprecates native detached review
delivery. Cafe does not expose that path or discover/adopt arbitrary detached
provider threads. A separate review can be started in an ordinary Cafe-created
chat; its normal creation/admission owns the native thread before review begins.
An unexpected response thread ID is an indeterminate protocol failure, not
authority to bind another native thread or replay the review.

Review inherits the materialized native thread configuration and sandbox,
including an upstream review-model override when configured. The native API has
no per-review model/effort/sandbox override. The action explains that composer-only
changes are not review settings; it does not advertise a requested model as
independently verified execution telemetry. Upstream's reviewer explicitly uses
non-interactive `approval_policy: Never` while retaining the inherited sandbox.
The action discloses that behavior before submission, especially for a full-access
session; Cafe does not invent interactive review approvals or alter sandbox policy.

## Boundaries and failures

Bound target strings and reject control characters and option-shaped Git targets.
Pass references as structured protocol values; Cafe never constructs a shell
command from them. Native Codex resolves the Git target in its bound workspace.
Treat provider review text as bounded inert Markdown, never HTML or instructions.
Map exact `enteredReviewMode` and `exitedReviewMode` items to their canonical
lifecycle kinds. The completed exit item supplies bounded work-log text; only native
`turn/completed` establishes turn completion. Qualified native source also emits
an ordinary assistant item containing rendered findings after the review-exit
item, so Cafe does not synthesize duplicate assistant output from that exit.

The existing account/session ownership, owner RPC authorization, durable receipt
and generation checks remain mandatory. Review does not install/update a CLI,
modify provider profiles, create a scheduler, or use a new permission policy.
Unknown/unsupported native methods fail clearly rather than falling back to a
paid natural-language turn. No provider call is automatically repeated merely
because its acknowledgement is missing.

## Verification

Credential-free contract, decider, service, runtime and adapter fixtures qualify
all four structured targets, wrong account/provider, active-turn races, native
errors, unexpected detached identities and lifecycle rendering without synthetic
terminal events. Browser fixtures cover accessible target selection, busy/error
states and escaped text. Repository formatting, lint, typecheck, full tests and
the final forced desktop build remain release gates; native cross-platform CI
qualifies the published source separately. No live paid inference is implied.

Protocol reference: [Codex app-server review](https://learn.chatgpt.com/docs/app-server#review).
Source qualification: official Codex revision `a956835d020762cb2b570053af06f643a11c0ecc`,
`codex-rs/core/src/tasks/review.rs` and `codex-rs/core/src/codex_delegate.rs`.

Focused evidence: the seven-file helper/decider/adapter/service/reactor/ingestion/
runtime set passed 737 tests; the review browser fixture passed six tests. Server
and web typechecks passed. A controlled restoration of only the two former native
item-name comparisons reproduced all four dropped review lifecycle events in
15 ms; restoring the exact-name fix passed the same assertion. A FIFO sentinel
closes that regression fixture, so omitted events fail assertions rather than
relying on a timeout. The initial fixture omitted required native timestamp fields;
preflight native-schema checks now reject that malformed fixture immediately.
Browser substring checks use supported text locators rather than unsupported
matcher semantics. No tests, production deadlines, provider permissions or
account boundaries were weakened to obtain these passes. See the user-facing
[review guide](../codex-native-review.md) for behavior and limits.
