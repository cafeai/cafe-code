# Decision: Codex device-code sign-in from Cafe clients

Decision status: Accepted within the requested implementation scope
Created: 2026-10-20
Decision authority: the user's request to implement the code-based Codex flow
in Cafe for remote clients, without signing into a live account during development.

## Native protocol and client behavior

Use the official app-server `account/login/start` request with
`type: "chatgptDeviceCode"`. Its typed response carries `loginId`,
`verificationUrl` and `userCode`; the exact matching `account/login/completed`
notification establishes success. The native app-server writes credentials into
the selected instance's admitted authentication source home. Cafe neither parses
CLI stdout nor copies credentials between machines or profiles.

The installed stable Codex 0.160.0 binary's generated JSON schemas contain this
request and response variant. Advertise device-code login only for an observed
stable version at least 0.160.0; legacy/missing capability metadata is unknown.
The generated repository protocol also contains the typed variant. This is native
protocol compatibility, not an account entitlement or proof that an organization
enables device authorization. An account or workspace administrator may need to
enable device-code login.

An explicit Log in gesture opens a dialog with the code and the exact official
`https://auth.openai.com/codex/device` address. Copy and Open verification page
operate on the client computer. Show waiting, success or finite local failure
feedback. Clear instructions on failure or success. Do not infer a provider code
expiry from the response: it contains no expiry field. Cafe retains the existing
60-second initialization, ten-minute human-completion and three-second native
cancellation limits.

## Authority and lifetime

Keep the existing owner-only, HTTPS-or-same-machine sign-in policy. Paired client
roles cannot change server credentials; Settings explains that restriction for
saved remote connections. Revalidate the exact persisted owner session, enabled
instance and selected configuration before admission, after awaited daemon session
inventory, and before releasing each private event. Session revocation/expiry and
configuration replacement retire the attempt. No open Cafe session for the
selected account is allowed before changing native authentication; a confirmed
rejected cached account retains the explicit guarded logout behavior.

Run the disposable native connection beside the backend Settings snapshot. The
daemon's actual session inventory remains the idle fence. Stream only the code,
official address and authenticated outcome to the requesting connection; native
login IDs remain private. No code or credential enters snapshots, settings,
provider caches, traces or the daemon's durable command ledger. All received
native and transport errors remain opaque, with finite Cafe-owned UI reasons.

The one-shot client stream never reconnects or replays. Dialog close, component
unmount, environment switch or socket failure cancels the exact native login and
joins child cleanup. Instance retirement owns the same cancellation. A shared
reservation excludes overlapping browser/device attempts until native cleanup
completes. Successful completion refreshes the selected backend snapshot; it does
not submit inference, start a chat or restart Cafe.

## Qualification

Synthetic native fixtures cover exact completion, early notifications, selected
account idle checks, rejected cached authentication, unsupported versions,
official bounded instructions, cancellation, failure, startup/completion budgets
and native exit. Backend fixtures exercise owner/transport/session admission,
revocation, expiry, replacement and private event release. Transport fixtures use
the actual RPC/socket protocol to prove cancellation and no reconnect replay.
Native browser fixtures exercise Log in, Copy, client browser opening, Cancel,
completion and opaque failure. These do not authenticate a live account.

Protocol reference: [OpenAI app-server authentication](https://learn.chatgpt.com/docs/app-server).
Account setup: [Codex authentication](https://learn.chatgpt.com/docs/auth).
