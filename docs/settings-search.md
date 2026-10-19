# Settings search

The field at the top of the Settings sidebar finds settings by name, section,
synonym or provider account name. ⌘F (Ctrl+F on Windows/Linux) focuses it while
Settings is open; pressing it again in the field, or inside a dialog, falls
through to the browser's own find. The Keybindings page keeps ⌘F for its own
keybinding filter. The query persists while moving between Settings pages and
resets when you leave Settings.

## Behavior

- Results replace the sidebar menu, grouped under the menu item that owns each
  page. Matching text is bold; when only a synonym or the English name matched,
  it is shown after the section.
- ↑/↓ move the selection, Enter or a click opens it. Escape clears the query,
  a second Escape leaves the field, and a third leaves Settings as before.
- Opening a result navigates to its page, scrolls the setting to the middle,
  tints it with the accent for about 1.7 seconds (sections get an accent ring
  instead) and moves keyboard focus to the row's control. Clicking or scrolling
  the page ends the tint early. Page results simply open the page.
- Every entry is searched in the selected interface language and in English.

## Index

`apps/web/src/components/settings/settingsSearchIndex.ts` is a finite
Cafe-authored list. Each entry's `id` matches the `searchId` prop on the
`SettingsRow` or `SettingsSection` that renders it; provider account cards use
`provider:<instanceId>`. Titles and sections reuse the page's own copy.
Synonyms are one comma-separated message per entry in the
`settings search keywords` translation context.

When you add a Settings row worth finding, add an index entry and pass the same
id as `searchId`. A missing or not-yet-rendered anchor is not an error: landing
waits up to three seconds for a page's first data load, then leaves the page at
its top. Platform-only rows (Keep awake, HTTPS, global dictation) declare
`available` so they are not offered where they cannot render.

## Limits

- Values inside settings (for example a provider's models or a specific
  keybinding) are not searched; the Keybindings page keeps its own filter.
- Settings that live inside dialogs or collapsed rows are found through their
  section or page.
- At most 40 results are shown for a query.

Matching, ranking and grouping are pure (`settingsSearchMatching.ts`) and covered
by unit tests; typing, keyboard selection, landing, highlight, focus and Escape
are covered by `SettingsSearch.browser.tsx`.
