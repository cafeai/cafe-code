import IntlMessageFormat, { type FormatXMLElementFn } from "intl-messageformat";
import japaneseCatalog from "./locales/ja.json" with { type: "json" };
import koreanCatalog from "./locales/ko.json" with { type: "json" };

/** English-source grammar remains the safe fallback, independently of the
 * user's presentation language. Only these reviewed bundled locales are
 * eligible; neither a setting nor a received provider value imports a catalog. */
export const UI_LOCALE = "en" as const;
export const UI_DIRECTION = "ltr" as const;
export type UiLocale = "en" | "ja" | "ko";
export type UiLanguagePreference = "system" | UiLocale;
export const UI_LOCALES = Object.freeze([
  Object.freeze({ locale: UI_LOCALE, direction: UI_DIRECTION, name: "English" }),
  Object.freeze({ locale: "ja" as const, direction: UI_DIRECTION, name: "日本語" }),
  Object.freeze({ locale: "ko" as const, direction: UI_DIRECTION, name: "한국어" }),
]);

/** Resolve only the primary system language, never a secondary preference.
 * A computer primarily in English with Japanese as an additional language
 * still defaults to English. Explicit choices always win, including English.
 * Unknown/malformed values cannot select an unbundled locale. */
export function resolveUiLocale(
  preference: unknown,
  systemLanguages: readonly string[] = [],
): UiLocale {
  if (preference === "en" || preference === "ja" || preference === "ko") return preference;
  const primary = systemLanguages[0];
  if (typeof primary !== "string" || primary.length > 128) return UI_LOCALE;
  try {
    const language = new Intl.Locale(primary).language;
    return language === "ja" || language === "ko" ? language : UI_LOCALE;
  } catch {
    return UI_LOCALE;
  }
}

export type UiDirection = "ltr" | "rtl";
export type UiMessageValue = string | number | boolean | Date | null | undefined;
export type UiMessageValues = Readonly<Record<string, UiMessageValue>>;
export type UiRichMessageValues<T> = Readonly<
  Record<string, UiMessageValue | T | FormatXMLElementFn<T>>
>;
export type UiMessageCatalog = Readonly<Record<string, string>>;

export interface UiTranslatorOptions {
  /** A locale belongs to this isolated instance; it cannot register a release. */
  readonly locale?: string;
  readonly direction?: UiDirection;
  /** Reviewed message data, never executable JavaScript or fetched HTML. */
  readonly catalog?: UiMessageCatalog;
  readonly maxCacheEntries?: number;
}

export interface UiTranslator {
  readonly locale: string;
  readonly direction: UiDirection;
  readonly text: (source: string, values?: UiMessageValues, context?: string) => string;
  readonly parts: <T>(
    source: string,
    values?: UiRichMessageValues<T>,
    context?: string,
  ) => readonly (string | T)[];
}

// A long-running chat cannot retain a new compiled pattern for every received
// token/name. Call sites and extraction require static Cafe-owned sources; this
// independent ceiling still prevents an accidental dynamic caller from growing
// the cache forever. Values and rendered output are never retained in a cache.
export const UI_MESSAGE_CACHE_LIMIT = 512;
const MAX_CACHE_ENTRIES = 1_024;
const MAX_CACHED_SOURCE_LENGTH = 16_384;
const FORMATTER_CACHE_LIMIT = 128;

class BoundedCache<T> {
  private readonly entries = new Map<string, T>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }
}

/** Gettext's context separator permits two identical English phrases to have
 * different meanings. Extraction rejects that control character in authored
 * sources/contexts, so it never creates an ambiguous catalog identity. */
export function uiMessageKey(source: string, context?: string): string {
  return context ? `${context}\u0004${source}` : source;
}

function canonicalLocale(locale: string | undefined): string {
  try {
    return locale ? (Intl.getCanonicalLocales(locale)[0] ?? UI_LOCALE) : UI_LOCALE;
  } catch {
    return UI_LOCALE;
  }
}

function cacheLimit(requested: number | undefined): number {
  return requested !== undefined && Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, MAX_CACHE_ENTRIES)
    : UI_MESSAGE_CACHE_LIMIT;
}

/** Read data properties only. Neither an inherited catalog entry nor a getter
 * is translation data, and neither may execute while the UI formats copy. */
function snapshotCatalog(catalog: UiMessageCatalog | undefined): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  if (!catalog) return result;
  try {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(catalog))) {
      if ("value" in descriptor && typeof descriptor.value === "string") {
        result.set(key, descriptor.value);
      }
    }
  } catch {
    // A malformed boundary value must not prevent the English interface from
    // opening. Do not log errors: formatter errors can contain private values.
    result.clear();
  }
  return result;
}

