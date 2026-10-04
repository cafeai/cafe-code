# Scheduled follow-ups

Scheduled follow-ups run instructions in an existing Cafe chat using **Codex, Claude, or Grok**. Open **Tasks → Scheduled → New follow-up**. The Tasks button is available even before the chat has a plan or subagents. Chats without a project are supported too.

You can also ask the model, for example, “Check this build every ten minutes.” Cafe automatically connects scheduling tools to each session, including separate account profiles. **No MCP installation is needed for chats inside Cafe.** Review the proposal in Tasks and the account that will execute and pay for it, then choose **Approve & enable**. Connectivity is automatic; recurring paid execution still needs your approval.

Saved follow-ups also appear as cards at the bottom of the conversation, even when Tasks is closed. Proposals are shown first with **Needs your approval** and **Won’t run until you approve**. Choose **Review schedule** to open the same review form used by Tasks, already filled with the saved instructions and timing. Opening a card does not approve, enable or run anything. You must still review the paying account and choose **Approve & enable** yourself.

The conversation shows three cards at a time, with controls to see the rest. These are live views of saved schedules, not permanent copies attached to an assistant message: approval, pauses, completion and deletion are reflected in both views. Saved proposals reappear after reopening the chat. Updates refresh approximately every 15 seconds while the view is visible and on reconnection; failed refreshes show last-known status rather than claiming it is current. Reading older messages does not force the conversation to scroll to a new proposal.

## Creating and managing a follow-up

Give the follow-up a short name and instructions explaining what to check and what counts as a meaningful change. Choose once, an interval of at least five minutes, daily, weekdays, weekly, or a custom calendar. Calendar rules use the selected IANA timezone; the next three occurrences are previewed before saving. One-time dates and optional end dates are explicitly entered in UTC. Custom weekday, month-day, and month selections are intersections, not alternatives.

By default, each run uses the chat's current model and settings on its saved provider profile. A same-profile model/settings override applies only to that follow-up, never to the chat's normal defaults. The profile is shown for review; scheduling preserves the chat's existing permission requirements. Switching the chat to another profile or permission mode requires reviewing and resuming the follow-up. Reconfiguring or signing into an existing profile still follows Cafe's ordinary provider configuration/authentication behavior; schedules do not pin immutable billing-account credentials.

Optional limits include an end date, maximum number of attempted runs, and permission to finish automatically when the requested goal is met. A failed or uncertain attempted submission counts toward the run limit. Finishing automatically is off unless you enable it.

Cards show the next run, recurrence/timezone, profile/model, and latest outcome. **Edit**, **Pause**, **Resume**, **Run now**, and **Delete** are explicit actions. **Delete** opens a confirmation: choose **Keep schedule** to cancel, or **Delete schedule** to stop future runs and remove the schedule from the list. Deletion does not interrupt an already accepted turn. The history view uses bounded pages rather than rendering every old run. Old completed results remain available while the schedule exists.

## Busy chats, closing Cafe, and restart

Schedules and run history live in Cafe's database, not the browser or window. Closing a Tasks panel, disconnecting a renderer, or restarting Cafe does not erase them. The backend owns the timer and resumes from durable records after startup. Missed recurring occurrences are coalesced into one catch-up run rather than replaying every missed interval.

Execution requires the owning backend to be running and the computer awake. On macOS, closing the Cafe window normally leaves that backend running. Explicitly quitting/stopping the backend or sleeping/shutting down the computer stops new execution until it is available again. This feature does not install an OS service or wake the computer. A saved remote environment runs schedules on its own backend, not on the viewer's computer.

If a chat is already working or awaiting approval/input, a follow-up waits. It never steers or interrupts an existing turn. Waiting past an end date does not authorize a late run. **Stop**, archive, and delete actions revoke future scheduled execution as part of the same durable control operation; reopening the chat does not silently resume paused schedules.

After a crash or missing provider acknowledgement, Cafe reconciles the exact recorded occurrence. An uncertain attempt is marked **Status unconfirmed / Needs attention**, not submitted again under a new ID. This intentionally favors avoiding duplicate external actions and charges over automatic retry. A normal known provider failure also needs review; the scheduler does not repeatedly restart failing work or impose a silence timeout on long reasoning/tool activity.

## Notifications and agent-created proposals

Choose notifications for every run, changes and errors, or errors only. Cafe reads a bounded structured result from the exact scheduled turn's final assistant message. A malformed/missing result cannot be treated as proof of “no changes.” Errors and uncertain completion are not concealed by quiet mode. If you steer a scheduled turn yourself, it is treated as user-directed work for notification purposes. Metadata is hidden from rendered Markdown but the original provider message is retained unchanged.

Agents using Cafe's MCP can **propose**, list, and pause follow-ups. A proposal is not active until you choose **Approve & enable** in Tasks. Changes proposed by an agent also need renewed approval. Internal connections are limited to the exact chat and account; switching accounts invalidates the old connection and requires reviewing existing schedules, even if you switch back before the next run. Normal session restart/resume connects the new account. Optional external management MCP uses its existing owner credentials and is not needed internally. Neither connection can enable/resume, run immediately, or submit another run's result using a public ID.

After updating Cafe, already-running old sessions may need normal rebuilt-runtime adoption and restart/resume to receive these tools. Cafe does not interrupt work to install them. Native provider tool-approval policies still apply; their permissions are never silently weakened.

## Operational limits

- At most 100 nondeleted schedules per chat, one unfinished occurrence per schedule, and one admitted scheduled turn per chat.
- Due, waiting, and reconciliation scans are bounded; busy chats do not block all other schedules.
- The scheduler checks approximately every 15 seconds while the backend is active. It is not a hard-real-time alarm.
- Model/catalog availability and native provider permissions remain authoritative. Creating a schedule does not change provider configuration or security approvals.
- No prompt, output, private provider configuration, or credentials are added to scheduler logs.

See [the architecture decision](decisions/scheduled-followups.md) for ownership, delivery guarantees, and verification boundaries.
