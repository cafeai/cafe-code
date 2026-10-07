# Desk and chat tabs

Use **Projects** to browse the saved project/chat catalog, including the separate
**Chats** section for conversations without a project. Use **Desk** to
show only your open chats, grouped the way you are working. Atrium, Settings,
project actions and the chat composer stay in their usual places.

The tabs now occupy the top window bar, with a taller row instead of a separate
chat header above them. Native window controls retain their own space. Project
context remains in each tab's hover title and the sidebar. Source-build badges
such as **Newer dev** sit beside **Settings** at the bottom of the sidebar.

- In **Settings → Chats → Single-click behavior**, choose **Preview** (the default)
  or **Open**. Open keeps each clicked chat as a regular tab.
- With Preview selected, click a chat in Projects, Chats or search to preview it in the current group.
  Preview titles are italic. Opening another chat replaces that group's preview;
  selecting a kept tab dismisses it. Each visible split group has its own preview.
  Double-click the chat row or its tab to keep it open, or choose **Keep open**
  from the tab's context menu. Kept tabs retain normal titles and restore on restart.
  Previews are excluded from saved layouts and reopen history. Dragging a tab to
  rearrange or split it keeps it open. Closing a preview retains its input and work.
- Use the **New chat** icon beside **Chats** in Projects, or the global New chat
  shortcut, to create a standalone conversation in the active group without a folder.
  Desk's **Open chats** heading has no creation button.
  Existing per-project New chat actions still create project-associated chats.
- Drag tabs to reorder, into another group to move, or to a chat pane edge to
  split. Hover the left or right half of a tab to see an insertion line before
  or after it; empty tab-strip space appends. Tab-strip targets never show a
  pane split preview. The group grip swaps group positions. Drag a divider to resize.
  The highlighted half follows the nearest outer edge; the center adds the tab
  to that group. Escape or dropping outside the workspace cancels the move.
- Use a tab's right-click menu or the group's `…` button for close, close others,
  close right, close all, reopen, split, move, merge and focus actions.
- Choose **Open** in that menu to open the clicked chat's project/worktree in
  an installed editor, the file manager, or a terminal. The existing favorite-editor
  keyboard shortcut still acts on the focused chat pane. These actions are
  available only for local projects with the corresponding desktop capability.
- Right-click an open chat in the Desk sidebar, or press Shift+F10 / the keyboard
  menu key while its row or tab is focused, to rename, archive, move it to the
  Recycle Bin, delete it permanently, or close its tab. Opening this menu does
  not select another sidebar row or activate an inactive pane/tab. Uncreated
  drafts keep only tab/layout actions.
  Archive stays unavailable while the chat is working; permanent deletion always
  asks for confirmation before changing anything and reuses the existing chat
  shutdown and cleanup path. If a final purge fails, check Recently Deleted
  before trying again. Close tab remains a local navigation action.
- Chat context menus use the same rounded, theme-aware panel on desktop and in
  the browser, with icon rows, grouped separators, keyboard navigation, and
  Escape/outside dismissal. They follow Cafe's current colors and interface
  scaling; menu labels show only actions the corresponding surface supports.
  Escape or choosing an item returns focus to the menu's original control;
  clicking or focusing elsewhere keeps that new destination. Pending layout
  choices and group-name dialogs are discarded if their original Desk layout changes.
  Sidebar inline group edits also reject a replaced group or environment, while
  ordinary clicking away still saves an edit to the same unchanged group.
  Chat actions stay bound to the originally clicked chat, never a newer selection.
  A delayed delete result does not navigate away from a chat you selected later,
  even if you switched away and back while deletion was pending.
- Dividers stop at usable pane sizes, including nested groups. Use the existing
  focus/restore icon to expand one group and return to the split layout. Saved
  ratios that no longer fit are adjusted for display without losing your layout
  preference. If the window cannot fit all groups, the restore icon explains
  that you need to enlarge the window; the split returns once there is room.
- Click a sidebar row's pencil or press F2 on a tab/row to rename an existing chat.
  Top tabs show only an always-visible close X; rename also remains in their
  right-click menu. Click a pane's group name to rename the group.
  In the Desk sidebar, hover or keyboard
  focus a group heading to replace its count with a pencil; click the pencil or
  press F2 to edit the name inline. Enter or clicking away saves, Escape cancels,
  and clicking the heading normally still activates the group. New drafts gain
  chat renaming after creation.
  Project chat rows keep rename and archive together at the right edge; hover
  or focus the row to reveal them (touch layouts show them directly).
  Desk rows use the same selected-row styling and relative activity time as
  Projects. Hover or keyboard focus replaces that time with rename/close buttons
  without shifting the title (touch shows the actions directly). The pencil
  edits the title inline: Enter or clicking away saves, Escape cancels.
  Rename failures keep the edited text for retry; no modal interrupts the chat.
- Choose **Search open tabs…** from the group's `…` menu to find an open tab. Arrow keys/Home/End navigate
  a focused tab strip. Menus offer alternatives to dragging.
- Pin task/context/quota information from its existing composer popover, or
  choose **Pin session information** from a group's menu. Each group remembers
  its own setting. Narrow panes retain the setting but use the popovers until
  there is space; Focus group gives that chat more room.

Closing tabs never deletes chats, stops agents, or discards draft/queued text.
Reopen closed tab restores recent tabs. Desk layout is a preference on this
client, saved separately for each connected primary environment. It does not
move projects, copy chats, or synchronize a layout to another computer.

Up to four panes can be visible; each can contain many tabs. Smaller windows
show one group at a time with group-switching controls while retaining the saved
split layout. Standalone creation and its durable catalog are documented in
[Chats without projects](standalone-chats.md); the original tab-group navigation
and provider-neutral close behavior remain unchanged.
