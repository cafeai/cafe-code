# Claude message delivery and task controls

## Message delivery

Selecting Claude in the composer shows the compact **Delivery · Automatic**
control inside the shared composer tools tab. It stays visible and dimmed when
the account's runtime capability is unavailable, the server is reconnecting, or a
message is being sent. Hover or focus the control for the reason. For a qualified
account, its popup offers Automatic, Now,
Next and Later; hover or focus an option for its explanation. The existing
model-options menu also keeps the same **Message delivery** choices when the
account supports them. Providers without tab controls, such as Grok, hide the tab.
The shared caret minimizes or restores every control in the tab at a fixed position
without moving the composer. One layout preference applies across all chats and
providers and survives navigation and reloads; delivery priority remains scoped
to the selected chat/account.
**Automatic** preserves the provider's existing behavior; Cafe does not assume
that omission is equivalent to one of the explicit choices.

- **Now:** asks Claude to incorporate your message into its current work. Supported
  foreground tools may move into the background.
- **Next:** asks for delivery at the next available boundary.
- **Later:** leaves the message behind higher-priority work. This is queue ordering,
  not a scheduled time or a promise about when execution will begin.

These choices do not approve tools or bypass a pending permission request. The
choice belongs to the individual message and survives Cafe's durable queue and
reconnect handling; input whose delivery is uncertain is not automatically sent
again. The unsent choice is scoped to the selected chat and account; switching
provider or account cannot carry it into a different selection. An already queued
message retains its captured account and priority. Priority cannot steer work
running under a different provider/account; that message uses Cafe's normal queue
instead. Scheduled follow-ups remain idle-only and cannot use urgent delivery.
If the bound turn ends or changes while preparing a priority message, Cafe rejects
that delivery rather than starting another turn or sending it to a replacement
session. Review the retained message before explicitly sending again.

The selector requires the configured Claude executable to report a qualified
version, not merely a recent SDK installed with Cafe. An unknown or unsupported
runtime keeps the existing default; explicitly submitted unsupported priorities
fail rather than silently pretending to work. Restart/resume normally after adopting
a rebuilt Cafe runtime to receive new session capabilities.

## Individual tasks

Open **Tasks** to see current ordinary provider tasks and foreground tools. The
list shows five rows per page. Subagents retain their existing task/detail view,
with the same individual controls in the selected subagent's detail.

- **Run in background** targets just the displayed foreground task or tool. It
  never means “background everything.” A provider that declines because the work
  is no longer foreground is reported honestly.
- **Stop task** targets one provider-issued native task. A foreground tool that
  has no native task identity can offer backgrounding, but does not pretend to
  have a safe individual Stop operation.
- **Stop chat** remains the existing, separate whole-chat control.

An accepted request is not proof that the task has finished. Cafe keeps waiting
for the provider's authoritative status update, leaving the parent and sibling
tasks alone. Native task lifecycle replaces a foreground tool's temporary control
reference when available. Completed, hidden, old-runtime and unverified tasks do
not retain controls. A task ID reused for new work gets a new control incarnation.

Controls are restricted to the owner and the exact chat, account, originating turn,
provider runtime and task incarnation. Attempts are durably recorded before native
I/O. A lost response or the 15-second acknowledgement deadline produces an uncertain
outcome; reconnecting or clicking again cannot silently repeat the mutation. This
deadline does not claim to cancel a control request already delivered to Claude.

Implementation, lifecycle safeguards and synthetic verification boundaries are
documented in [the task-control decision](decisions/provider-task-controls.md).
