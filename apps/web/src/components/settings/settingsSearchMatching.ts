import type { UiLocale } from "@cafecode/shared/i18n";

import type { SettingsSectionPath } from "./SettingsSidebarNav";

/**
 * Pure matching for the Settings sidebar search. Entries are a finite,
 * Cafe-authored index (settingsSearchIndex.ts) plus provider account names;
 * this module never reads the DOM, settings values or provider state.
 *
 * Every entry is searched in the selected interface language and in English,
 * so an English setting name still finds its row in a Japanese or Korean UI.
 */
export interface SettingsSearchEntry {
  /** Stable anchor id matching a `searchId` prop on the target row/section. */
  readonly id: string;
  /** Route that renders the anchor. */
  readonly path: SettingsSectionPath;
  /** Page entries name a whole Settings page and land at its top. */
  readonly kind: "page" | "setting";
  readonly title: (locale: UiLocale) => string;
  /** Section name shown under the title; omitted for untitled sections. */
  readonly section?: (locale: UiLocale) => string;
  /** Comma-separated extra words (synonyms) that should also find the entry. */
  readonly keywords?: (locale: UiLocale) => string;
}

export interface SettingsSearchRange {
  readonly start: number;
  readonly end: number;
}

export interface SettingsSearchResult {
  readonly entry: SettingsSearchEntry;
  readonly score: number;
  readonly title: string;
  readonly titleRanges: readonly SettingsSearchRange[];
  readonly section: string | null;
  readonly sectionRanges: readonly SettingsSearchRange[];
  /** The keyword or English name that matched when the shown title did not. */
  readonly alternate: string | null;
  readonly alternateRanges: readonly SettingsSearchRange[];
}

export interface SettingsSearchGroup {
  /** The sidebar menu item (its route) that owns these results. */
  readonly navPath: SettingsSectionPath;
  readonly results: readonly SettingsSearchResult[];
}

export interface SettingsSearchNavItem {
  readonly to: SettingsSectionPath;
  readonly activePaths?: ReadonlyArray<string>;
}

/** Bounded so a one-letter query never renders the whole index. */
export const SETTINGS_SEARCH_RESULT_LIMIT = 40;
/** Queries longer than this are truncated; no setting name is this long. */
const MAX_QUERY_LENGTH = 120;
const MAX_QUERY_TOKENS = 8;

interface FoldedText {
  readonly text: string;
  /** Original UTF-16 start/end for each folded UTF-16 unit. */
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

/**
 * Case-, width- and accent-insensitive form used for matching. NFKD folds
 * full-width Latin and compatibility characters; only Latin combining marks
 * are removed, so Japanese dakuten and Korean jamo stay distinct letters.
 * The index maps let highlights point back at the original string.
 */
export function foldSettingsSearchText(value: string): FoldedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const char of value) {
    const piece = char
      .normalize("NFKD")
      .replace(/[̀-ͯ]/gu, "")
      .toLowerCase();
    for (let unit = 0; unit < piece.length; unit++) {
      starts.push(index);
      ends.push(index + char.length);
    }
    text += piece;
    index += char.length;
  }
  return { text, starts, ends };
}

export function tokenizeSettingsSearchQuery(query: string): readonly string[] {
  const folded = foldSettingsSearchText(query.slice(0, MAX_QUERY_LENGTH)).text;
  const tokens: string[] = [];
  for (const token of folded.split(/\s+/u)) {
    if (token.length > 0 && !tokens.includes(token)) tokens.push(token);
    if (tokens.length === MAX_QUERY_TOKENS) break;
  }
  return tokens;
}

