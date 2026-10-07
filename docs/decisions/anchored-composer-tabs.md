# Anchored composer tabs

Status: Implemented under the user's request for compact delivery controls and a stationary minimize/expand caret.

One generic **Composer tools** tab above the composer contains available controls,
including Code review and qualified Claude message delivery. Each feature supplies
only its own control; neither owns a separate tab or collapse state. Render these
controls as independent children so future features can appear together in the
same container. The tab adapts to its contents without replacing its caret when
the provider changes. The existing options-menu shortcuts remain available and share the
same controlled review dialog or account-scoped delivery choice. This replaces
only the menu-only presentation from the provider-aware composer decision.

Delivery shows its current choice in a short label. The popup lists Automatic,
Now, Next and Later, with explanations in hover/focus tooltips rather than inline
prose. Choosing an option never submits the composer. Automatic still means an
omitted priority; account/chat changes retain the existing reset and dispatch
binding rules.

Tabs collapse toward a fixed right edge. Their caret is absolutely positioned,
and both tab height and reserved composer spacing stay constant across toggles.
This keeps the pointer target stationary throughout the width animation, including
at 80–130% interface scale. Reduced-motion users receive no animation. One persisted
editor-wide `composerTabCollapsed` preference applies across every chat, provider,
environment and pane. Migrate either legacy tab's valid minimized choice when no
explicit shared choice exists, then persist only the new shared preference.

Review visibility still requires the exact selected Codex account and saved ready
session. Busy work hides its trigger without discarding a submitting dialog.
Provider/account/runtime changes invalidate the dialog, and the same native
permission disclosure, structured target validation and no-replay behavior apply.
No provider protocol, queue, permission or lifecycle changes are introduced.

Credential-free browser fixtures exercise the actual composer at narrow/wide
widths and both scale bounds, measure caret and frame positions throughout
repeated toggles, verify tooltip access and explicit option selection, and retain
provider/account ownership and dialog regressions. The full default suite and
forced desktop build remain required.
