# Native Codex review

In an idle Codex chat, select the **Code review** tab above the composer. The
existing model-options menu also keeps its **Codex review** shortcut. Choose one of:

- **Uncommitted changes** in the chat's workspace.
- **Changes against a base branch**, such as `main` or `origin/main`.
- **A specific commit**, using its hexadecimal SHA rather than a shell command.
- **Custom review instructions**.

The tab and menu action appear only when the account currently selected in the composer
matches the saved, ready Codex session, the server is connected, and the chat is
idle. Selecting Claude, Grok or a different Codex account hides it immediately,
even before sending a message. Work, a send, a connection or a checkpoint restore
also makes it unavailable. Changing its chat, account or session binding closes
the old review dialog; submission checks the current selection again.

The tab's caret minimizes or restores it without moving the caret or the composer.
Its minimized choice is shared across all chats, environments and panes and survives
reloads. The action's explanation is available on hover or keyboard focus.

Review runs in that exact Cafe chat and Codex account. The confirmation names the
account and explains its permission behavior. Native review uses the existing
native session's configuration, including any provider-configured review model;
it does not submit unsent composer model, effort or speed changes as review
overrides. Codex's native reviewer is non-interactive: it does **not** ask approval
questions and retains the session's sandbox. A full-access session remains
full-access. Review never silently widens the sandbox in Cafe.

Findings appear in the conversation and review entry/exit appears in the work
log. An exit marker is not proof that the entire turn has finished; Cafe waits for
the provider's authoritative turn-completed event. The ordinary chat Stop control
cancels the native turn. A busy chat rejects a new review rather than sending it
as an instruction to the current task.

For a separate review, create or open another Cafe-owned Codex chat in the desired
workspace and use its Codex review menu action after its session is ready. Cafe does
not create or adopt deprecated detached native review threads. Claude and Grok
do not expose this Codex-specific action. Asking any model to review code in an
ordinary message still works as an ordinary conversation request.

If the provider rejects the method or its acknowledgement cannot be confirmed,
Cafe shows an error without sending a replacement model prompt or replaying the
review. Check the work log and provider connection before another attempt. Normal
restart/resume reconciliation retains the existing thread/account binding.

See the [review lifecycle and ownership decision](decisions/codex-native-review.md)
for the qualified protocol and implementation boundaries. These checks use
credential-free fixtures; they do not claim paid review runs against a live account.