export function splitSettingsSearchKeywords(value: string): readonly string[] {
  return value
    .split(/[,、，]/u)
    .map((keyword) => keyword.trim())
    .filter((keyword) => keyword.length > 0);
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

interface Occurrence {
  readonly start: number;
  readonly fieldStart: boolean;
  readonly wordStart: boolean;
}

/** Prefer a word-start occurrence ("color" in "Accent color") over a mid-word one. */
function findOccurrence(folded: string, token: string): Occurrence | null {
  let first: number | null = null;
  let from = 0;
  while (from <= folded.length - token.length) {
    const start = folded.indexOf(token, from);
    if (start < 0) break;
    first ??= start;
    const previous = start === 0 ? "" : folded.charAt(start - 1);
    if (start === 0 || !WORD_CHARACTER.test(previous)) {
      return { start, fieldStart: start === 0, wordStart: true };
    }
    from = start + 1;
  }
  return first === null ? null : { start: first, fieldStart: false, wordStart: false };
}

function rangesFor(source: string, tokens: readonly string[]): SettingsSearchRange[] {
  const folded = foldSettingsSearchText(source);
  const ranges: SettingsSearchRange[] = [];
  for (const token of tokens) {
    const occurrence = findOccurrence(folded.text, token);
    if (!occurrence) continue;
    const startIndex = folded.starts[occurrence.start];
    const endIndex = folded.ends[occurrence.start + token.length - 1];
    if (startIndex === undefined || endIndex === undefined) continue;
    ranges.push({ start: startIndex, end: endIndex });
  }
  ranges.sort((left, right) => left.start - right.start);
  const merged: SettingsSearchRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** Fixed weights: titles outrank synonyms, which outrank section names. */
const WEIGHTS = {
  titleFieldStart: 6,
  titleWordStart: 5,
  title: 3,
  keywordWordStart: 3.5,
  keyword: 2,
  sectionWordStart: 2,
  section: 1,
} as const;
/** Matches only in the English fallback rank slightly below local ones. */
const FALLBACK_PENALTY = 0.5;

interface Field {
  readonly kind: "title" | "keyword" | "section";
  readonly source: string;
  readonly folded: string;
  readonly fallback: boolean;
}

function fieldScore(field: Field, occurrence: Occurrence): number {
  const base =
    field.kind === "title"
      ? occurrence.fieldStart
        ? WEIGHTS.titleFieldStart
        : occurrence.wordStart
          ? WEIGHTS.titleWordStart
          : WEIGHTS.title
      : field.kind === "keyword"
        ? occurrence.wordStart
          ? WEIGHTS.keywordWordStart
          : WEIGHTS.keyword
        : occurrence.wordStart
          ? WEIGHTS.sectionWordStart
          : WEIGHTS.section;
  return field.fallback ? base - FALLBACK_PENALTY : base;
}

function entryFields(entry: SettingsSearchEntry, locale: UiLocale) {
  const locales: UiLocale[] = locale === "en" ? ["en"] : [locale, "en"];
  const fields: Field[] = [];
  const seen = new Set<string>();
  const add = (kind: Field["kind"], source: string, fallback: boolean) => {
    const folded = foldSettingsSearchText(source).text;
    const key = `${kind}:${folded}`;
    if (folded.length === 0 || seen.has(key)) return;
    seen.add(key);
    fields.push({ kind, source, folded, fallback });
  };
  for (const fieldLocale of locales) {
    const fallback = fieldLocale !== locale;
    add("title", entry.title(fieldLocale), fallback);
    if (entry.section) add("section", entry.section(fieldLocale), fallback);
    if (entry.keywords) {
      for (const keyword of splitSettingsSearchKeywords(entry.keywords(fieldLocale))) {
        add("keyword", keyword, fallback);
      }
    }
  }
  return fields;
}

export function matchSettingsSearchEntry(
  entry: SettingsSearchEntry,
  tokens: readonly string[],
  locale: UiLocale,
): SettingsSearchResult | null {
  if (tokens.length === 0) return null;
  const fields = entryFields(entry, locale);
  let score = 0;
  for (const token of tokens) {
    let best = 0;
    for (const field of fields) {
      const occurrence = findOccurrence(field.folded, token);
      if (occurrence) best = Math.max(best, fieldScore(field, occurrence));
    }
    if (best === 0) return null;
    score += best;
  }

  const title = entry.title(locale);
  const foldedTitle = foldSettingsSearchText(title).text;
  const phrase = tokens.join(" ");
  if (foldedTitle === phrase) score += 6;
  else if (foldedTitle.startsWith(phrase)) score += 3;
  if (entry.kind === "page") score += 0.5;

  const titleRanges = rangesFor(title, tokens);
  const section = entry.section ? entry.section(locale) : null;
  // Bold the section only when it explains the match; repeating a bold
  // section under every title match (e.g. "sidebar") is noise.
  const sectionRanges = section && titleRanges.length === 0 ? rangesFor(section, tokens) : [];

  // When the shown title does not contain the query, show what did match
  // (a synonym or the English name) so the result never looks arbitrary.
  let alternate: string | null = null;
  let alternateRanges: SettingsSearchRange[] = [];
  if (titleRanges.length === 0) {
    let bestCount = 0;
    for (const field of fields) {
      if (field.kind === "section" || field.source === title) continue;
      const count = tokens.filter((token) => field.folded.includes(token)).length;
      if (count > bestCount) {
        bestCount = count;
        alternate = field.source;
      }
    }
    alternateRanges = alternate ? rangesFor(alternate, tokens) : [];
  }

  return {
    entry,
    score,
    title,
    titleRanges,
    section,
    sectionRanges,
    alternate,
    alternateRanges,
  };
}

function navPathFor(
  path: SettingsSectionPath,
  navItems: readonly SettingsSearchNavItem[],
): SettingsSectionPath {
  const owner = navItems.find(
    (item) => item.to === path || (item.activePaths?.includes(path) ?? false),
  );
  return owner?.to ?? path;
}

/**
 * Ranked results grouped under the sidebar menu item that owns their page.
 * Groups are ordered by their best result, then menu order; the flattened
 * group order is also the keyboard order.
 */
export function searchSettings(input: {
  readonly entries: readonly SettingsSearchEntry[];
  readonly query: string;
  readonly locale: UiLocale;
  readonly navItems: readonly SettingsSearchNavItem[];
  readonly limit?: number;
}): readonly SettingsSearchGroup[] {
  const tokens = tokenizeSettingsSearchQuery(input.query);
  if (tokens.length === 0) return [];
  const matches: Array<{ result: SettingsSearchResult; index: number }> = [];
  input.entries.forEach((entry, index) => {
    const result = matchSettingsSearchEntry(entry, tokens, input.locale);
    if (result) matches.push({ result, index });
  });
  matches.sort((left, right) => right.result.score - left.result.score || left.index - right.index);
  const limited = matches.slice(0, input.limit ?? SETTINGS_SEARCH_RESULT_LIMIT);

  const navOrder = new Map(input.navItems.map((item, index) => [item.to, index]));
  const groups = new Map<SettingsSectionPath, { best: number; results: SettingsSearchResult[] }>();
  for (const { result } of limited) {
    const navPath = navPathFor(result.entry.path, input.navItems);
    const group = groups.get(navPath);
    if (group) group.results.push(result);
    else groups.set(navPath, { best: result.score, results: [result] });
  }
  return [...groups.entries()]
    .toSorted(
      ([leftPath, left], [rightPath, right]) =>
        right.best - left.best ||
        (navOrder.get(leftPath) ?? Number.MAX_SAFE_INTEGER) -
          (navOrder.get(rightPath) ?? Number.MAX_SAFE_INTEGER),
    )
    .map(([navPath, group]) => ({ navPath, results: group.results }));
}
