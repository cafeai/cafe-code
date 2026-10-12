import IntlMessageFormat from "intl-messageformat";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  UI_DIRECTION,
  UI_LOCALE,
  UI_LOCALES,
  UI_MESSAGE_CACHE_LIMIT,
  createUiTranslator,
  getUiLocale,
  getUiTranslator,
  resolveUiLocale,
  setUiLocale,
  subscribeUiLocale,
  uiFormatDateTime,
  uiFormatList,
  uiFormatNumber,
  uiMessageKey,
  uiMessageParts,
  uiText,
} from "./i18n.ts";

afterEach(() => {
  setUiLocale("en");
  vi.restoreAllMocks();
});

describe("released interface messages", () => {
  it("exports immutable reviewed production metadata with English source fallback", () => {
    expect(UI_LOCALE).toBe("en");
    expect(UI_DIRECTION).toBe("ltr");
    expect(UI_LOCALES).toEqual([
      { locale: "en", direction: "ltr", name: "English" },
      { locale: "ja", direction: "ltr", name: "日本語" },
      { locale: "ko", direction: "ltr", name: "한국어" },
    ]);
    expect(Object.isFrozen(UI_LOCALES)).toBe(true);
    expect(Object.isFrozen(UI_LOCALES[0])).toBe(true);
  });

  it("resolves explicit choices before only the primary system language", () => {
    for (const system of [
      [],
      ["ja-JP"],
      ["ko-KR"],
      ["en-US", "ja-JP"],
      ["fr-FR"],
      ["bad_locale"],
    ]) {
      expect(resolveUiLocale("en", system)).toBe("en");
      expect(resolveUiLocale("ja", system)).toBe("ja");
      expect(resolveUiLocale("ko", system)).toBe("ko");
    }
    expect(resolveUiLocale("system", ["ja-JP"])).toBe("ja");
    expect(resolveUiLocale("system", ["ko-KR", "ja-JP"])).toBe("ko");
    expect(resolveUiLocale(undefined, ["JA-jp"])).toBe("ja");
    expect(resolveUiLocale("system", ["en-US", "ko-KR"])).toBe("en");
    expect(resolveUiLocale("system", ["fr-FR", "ja-JP"])).toBe("en");
    expect(resolveUiLocale("system", ["ja_ JP"])).toBe("en");
    expect(resolveUiLocale("system", ["ja".repeat(500)])).toBe("en");
  });

  it("publishes only real finite language changes and retires subscribers", () => {
    const changed = vi.fn();
    const stop = subscribeUiLocale(changed);
    const english = getUiTranslator();
    setUiLocale("ja");
    expect(getUiLocale()).toBe("ja");
    expect(getUiTranslator()).not.toBe(english);
    expect(uiText("Cancel")).toBe("キャンセル");
    setUiLocale("ja");
    expect(changed).toHaveBeenCalledTimes(1);
    setUiLocale("ko");
    expect(uiText("Cancel")).toBe("취소");
    expect(uiText("Cancel", undefined, undefined, "en")).toBe("Cancel");
    expect(getUiLocale()).toBe("ko");
    stop();
    setUiLocale("en");
    expect(changed).toHaveBeenCalledTimes(2);
    expect(getUiTranslator()).toBe(english);
  });

  it("rejects inherited or malformed translator keys without changing selection", () => {
    const english = getUiTranslator("en");
    for (const key of ["__proto__", "constructor", "toString", "fr", ""]) {
      const invalid = key as Parameters<typeof getUiTranslator>[0];
      expect(getUiTranslator(invalid)).toBe(english);
      setUiLocale(invalid!);
      expect(getUiLocale()).toBe("en");
      expect(uiText("Cancel", undefined, undefined, invalid)).toBe("Cancel");
    }
  });

  it("preserves plain copy, apostrophes, whitespace and literal angle text", () => {
    expect(uiText("Don't stop")).toBe("Don't stop");
    expect(uiText("  Earlier work\n")).toBe("  Earlier work\n");
    expect(uiText("Use <code>yarn test</code>")).toBe("Use <code>yarn test</code>");
  });

  it("applies ICU escapes even without parameters", () => {
    expect(uiText("Use '{name}' and ''quoted'' text")).toBe("Use {name} and 'quoted' text");
    expect(uiText("Show '<b>' literally")).toBe("Show <b> literally");
  });

  it("interpolates complete sentences without reparsing argument data", () => {
    const hostile = "<script>secret()</script>{count, plural, other{changed}}";
    expect(uiText("Rename {name}", { name: hostile })).toBe(`Rename ${hostile}`);
    expect(uiText("{first}: {second}", { first: "{second}", second: "original" })).toBe(
      "{second}: original",
    );
  });

  it("supports booleans, empty values and copied date instants", () => {
    expect(
      uiText("{yes}/{no}/{empty}/{missing}", {
        yes: true,
        no: false,
        empty: null,
        missing: undefined,
      }),
    ).toBe("true/false//");
    const instant = new Date("2026-10-11T12:00:00Z");
    const formatter = new Intl.DateTimeFormat("en", { dateStyle: "short" });
    expect(uiText("Date: {at, date, short}", { at: instant })).toBe(
      `Date: ${formatter.format(instant)}`,
    );
  });

  it("supports singular, plural, exact zero, select and ordinal grammar", () => {
    const pattern = "{count, plural, =0 {No agents} one {# agent} other {# agents}}";
    expect(uiText(pattern, { count: 0 })).toBe("No agents");
    expect(uiText(pattern, { count: 1 })).toBe("1 agent");
    expect(uiText(pattern, { count: 2 })).toBe("2 agents");
    expect(uiText("{state, select, running {Working} other {Idle}}", { state: "running" })).toBe(
      "Working",
    );
    expect(
      uiText("{state, select, running {Working} other {Idle}}", { state: "constructor" }),
    ).toBe("Idle");
    expect(uiText("{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}", { n: 23 })).toBe(
      "23rd",
    );
  });

  it("supports plural offsets and nested selects", () => {
    // Follow ICU's authoring guidance: a fixed select surrounds whole plural
    // sentences. A pound inside a nested select is literal in this ICU parser,
    // not a reference to an outer plural's adjusted number.
    const pattern =
      "{state, select, busy {{count, plural, offset:1 =0 {No agents} =1 {You} one {You and # agent} other {You and # busy agents}}} other {{count, plural, offset:1 =0 {No agents} =1 {You} one {You and # agent} other {You and # agents}}}}";
    expect(uiText(pattern, { count: 2, state: "busy" })).toBe("You and 1 agent");
    expect(uiText(pattern, { count: 4, state: "busy" })).toBe("You and 3 busy agents");
  });

  it("formats ICU number/date/time values using native Intl", () => {
    expect(uiText("Processed {count, number}", { count: 1234.5 })).toBe(
      `Processed ${new Intl.NumberFormat("en").format(1234.5)}`,
    );
    const instant = new Date("2026-10-11T12:34:56Z");
    expect(uiText("Time: {at, time, short}", { at: instant })).toBe(
      `Time: ${new Intl.DateTimeFormat("en", { hour: "numeric", minute: "numeric" }).format(instant)}`,
    );
  });

  it("fails closed to source copy without throwing or logging private values", () => {
    const error = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    expect(uiText("Malformed {")).toBe("Malformed {");
    expect(uiText("Hello {missing}", { unrelated: "private-name" })).toBe("Hello {missing}");
    expect(uiText("Date {at, date}", { at: new Date(Number.NaN) })).toBe("Date {at, date}");
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not call inherited/getter/function scalar arguments", () => {
    const getter = vi.fn(() => "private-name");
    const inherited = Object.create({ name: "inherited" });
    const accessor = Object.defineProperty({}, "name", { get: getter });
    expect(uiText("Hello {name}", inherited)).toBe("Hello {name}");
    expect(uiText("Hello {name}", accessor)).toBe("Hello {name}");
    const callback = vi.fn(() => "executed");
    // A corrupted input boundary must not grant scalar formatting the rich API.
    expect(uiText("Hello {name}", { name: callback } as never)).toBe("Hello {name}");
    expect(getter).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(uiText("Hello {toString}", {})).toBe("Hello {toString}");
  });

  it("fails safely on an unreadable argument boundary without exposing its exception", () => {
    const error = vi.spyOn(console, "error");
    const values = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("private-value");
        },
      },
    );
    expect(uiText("Hello {name}", values)).toBe("Hello {name}");
    expect(error).not.toHaveBeenCalled();
  });

  it("does not invoke an overridden Date valueOf or toString", () => {
    const instant = new Date("2026-10-11T12:00:00Z");
    const valueOf = vi.spyOn(instant, "valueOf").mockImplementation(() => {
      throw new Error("Must not execute");
    });
    const toString = vi.spyOn(instant, "toString").mockImplementation(() => {
      throw new Error("Must not execute");
    });
    expect(uiText("{at, date, short}", { at: instant })).toBe(
      new Intl.DateTimeFormat("en", { dateStyle: "short" }).format(
        Date.prototype.getTime.call(instant),
      ),
    );
    expect(valueOf).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
  });
});

