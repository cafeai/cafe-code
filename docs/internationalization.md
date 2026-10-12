# Interface internationalization

Cafe Code supports English, Japanese and Korean with bundled assistant-authored
catalogs. Settings → Appearance → Language is one compact selector: System
default, English, 日本語 or 한국어. The explicit choice is remembered; English
remains English after restart on a Japanese/Korean computer. System default
uses only the primary system language: Japanese/Korean select their respective
catalogs, every other language falls back to English. Conversations are not
translated. The [release decision](decisions/interface-language-release.md)
extends the [original readiness decision](decisions/interface-internationalization.md).

## Authoring complete messages

Use named, unaliased `uiText` imports from `@cafecode/shared/i18n`. Sources and
optional contexts must be static English ICU literals. Received values are
parameters, never message sources:

```tsx
uiText("Open {name}", { name: project.name });
uiText("{count, plural, one {# attachment} other {# attachments}}", { count });
uiText("Open", undefined, "editor action");
```

Keep complete sentences together, including counts, units and conditional words.
Do not concatenate translated fragments or lower-case a label to recover an ID.
Canonical statuses, commands and control branches stay unchanged; translate their
final display labels. Quote literal ICU braces/angles and double apostrophes when
necessary; see the upstream [ICU syntax reference](https://formatjs.github.io/docs/core-concepts/icu-syntax/).

For rich renderer copy, import `UiMessage` from `~/i18n` and pass captured,
code-owned nodes. A catalog can reorder slots, not create links or actions:

```tsx
<UiMessage
  message="Open <settings></settings> for {name}."
  values={{ name: project.name }}
  slots={{ settings: <a href={settingsPath}>{uiText("Settings")}</a> }}
/>
```

Keep links, callbacks, permissions and ownership in reviewed code. Never render
translated HTML, replace DOM text, or fetch translations from a service.
`uiFormatNumber` and `uiFormatDateTime` retain viewer-native `Intl` semantics
when their locale is omitted. `uiFormatList` defaults to the selected UI language
because list conjunctions are interface grammar. UI language does not replace
viewer-local timezone/currency/date/number preferences or provider prompts.

## Inventory and exclusions

Coverage includes renderer controls, Settings, accessibility, tooltips, empty
states, Cafe-authored errors, menus, notifications, task/queue/retry wrappers,
work-log display helpers, native prompts and inert startup/public copy. Finite
built-in provider field schemas are localized only at their display boundary;
received custom schemas and provider option/model names remain opaque. Work-log
events retain canonical persisted kinds/summaries and fold before display labels
are resolved. Cafe-authored native menu labels use the selected language;
OS-generated role children, Services, native pickers and permission chrome
remain OS-owned copy. Menu roles/shortcuts retain their native behavior.

Do **not** translate user/provider prose, plans, model/account names, paths,
code, Markdown source, terminal output, commands, protocol IDs, credentials,
raw diagnostic payloads, package identity or provider instructions. Raw errors
used for control flow stay canonical; finite Cafe-owned guidance/fallback text
shown to a person is localized. Strings never confer authorization, liveness,
retry admission or receipt identity.

Expandable raw diagnostic details (including the persisted provider-switch
`Cafe Code started this turn…` evidence) remain opaque received evidence, not
language-dependent event data. Their finite UI headings/summaries are localized;
this task does not rewrite or pattern-translate saved diagnostic bodies.

## Catalog workflow and guardrails

Use the repository-pinned Node/Corepack Yarn environment:

```sh
yarn fmt
yarn i18n:extract
yarn i18n:check
yarn lint
yarn typecheck
yarn test
yarn workspace @cafecode/web test:browser
yarn build:desktop --force
```

Run the forced desktop build last, after tests on unchanged source. Extraction
generates `packages/shared/src/locales/en.json` and `messages.json`; the latter
records locations/context. Formatting changes line numbers, so extract after
formatting. Catalog generation uses the repository's existing formatter and
verifies that formatting preserves JSON data before publication. Do not edit
generated catalogs manually. Extraction also regenerates
only owned locale/splash fields in `index.html` and locale/description fields in
`manifest.webmanifest` and its two finite language variants; scripts, URLs,
identity and launch policy stay unchanged. Before mounting, the selected locale
sets only the exact owned boot-shell accessible label and finite same-origin
manifest link. Unknown/external manifest targets are never replaced.
All sources are validated before generated outputs are written.

Optional future catalogs use canonical `Intl` locale filenames such as
`fr.json`. Checking rejects unknown source/context keys, non-string values,
malformed ICU and mismatched named values or rich tags. Partial catalogs are
allowed for unreleased English-fallback authoring catalogs; released `ja.json`
and `ko.json` must be present and complete, preserving ICU argument kinds,
selector branches, plural offsets and boundary whitespace. Extraction never
modifies hand-authored translations or enables arbitrary filenames as languages.

Catalog/public inputs must be unchanged regular files, not symlinks. The six
generated outputs use exclusive same-directory temporary files, rechecked file
and parent identity, then atomic rename. Publication uncertainty preserves the
temporary for inspection and reports no file contents. This is a trusted-checkout
generator guard, not a hostile-concurrent namespace compare-and-swap, native
file capability or atomic multi-file transaction.

Lint includes `i18n:check`: it rejects stale/missing catalogs, dynamic sources,
malformed ICU, missing/unexpected named parameters or slots, ambiguous context
separators, API aliasing/shadowing, rich prop spreads/duplicates, accessor arguments,
overlapping rich/scalar names and raw direct renderer display sinks. Simple
same-file presentation bindings are traced. TypeScript checks scalar/node types,
but there is **no generated compile-time semantic ICU argument type**. This
check is not whole-program information-flow analysis: indirect helpers, native
copy and new custom components require explicit inventory/review. Test/fixture
strings and protocol/diagnostic data are deliberately excluded. The optional
AST migration is a one-time source-editing aid, never a runtime transform; review
its diff and canonical fields.

## Runtime language delivery

Production keeps immutable English source fallback `UI_LOCALE = "en"` and
`UI_DIRECTION = "ltr"`; the finite registry is en/ja/ko. `getUiLocale()` reports
the selected language. The existing validated client settings store persists
`languagePreference: system | en | ja | ko`; old files decode as System default.
The preference belongs to the primary client, not its selected remote workspace.
Ordinary/auxiliary roots set `lang`/`dir` before mounting; main supplies finite
read-only metadata and current-locale events without adding settings authority
to restricted recording overlays. Native menus and inert startup documents
observe the same saved preference. Web push formats each authenticated recipient's
finite saved locale separately; a recipient never mutates the backend's global
language. A locale update reuses only an existing exact endpoint/key subscription
and cannot create a new subscription, ask permission or re-enable notifications.
English sources are the fallback. Compiled-message caches default to 512
entries (maximum 1024); independent formatter caches hold 128 configurations and
never retain user values or rendered output.

Renderer copy reads `useUiLocale()` and passes that finite token as the fourth
`uiText`/`uiMessageParts` argument. Trusted source-owned lazy label tables/pure
display helpers use `useUiPresentation`; its weak, three-locale keyed snapshots
invalidate React Compiler caches without remounting chats, resetting drafts or
restarting subscriptions/actions. Never wrap infrastructure, provider state,
actions or received data in this presentation helper. Retain finite Cafe feedback
codes/descriptors and translate at render; received errors remain opaque.
Retained queue feedback carries only a private volatile provenance token; its
English block reason and durable dispatch/claim projection remain canonical.
The token is never serialized, cloned tokens cannot translate, and replacing a
reason revokes its old display provenance. Provider-update notices render
locale-subscribed copy within the same toast ID and unchanged action callbacks.
Delayed desktop notifications resolve language only at already-admitted delivery.
Native endpoint copy refreshes only its read-only metadata after main admits a
locale event, without restarting authentication subscriptions. Manual endpoint
preference receipts preserve their earlier English-derived identity separately
from labels, so a language change cannot select a different connection URL.
`createUiTranslator` also supports isolated RTL/plural qualification, not arbitrary
production selection or loaded plugins. Catalogs are copied
own string data, never inherited entries, getters, executable code or HTML.
Missing/invalid translations fall back to English without logging private values.
React escapes interpolation; rich adapters accept captured code-owned nodes.
Formatting follows [IntlMessageFormat](https://formatjs.github.io/docs/intl-messageformat/).

The isolated browser fixture tests hostile interpolation, all Arabic plural
categories and narrow LTR/RTL theme/scale/reduced-motion examples. These are
readiness tests, not a complete Arabic translation or qualification of every
existing RTL layout. Local macOS evidence does not replace native Windows/Linux
CI or live desktop/provider qualification.
