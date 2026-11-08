# Decision: explicit unanswered dispositions for Claude questions

Status: Accepted design; implementation under qualification

Created: 2026-10-30 13:06:02 JST (UTC+0900)
Last updated: 2026-10-30 15:07:23 JST (UTC+0900)

Decision authority: implementation choice within the user's approved provider
update. Design acceptance and source implementation do not establish passing
checks or live provider adoption. The coordinated provider audit records package
admission separately.

## Context

Claude Code's native question callback can distinguish an actual answer from an
explicitly unanswered question. Native clients advertise this extension with the
initialization capability `ask_user_question_unanswered_v1`. A version string,
wrapper pin, provider-wide feature flag or an older saved request is not evidence
that the current native query accepts annotations. Older strict native clients
can reject an otherwise valid response if an unsupported annotation is attached.

Cafe already has authenticated pending question activities and a durable response
command. These are distinct from permission grants, private MCP elicitation,
ordinary chat messages and Codex's optional inline questions.

## Decision

Retain the existing `answers` map and add a separate optional `unanswered` map
whose values are `skipped` or `dismissed`. Each known question has exactly one
actual answer or one explicit disposition when this extension is used. Neither
an empty fabricated answer nor renderer-authored native metadata substitutes for
that distinction. Unknown question keys and conflicting answer/disposition pairs
are refused by the live provider boundary. Existing answers-only responses retain
their compatibility behavior and omit the native `annotations` property.

Only the exact pending native Claude callback can advertise
`supportsUnanswered: true`. The server preserves its current session/query/request
ownership and rechecks that authority before constructing native annotations.
Durable activity replay supplies presentation, never callback authority. A stale
request, replaced query or unsupported native client cannot gain this feature
from a renderer flag. Native keys remain the original question text; Cafe's
canonical question identities stay on its own side of the adapter.

The extension admits at most 64 distinct question identities, with at most
16,384 UTF-16 code units per identity and 65,536 in total. Mixed response
validation separately bounds the combined keys and answer text. These finite
transport limits are not permission to truncate question meaning or guess a
shorter identity; unsupported inputs retain the older answering path.

Expose two deliberate actions on capable question cards:

- **Skip** replaces the current question's local answer with an explicit skip
  and advances. Selecting an option or typing afterwards removes that skip.
  Skipping the final question submits only if all questions are resolved.
- **Dismiss** submits existing valid answers and prior explicit skips, marking
  only the still-unanswered questions as dismissed. It does not interrupt the
  turn, stop a session or submit the main chat draft.

Both actions are hidden when capability evidence is absent. Question responses
use their own busy state, independent of approval submissions. An in-flight
reservation prevents another local submission before React renders disabled
controls. The renderer also rechecks the current canonical pending request at
the native action boundary so a resolution received before the next render
cannot dispatch an obsolete card. Transport failure retains local answer state
and permits explicit retry; the provider's exact callback settlement remains
authoritative.

An option's queued auto-advance is retired when the user explicitly skips or
dismisses that card. The existing countdown, ordinary answering, navigation,
Stop control and main composer draft remain separate. No new timer, implicit
steer, turn start or paid inference is introduced.

## Security, privacy and compatibility

Question text, answers and annotations belong to the authenticated conversation
and its existing response transport. Ordinary canonical operational logs retain
only bounded routing metadata, question counts and Boolean resolution/capability
facts for these exact input-request events; they omit question/answer content,
full-text disposition keys, raw copies and private diagnostic snapshots. This
log-only projection never replaces or rewrites the authenticated canonical event,
its activity or the native callback. The separate optional protected native
protocol transcript log and other content-bearing event types retain their
existing behavior; this change does not claim to scrub historical logs or every
transcript copy.
The adapter translates the bounded typed disposition into native
`annotations[question].unanswered` only after capability and request validation.
Prototype-like provider question identities are inert own response properties,
never object prototype mutations. Native explanatory text still belongs in
`answers`: the model does not see unanswered metadata as an explanation.

The native protocol also defines `replied_in_chat`. Cafe deliberately does not
expose that action in this change: implementing it would require a separately
owned ordinary chat submission and acknowledged delivery. Merely opening the
composer, typing a draft or receiving another message cannot mark a question as
replied in chat. Dismiss is also not an alias for cancellation or approval.

No credentials, native history, global settings or permissions are copied or
changed. SDK and managed CLI pin changes require independent complete-family
provenance and compatibility review. The normal 24-hour package-age policy
remains in force; the user explicitly waived elapsed age only for SDK 0.3.314
and CLI 2.1.314 in this update. The coordinated audit records that exception
separately from timestamp, signature, archive-integrity and platform checks.
Running external CLI generations are not upgraded by a source pin or a rebuilt
application bundle.

## Alternatives and verification

Always attaching native annotations was rejected because older clients reject
the extension. Encoding "skipped" as a normal answer was rejected because it
changes model-visible meaning and loses the user's actual response distinction.
Treating Dismiss as Stop was rejected because the question callback can continue
without terminating unrelated work.

Pure controller tests cover capability omission, real answers, explicit skips,
partial dismissal, answer/disposition exclusivity, duplicate identities and inert
prototype-like keys. Native browser journeys cover actual Skip/Dismiss and
legacy answer submission, exact outgoing commands, independent busy controls and
preservation of the main draft. Adapter and contract tests must separately
qualify native capability/ownership refusal and exact old/new wire shapes. These
tests use synthetic providers; they do not claim live Claude execution.

The controller and native browser wiring passed focused qualification on
2026-10-30 13:29:51 JST (UTC+0900). Complete integration qualification against the
final qualified SDK/runtime pins (with the exact 314 elapsed-age exception above),
repository checks and the fresh forced
desktop build remain separate completion gates.