function isPlainMessage(source: string): boolean {
  // A doubled apostrophe is an ICU escape even without braces. Ordinary single
  // apostrophes are literal, so "Don't stop" need not allocate a parser/cache.
  return !/[{}<>]|''/.test(source);
}

/** Scalar arguments cannot introduce callbacks, prototypes or HTML. Dates are
 * copied to their numeric instant using the intrinsic (not an overridden
 * valueOf); ICU date/time expressions continue to format the same instant. */
function scalarValue(value: unknown): string | number | undefined {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return String(value);
  if (value instanceof Date) return Date.prototype.getTime.call(value);
  return undefined;
}

function copyValues<T>(
  values: UiRichMessageValues<T> | UiMessageValues | undefined,
  rich: boolean,
): Record<string, string | number | T | FormatXMLElementFn<T>> | undefined {
  if (!values) return undefined;
  const result: Record<string, string | number | T | FormatXMLElementFn<T>> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(values))) {
    if (!("value" in descriptor)) continue;
    const scalar = scalarValue(descriptor.value);
    if (scalar !== undefined) {
      result[key] = scalar;
    } else if (rich) {
      // Only the rich API accepts caller-owned nodes/functions. The catalog
      // can reference a named slot but cannot manufacture its element, href,
      // event handler or callback. React adapters must return escaped nodes.
      result[key] = descriptor.value;
    }
  }
  return result;
}

/** Create an isolated immutable translator. This is also the qualification
 * boundary for future reviewed catalogs; it does not enable a production
 * locale. Sources remain English ICU patterns and data is never reparsed as a
 * pattern. No eval, Function constructor, DOM mutation or HTML rendering occurs.
 * Rich callbacks are code-owned, pure render functions, not catalog content. */
export function createUiTranslator(options: UiTranslatorOptions = {}): UiTranslator {
  const locale = canonicalLocale(options.locale);
  const direction = options.direction === "rtl" ? "rtl" : "ltr";
  const catalog = snapshotCatalog(options.catalog);
  const compiled = new BoundedCache<IntlMessageFormat | null>(cacheLimit(options.maxCacheEntries));

  const format = <T>(
    pattern: string,
    formatLocale: string,
    values: UiRichMessageValues<T> | UiMessageValues | undefined,
    rich: boolean,
  ): readonly (string | T)[] | undefined => {
    if (isPlainMessage(pattern)) return [pattern];
    const key = JSON.stringify([rich, formatLocale, pattern]);
    let formatter = compiled.get(key);
    if (formatter === undefined) {
      try {
        // ignoreTag keeps scalar catalog text inert even if it contains angle
        // brackets. The rich path recognizes only ICU named tags, not HTML.
        formatter = new IntlMessageFormat(pattern, formatLocale, undefined, {
          ignoreTag: !rich,
        });
      } catch {
        formatter = null;
      }
      if (pattern.length <= MAX_CACHED_SOURCE_LENGTH) compiled.set(key, formatter);
    }
    if (!formatter) return undefined;
    try {
      return formatter.formatToParts<T>(copyValues(values, rich)).map((part) => part.value);
    } catch {
      return undefined;
    }
  };

  const parts = <T>(
    source: string,
    values?: UiRichMessageValues<T> | UiMessageValues,
    context?: string,
    rich = true,
  ): readonly (string | T)[] => {
    const translated = catalog.get(uiMessageKey(source, context));
    if (translated !== undefined) {
      const result = format(translated, locale, values, rich);
      if (result !== undefined) return result;
    }
    // Fallback grammar is English, not the missing/invalid target catalog's
    // plural grammar. Failed format errors are never surfaced with values.
    return format(source, UI_LOCALE, values, rich) ?? [source];
  };

  return Object.freeze({
    locale,
    direction,
    text: (source: string, values?: UiMessageValues, context?: string) =>
      parts<string>(source, values, context, false).join(""),
    parts: <T>(source: string, values?: UiRichMessageValues<T>, context?: string) =>
      parts<T>(source, values, context),
  });
}

const englishTranslator = createUiTranslator({ locale: UI_LOCALE, direction: UI_DIRECTION });
const releasedTranslators: Readonly<Record<UiLocale, UiTranslator>> = Object.freeze({
  en: englishTranslator,
  ja: createUiTranslator({ locale: "ja", catalog: japaneseCatalog }),
  ko: createUiTranslator({ locale: "ko", catalog: koreanCatalog }),
});
let activeLocale: UiLocale = UI_LOCALE;
const localeListeners = new Set<() => void>();

