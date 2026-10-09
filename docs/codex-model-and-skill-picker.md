# Codex model settings and skills

## Account picker

The composer model picker scrolls its account-icon rail and model list
independently. Scroll over the left rail to reach additional accounts; keyboard
focus also reveals accounts below the visible area. Icons retain their normal
size, including in compact and provider-locked pickers. Small pickers still size
to their content rather than filling a fixed-height panel.

Scrolling does not select an account or model. Selecting an account previews its
models and returns focus to Search; only choosing a model commits that exact
account/model pair. Disabled accounts and locked continuation boundaries keep
their existing restrictions. Opening the picker retains the ordinary bounded
catalogue refresh; scrolling does not add provider requests.

## Service tier

Open the composer model settings to choose **Service tier**. Cafe shows **Standard**
and the additional choices advertised for that exact Codex account and model.
For example, a model may expose Fast and Ultra fast as separate choices. Neither
name establishes a price or entitlement; the provider still decides what the
account is allowed to use.

Cafe never enables a paid tier simply because it appears first in a catalogue.
An unchanged, omitted tier inherits native settings. Explicit Standard sends the
provider's standard-routing sentinel, so it can turn a previous Fast choice off.
Older saved Fast on/off settings retain the same Fast/Standard meaning, rather
than being upgraded to Ultra fast. No account or model preference is rewritten
merely by opening the menu.

If a saved tier is no longer advertised, Cafe keeps it visible as **Unavailable
service tier** and rejects its submission. Reopen the model picker to request a
catalogue refresh, then choose an available tier. Cafe will not silently substitute
another tier, model or account.
Accepted-turn work logs and Atrium cards show the frozen submitted tier. These
are settings records, not independent confirmation of effective routing or billing.

## Skill picker

Type `$` in the composer to discover enabled skills for the selected Codex account
and this chat's saved workspace. Typing more filters the result without starting
more metadata requests. Close and reopen the picker to refresh. Pick a skill to
insert its `$name` reference; Codex resolves and runs it only through the ordinary
prompt workflow, retaining its native permissions and behavior.

Selecting another account, chat, project or environment clears the old result.
Moving the workspace or changing the configured account also clears it even when
the chat and account labels stay the same. Ordinary status refreshes do not start
additional discovery requests.
Private skill paths and skill contents are not exposed in the picker. Discovery
does not start a model turn or run the skill. An unavailable result is distinct
from an empty list and offers retry guidance; a disabled/unauthenticated account
must first be enabled and signed in.

For a new project-root draft, Cafe uses the saved project root. A new worktree or
standalone workspace must first be created by normal chat startup; the picker
will not create one or borrow skills from another directory. Existing saved
worktree chats use their actual worktree directory.

Implementation boundaries and synthetic qualification are documented in
[skill discovery](decisions/codex-skill-discovery.md) and
[model service tiers](decisions/codex-model-service-tiers.md).
