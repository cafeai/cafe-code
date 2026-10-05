# Claude conversation forks and live commands

Last updated: 2026-10-05 11:02:38 JST (UTC+0900).

## Fork from a message

In a saved Claude chat, use **Fork from this message** beside a finished user or
assistant message. Confirm the account shown in the dialog. The new chat includes
that message and the preceding native conversation, and the original chat stays
unchanged. The action creates a branch; it does not send a model request.

Both chats keep the same workspace files. Forking a conversation does **not**
rewind those files. A branch halfway through a turn keeps only earlier complete
filesystem checkpoints, not a checkpoint or work log from later in that turn.
Active tasks and pending approvals are not copied into the new chat.

The source and all its background work must be idle. Cafe must also prove the
selected message's exact native identity and the complete bounded source view.
Older, ambiguous, very large or compacted-away histories may be unavailable;
Cafe never silently substitutes the latest history or drops older messages.
If a response is uncertain, check your chats before trying again. Cafe does not
automatically repeat the fork. These native selected-message actions are Claude
features, not a promise that every provider supports the same operation.

## Current slash-command suggestions

Open `/` in an existing Claude chat to see the commands advertised by its current
session. Plugin additions, removals and renames update the open picker without
restarting the provider or making an extra model request. Selecting a suggestion
inserts its exact command name; normal Send still controls execution.

Changing accounts, workspaces or sessions clears the old list. A disconnected or
unavailable session is labeled honestly, and a draft does not borrow another
chat's commands. Built-in Cafe commands and manual command entry remain usable.
Other providers retain their existing command sources.

Restart or resume normally after adopting the rebuilt Cafe runtime to receive
these features; installing a new Cafe build does not modify an already-running
provider process in place.

The [selected-message fork decision](decisions/claude-selected-message-forks.md)
and [live command catalog decision](decisions/claude-command-catalog.md) describe
identity, privacy, resource bounds and credential-free verification. For separate
delivery and task controls, see [Claude task controls](claude-task-controls.md).
