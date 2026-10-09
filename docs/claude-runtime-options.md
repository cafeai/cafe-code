# Claude response budgets, Ultracode and workflows

Last updated: 2026-10-09 13:03:52 JST (UTC+0900)

## Choose a response budget per account

In **Settings → Providers**, edit the Claude account and set **Maximum response
tokens**. Cafe supports whole numbers from 1 to 128,000, including values above
64,000. Leave it blank to inherit the account environment or native model default.
Clearing the field removes Cafe's explicit override; it does not delete an
inherited environment setting. Saving uses the existing account reload, which
can end its sessions. Change it between sessions, not during important work.

The setting supplies `CLAUDE_CODE_MAX_OUTPUT_TOKENS` in the owning account's
copied environment for new interactive queries. It does not change global
environment variables, provider profiles, other accounts, metadata/title helpers
or login/health checks. It is a per-request budget, not a total workflow budget or
a promise about every native child agent's budget inheritance.

Thinking can consume the output budget too. Larger values permit more output
usage and can reduce context room before compaction. The model/service still
clamps to its own limit, and exhaustion can still occur before a final answer.
128,000 is Cafe's qualified setting range, not a universal upstream maximum.
See the [official environment reference](https://code.claude.com/docs/en/env-vars#claude_code_max_output_tokens)
and [response-limit recovery](claude-response-limits.md).

## Max and Ultracode are separate

Use the composer's effort/model-options menu. **Max** is a native reasoning
effort. **Ultracode** is a separate native workflow mode, with **Native default**,
**On** and **Off** choices. You can select Max and Ultracode together; Cafe does
not substitute a fabricated effort value or inject a prompt to simulate it.

The control requires a qualified stable Claude Code 2.1.284+ runtime and a model
with xhigh support. Native account/workflow eligibility and managed policy remain
authoritative. Cafe records **Ultracode requested**, not an unverified claim that
the service enabled it. Omission preserves native startup policy; removing a
previous explicit choice uses the supported native reset on that same query.

Ultracode opts into larger orchestration and potentially substantially more
tokens/agents. Native workflows have separate concurrency policy; ordinary
Agent-tool limits are not a universal workflow cap. Native tool permissions and
Cafe's exact task-control confirmations remain unchanged. Cafe never enables a
disabled workflow policy or uses private settings RPCs to bypass eligibility.
See [native effort/mode behavior](https://code.claude.com/docs/en/model-config#effort-level)
and [workflow operation](https://code.claude.com/docs/en/workflows).

## Workflow details in Tasks

The Tasks popover and docked rail have a separate paged **Workflows** section.
It includes recent retained workflow outcomes, while the ordinary subagent roster
stays active/waiting-only. A workflow card can show its received name, description,
root status and usage, then phases and agent labels, models, token counts,
durations and statuses. Phase progress counts only explicitly reported Done
agents. Missing values say unavailable; a root ending does not prove a child's
success. Omitted progress snapshots retain the previous admitted details.

The pinned SDK 0.3.288/native Claude Code 2.1.288 exposes public task lifecycle
edges. Its native stream also emits a `workflow_progress` snapshot sibling
omitted from the exported SDK types. Cafe's isolated received-only decoder uses
that qualified runtime extension when present; it never fetches private journals
or reconstructs missing phases. A different configured runtime can supply less
detail. This compatibility boundary is not a public SDK guarantee.

Snapshots keep at most 128 combined phase/agent rows and explicitly label
truncation; oversized or malformed snapshots cannot erase good prior evidence.
Agent prompts, result previews, private errors, tool summaries, paths and unknown
fields are excluded. This minimizes common sensitive fields and patterns, not a
guarantee that arbitrary human-chosen labels contain no sensitive information.
The owning authenticated chat remains the disclosure boundary.

Phase/agent rows are read-only. Numeric indexes are not transcript identities or
stop/retry targets. Only the existing current root-task receipt can authorize
its supported control, under the same chat/account/query/task incarnation.
Token counters are descriptive received telemetry, not billing totals or main
context occupancy. Root terminal outcomes come from native task lifecycle edges,
not a screenshot, missing row, elapsed time or completed phase count.

## Qualification and adoption

Controlled SDK, contract, SQLite and browser fixtures cover ownership, launch
isolation, updates/reset, bounded replay/history, privacy, malformed/foreign/late
events, keyboard use, themes and scaling. They run without providers, credentials,
profiles or paid inference. Hosted native-platform CI is separate from local
macOS qualification and does not establish a specific account's eligibility.

Use the pinned Node/Corepack Yarn checks and full default/browser suites, followed
last by `yarn build:desktop --force`. Adopt the rebuilt app/backend normally;
a push cannot live-repair old sessions or recover text never received. The
[runtime-options decision](decisions/claude-runtime-options.md) records the
persistence, compatibility and disclosure boundaries.
