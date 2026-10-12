# Live chat activity

Last updated: 2026-10-12 15:11:00 JST (UTC+0900)

The composer has one compact activity line above the editor. It shows Working,
Running command, a computer action, or waiting for a tool, agent, answer or
approval. Questions and approvals use the attention colour. When work is
inspectable, the line opens the existing Tasks popover or focuses its docked
rail. The Tasks control includes its active count.

Hovering this line reveals the elapsed turn time beside the label with a small
horizontal expansion; keyboard focus reveals the same information. It collapses
on leaving the line or losing focus, and reduced motion removes the expansion.
The counter uses the exact current root-turn start, or the local dispatch start
while acceptance is pending. New commands, compaction and transport retries
within that turn do not reset it. A new accepted turn uses its own start.

Only the revealed counter ticks, without re-rendering the streaming composer or
announcing every second. Hidden documents pause it and catch up on return.
Completed roots, independently running background agents, recovery backoff,
idle connection preparation and rewind have no running-root counter. A locally
dispatched send includes its preparation/acceptance wait. Elapsed time
never reopens a turn or changes its Stop, send, retry or task controls.

The response-duration divider describes the main response. Independently active
native tasks and agents can outlive that response; the activity line then says
Background work running. Sidebar rows, project groups and Desk tabs use the
same accent spinner until that confirmed work settles. No second live timer is
added to the message list.

## Evidence and synchronization

`packages/shared/src/liveWork.ts` accepts structured task or tool observations
bound to the exact current native runtime. A completed, hidden, invalidated or
replaced observation does not remain active. Routine steer and turn-progress
messages do not count as independent work. Silence, elapsed time and saved
Working labels are never liveness evidence.

Migration 92 creates a small lifecycle-head projection and seeds existing
explicitly bound observations once. Activity ingestion updates it incrementally
inside the same transaction as the activity row. Shell snapshots read indexed
current-runtime counts rather than loading the transcript. A known zero count
clears stale local activity tails; missing evidence remains unknown. Connected
desktop and remote clients receive the same optional `liveWork` shell summary.
Detail snapshots also retain those indexed active lifecycle heads, so Tasks can
show a still-running job even after its start falls out of the recent transcript
tail. Completed heads no longer need that extra retention.

These fields affect presentation only. They do not reopen a finished turn,
change send/queue admission, grant task controls, or launch or probe a provider.
Individual controls still require their existing exact account, runtime and
generation binding. Read-only work remains visible when the composer selects
another account.

## Earlier Work logs

Recent command/tool activity stays inline in a bounded 500-row live window.
Eviction does not delete the saved log. A long current turn now has one compact
Earlier work disclosure at its first retained message; previous turns retain
their collapsed Work log rows, including when latest-turn metadata is absent.
Availability checks read indexed presence only. Activity pages download after
explicit expansion, not while scrolling or receiving message tokens.

Earlier work loads the nearest six saved rows, then24 at a time through Show
older. The opened range stays stable while live work arrives. Recent resets it
to the latest earlier range; at most 1000 raw rows remain in this reader. A plus
beside the visible count means more or omitted entries, not an exact lifetime
total. Received live operation snapshots replace stale history and prevent an
already-inline command from appearing twice. Subagents remain separate.

Failures appear inline with Retry, never a toast or automatic history loop.
Changing chats discards late responses. These reads cannot start, stop or
reopen a turn, confer task control, or change provider retry behavior. See
[the bounded history decision](decisions/bounded-work-log-history.md).

## Ordinary provider tasks

Provider retries and errors use the command row's expandable details style.
The closed row shows the saved agent identity/avatar (or Root/Agent not
recorded), a fixed retry/error label and native local date/time. Only explicit
expansion loads its private retained diagnostic JSON, origin and correlation
information. Known secrets are filtered before storage, and omissions or
truncation are stated; this is not untouched original wire JSON. Copy JSON and
Copy details are explicit actions. Legacy observations say details were not
recorded. No diagnostic read starts a provider or changes retry policy.
The private reader revalidates the exact owner session before lookup and before
returning bytes, so a retained socket cannot bypass session revocation or expiry.

Known provider errors remain indicated in collapsed Work log headers. A matching
durably represented root failure replaces the large duplicate error banner,
without clearing canonical errors or removing actionable recovery/authentication
feedback. See [the private diagnostic decision](decisions/private-provider-error-diagnostics.md).

Schedule refresh/disconnection messages and Refresh schedules appear only in
Tasks, not the main conversation. Saved follow-up notices remain in chat with
last-known state and their existing stale-action gates.

In both the Tasks popover and docked rail, ordinary Provider tasks appear last,
below Scheduled work. Workflows, active subagents and the checklist retain their
existing relative order above Scheduled work. Short-lived ordinary tasks can
appear and retire without moving those earlier sections or resetting the
schedule editor. A rail with Scheduled work does not insert a separate empty
task placeholder when an ordinary task retires.

Ordinary tasks use compact icon/title rows with their available individual
actions inline. While Claude is still streaming tool arguments, the exact empty
`Agent: {}` / `Task: {}` and `Bash: {}` placeholders appear as Agent task and
Shell command. Useful received descriptions and commands remain visible;
unknown tool names and literal braces in commands are not rewritten. Long
titles wrap within the card, including at larger interface sizes.

Labels use bounded existing public text, with invisible terminal/bidi controls
removed and markup rendered as inert text. Naming does not inspect additional
raw inputs, infer completion, grant controls or retry an uncertain action.
Workflow and subagent detail controls retain their existing footer placement.

## Computer use

The composer control shows Cua's rounded pointer silhouette and the visible
label Computer use. Its existing local Mac, provider and per-chat opt-in
requirements remain in effect.

Known Cafe native bridge actions get readable work-log descriptions, such as
Clicking / Clicked, Reading the window / Read the window, and Released computer
control. This also formats saved bridge tool names without rewriting history.
Unrelated MCP tools retain their normal presentation. Typed text, clipboard
contents, URLs, arguments and private bridge identifiers stay out of these
labels. An unfamiliar Cafe action uses Using the computer / Used the computer.

The pointer follows the bundled Cua default cursor artwork in
`libs/cua-driver/rust/crates/cursor-overlay/assets/cua.default.lottie`; Cafe's
existing Cua source pin and notices apply.
