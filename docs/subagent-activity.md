# Subagent history and activity

Select a subagent in Tasks to open its detail. Cafe shows its saved assignment,
progress and status, available public messages, and an **Activity** section for
verified Codex and Claude histories.

Activity labels summarize command, file-read, file-edit, agent-message and other
tool operations. They are not raw command/output logs and do not imply that an
operation succeeded. Private reasoning, tool payloads and recipient identities
remain hidden. Cafe does not copy the parent chat's model settings onto a child
as if they were verified child execution settings.

The list keeps the newest 128 available operations. A notice identifies earlier
activity outside the retrieval window. Activity and public messages are separate
sections; provider timestamps appear only when available. While following the end,
new activity stays in view. Scrolling back preserves your position and offers a
jump to new updates. Switching to another child clears the previous child's data.

An unavailable refresh preserves the last safe snapshot and shows Retry; it does
not claim that old data is current. Native indexed history can lag active work.
Normal restart of the rebuilt backend is required to receive the updated detail
fields from its daemon. No provider session is restarted merely to view history.

See [the activity and ownership decision](decisions/provider-aware-composer-and-child-activity.md).
