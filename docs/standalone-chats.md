# Chats without projects

Cafe chats can exist without a project or repository. **Desk** organizes open
tabs; **Projects** contains the saved project/chat catalog. A tab's group does
not determine its project association.

- Click the New chat icon beside **Chats** in Projects, or use the global New chat
  shortcut, to open a standalone editor. Desk has no new-chat heading button.
  The selected sidebar view stays selected.
  No folder is required, even when you have no projects.
- To create a project-associated chat, use that project's existing New chat
  action. The standalone New chat icon does not choose the current project.
- A new chat stays in a pending editor until you press **Send**, just like a
  project draft. It adds no tab, Open chats row/count or saved Chats entry before
  that send. Pressing the icon again reopens your unfinished draft with its text,
  attachments and selected settings. A draft whose first send is still pending
  keeps its own identity, so another new-thread action opens a fresh editor.
- After first send creates the conversation, its tab opens in the captured group
  and it appears in the saved Chats list. A background send finishing does not
  switch away from the newer editor you are using.
- Find saved standalone conversations in **Projects → Chats** and search.
  Opening an existing conversation selects its tab rather than duplicating it.
- In **Projects → Chats**, hover a saved row or focus it with the keyboard to
  reveal its archive action. Touch screens show it directly. Archived chats can
  be restored from **Settings → Archived threads**. Move to Recycle Bin remains
  available in the row's context menu, with restore in **Recently Deleted**.
- Closing a Desk tab is view-only. It does not delete or archive the chat, stop
  the agent, or discard saved input. Rename and archive use the familiar sidebar
  controls; restore archived/deleted conversations through existing Settings.

The composer, attachments, model/account controls, messages, compact tabs and
per-group task/context/quota pinning remain unchanged. Standalone chats omit
repository-specific branch, worktree, editor, Git and project-file controls.

New chats default to **Full access**, including standalone chats. Choose
**Supervised** or **Auto-accept edits** in the composer's model-options menu to
use a different access mode. Existing chats and saved drafts retain their selected
access mode. Providers use a
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
