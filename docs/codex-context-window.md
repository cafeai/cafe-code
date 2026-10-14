# Codex context-window overrides

Status: Implemented; native account capacity and hosted release qualification are separate
Created: 2026-10-12 11:10:24 JST (UTC+0900)
Last updated: 2026-10-15 03:07:23 JST (UTC+0900)

For Codex chats, use **More composer controls → Context window…** beneath
Subagent limit… to save a custom token count. Blank or Reset removes the chat's
override. The setting is separate from model reasoning effort and is not sent
to Claude or other providers.

Codex provider settings also offer a default context-window override. The selected
chat's explicit value wins; otherwise the chat inherits its selected account's
current default, then Codex's own configuration/catalog. New chats do not copy
defaults into explicit overrides. Resetting a chat inherits the provider default;
clearing the provider default returns inherited chats to Codex's settings. Neither
action edits global Codex configuration or affects another account.

The Tasks/context details and pinned sidebar show the override beside the
subagent limit, including an inherited provider default. A compact current-to-saved
label shows a pending change when recorded session configuration is known; unknown
configuration is marked saved. Matching context with missing/different recorded
compaction-request evidence is also pending, not proof that the estimate applies.
Clearing a choice still retains a known current
override while a return to inheritance is pending. Further source/configuration
details live in the information tooltip rather than extra status rows.

The usage percentage, total processed and automatic-compaction description form
one compact related-fact group, matching the Primary Window's tighter spacing.
Beside a saved effective context override, a muted parenthetical estimates the
reviewed default total-scope compaction base: for example,
`Context override: 800K (~720K compaction)`. A lower explicit compaction request
from the same selected enabled Codex account lowers the estimate. Pending labels
still show current → saved; the parenthetical describes the saved value for the
next safe opening, not the currently running session. It disappears when the
final saved context choice is cleared, even if an old active value remains.

The information tooltip explains the approximation: native model caps, accounting
scope and buffers can differ. This is presentation only; it never changes the
native usage event, meter, provider request or saved preference. The same summary
is available in Tasks/context details, the pinned rail and context controls, with
viewer-language compact numbers.

Saving never interrupts current work. Changed configuration waits for a subsequent
send at a safe native idle boundary, including running agents and received events.
The immediately next send may be a steer that keeps the current configuration.
Unsupported or unknown runtime qualification refuses numeric intent while keeping
the unsent prompt available; the preference is not silently discarded.
Explicit numeric configuration requires the configured owner's reviewed stable
Codex runtime, 0.162.1 or newer, and both authenticated context and paired-compaction
capabilities from its actual Cafe owner. Older context-only daemons cannot qualify
the new policy. Reset can still
clear saved chat intent when the editor cannot apply a number.

The context meter continues to show Codex's reported usable window. It can differ
from the requested number because Codex owns model maximum clamping and reserved
headroom. An override cannot grant capacity unsupported by the model/account;
there is no universal 500k or 1m default.

An active context override also requests an auto-compaction limit using the same
nominal number, so a smaller fixed model/config threshold does not silently
defeat the larger-window choice. A separate **Auto-compact override** in provider
Settings takes precedence and can still compact earlier. With neither override,
Cafe omits both requests and lets Codex configuration/model defaults decide.
Resetting a chat still pairs an inherited provider context default; clearing the
final context choice removes only the derived request, not a separate compaction
setting. No global Codex config file is changed.

Cafe separately records the nominal automatic-compaction request after an actual
successful native opening. Missing older evidence stays unknown; it is not
backfilled from the saved 800K choice. At the next ordinary send, an older session
with the same context number but missing/different compaction policy is safely
retired/resumed only after the existing final root/children/ingress idle checks.
Steering ongoing work retains its current policy. An incompatible or uncertain
owner refuses new application instead of claiming success or restarting work.

If a pure configuration replacement is refused at the final native idle fence,
the existing exact owner can continue with its recorded policy while the saved
change stays pending. The same behavior now survives the authenticated daemon
boundary; it is not a relaxed idle guard or permission to retry paid input.
Unrelated restart requirements and unknown evidence still refuse. See
[finite reconfiguration refusals](decisions/provider-reconfiguration-refusal-transport.md).

Codex retains its native scope, context cap, margin and buffering. In the reviewed
version's default total scope, 800K nominal context permits a 720K base compaction
threshold even though a 5% reserve produces a 760K usable meter. That example is
not a measured account threshold or a universal promise about when it compacts.
The native token event does not report the resolved compaction threshold, and
Cafe does not substitute the requested number into the meter.

### Diagnosing unexpectedly early compaction

The local debug endpoint distinguishes actual-opening nominal request evidence
from an unreported native resolved threshold. Newly observed compactions carry
bounded same-source usage captured before their observed start, with separate
input, cached input, output, reasoning output, last total, lifetime total and
usable-window fields. Completion retains the original pre-start sample rather
than substituting post-compaction usage. Root and child observations remain
separate and require the exact current account and native runtime; older missing
records and evicted starts remain unknown. Root request evidence never proves a
child's effective inherited policy.

Reasoning can consume context capacity, but its reported count is not added again
to native total usage. Neither an early visible-meter value nor an 800K request
proves a 500K/720K effective threshold. Native reason, scope and resolved trigger
remain explicitly unreported until the provider supplies evidence. No history or
private content is read to manufacture them. Tracing becomes available after
normal rebuilt owner adoption; it does not retrofit old events or restart active
work. See [the observation decision](decisions/codex-compaction-observation-diagnostics.md).

Use the repository's normal rebuilt daemon/session adoption. Saving the preference
does not upgrade/install Codex or restart an active daemon. Native availability
and account-specific capacity are not established by synthetic tests.

See [the design and safety decision](decisions/codex-context-window-override.md),
its [compaction pairing successor](decisions/codex-context-compaction-pairing.md),
its [actual-opening adoption successor](decisions/codex-compaction-request-adoption.md),
and [Codex's configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