describe("isolated bundled catalogs", () => {
  it("uses context-specific identities without borrowing another meaning", () => {
    expect(uiMessageKey("Open", "file-action")).toBe("file-action\u0004Open");
    const translator = createUiTranslator({
      locale: "de",
      catalog: { Open: "Offen", [uiMessageKey("Open", "file-action")]: "Öffnen" },
    });
    expect(translator.text("Open")).toBe("Offen");
    expect(translator.text("Open", undefined, "file-action")).toBe("Öffnen");
    expect(translator.text("Open", undefined, "untranslated-context")).toBe("Open");
    expect(uiText("Open")).toBe("Open");
  });

  it("keeps the registry unchanged when qualifying a future RTL plural catalog", () => {
    const source = "{count, plural, one {# agent} other {# agents}}";
    const translator = createUiTranslator({
      locale: "ar",
      direction: "rtl",
      catalog: {
        [source]:
          "{count, plural, zero {zero} one {one} two {two} few {few} many {many} other {other}}",
      },
    });
    expect(translator.direction).toBe("rtl");
    expect([0, 1, 2, 3, 11, 100].map((count) => translator.text(source, { count }))).toEqual([
      "zero",
      "one",
      "two",
      "few",
      "many",
      "other",
    ]);
    expect(UI_LOCALES).toHaveLength(3);
    expect(uiText(source, { count: 2 })).toBe("2 agents");
  });

  it("canonicalizes isolated locale metadata and rejects malformed locale spelling", () => {
    expect(createUiTranslator({ locale: "EN-us" }).locale).toBe("en-US");
    expect(createUiTranslator({ locale: "not_a_locale" }).locale).toBe("en");
    expect(Object.isFrozen(createUiTranslator())).toBe(true);
  });

  it("falls back with English grammar for missing or invalid translations", () => {
    const source = "{count, plural, one {# agent} other {# agents}}";
    const translator = createUiTranslator({ locale: "ru", catalog: { [source]: "Broken {" } });
    expect(translator.text(source, { count: 21 })).toBe("21 agents");
    expect(translator.text("Missing {name}", { name: "entry" })).toBe("Missing entry");
  });

  it("falls back if a translation expects an unavailable argument", () => {
    const translator = createUiTranslator({ catalog: { "Hello {name}": "Hello {other}" } });
    expect(translator.text("Hello {name}", { name: "reader" })).toBe("Hello reader");
  });

  it("snapshots only own string data and never executes catalog getters", () => {
    const getter = vi.fn(() => "secret");
    const catalog = Object.create({ Inherited: "wrong" });
    Object.defineProperty(catalog, "Getter", { get: getter, enumerable: true });
    catalog.Open = "Translated";
    catalog.Bad = () => "wrong";
    const translator = createUiTranslator({ catalog });
    catalog.Open = "Changed later";
    expect(translator.text("Open")).toBe("Translated");
    expect(translator.text("Inherited")).toBe("Inherited");
    expect(translator.text("Getter")).toBe("Getter");
    expect(translator.text("Bad")).toBe("Bad");
    expect(getter).not.toHaveBeenCalled();
  });

  it("keeps English usable if a supplied catalog cannot be enumerated", () => {
    const catalog = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("private-catalog-detail");
        },
      },
    );
    expect(createUiTranslator({ catalog }).text("Hello {name}", { name: "reader" })).toBe(
      "Hello reader",
    );
  });

  it("treats prototype-shaped own catalog and argument keys as inert data", () => {
    const catalog = Object.fromEntries([["__proto__", "Catalog text"]]);
    const translator = createUiTranslator({ catalog });
    expect(translator.text("__proto__")).toBe("Catalog text");
    expect(uiText("{__proto__}", Object.fromEntries([["__proto__", "Argument text"]]))).toBe(
      "Argument text",
    );
    expect({}.toString).toBe(Object.prototype.toString);
  });
});

