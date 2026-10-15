# Desk and chat tabs

Last updated: 2026-10-16 00:40:48 JST (UTC+0900)

Use **Projects** to browse the saved project/chat catalog, including the separate
**Chats** section for conversations without a project. Use **Desk** to
show only your open chats, grouped the way you are working. Atrium, Settings,
project actions and the chat composer stay in their usual places.

While reviewing earlier messages, hover or focus **Scroll to bottom** to reveal
its compact options popout. Choose **Hide until bottom** to dismiss the button
without moving the chat or changing review mode. The options chevron also works
with a click, keyboard or touch. Reaching the actual bottom automatically clears
the choice, so the button returns on your next scroll up. The temporary choice
follows that exact chat across tabs in the current layout (including another
view of the same chat), never another environment's chat. It is not saved across
app restarts; incoming messages and a requested-but-unfinished scroll do not
clear it. Remembered choices are bounded like the existing review-position cache.

The tabs now occupy the top window bar, with a taller row instead of a separate
chat header above them. Native window controls retain their own space. Project
context remains in each tab's hover title and the sidebar. Source-build badges
such as **Newer dev** sit beside **Settings** at the bottom of the sidebar.

Web clients narrower than 768px show one chat with its normal title and sidebar
button, without a tab strip or group controls. Open the sidebar to switch chats
in Projects or Desk. Saved tabs, drafts and split layouts remain intact; tabs and
splits return when the browser becomes wide enough. The desktop app retains tabs
at every width.
On macOS desktop, the sidebar reopen button stays clear of the traffic lights
when the sidebar is hidden. Desk, chat, Settings, empty-state and sidebar
headers share a fixed native-sized vertical band, so changing interface size
does not move that control toward the window buttons. Only the top-left split
pane reserves their leading space; lower panes keep normal tab spacing. This
does not reposition the native window buttons or alter browser/mobile layouts.
Renderer geometry and hide/reopen behavior are covered by
`SidebarChromeHeader.browser.tsx`, `MacTitlebar.browser.tsx`,
`MacBrowserTitlebar.browser.tsx` and `DeskWorkspace.browser.tsx` in the web browser suite; native AppKit placement
remains a separate desktop smoke check.

- In **Settings → Chats → Clicking a chat**, choose **Preview** (the default)
  or **Open**. Open keeps each clicked chat as a regular tab.
- With Preview selected, click a chat in Projects, Chats or search to preview it in the current group.
  Preview titles are italic. Opening another chat replaces that group's preview;
  selecting a kept tab dismisses it. Each visible split group has its own preview.
  Double-click the chat row or its tab to keep it open, or choose **Keep open**
  from the tab's context menu. Sending a message also keeps its preview open
  immediately, including queued messages and live steering. Kept tabs retain
  normal titles and restore on restart.
  Previews are excluded from saved layouts and reopen history. Dragging a tab to
  rearrange or split it keeps it open. Closing a preview retains its input and work.
- Use the **New chat** pencil icon beside **Chats** in Projects, or the global New chat
  shortcut, to create a standalone conversation in the active group without a folder.
  The Projects heading and shortcut share the same action and keep the selected sidebar view unchanged.
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
  menu key while its row or tab is focused, to duplicate, rename, archive, move it to the
  Recycle Bin, delete it permanently, or close its tab. Opening this menu does
  not select another sidebar row or activate an inactive pane/tab. Uncreated
  drafts keep only tab/layout actions.
  Archive stays unavailable while the chat is working; permanent deletion always
  asks for confirmation before changing anything and reuses the existing chat
  shutdown and cleanup path. If a final purge fails, check Recently Deleted
  before trying again. Close tab remains a local navigation action.
- Choose **Duplicate chat** from a saved chat's right-click menu in Desk or
  Projects, including Projects' standalone **Chats** section. This is the same
  provider-history operation previously called **Fork chat** in project rows.
  It creates a separate, resumable Codex or Claude conversation at that point,
  preserving its account/settings and leaving the original chat and draft alone.
  It sends no message automatically. The copy uses the same project/workspace
  files and worktree; duplication does not clone files or create a Git branch.
  Wait for the chat and its background work/questions to finish first. Uncreated
  drafts and providers without native history branching cannot be duplicated.
  A successful copy opens separately unless you changed your selection/layout
  while it was being prepared. After a connection error, check the chat list
  before retrying; an explicit same-source retry reuses the unresolved copy's
  identity, while changed-source uncertainty refuses rather than making another
  branch. No action is automatically retried.
  If the copy was created but could not open, the notification says so; open
  that existing copy from the chat list instead of duplicating it again.
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
  right-click menu. Group names fill a flat section of the tab bar beside their
  drag handle. Click a pane's group name to rename the group.
  The desktop title bar keeps a small blank area just before the upper-right
  focus and menu icons for moving the window, even when the tabs fill the row.
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
split layout. Tabs share the available width and shrink evenly as more open,
with truncated titles and visible close buttons. Once they reach their minimum
width, the strip scrolls. Standalone creation and its durable catalog are documented in
[Chats without projects](standalone-chats.md); the original tab-group navigation
and provider-neutral close behavior remain unchanged.
