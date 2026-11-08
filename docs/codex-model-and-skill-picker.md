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

Fallback lists are startup guesses, not native account availability. Once the
current owner discovers a native catalogue, later same-account health checks
cannot add omitted static models back. Conclusive ChatGPT fallback omits retired
built-ins; API-key, unknown-account and explicit custom choices keep their own
policies. Saved choices are never silently substituted. Cached lists remain
historical presentation until a new owner establishes its own result. See
[catalogue provenance](decisions/codex-model-catalogue-provenance.md).

## Service tier

Open the composer model settings to choose **Service tier**. Cafe shows **Standard**
and the additional choices advertised for that exact Codex account and model.
For example, a model may expose Fast and Ultra fast as separate choices. Neither
name establishes a price or entitlement; the provider still decides what the
account is allowed to use.

Cafe never enables a paid tier simply because it appears first in a catalogue.
An unset tier defaults to Standard (Fast Off), even if native configuration or
the preceding turn used Fast. Cafe explicitly sends the provider's
standard-routing sentinel on ordinary openings and new turns.
Older saved Fast on/off settings retain the same Fast/Standard meaning, rather
than being upgraded to Ultra fast. No account or model preference is rewritten
merely by opening the menu.

Changing the composer does not change a running turn's routing during steering.
Native review and private guarded recovery keep their materialized/recorded
policy rather than adopting an unset composer choice. One-shot Codex metadata
helpers also default to Standard. See the [Standard-default decision](decisions/codex-standard-default.md).

The picker and native daemon can temporarily hold different catalogue formats.
An exact Fast choice (`priority`) also works when its owning model still exposes
the equivalent older Fast on/off control. This does not enable Fast for another
model/account or override a modern catalogue that explicitly removes it. Other
exact tiers still require the daemon owner's advertised capability. See
[legacy Fast parity](decisions/codex-legacy-fast-tier-parity.md).

If a saved tier is no longer advertised, Cafe keeps it visible as **Unavailable
service tier** and rejects its submission. Reopen the model picker to request a
catalogue refresh, then choose an available tier. Cafe will not silently substitute
another tier, model or account.
Accepted-turn work logs and Atrium cards show the frozen submitted tier. These
are settings records, not independent confirmation of effective routing or billing.

## Daybreak

Open the composer controls menu and find **Daybreak level** below **Access** and
above **Goal**. It offers **Off**, **Blue** and **Red** only when the selected
Codex account's model catalogue advertises each corresponding program. The
section is hidden without advertised Daybreak access; Standard-only and older
catalogues do not imply access.

**Off** explicitly requests Standard and remains the default on models that
support Standard. **Blue** and **Red** submit that exact level; selecting Blue
does not upgrade to Red when both are available. Switching models preserves the
saved level when the destination accepts it. If the destination cannot accept
that level and supports Standard, Cafe saves **Off** before sending. Returning to
a Daybreak-capable model keeps it Off until a level is selected again. Other
model options are retained. Existing saved Blue/Red options retain their recorded
program identity.

A model that accepts only Daybreak offers only its advertised levels and has no
implicit selection; select a Standard-capable model to turn Daybreak off. Opening
the menu never enables Daybreak. If access disappears entirely, the menu offers
**Turn unavailable Daybreak off** without offering unavailable levels.

The picker and provider daemon own separate model catalogues. An explicit Blue
or Red selection missing from the daemon's catalogue triggers one bounded
model-list refresh for that exact account before validation. The refreshed
catalogue must advertise the exact requested level before a session opens or a
turn is submitted. A removed level still refuses submission; other accounts,
model names and saved settings cannot supply access.

The standalone Daybreak Blue/Red aliases are no longer selectable, including in
cached and custom model lists. Saved chats retain their existing model identity;
Cafe does not rewrite their history or silently replace their model.

Cafe persists this choice with the chat's existing model options and sends the
selected `cyberAccessProgram` on ordinary Codex `turn/start` requests. Native
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
