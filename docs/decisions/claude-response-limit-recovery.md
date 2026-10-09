# Claude response-limit recovery

Decision status: Accepted — implementation and release verification remain separate.
Created: 2026-10-09 09:59:49 JST (UTC+0900)
Last updated: 2026-10-09 10:44:22 JST (UTC+0900)
Decision authority: agent implementation discretion within the user's explicit request to investigate, fix confirmed response-limit handling and push the changes to dev.
Implementation status: implemented with synthetic focused qualification; whole-repository, final-build and release CI verification remain separate.
Supersedes: none. Existing response-segment, approval, stream-integrity and user-control boundaries remain in force.

## Context

The existing adapter preserves streamed partial output but presents the native
response-limit explanation as ordinary assistant prose and a generic error.
The user has no targeted next step. The SDK's typed assistant error identifies a
response-limit category, but can describe either output or context exhaustion.
The native Claude Code loop already attempts bounded recovery, so an additional
unattended retry can consume more paid generation after those attempts and can
repeat tool work without new user control.

## Alternatives and decision

- A blanket output-cap increase was rejected: supported bounds vary by model,
  and larger generation also changes cost/context tradeoffs.
- Silently lowering requested effort was rejected: reasoning quality and saved
  user settings must remain intentional.
- Another automatic prompt or process restart was rejected: it is neither a
  no-cost operation nor proof that the original request was unreceived.
- Adopt a response-scoped typed marker and fixed actionable diagnostic. Await
  the authoritative result; preserve partial public content, cursor and usage.
  A successful later segment remains successful. Native recovery remains the
  provider's responsibility.
- Offer editable **Prepare shorter response** in the exact eligible failed chat.
  Require an empty composer and unchanged current account/lifecycle before any
  draft mutation. Do not send, clear errors, change settings or overwrite input.
  The actual user Send uses the existing authenticated, idempotent command path.

## Security, privacy and failure consequences

Provider error prose is not recovery authority. Exact primary/query/response
admission prevents nested or stale errors from changing the current failure.
Fixed diagnostic recognition is a presentation selector, not server-side
permission to send or restart. Preparation is local draft work; no new RPC,
credential read, process launch, approval bypass or inference is introduced.
Drafts, attachments, account changes, new work, Stop and navigation take
precedence over stale preparation. Failed persistence retains the draft and is
not permission to submit anything.

The original text stream's integrity checks remain unchanged. Missing output
cannot be reconstructed; neither preparation nor an accepted design guarantees
that a future model request will answer. A later Send can incur normal usage and
tool actions subject to the same approvals as other user requests.

## Compatibility, qualification and operation

No persisted schema, provider environment, dependency or platform launch policy
changes. Other error categories, nested tasks and Codex's separate history-copy
recovery remain independent. The bounded marker is response-local and cleared
at segment/reset/retirement boundaries; it is not restored as provider truth
from an old banner. Default synthetic tests and browser authority/focus cases
must pass alongside the required whole-repository checks and final forced build.

See [response limits](../claude-response-limits.md) for upstream references,
mitigations, test boundaries and normal rebuilt adoption. Source review and
local tests do not establish native Windows/macOS/Linux CI or a model-answer
guarantee. No live provider is interrupted to adopt this feature.
