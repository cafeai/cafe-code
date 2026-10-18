# Claude subscription allowance reports

Decision status: Accepted — native control-only reader with passive compatibility.
Last updated: 2026-10-16.
Decision authority: explicit user request to implement the verified Claude Code
`get_usage` subprocess approach. Supersedes the October 9 passive-only collection
restriction; authentication, provider turns and usage accounting stay unchanged.

## Native collection

`claudeAccountQuota.ts` launches the selected instance's installed Claude Code
executable with bidirectional newline-delimited JSON and writes exactly one
`control_request` with `subtype: "get_usage"` and `skip_behaviors: true`. No
initialize request, user message, slash command, model prompt or resume identity
is sent. The installed CLI handles authentication using the same instance-local
`ClaudeAuthenticationEnvironment` selection as chats and status probes. Cafe does
not read credentials, copy tokens or call a private OAuth endpoint itself.

The implementation was verified against installed Claude Code 2.1.301: a direct
request without initialize returned numeric five-hour and seven-day utilization,
reset timestamps and ordered server meters. The repository-pinned SDK 0.3.295
also declares `SDKControlGetUsageRequest`/`SDKControlGetUsageResponse` and the
experimental usage getter, including the transcript-scan opt-out. The raw control
path avoids starting an SDK query just to inspect allowances. The flags follow
the [official CLI reference](https://code.claude.com/docs/en/cli-reference).
The control is experimental; unsupported or changed replies become unavailable.
No provider dependency or installed executable is upgraded by this change.

The disposable child has no session persistence or configured tools/MCP, excludes
ordinary settings sources, and receives `disableAllHooks` before startup. Its cwd
is the selected home rather than a chat workspace. Managed provider policy remains
provider-owned; these flags are not a claim that Cafe can override managed hooks.
`skip_behaviors` prevents the optional scan of local transcripts. There is no
permission bypass, model fallback, login action or alteration of a live query.

Each read has a four-second bound, at most 256 KiB of stdout and 128 nonempty
frames. Only a success response with the exact random request id is admitted.
Stderr and arbitrary response fields are not logged or published. The surrounding
scope owns child retirement on success, failure, timeout and cancellation, with
a 250 ms graceful interval and bounded force-kill escalation. No user/provider
process outside this disposable child is interrupted.

Each exact provider instance shares one single-flight cache for 60 seconds,
including unavailable results. Only visible quota subscriptions trigger reads;
a one-minute tick refreshes an open surface. Closing a surface stops its refresh
stream. No background allowance scheduler is attached to chats or provider health.
Replacing the configured instance drops its cache, and exact object identity is
revalidated after every read before release. This metadata never enters the
provider status disk cache, command ledger, activity journal or RPC tracing.

## Projection and compatibility

The native reader emits `ProviderSessionQuotaReport.source = "claude-cli"`.
`claudeSessionQuota.ts` prefers the endpoint's complete ordered `limits` list,
including explicit empty levels, unknown kinds and duplicate rows. Legacy replies
without rows map documented five-hour, seven-day and scoped windows without
converting their already-percent utilization to fractions. Null utilization never
becomes zero. Extra usage retains safe integer minor currency units and unknown
currency. No endpoint identity, session cost, behaviors or arbitrary future fields
are exposed. Receipt time is Cafe's receipt, not proof of endpoint freshness.

All report parsing uses bounded own data properties; inherited metadata,
accessors, malformed percentages, invalid calendars and oversized row lists are
rejected. A malformed complete native report is unavailable rather than a partial
list masquerading as a complete current reading. Passed resets and old receipts
remain stale; presentation never refills a meter or invents a newer timestamp.

If native collection is unavailable, the existing passive `/usage` sibling may
still supply `source = "claude-session"`. Cafe strips that sibling before native
logging, canonical raw events, activity projection and accounting. Only an
established primary native session of the current query may replace its volatile
report, which clears on reset, rebind, retirement and stop. No automatic `/usage`
command, transcript scan or model prompt is used to obtain the fallback.

## Source authority and presentation

The existing owner-only `server.subscribeProviderQuota` stream validates the
current authenticated owner and configured enabled Claude instance around reads.
Settings may request that instance's allowances without any chat. An exact-chat
request still requires its saved current runtime/workspace binding. Changed
configuration, replaced instances, duplicate bindings and stale subscriptions
cannot publish old results under a new scope. Reconnecting saved environments
uses their existing server connection and never launches a competing local reader.

Invalidation subscriptions start before the initial read. One trailing slot and
an invalidation generation fence late publication, including configuration/session
ABA. Reads retain the five-second stream bound and six-second renderer loading
bound. A failed read does not retimestamp a passive fallback. Older remote owners
without the capability retain their passive behavior.

Settings, the session rail and context popover share a compact presenter. It
omits provider provenance, receipt dates, duplicate group headings and ordinary
severity/headline diagnostics. The normal weekly bucket is labeled Weekly.
For a selected Fable alias or canonical claude-fable model id, render its native
Fable scoped weekly meter in place of the normal weekly meter. Other selected
models show the normal weekly meter and omit Fable and other scoped meters,
regardless of their usage. A missing Fable meter never borrows the normal bucket.
Settings without a selected model uses the normal weekly view. Received account
data remains complete; selection is presentation only and neither refreshes the
subscription nor changes provider policy. Chat composer and rail use the current
account-scoped draft model choice, falling back to the saved chat selection.
Enabled extra usage with a reported utilization appears as one percentage line
below the last bar; no extra-usage tab, disclosure, monetary breakdown or invented
zero is rendered. Reset dates and stale readings stay beside the bars, with one
bounded scroll owner. Source and receipt metadata remain internal to freshness
and ownership validation.
Native login selection establishes the configured source; it does not create a
stable remote principal or credential epoch in the public report. Reset labels
use the viewer's locale and timezone. Cafe's processed-token/API-equivalent
cost accounting and context-window tokens remain separate.

## Qualification

Credential-free tests cover control-only input, exact request matching, split
NDJSON replies, malformed/oversized output, timeout, cancellation, exact child
retirement, cache bounds, instance isolation, source replacement and passive
fallback. Mapper/contract tests cover both native provenance and percent/reset
semantics. Browser coverage checks selected-model bar replacement, inline extra
usage and unchanged metadata subscriptions through the shared presenter. Existing native-host workers, deadlines
and macOS/Windows subset policies remain unchanged.

A local manual read additionally verified the production reader against Claude
Code 2.1.301 with the existing login, without a prompt. This is local macOS
qualification, not native Windows/Linux or every-subscription evidence. Required
repository checks and the final forced desktop build apply. Adoption follows the
normal backend update lifecycle; implementation does not restart Cafe or active
provider sessions.
