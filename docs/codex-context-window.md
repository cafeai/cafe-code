# Codex context-window overrides

Status: Implemented; native account capacity and hosted release qualification are separate
Created: 2026-10-12 11:10:24 JST (UTC+0900)
Last updated: 2026-10-13 15:54:01 JST (UTC+0900)

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
configuration is marked saved. Clearing a choice still retains a known current
override while a return to inheritance is pending. Further source/configuration
details live in the information tooltip rather than extra status rows.

Saving never interrupts current work. Changed configuration waits for a subsequent
send at a safe native idle boundary, including running agents and received events.
The immediately next send may be a steer that keeps the current configuration.
Unsupported or unknown runtime qualification refuses numeric intent while keeping
the unsent prompt available; the preference is not silently discarded.
Explicit numeric configuration requires the configured owner's reviewed stable
Codex runtime, 0.162.1 or newer, and its authenticated capability. Reset can still
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

Codex retains its native scope, context cap, margin and buffering. In the reviewed
version's default total scope, 800K nominal context permits a 720K base compaction
threshold even though a 5% reserve produces a 760K usable meter. That example is
not a measured account threshold or a universal promise about when it compacts.
The native token event does not report the resolved compaction threshold, and
Cafe does not substitute the requested number into the meter.

Use the repository's normal rebuilt daemon/session adoption. Saving the preference
does not upgrade/install Codex or restart an active daemon. Native availability
and account-specific capacity are not established by synthetic tests.

See [the design and safety decision](decisions/codex-context-window-override.md)
and its [compaction pairing successor](decisions/codex-context-compaction-pairing.md),
and [Codex's configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
