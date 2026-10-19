# Decision: New chat beside the collapsed-sidebar toggle

Decision status: Accepted by the user's explicit feature request
Implementation status: Implemented
Verification status: Native renderer cases below; current-source repository gates required for completion, without live or foreign-host qualification
Created: 2026-10-20 00:17:07 JST (UTC+0900)
Last updated: 2026-10-20 00:31:17 JST (UTC+0900)

## Context and decision

Closing navigation previously hid every global New chat pencil. The user asks
for a button immediately right of the remaining sidebar toggle, appearing and
leaving with the sidebar transition. Add it to the shared content controls used
by ordinary/compact chat, Settings and empty-chat headers. The open sidebar's
existing heading actions and toggle remain unchanged.

Reuse SidebarNewChatButton and the existing standalone-chat handler. The selected
environment must be bootstrapped; the handler still checks native server
capability and synchronously captures the environment and active Desk group.
Unfinished-draft reuse, sticky defaults, first-send exclusion, pending-editor
ownership and promotion remain authoritative. This action never borrows the
visible chat's project or starts a provider. See the existing
[Desk entrypoint decision](desk-open-chats-new-action.md).

## Presentation and lifetime

The controls slide and fade in both directions with the existing 200ms sidebar
motion, with no repeated entrance when switching chats while navigation is
already closed. Native discrete display transitions retain exit paint;
hidden/aria-hidden/inert withdraw the controls from navigation and activation
immediately. Native CSS reversal handles rapid toggles without timers or stale
completion callbacks. Reduced motion removes translation, fades entrance only
and retires exit paint immediately.
Browsers without discrete display transitions still reach the same hidden and
usable states; their exit may be immediate.

Mac traffic-light clearance follows the actual visible group, not a retained
hidden trigger. Its leading padding transitions with the sidebar's own layout
slide, so exit paint cannot jump under native controls before the content header
moves away. This scoped layout-compensation exception never applies to the open
sidebar, non-Mac or secondary panes. Reduced motion disables it and exit paint
together. Desk's top-left restriction hides the entire group so a sibling
button cannot leak into secondary panes. Real buttons retain the shared no-drag
rule. Mobile keeps its sheet toggle while the new pencil follows openMobile.

## Alternatives and qualification

Duplicating chat creation per header would fork environment/draft ownership.
Timers or animation-end-driven admission would make decoration control usability
and require cancellation fences. Both are unnecessary here. No new permission,
provider/session mutation, subscription, persistence or dependency is introduced.

Native renderer fixtures cover pointer/keyboard activation, exact callback
counts, scoped bootstrap admission, hidden/inert controls and split-pane
exclusion. Full-app standalone coverage retains draft text/settings, group and
environment identity and zero dispatch before Send. Reduced motion uses its
existing separate provider-owned context. No transient frame, glyph or easing
assertions are required; renderer evidence is not native AppKit/Windows smoke or
running-user-app adoption. See [Chats without projects](../standalone-chats.md).
