# Claude response limits

Last updated: 2026-10-09 09:59:49 JST (UTC+0900)

## Why a long run can end without an answer

Claude's output budget includes thinking as well as visible text. A model can
spend that budget reasoning and reach the cap before giving a useful final
answer. Higher effort makes this more likely; lowering effort is one documented
mitigation, not a guarantee. This is separate from the conversation's context
window and account usage allowance. See [Anthropic's thinking and cost guidance](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost).

Cafe uses the Agent SDK's Claude Code loop, not the ordinary Claude chat app's
implementation. The pinned SDK 0.3.288/bundled Claude Code 2.1.288 already has a
bounded output-limit recovery loop with three additional native attempts. Cafe
does not extend it with an unattended retry, replay the original prompt or
attachments, or restart the provider to hide a failure. A separately configured
Claude executable can differ from that bundled version. The screenshot of a
failed run alone cannot prove its version, retry count or hidden token breakdown.
The [SDK loop guide](https://code.claude.com/docs/en/agent-sdk/agent-loop) explains
the execution and result boundary. Ordinary Claude chat's documented
[length-limit handling](https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work)
does not establish a guarantee that output-limit exhaustion will produce an answer.

## Cafe's failure handling

Only an exact primary assistant `error: "max_output_tokens"` belonging to the
current response selects the fixed response-limit guidance. Provider prose is
not a classifier; a child's failure cannot mark its parent as exhausted.
The SDK also uses this category for context-window exhaustion, so the guidance
does not guess an output-only cause from the category alone. API stop reasons
[distinguish output truncation from a full context window](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons).

The authoritative SDK result still owns terminal status. A result whose subtype
is `success` can have `is_error: true`; that remains a failed response. A genuinely
successful later segment is not converted into failure by an earlier limit.
Already received public text and tool evidence remain available, partial text is
settled through the existing exact-prefix completion path, and usage/native
resume state retain their existing accounting and ownership rules. Cafe does
not reconstruct missing text, reveal hidden thinking or execute incomplete tool
arguments. The fixed diagnostic contains no raw provider text, paths or secrets.

## Recover deliberately

The matching failed Claude chat offers **Prepare shorter response**. This places
an editable request for a concise answer and smaller sections in an empty
composer and focuses it. It does **not** send a prompt. Review the text and effort
setting, then use the normal **Send** action. Preparation keeps the current
account, model, mode and permission choices; subsequent user changes retain the
ordinary composer/send rules. Existing drafts, attachments and queued-message
edits must never be overwritten. A busy, disconnected, changed-account or
superseded failure cannot prepare recovery text into the wrong chat.

Consider lower effort when the work was over-thought. If the context window is
full, use the normal `/compact` command first. Requesting smaller sections often
helps, but no model-answer guarantee is made. A new Send is a new user-authorized
generation and can incur usage or tools under the chat's existing permissions.
The preparation button itself performs no provider or billing operation.

`CLAUDE_CODE_MAX_OUTPUT_TOKENS` is an upstream advanced control. Its defaults and
caps are model-specific, and values above a model's cap are clamped. Increasing
it can reduce context room before compaction and permit more output cost; Cafe
does not silently set a larger cap. See the [official environment reference](https://code.claude.com/docs/en/env-vars#claude_code_max_output_tokens).

## Qualification and adoption

Credential-free adapter fixtures cover structured primary admission, malformed
or foreign sources, children, duplicates, native failure/success, queued input,
partial streams and no unsolicited sends. Shared and renderer fixtures cover
exact fixed diagnostic recognition, draft/attachment/edit preservation,
replacement authority, focus and existing error/recovery behavior. Native
macOS/Windows browser CI repeats the relevant banner/composer fixtures; Linux
retains the complete browser suite. No live provider, account or damaged
historical response is used as a fixture.

Use the repository-pinned Node and Corepack Yarn. Run the focused Claude adapter,
shared response-limit and renderer tests, then repository fmt/lint/typecheck,
default tests and browser tests. The forced desktop build is the last local
verification step. This is source/renderer qualification, not a guarantee about
a particular upstream account or model. Normal rebuilt backend/daemon/app
adoption is required; a push does not update an already-running query or recover
an answer that was never received.

The [recovery decision](decisions/claude-response-limit-recovery.md) records why
the explicit preparation boundary does not add autonomous inference.
