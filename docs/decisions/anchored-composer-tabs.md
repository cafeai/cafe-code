# Anchored composer tabs

Status: Implemented under the user's request for compact delivery controls; minimized tabs now form a shallow lip with a lowered caret.

One generic **Composer tools** tab above the composer contains controls belonging
to the selected provider, currently Codex Code review. Claude message delivery
lives only in the existing extra-options menu.
Keep the tab visible whenever that provider has controls, including when their
actions are temporarily unavailable; providers without tab controls, such as Claude and Grok,
have no tab. Dim unavailable controls, keep their hover/focus explanation available,
and guard mouse and keyboard activation without relaxing action admission.
Each feature supplies
only its own control; neither owns a separate tab or collapse state. Render these
controls as independent children so future features can appear together in the
same container. The tab adapts to its contents, and the shared collapse preference
survives provider changes even when the selected provider has no tab. The Code
review options-menu shortcut shares the same controlled review dialog.

The extra-options menu lists Automatic,
Now, Next and Later, with explanations in hover/focus tooltips rather than inline
prose. Choosing an option never submits the composer. Automatic still means an
omitted priority; account/chat changes retain the existing reset and dispatch
binding rules.

Tabs collapse toward a fixed right edge. The minimized decoration is `0.625rem`
high, with about `0.375rem` exposed above the composer; its caret lowers into that
lip. The larger layout box, button hit area and reserved composer spacing stay
constant across toggles. The decoration alone animates its height, without
relaying out the editor or moving the pointer target, including at 80–130%
interface scale and with coarse pointers. Reduced-motion users receive no animation. One persisted
editor-wide `composerTabCollapsed` preference applies across every chat, provider,
environment and pane. Migrate either legacy tab's valid minimized choice when no
explicit shared choice exists, then persist only the new shared preference.

Preserve the original rounded tab outline, palette, typography and rise-in
animation. Draw the original curved ends separately from the flexible center so
longer controls do not stretch the corners or crowd their icons. Measure the
mounted controls to animate a numeric expanded width; hiding them with
`display: none` or switching to `width: max-content` must not make resizing jump.
Minimized controls are inert and hidden from accessibility while their geometry
remains available for measurement. Fade the contents and rotate the anchored
caret while lowering it during the width and decorative-height transitions.
The expanded decorative right edge extends by `0.375rem` beyond the layout box
to give the caret breathing room. Animate that extension back to zero when
minimized; the caret's button and the editor keep their original coordinates.

Queued and accepted steering messages join the composer as a full-width top
section, with square lower corners and a single divider above the typing area.
The tab anchors above the combined frame's upper-right edge, keeping its controls
clear of queue rows without reducing their width. An empty queue restores the
typing area's rounded top corners.

Review activation still requires the exact selected Codex account and saved ready
session. Busy work dims its trigger without discarding a submitting dialog.
Claude delivery choices require their advertised runtime capability and remain
disabled while sending or disconnected.
Provider/account/runtime changes invalidate the dialog, and the same native
permission disclosure, structured target validation and no-replay behavior apply.
No provider protocol, queue, permission or lifecycle changes are introduced.

Credential-free browser fixtures exercise the actual composer at narrow/wide
widths and both scale bounds, measure the stable hit area and frame throughout
repeated toggles, verify the minimized lip and lowered caret, require intermediate animated widths, capture both tab states
for visual inspection, verify tooltip access and explicit option selection, and retain
provider/account ownership and dialog regressions. The full default suite and
forced desktop build remain required.
