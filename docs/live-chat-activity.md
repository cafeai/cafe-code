# Live chat activity

Last updated: 2026-10-11 02:01:33 JST (UTC+0900)

The composer has one compact activity line above the editor. It shows Working,
Running command, a computer action, or waiting for a tool, agent, answer or
approval. Questions and approvals use the attention colour. When work is
inspectable, the line opens the existing Tasks popover or focuses its docked
rail. The Tasks control includes its active count.

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
