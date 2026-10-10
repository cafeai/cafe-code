# Codex model settings and skills

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

## Daybreak

Open the composer model settings to choose **Daybreak · Off / On**. The control
appears only when the selected Codex account's model catalogue advertises Daybreak
for that model. Standard-only and older catalogues do not imply access.

**On** uses Daybreak Red when the account and model advertise Red, and Daybreak
Blue otherwise when Blue is supported. Switching between compatible models keeps
the saved choice On and resolves the program for the new model. **Off** explicitly
requests Standard. A model that accepts only Daybreak offers On; select a model
that supports Standard to turn it off. Opening the settings menu never enables
Daybreak. If an enabled choice loses its advertised support, sending fails with
guidance to refresh and choose a supported model or setting. The model settings
menu also offers **Turn unavailable Daybreak off** for a saved On choice after
access disappears; it does not offer On without advertised support.

The standalone Daybreak Blue/Red aliases are no longer selectable, including in
cached and custom model lists. Saved chats retain their existing model identity;
Cafe does not rewrite their history or silently replace their model.

Cafe persists this choice with the chat's existing model options and sends the
resolved `cyberAccessProgram` on ordinary Codex `turn/start` requests. Native
`daybreakEnabled` thread metadata is a preference, not turn routing authority;
Cafe does not synchronize its saved choice through that metadata. Native reviews
retain their session settings, and one-shot title/branch helpers do not expose
this turn-only control. Daybreak does not change Cafe's access or approval mode;
Codex remains responsible for authorization.

The public [Daybreak guide](https://developers.openai.com/api/docs/guides/daybreak)
explains why Red approval does not make Red valid for every model. API program
names use underscores; the Codex app-server protocol uses `standard`,
`daybreakBlue` and `daybreakRed`. The experimental turn field was qualified
against isolated schema exports from Codex 0.159.1 and 0.162.0 and is retained by
Cafe's local decoder without modifying the stable generated protocol pin.

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
