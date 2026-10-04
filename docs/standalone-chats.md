# Chats without projects

Cafe chats can exist without a project or repository. **Desk** organizes open
tabs; **Projects** contains the saved project/chat catalog. A tab's group does
not determine its project association.

- Choose **New chat** above the Desk/Projects switch, or the plus beside Desk's
  **Open chats**, to start a standalone conversation in the active tab group.
  No folder is required, even when you have no projects.
- To create a project-associated chat, use that project's existing New chat
  action. Global New chat does not automatically choose the current project.
- Find standalone conversations and saved unsent drafts in **Projects → Chats**.
  Saved conversations also appear in search. Opening an existing conversation
  selects its tab rather than duplicating it.
- Closing a Desk tab is view-only. It does not delete or archive the chat, stop
  the agent, or discard saved input. Rename and archive use the familiar sidebar
  controls; restore archived/deleted conversations through existing Settings.

The composer, attachments, model/account controls, messages, compact tabs and
per-group task/context/quota pinning remain unchanged. Standalone chats omit
repository-specific branch, worktree, editor, Git and project-file controls.

New standalone chats start with approval-required permissions. Providers use a
private server-managed working directory rather than a previously opened
project or the backend's working directory. This is not a tool-free sandbox:
your provider's ordinary tools, global instructions and permission controls
still apply. These use your configured agent providers and their accounts, not
a separate ChatGPT service or different subscription pricing.

Older saved servers must advertise standalone-chat support before creation is
available. Upgrade that server if Cafe reports the capability is unavailable;
the client will not silently manufacture a project instead.

If Cafe cannot prepare a standalone chat's private directory, it reports a start
failure instead of leaving the chat on Starting. Local directory preparation is
limited to 15 seconds; Codex native session startup is separately limited to
60 seconds. These are setup limits, not limits on how long a model may think.
Failed setup does not automatically resend your message.

macOS workspaces use stable volume identity so ordinary device renumbering after
a reboot does not invalidate newly enrolled folders. Older folders whose saved
device identity has already changed need a verified ownership repair; Cafe will
not silently adopt a potentially replaced folder or delete its contents.

See [the architecture decision](decisions/standalone-chats.md) for persistence,
provider-context, security and compatibility boundaries.