export function getUiLocale(): UiLocale {
  return activeLocale;
}

export function getUiDirection(): UiDirection {
  return UI_DIRECTION;
}

/** Stable per-locale identities let renderer hooks invalidate compiler/memo
 * caches without remounting chat trees or resetting their drafts/lifecycles. */
export function getUiTranslator(locale: UiLocale = activeLocale): UiTranslator {
  // A cast or malformed adapter must never resolve an inherited object member
  // such as `constructor` as a translator. Only our finite bundled keys count.
  return Object.hasOwn(releasedTranslators, locale)
    ? releasedTranslators[locale]
    : englishTranslator;
}

export function setUiLocale(locale: UiLocale): void {
  if (!Object.hasOwn(releasedTranslators, locale) || locale === activeLocale) return;
  activeLocale = locale;
  for (const listener of [...localeListeners]) listener();
}

export function subscribeUiLocale(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => localeListeners.delete(listener);
}

/** Code-owned static option arrays need lazy labels, not startup-language
 * strings. Only explicit source-authored zero-argument label factories acquire
 * getters; the array's canonical values/order and read-only tuple type remain
 * unchanged. This helper never processes received/user/provider metadata. */
export function uiLabelList<const T extends readonly unknown[]>(
  entries: T,
): { readonly [K in keyof T]: T[K] extends () => infer V ? V : T[K] } {
  const result = [...entries];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (typeof entry === "function") {
      Object.defineProperty(result, index, { enumerable: true, get: () => entry() });
    }
  }
  return Object.freeze(result) as {
    readonly [K in keyof T]: T[K] extends () => infer V ? V : T[K];
  };
}

/** Format Cafe-authored source copy only; provider/user text is argument data. */
export function uiText(
  source: string,
  values?: UiMessageValues,
  context?: string,
  locale: UiLocale = getUiLocale(),
): string {
  return getUiTranslator(locale).text(source, values, context);
}

/** Return escaped-text chunks plus explicitly caller-owned rich slots. This
 * function intentionally has no React dependency and never creates markup. */
export function uiMessageParts<T>(
  source: string,
  values?: UiRichMessageValues<T>,
  context?: string,
  locale: UiLocale = getUiLocale(),
): readonly (string | T)[] {
  return getUiTranslator(locale).parts(source, values, context);
}

const numberFormatters = new BoundedCache<Intl.NumberFormat>(FORMATTER_CACHE_LIMIT);
const dateTimeFormatters = new BoundedCache<Intl.DateTimeFormat>(FORMATTER_CACHE_LIMIT);
const listFormatters = new BoundedCache<Intl.ListFormat>(FORMATTER_CACHE_LIMIT);

function formatterKey(locale: string | undefined, options: object | undefined): string {
  return JSON.stringify([
    locale ?? null,
    options ? Object.entries(options).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : [],
  ]);
}

/** An omitted locale deliberately preserves the viewer's native Intl locale,
 * independently of the selected interface language. Caches retain only trusted
 * formatting configurations, never the displayed number/date or user text. */
export function uiFormatNumber(
  value: number | bigint,
  options?: Intl.NumberFormatOptions,
  locale?: string,
): string {
  try {
    const key = formatterKey(locale, options);
    let formatter = numberFormatters.get(key);
    if (!formatter) {
      formatter = new Intl.NumberFormat(locale, options);
      numberFormatters.set(key, formatter);
    }
    return formatter.format(value);
  } catch {
    return new Intl.NumberFormat().format(value);
  }
}

export function uiFormatDateTime(
  value: Date | number,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  try {
    const key = formatterKey(locale, options);
    let formatter = dateTimeFormatters.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(locale, options);
      dateTimeFormatters.set(key, formatter);
    }
    return formatter.format(value);
  } catch {
    try {
      return new Intl.DateTimeFormat().format(value);
    } catch {
      return "—";
    }
  }
}

/** List conjunctions are interface grammar, unlike viewer-native dates and
 * numbers. Use the selected interface language. Names remain inert argument data, and only formatter configurations
 * enter the independently bounded cache. */
export function uiFormatList(
  items: readonly string[],
  options?: Intl.ListFormatOptions,
  locale: string = getUiLocale(),
): string {
  try {
    const key = formatterKey(locale, options);
    let formatter = listFormatters.get(key);
    if (!formatter) {
      formatter = new Intl.ListFormat(locale, options);
      listFormatters.set(key, formatter);
    }
    return formatter.format(items);
  } catch {
    return new Intl.ListFormat(UI_LOCALE).format(items);
  }
}
