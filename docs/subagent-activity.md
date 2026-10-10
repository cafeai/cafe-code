# Subagent history and activity

Select a subagent in Tasks or Atrium to open its detail. Cafe shows its saved assignment,
progress and status, available public messages, and an **Activity** section for
verified Codex and Claude histories.

Activity labels summarize command, file-read, file-edit, agent-message and other
tool operations. Recognized file operations include their target path; commands
include a conservative command description beneath the label. These selectable,
wrapping details are limited to 512 UTF-8 bytes. Sensitive arguments, environment
values and unsupported script content are hidden. Missing or unsupported native
metadata retains the category-only fallback instead of inventing a detail.

These are not raw command/output logs and do not imply that an operation
succeeded. Private reasoning, tool payloads, output and recipient identities
remain hidden. The text cannot execute commands or open files. Cafe does not copy
the parent chat's model settings onto a child as verified child execution settings.

The list keeps the newest 128 available operations. A notice identifies earlier
activity outside the retrieval window. Activity and public messages are separate
sections; provider timestamps appear only when available. While following the end,
new activity stays in view. Scrolling back preserves your position and offers a
jump to new updates. Switching to another child clears the previous child's data.
Selection remains bound to the exact server, parent chat, turn, child and retained
history. A delayed result from a closed or replaced selection cannot appear under
another worker, and historical formatting follows the verified history provider.

Atrium uses the same already-loaded detail reader as the chat, without a separate
hashed module fetch when a worker is clicked. Unexpected detail rendering failures
stay inside the popup with a **Back to Atrium** action; they do not replace the
whole app or reload drafts. Missing renderer assets return an uncached 404 rather
than application HTML. Cafe never substitutes new code for an old asset hash.
An already-open renderer from before this fix needs an explicit app reload after
adopting the rebuilt version; the fix does not repair an old renderer in place.

An unavailable refresh preserves the last safe snapshot and shows Retry; it does
not claim that old data is current. Native indexed history can lag active work.
Normal restart of the rebuilt backend is required to receive the updated detail
fields from its daemon. No provider session is restarted merely to view history.

Large Codex command results are handled by a separate bounded history reader;
they are never displayed as raw output. If native history exceeds its limits,
Cafe retains safely read entries or tries one separately verified public-summary
read. The incomplete-history notice still applies: summaries can omit intermediate
messages and activity, and an empty bounded result does not mean no work occurred.

See [the activity detail decision](decisions/subagent-activity-details.md) and
[the preserved ownership decision](decisions/provider-aware-composer-and-child-activity.md).
Native retrieval and fallback bounds are documented in
[the wire-budget decision](decisions/codex-history-wire-budgets.md).
