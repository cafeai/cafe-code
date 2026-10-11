# English-only interface internationalization boundary

Decision status: Accepted within the requested interface-readiness implementation
Implementation status: Local integration; final qualification pending
Production-language gate superseded by: [Japanese/Korean language release](interface-language-release.md). The original rationale below is retained; catalog/security/identity decisions still apply.
Created: 2026-10-11 15:10:05 JST (UTC+0900)
Last updated: 2026-10-11 16:24:50 JST (UTC+0900)

## Context

Cafe-authored copy was spread across JSX, display helpers, native menus/dialogs,
backend notifications and inert startup documents. DOM replacement would miss
native/accessibility copy and could interpret received provider content as UI
text. The user requested complete future-language readiness while keeping
English, explicitly without a dev push.

## Decision

Use static English-source ICU messages, optional context, named scalar arguments
and code-owned rich slots. Share a pure Node/browser formatter without React;
renderer adapters create escaped text and captured nodes. Pin IntlMessageFormat
12.1.3 and extraction parser 3.5.21 in the existing Yarn lock rather than building
an incomplete ICU parser. No fetched/executable catalogs, automatic locale
detection or production language picker are introduced.

English remains the immutable sole production locale. Extract English and
source-location catalogs from approved static calls; add stale-catalog and
direct/limited-indirect renderer-copy checks to lint. Generate only owned static
boot/public fields. Keep native variants explicit and OS-generated role children
OS-owned. Bounded caches and immutable own-data catalog snapshots avoid retaining
received values; malformed/missing translations fall back without private logs.

Future bundled catalogs are checked without enabling languages: canonical locale
filenames, known source/context keys, string data and exact named value/rich-tag
parity. Read and generation tools refuse symlinks and stale file identity, publish
only four explicit outputs through exclusive temporaries and atomic rename, and
preserve uncertain evidence without printing contents. These trusted-checkout
guards are not native filesystem capabilities or hostile-concurrent namespace
compare-and-swap guarantees.

Localize finite Cafe labels at display boundaries. Preserve IDs, enums, commands,
error sentinels, work-log envelopes, receipts, provider options, received content
and security/lifecycle admission. Additive provider-switch display names are
presentation data only; canonical event validation stays authoritative. Omitted
date/number locales preserve viewer-native Intl, separately from English grammar.

## Alternatives and consequences

DOM replacement and runtime English-string guessing cannot reliably distinguish
private received text. A custom plural engine duplicates established ICU behavior.
A React-only framework would not cover native/shared/static delivery on its own.
English-source keys make migration reviewable; context disambiguates identical
phrases, and source changes intentionally invalidate catalog keys.

The static check validates source/argument/tag shape, not semantic ICU types or
arbitrary inter-module data flow. Manual indirect-copy review remains required;
diagnostics remain opaque. Runtime language switching and full-layout RTL
qualification require later language-release work. Presentation strings mint no
capabilities and change no provider/process/permission policy.

## Qualification

Isolated shared tests cover ICU/fallback/context, hostile arguments, own-data
admission and bounded caches. Browser tests cover inert rich slots, action
identity, narrow LTR/RTL, themes, scale and reduced motion. Migration tests protect
IDs/CSS/commands. Full default/browser suites and forced desktop build LAST are
required on unchanged source. Local Mac evidence does not qualify native
Windows/Linux. See [authoring and delivery](../internationalization.md).
