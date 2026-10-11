# Bundled English, Japanese and Korean interface release

Decision status: Accepted within the user's requested language implementation
Implementation status: Implemented; authorized publication requires repository qualification gates
Created: 2026-10-11 17:58:16 JST (UTC+0900)
Last updated: 2026-10-11 20:42:26 JST (UTC+0900)
Supersedes: the production-language gate of [interface readiness](interface-internationalization.md); its catalog/security/identity boundaries remain in force.

## Context and authority

The user now requests full assistant-authored Japanese and Korean translations,
a minimal Settings selector, automatic primary-system selection and a saved
explicit override. Publication was originally local-only. On
2026-10-11 20:42:26 JST (UTC+0900), the user's explicit all-outstanding dev push
request superseded that restriction; qualification must finish before delivery. The
accepted readiness ADR describes its earlier English-only decision accurately;
this successor records the newly authorized release instead of rewriting it.

## Decision

Bundle exactly `en`, `ja` and `ko`. Source/context keys remain English and ICU
contracts are immutable across catalogs; released Japanese/Korean catalogs
must cover every extracted key. Translators hand-author reviewed messages,
including full permission/recovery caveats, rather than calling a remote
translation service. Product names, commands, models, receipts, paths and
received prose remain data. Missing/malformed runtime data safely falls back to
English source grammar without exposing private formatter diagnostics.

Persist `languagePreference` through the existing client-settings store, with
`system` as the legacy/default value. Explicit English/Japanese/Korean wins
over system language, including after restart. For System default, inspect only
the primary preferred OS/browser language: `ja-*` selects Japanese, `ko-*`
Korean, all other/invalid/absent languages English. Secondary languages do not
override an English-primary computer. Never store the resolved language in
place of `system`; otherwise a changed system language would be ignored.

Language is presentation-only. Renderer subscriptions invalidate translated
render/memo/compiler caches while retaining component identity, drafts, chats,
provider sessions and Stop/retry authority. Code-owned static labels are lazy
and become locale-specific presentation snapshots; received objects never go
through that snapshot boundary. Main-process startup/menu/dialog/inert copy
uses the validated existing preference and OS language. Ordinary/restricted
renderers receive only finite read-only locale metadata/events; no provider,
filesystem, settings-write or desktop-control capability is added. Backend
request/subscriber language is explicit, never a mutable global shared among
owners. Date/time/currency formatting retains viewer-native Intl semantics.

Retained queue notices keep private volatile provenance separate from their
canonical English block/claim truth; persistence never stores a display token.
Native endpoint preferences retain stable receipts independently of translated
labels. Existing provider-update toast IDs/callbacks and delayed notification
admission are unchanged; only the delivered/rendered copy observes language.

The picker contains System default plus self-named English/日本語/한국어,
without flags, duplicated explanatory controls or a restart requirement.

## Alternatives and consequences

A full reload/remount could update stale copy but risks draft/lifecycle churn;
explicit render dependencies and metadata snapshots keep identity intact.
Generic DOM replacement or remote catalogs cannot distinguish user data and
are rejected. Resolving all secondary preferred languages would surprise an
English-primary system. Storing only a resolved locale loses explicit-vs-system
intent. OS-generated menu role children keep native OS spellings.

## Qualification

Require complete catalog/ICU coverage, translation review, explicit/system and
legacy/invalid resolution, persisted restart and reactive settings tests,
memoized table/helper/rich-slot updates, draft/action identity preservation,
narrow scaled light/dark layouts, native/inert isolated tests, unchanged full
repository/default/browser checks and forced desktop build LAST on unchanged
source. Native Windows/Linux CI remains distinct from local macOS evidence;
hosted qualification must bind the actual delivered language-release commit,
not an earlier feature's successful CI run.