describe("caller-owned rich content", () => {
  it("returns flat text and exact node identities without creating HTML", () => {
    const node = Object.freeze({ kind: "link", href: "https://example.test/reviewed" });
    const slot = vi.fn(() => node);
    expect(uiMessageParts("Read <slot></slot> for {name}.", { slot, name: "<reader>" })).toEqual([
      "Read ",
      node,
      " for <reader>.",
    ]);
    expect(slot).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("supports nested pure slots and translator-controlled sentence reordering", () => {
    type Node = { kind: string; children: Array<string | Node> };
    const source = "Read <link><bold>{name}</bold></link> now";
    const translator = createUiTranslator({
      locale: "de",
      catalog: { [source]: "Jetzt <link><bold>{name}</bold></link> lesen" },
    });
    const values = {
      name: "Guide",
      link: (children: Array<string | Node>): Node => ({ kind: "link", children }),
      bold: (children: Array<string | Node>): Node => ({ kind: "bold", children }),
    };
    expect(translator.parts<Node>(source, values)).toEqual([
      "Jetzt ",
      { kind: "link", children: [{ kind: "bold", children: ["Guide"] }] },
      " lesen",
    ]);
  });

  it("does not invent callbacks from markup, tag attributes or inherited values", () => {
    expect(uiMessageParts("<missing>Text</missing>")).toEqual(["<missing>Text</missing>"]);
    const slot = vi.fn(() => "trusted");
    expect(uiMessageParts('<slot href="javascript:bad">Text</slot>', { slot })).toEqual([
      '<slot href="javascript:bad">Text</slot>',
    ]);
    expect(uiMessageParts("<slot>Text</slot>", Object.create({ slot }))).toEqual([
      "<slot>Text</slot>",
    ]);
    expect(slot).not.toHaveBeenCalled();
  });

  it("keeps scalar markup literal and never runs a smuggled callback", () => {
    const callback = vi.fn(() => "executed");
    expect(uiText("<slot>Text</slot>", { slot: callback } as never)).toBe("<slot>Text</slot>");
    expect(callback).not.toHaveBeenCalled();
  });

  it("returns literal English source when a pure slot cannot render", () => {
    const callback = vi.fn(() => {
      throw new Error("Private component detail");
    });
    expect(uiMessageParts("<slot>Text</slot>", { slot: callback })).toEqual(["<slot>Text</slot>"]);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

describe("bounded formatting work", () => {
  it("formats empty, singleton and multi-name lists using English interface grammar", () => {
    for (const names of [[], ["Claude"], ["Claude", "OpenAI"], ["Claude", "OpenAI", "Grok"]]) {
      expect(uiFormatList(names)).toBe(new Intl.ListFormat("en").format(names));
    }
    expect(uiFormatList(["<script>inert</script>", "{name}"])).toBe(
      "<script>inert</script> and {name}",
    );
  });

  it("supports explicit list locales/options and fails back to English grammar", () => {
    const names = ["Claude", "OpenAI", "Grok"];
    const options = { style: "short", type: "disjunction" } as const;
    expect(uiFormatList(names, options, "de-DE")).toBe(
      new Intl.ListFormat("de-DE", options).format(names),
    );
    expect(uiFormatList(names, undefined, "bad_locale")).toBe(
      new Intl.ListFormat("en").format(names),
    );
    expect(uiFormatList(names, { type: "bad" } as never)).toBe(
      new Intl.ListFormat("en").format(names),
    );
  });

  it("reuses bounded list configurations rather than retaining displayed names", () => {
    const constructors = vi.spyOn(Intl, "ListFormat");
    const first = { style: "narrow", type: "unit" } as const;
    expect(uiFormatList(["first", "second"], first, "en-GB")).not.toContain("third");
    expect(
      uiFormatList(["third", "fourth"], { type: "unit", style: "narrow" }, "en-GB"),
    ).not.toContain("first");
    expect(constructors).toHaveBeenCalledTimes(1);
    for (let index = 1; index <= 128; index += 1) {
      uiFormatList(["one", "two"], first, `en-GB-x-c${index}`);
    }
    expect(constructors).toHaveBeenCalledTimes(129);
    uiFormatList(["changed", "names"], first, "en-GB-x-c128");
    expect(constructors).toHaveBeenCalledTimes(129);
    uiFormatList(["changed", "names"], first, "en-GB");
    expect(constructors).toHaveBeenCalledTimes(130);
  });

  it("skips compilation of plain messages and caches sources, not argument values", () => {
    const parse = vi.spyOn(IntlMessageFormat, "resolveLocale");
    const translator = createUiTranslator();
    expect(translator.text("Plain message")).toBe("Plain message");
    expect(parse).not.toHaveBeenCalled();
    expect(translator.text("Name {name}", { name: "first" })).toBe("Name first");
    expect(translator.text("Name {name}", { name: "second" })).toBe("Name second");
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("enforces LRU eviction without changing returned content", () => {
    const parse = vi.spyOn(IntlMessageFormat, "resolveLocale");
    const translator = createUiTranslator({ maxCacheEntries: 2 });
    translator.text("A {n}", { n: 1 });
    translator.text("B {n}", { n: 2 });
    translator.text("A {n}", { n: 3 });
    translator.text("C {n}", { n: 4 });
    expect(parse).toHaveBeenCalledTimes(3);
    expect(translator.text("A {n}", { n: 5 })).toBe("A 5");
    expect(parse).toHaveBeenCalledTimes(3);
    expect(translator.text("B {n}", { n: 6 })).toBe("B 6");
    expect(parse).toHaveBeenCalledTimes(4);
  });

  it("also bounds and caches parser failures", () => {
    const parse = vi.spyOn(IntlMessageFormat, "resolveLocale");
    const translator = createUiTranslator({ maxCacheEntries: 1 });
    translator.text("Broken {");
    translator.text("Broken {");
    expect(parse).toHaveBeenCalledTimes(1);
    translator.text("Other {n}", { n: 1 });
    translator.text("Broken {");
    expect(parse).toHaveBeenCalledTimes(3);
  });

  it("does not retain unexpectedly large patterns", () => {
    const parse = vi.spyOn(IntlMessageFormat, "resolveLocale");
    const translator = createUiTranslator();
    const pattern = `${"x".repeat(16_385)}{n}`;
    expect(translator.text(pattern, { n: 1 })).toBe(`${"x".repeat(16_385)}1`);
    translator.text(pattern, { n: 2 });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("uses the safe cache default for malformed requested budgets", () => {
    expect(UI_MESSAGE_CACHE_LIMIT).toBe(512);
    for (const maxCacheEntries of [0, -1, Number.NaN, 1.5]) {
      expect(createUiTranslator({ maxCacheEntries }).text("Value {n}", { n: 1 })).toBe("Value 1");
    }
  });

  it("clamps an excessive requested message-cache budget", () => {
    const compile = vi.spyOn(IntlMessageFormat, "resolveLocale");
    const translator = createUiTranslator({ maxCacheEntries: 10_000 });
    for (let index = 0; index < 1_025; index += 1) {
      expect(translator.text(`Static ${index} {n}`, { n: 1 })).toBe(`Static ${index} 1`);
    }
    expect(compile).toHaveBeenCalledTimes(1_025);
    expect(translator.text("Static 1024 {n}", { n: 2 })).toBe("Static 1024 2");
    expect(compile).toHaveBeenCalledTimes(1_025);
    expect(translator.text("Static 0 {n}", { n: 3 })).toBe("Static 0 3");
    expect(compile).toHaveBeenCalledTimes(1_026);
  });

  it("reuses numeric configurations despite option insertion order and changing values", () => {
    const constructors = vi.spyOn(Intl, "NumberFormat");
    const options = {
      notation: "engineering",
      minimumIntegerDigits: 7,
      maximumFractionDigits: 2,
    } as const;
    uiFormatNumber(1, options, "en-GB");
    uiFormatNumber(
      2,
      { maximumFractionDigits: 2, minimumIntegerDigits: 7, notation: "engineering" },
      "en-GB",
    );
    expect(constructors).toHaveBeenCalledTimes(1);
  });

  it("bounds numeric configuration caches independently of message instances", () => {
    const constructors = vi.spyOn(Intl, "NumberFormat");
    const configurations = Array.from({ length: 130 }, (_, index) => ({
      notation: "scientific" as const,
      minimumIntegerDigits: 1 + Math.floor(index / 21),
      maximumFractionDigits: index % 21,
    }));
    for (const options of configurations) uiFormatNumber(12.5, options, "en-GB");
    expect(constructors).toHaveBeenCalledTimes(130);
    uiFormatNumber(12.5, configurations[129], "en-GB");
    expect(constructors).toHaveBeenCalledTimes(130);
    uiFormatNumber(12.5, configurations[0], "en-GB");
    expect(constructors).toHaveBeenCalledTimes(131);
  });

  it("reuses date configurations without retaining their displayed instants", () => {
    const constructors = vi.spyOn(Intl, "DateTimeFormat");
    const options = { dateStyle: "full", timeZone: "UTC" } as const;
    const first = uiFormatDateTime(0, options, "en-GB");
    const second = uiFormatDateTime(86_400_000, { timeZone: "UTC", dateStyle: "full" }, "en-GB");
    expect(first).not.toBe(second);
    expect(constructors).toHaveBeenCalledTimes(1);
  });

  it("preserves native numeric/date formatting when no locale is supplied", () => {
    expect(uiFormatNumber(12345.67)).toBe(new Intl.NumberFormat().format(12345.67));
    expect(uiFormatNumber(12345n)).toBe(new Intl.NumberFormat().format(12345n));
    const instant = new Date("2026-10-11T12:34:56Z");
    const options = { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" } as const;
    expect(uiFormatDateTime(instant, options)).toBe(
      new Intl.DateTimeFormat(undefined, options).format(instant),
    );
    expect(uiFormatDateTime(instant.getTime(), options)).toBe(uiFormatDateTime(instant, options));
  });

  it("supports explicit reviewed formatting locales/options", () => {
    const options = { style: "currency", currency: "EUR" } as const;
    expect(uiFormatNumber(1234.5, options, "de-DE")).toBe(
      new Intl.NumberFormat("de-DE", options).format(1234.5),
    );
    const instant = new Date("2026-10-11T12:34:56Z");
    const dateOptions = { dateStyle: "short", timeZone: "UTC" } as const;
    expect(uiFormatDateTime(instant, dateOptions, "de-DE")).toBe(
      new Intl.DateTimeFormat("de-DE", dateOptions).format(instant),
    );
  });

  it("falls back to native formatting for invalid locales and neutral invalid dates", () => {
    expect(uiFormatNumber(2, undefined, "bad_locale")).toBe(new Intl.NumberFormat().format(2));
    const instant = new Date("2026-10-11T12:00:00Z");
    expect(uiFormatDateTime(instant, undefined, "bad_locale")).toBe(
      new Intl.DateTimeFormat().format(instant),
    );
    expect(uiFormatDateTime(new Date(Number.NaN))).toBe("—");
  });
});
