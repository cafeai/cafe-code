# Decision: adjacent New chat action in Desk's Open chats heading

Decision status: Accepted by the user's explicit request to restore this Desk entrypoint
Implementation status: Implemented
Verification status: Native browser fixture scope below; unchanged-source repository gates are required for publication, with no live-provider or hosted claim
Created: 2026-10-14 23:49:58 JST (UTC+0900)
Last updated: 2026-10-15 00:21:35 JST (UTC+0900)
Partially supersedes: only the no-Desk-heading-button placement in
[standalone chats](standalone-chats.md) and the integration placement status in
[the historical Desk entrypoint](desk-chat-creation-entrypoint.md).

## Context and decision authority

The prior integration removed Desk's creation icon while retaining Projects'
Chats heading action. The user now explicitly requests the same pencil button
immediately right of Desk's Open chats label and inclusion in the current dev
push. Keep that label and add the requested adjacent entrypoint; do not change
Desk's role as an open-view list or rewrite the earlier accepted history.

## Shared action and ownership

Reuse SidebarNewChatButton's theme, scale, icon, tooltip and native keyboard
button. Supply the same canonical standalone creation callback and selected-
server bootstrap gate as Projects. The accessible name identifies the active
tab group, distinguishing the action from an existing draft named New chat.

The handler rechecks the selected environment's capability and captures its
active group. Existing unfinished-draft reuse, selected defaults, first-send
exclusion, pending-editor ownership and delayed promotion fences remain intact.
No unsent tab, saved chat, provider call or inference is created by the gesture.
Project-associated creation remains explicit through the existing project action.

## Alternatives and consequences

Changing sidebar mode or adding a separate draft implementation would duplicate
ownership and defaults. Reusing the existing action gives both views the same
meaning without a new lifecycle or transport. The pencil sits beside the label,
not at the far sidebar edge. Shared rem tokens retain native interface scaling;
the heading must remain shrink-safe in narrow light/dark layouts.

No new credentials, permissions, provider/session mutation, subscriptions,
dependency, persistence format or platform-specific policy is introduced.
Unsupported/unbootstrapped servers retain the existing disabled/admission
behavior. An old renderer must adopt the rebuilt version normally; the change
does not restart or repair existing provider work.

## Qualification and preserved decisions

Native browser fixtures cover actual click and keyboard activation, disabled
negative input, adjacent geometry in both themes at interface-scale bounds,
unfinished draft/content/settings reuse and captured-group promotion. Keep the
global shortcut coverage, exact pre-Send zero-dispatch assertions, original
input ownership, workers and deadlines. Use the pinned repository checks and
forced desktop build LAST before the approved normal dev publication.

These fixtures are not live user/provider adoption or native foreign-platform
qualification. All nonplacement rules in the predecessors remain in force.
See [Chats without projects](../standalone-chats.md) for the current user guide.
