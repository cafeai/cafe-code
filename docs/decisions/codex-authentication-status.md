# Decision: show rejected Codex credentials as signed out

Decision status: Accepted within the requested implementation scope
Created: 2026-10-20
Decision authority: the user's request to stop showing a revoked remote Codex
login as authenticated.
Implementation status: Implemented; synthetic qualification does not establish
live account recovery or authorize a deployment/restart.

## Problem

`codex login status` and cached `account/read` metadata can identify saved
credentials even after OpenAI revokes their refresh token. Cafe previously
retained the authenticated account presentation after native revocation.
The existing lightweight account-usage read discarded HTTP failures. Clicking
Log in then returned early on the same cached account.

## Decision

Keep the lightweight health probe and existing budgets. Observe a terminal
native structured 401, or the exact bounded native auth-manager refresh-token
revocation record, from the current instance/thread/runtime generation. Generic
stderr, MCP/tool errors, unauthorized prose, retry notifications and 403
policy/entitlement failures do not establish account sign-out. Native successful
root completion can retire that generation's refusal.

Bind observations to a private, volatile digest of the exact admitted credential
file for that native opening. Reads are explicitly home-bound and bounded, and
refuse symlink entries. Never publish/persist credential bytes or their digest.
A different revision retires old evidence; late old-process observations cannot
modify the new revision. Driver replacement retains existing registry fencing.

The existing account-usage request can report a 401 for its still-current
credential revision. An expired/opaque access token with a refresh token remains
inconclusive, allowing native renewal. A rejected unexpired token, or an expired
one without a refresh token, requires sign-in. Transport/5xx/429/403 failures
remain inconclusive. This adds no inference, timer or extra HTTP request to probes.

A confirmed refusal requests a scoped health refresh and overrides cached CLI
authentication with `unauthenticated`, removing stale email, plan and quota
presentation. Existing Settings copy reads **Not signed in**. The refusal survives
ordinary refreshes for the same credentials; it is volatile and is not reconstructed
from transcripts, old logs or persisted cache as fresh proof.

Explicit owner-triggered Log in bypasses the cached-account early return only
for a current refusal. Preserve both local and actual owner-session idle checks,
then recheck the refusal against both the runtime overlay and actual login source
before `account/logout` and `account/login/start`. Fresh source credentials
appearing during admission refuse the attempt without logout.
Only the exact successful login completion refreshes account state. No automatic
logout, credential deletion, active interruption, replay or Cafe restart occurs.

## Qualification

Use inert native-runtime and HTTP fixtures with test-owned credentials, exact
generation/account negatives, held-request credential rotation, refreshable
expiry, transport/policy failures, login busy/race guards, and the actual Settings
card's transition and Log in action. Live authentication and remote deployment
remain separate user actions.
