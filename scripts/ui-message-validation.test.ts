// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir } from "node:fs/promises";
// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fsPromises from "node:fs/promises";
import os from "node:os";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import {
  argumentNames,
  bindingNames,
  canonicalLocaleCatalogFilename,
  checkMessageArguments,
  directMessageApiName,
  messageApiBoundaryIssues,
  messageApiImports,
  messageContract,
  localeCatalogIssues,
  publishRegularRepositoryTextFile,
  readRegularLocaleCatalogFile,
  readRegularRepositoryTextFile,
} from "./ui-message-validation.ts";

// Keep native file reads/metadata/publication for isolated temporary fixtures.
// Metadata/rename are observable so one exact fixture-owned replacement or
// uncertain native failure can be injected without production test hooks.
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, lstat: vi.fn(original.lstat), rename: vi.fn(original.rename) };
});

function expression(code: string): ts.Expression {
  const file = ts.createSourceFile(
    "fixture.ts",
    `const value = ${code}`,
    ts.ScriptTarget.Latest,
    true,
  );
  return (file.statements[0] as ts.VariableStatement).declarationList.declarations[0]!.initializer!;
}
describe("static message contracts", () => {
  it("finds API names through nested object/array parameter destructuring", () => {
    const file = ts.createSourceFile(
      "fixture.ts",
      "function View({nested: [uiText, {UiMessage}]}) {}",
      ts.ScriptTarget.Latest,
      true,
    );
    const name = (file.statements[0] as ts.FunctionDeclaration).parameters[0]!.name;
    expect(bindingNames(name)).toEqual(["uiText", "UiMessage"]);
  });
  it("collects nested ICU plural/select/date and trusted rich slots", () => {
    const contract = messageContract(
      "{count, plural, one {<action>{when, date}</action>} other {{kind, select, ready {Ready} other {Wait}}}}",
    );
    expect([...contract.values].sort()).toEqual(["count", "kind", "when"]);
    expect([...contract.tags]).toEqual(["action"]);
  });
  it("rejects missing and extraneous placeholders instead of silent fallback", () => {
    expect(checkMessageArguments("Hi {name}", new Set())).toContain("missing: name");
    expect(checkMessageArguments("Hi", new Set(["name"]))).toContain("unexpected: name");
    expect(checkMessageArguments("Hi {name}", new Set(["name"]))).toBeUndefined();
  });
  it("does not evaluate received records, computed properties, spreads or duplicate arguments", () => {
    for (const value of [
      "received",
      "{...received}",
      "{[key]: value}",
      "{name: 1, name: 2}",
      '{get name(){throw new Error("must not execute")}}',
      '{set name(value){throw new Error("must not execute")}}',
      '{name(){throw new Error("must not execute")}}',
      '{"__proto__": null}',
    ])
      expect(argumentNames(expression(value))).toBeUndefined();
    expect([...argumentNames(expression('{name, "count": 1}'))!]).toEqual(["name", "count"]);
    expect([...argumentNames(expression("{action: (parts) => parts, __proto__}"))!]).toEqual([
      "action",
      "__proto__",
    ]);
  });

  function boundaryIssues(
    code: string,
    approved = new Set(["uiText", "uiMessageParts", "UiMessage"]),
  ) {
    const file = ts.createSourceFile(
      "fixture.tsx",
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    return messageApiBoundaryIssues(file, approved).map((issue) => issue.message);
  }

  it("admits exact named API imports and rejects namespace/import aliases without loading modules", () => {
    const parseImports = (code: string) =>
      messageApiImports(
        ts.createSourceFile("fixture.ts", code, ts.ScriptTarget.Latest, true),
        (specifier) => specifier === "@cafecode/shared/i18n" || specifier === "~/i18n",
      );
    const direct = parseImports(
      'import {uiText, uiMessageParts} from "@cafecode/shared/i18n"; import {UiMessage} from "~/i18n";',
    );
    expect([...direct.approvedNames]).toEqual(["uiText", "uiMessageParts", "UiMessage"]);
    expect(direct.issues).toEqual([]);
    expect(
      parseImports('import {uiText as translate} from "@cafecode/shared/i18n";').issues.map(
        (issue) => issue.message,
      ),
    ).toEqual(["message APIs cannot be aliased"]);
    expect(
      parseImports('import * as messages from "@cafecode/shared/i18n";').issues.map(
        (issue) => issue.message,
      ),
    ).toEqual(["use named unaliased i18n imports for static catalog validation"]);
    const unrelated = parseImports(
      'import {uiText} from "unrelated"; import Formatter from "formatter";',
    );
    expect([...unrelated.approvedNames]).toEqual([]);
    expect(unrelated.issues).toEqual([]);
  });

  it("admits only direct named calls, harmless callee parentheses and explicit rich props", () => {
    const code = `import {uiText, uiMessageParts} from "@cafecode/shared/i18n";
      import {UiMessage} from "~/i18n";
      uiText("Ready"); ((uiText))("Hi {name}", {name});
      uiMessageParts("<action>Open</action>", {action: (parts) => parts});
      const View=()=> <UiMessage message="Hi {name}<action></action>" values={{name}} slots={{action: <button/>}}/>;
      const Paired=()=> <UiMessage message="Ready"></UiMessage>;
      type MessageFunction = typeof uiText;`;
    expect(boundaryIssues(code)).toEqual([]);
    expect(directMessageApiName(expression("((uiText))"))).toBe("uiText");
    expect(directMessageApiName(expression("(uiText as Function)"))).toBeUndefined();
    expect(directMessageApiName(expression("object.uiText"))).toBeUndefined();
  });

  it("rejects escaped aliases, callbacks, objects, casts and direct component function calls", () => {
    for (const code of [
      "const translate=uiText; translate(received)",
      "const messages={uiText}; messages.uiText(received)",
      "register(uiText)",
      "(uiText as Function)(received)",
      "const Component=UiMessage; const View=()=> <Component {...received}/>",
      "UiMessage({message: received})",
      "const {uiText: translate}=received; translate(receivedSource)",
      'received["uiText"](receivedSource)',
    ])
      expect(boundaryIssues(code).length).toBeGreaterThan(0);
  });

  it("rejects missing approved imports and nested/destructured local API shadowing", () => {
    expect(boundaryIssues('uiText("Ready")', new Set())).toContain(
      "message API must be the approved named import",
    );
    for (const code of [
      "function View({nested: [uiText, {UiMessage}]}) {}",
      "const {nested: {uiMessageParts}}=received",
      "const View = function uiText(){}",
      "const View = class UiMessage{}",
    ])
      expect(boundaryIssues(code)).toContain("message APIs cannot be shadowed");
  });

  it("binds omitted context to the global undefined sentinel without evaluating source", () => {
    expect(boundaryIssues('uiText("Open", {}, undefined, locale)')).toEqual([]);
    for (const code of [
      'function View(undefined: string) { return uiText("Open", {}, undefined, locale); }',
      'function View({nested: [undefined]}) { return uiText("Open", {}, undefined, locale); }',
      'const {context: undefined} = received; uiText("Open", {}, undefined, locale);',
      'import {context as undefined} from "received"; uiText("Open", {}, undefined, locale);',
      'import undefined from "received"; uiText("Open", {}, undefined, locale);',
      'import * as undefined from "received"; uiText("Open", {}, undefined, locale);',
      'try {} catch (undefined) { uiText("Open", {}, undefined, locale); }',
    ])
      expect(boundaryIssues(code)).toContain(
        "message source cannot shadow the global undefined context sentinel",
      );
    // Unrelated source files have no message collector contract to establish.
    expect(boundaryIssues("function View(undefined: string) {}", new Set())).toEqual([]);
  });

  it("rejects all rich-prop spreads and duplicate attributes before catalog admission", () => {
    for (const code of [
      '<UiMessage message="Ready" {...received}/>',
      '<UiMessage {...received} message="Ready"/>',
      '<UiMessage message="Hi {name}" values={{name}} {...received}/>',
    ])
      expect(boundaryIssues(code)).toContain(
        "UiMessage props must be explicit; JSX spreads cannot establish a static contract",
      );
    expect(boundaryIssues('<UiMessage message="Ready" message={received}/>')).toContain(
      "UiMessage attributes cannot be duplicated",
    );
    expect(boundaryIssues('<UiMessage message="Ready" values={{}} values={received}/>')).toContain(
      "UiMessage attributes cannot be duplicated",
    );
    expect(
      boundaryIssues('<UiMessage message="Hi {name}" values={{name}} slots={{name: <b/>}}/>'),
    ).toContain("UiMessage values and slots cannot overlap");
    expect(
      boundaryIssues(
        '<UiMessage message="Hi {name}<action></action>" values={{name}} slots={{action: <b/>}}/>',
      ),
    ).toEqual([]);
  });

  it("does not reserve non-message constructors/imports or execute source expressions", () => {
    const code = `import MessageFormatter from "formatter";
      const Formatter=MessageFormatter; const constructors={MessageFormatter};
      new Formatter(received); constructors.MessageFormatter(received);
      const values={get name(){throw new Error("must not execute")}};`;
    expect(boundaryIssues(code)).toEqual([]);
  });
});

describe("optional bundled locale catalogs", () => {
  const english = new Map([
    ["Ready", "Ready"],
    ["greeting\u0004Hi {name}", "Hi {name}"],
    ["Open <action>{name}</action>", "Open <action>{name}</action>"],
    [
      "counted",
      "{count, plural, one {<action>{when, date}</action>} other {{kind, select, ready {Ready} other {Wait}}}}",
    ],
  ]);

  it("admits canonical Intl locale filenames without enabling a language", () => {
    for (const filename of ["fr.json", "en-US.json", "zh-Hant-TW.json", "de-DE-u-ca-gregory.json"])
      expect(canonicalLocaleCatalogFilename(filename)).toBe(filename.slice(0, -5));
    for (const filename of [
      "fr_FR.json",
      "FR.json",
      "en-us.json",
      "iw.json",
      "fr.JSON",
      "fr",
      ".json",
      "../fr.json",
      "folder/fr.json",
      "folder\\fr.json",
      "invalid_locale.json",
    ])
      expect(canonicalLocaleCatalogFilename(filename)).toBeUndefined();
  });

  it("allows partial catalogs and exact source/context identities without changing inputs", () => {
    const partial = { "greeting\u0004Hi {name}": "Bonjour {name}" };
    expect(localeCatalogIssues({}, english)).toEqual([]);
    expect(localeCatalogIssues({}, english, true)).toEqual([
      `released catalog is missing ${english.size} source entries`,
    ]);
    expect(localeCatalogIssues(Object.fromEntries(english), english, true)).toEqual([]);
    expect(localeCatalogIssues(partial, english)).toEqual([]);
    expect(partial).toEqual({ "greeting\u0004Hi {name}": "Bonjour {name}" });
    expect(localeCatalogIssues({ "Hi {name}": "Bonjour {name}" }, english)).toEqual([
      "entry 1: unknown generated source/context key",
    ]);
    expect(localeCatalogIssues({ "other\u0004Hi {name}": "Bonjour {name}" }, english)).toEqual([
      "entry 1: unknown generated source/context key",
    ]);
  });

  it("binds released catalogs to complete ICU controls and boundary whitespace", () => {
    const source = " {count, plural, offset:1 =0 {None} one {# task} other {# tasks}} ";
    const sources = new Map([[source, source]]);
    expect(
      localeCatalogIssues(
        { [source]: " {count, plural, offset:1 =0 {なし} one {#件} other {#件}} " },
        sources,
        true,
      ),
    ).toEqual([]);
    expect(
      localeCatalogIssues({ [source]: " {count, plural, one {#件} other {#件}} " }, sources, true),
    ).toContain("entry 1: released target ICU controls must match generated English");
    expect(localeCatalogIssues({ [source]: source.trim() }, sources, true)).toContain(
      "entry 1: released target boundary whitespace must match generated English",
    );
    const branching = "{choice, select, first {{amount, number}} other {{name}}}";
    expect(
      localeCatalogIssues(
        { [branching]: "{choice, select, first {{name}} other {{amount, number}}}" },
        new Map([[branching, branching]]),
        true,
      ),
    ).toContain("entry 1: released target ICU controls must match generated English");
    const currency = "{amount, number, ::currency/USD}";
    expect(
      localeCatalogIssues(
        { [currency]: "{amount, number, ::currency/EUR}" },
        new Map([[currency, currency]]),
        true,
      ),
    ).toContain("entry 1: released target ICU controls must match generated English");
    const pounds = "{count, plural, one {# task} other {# tasks}}";
    expect(
      localeCatalogIssues(
        { [pounds]: "{count, plural, one {Task} other {Tasks}}" },
        new Map([[pounds, pounds]]),
        true,
      ),
    ).toContain("entry 1: released target ICU controls must match generated English");
  });

  it("rejects non-object/non-string entries and accessors without invoking a getter", () => {
    for (const value of [null, [], "Ready", 4, true])
      expect(localeCatalogIssues(value, english)).toEqual([
        "catalog must be a JSON object of string entries",
      ]);
    for (const value of [null, 4, false, [], {}])
      expect(localeCatalogIssues({ Ready: value }, english)).toEqual([
        "entry 1: catalog value must be a string data property",
      ]);
    const getter = vi.fn(() => {
      throw new Error("must not run");
    });
    const candidate = Object.defineProperty({}, "Ready", { enumerable: true, get: getter });
    expect(localeCatalogIssues(candidate, english)).toEqual([
      "entry 1: catalog value must be a string data property",
    ]);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects malformed ICU and omitted/extra named values with content-free diagnostics", () => {
    expect(localeCatalogIssues({ "greeting\u0004Hi {name}": "secret target {" }, english)).toEqual([
      "entry 1: target ICU is invalid",
    ]);
    for (const target of ["Bonjour", "Bonjour {extra}", "Bonjour {name} {extra}"])
      expect(localeCatalogIssues({ "greeting\u0004Hi {name}": target }, english)).toEqual([
        "entry 1: target value names must exactly match generated English",
      ]);
    expect(
      localeCatalogIssues({ "private unknown key": "private target" }, english).join(" "),
    ).not.toContain("private");
  });

  it("keeps rich tags separate from scalar values even when their name union is unchanged", () => {
    const key = "Open <action>{name}</action>";
    expect(localeCatalogIssues({ [key]: "Ouvrir <action>{name}</action>" }, english)).toEqual([]);
    expect(localeCatalogIssues({ [key]: "Ouvrir {action}<name></name>" }, english)).toEqual([
      "entry 1: target value names must exactly match generated English",
      "entry 1: target rich-tag names must exactly match generated English",
    ]);
    expect(localeCatalogIssues({ [key]: "Ouvrir {name}" }, english)).toEqual([
      "entry 1: target rich-tag names must exactly match generated English",
    ]);
  });

  it("checks required names in every nested branch but makes no semantic type claim", () => {
    expect(
      localeCatalogIssues(
        { counted: "{count, plural, one {<action>{when}</action>} other {{kind}}}" },
        english,
      ),
    ).toEqual([]);
    expect(
      localeCatalogIssues(
        { counted: "{count, plural, one {{when, date}} other {{kind}}}" },
        english,
      ),
    ).toEqual(["entry 1: target rich-tag names must exactly match generated English"]);
    expect(
      localeCatalogIssues(
        { counted: "{count, plural, one {<action>{when}</action>} other {Ready}}" },
        english,
      ),
    ).toEqual(["entry 1: target value names must exactly match generated English"]);
  });
});

describe("repository catalog read and generated publication admission", () => {
  async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "cafe-i18n-catalog-"));
    try {
      await run(directory);
    } finally {
      vi.restoreAllMocks();
      vi.mocked(fsPromises.lstat).mockReset();
      vi.mocked(fsPromises.rename).mockReset();
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("reads only an exact unchanged regular catalog and rejects nonregular/foreign names", async () => {
    await fixture(async (directory) => {
      await writeFile(path.join(directory, "fr.json"), '{"Ready":"Prêt"}');
      const snapshot = await readRegularLocaleCatalogFile(directory, "fr.json");
      expect(snapshot.contents).toBe('{"Ready":"Prêt"}');
      expect(typeof snapshot.fileRevision.ino).toBe("bigint");
      await mkdir(path.join(directory, "de.json"));
      await expect(readRegularLocaleCatalogFile(directory, "de.json")).rejects.toThrow(
        "regular file",
      );
      await expect(readRegularLocaleCatalogFile(directory, "../fr.json")).rejects.toThrow(
        "canonical Intl locale",
      );
      await expect(readRegularLocaleCatalogFile(directory, "FR.json")).rejects.toThrow(
        "canonical Intl locale",
      );
      await expect(
        readRegularLocaleCatalogFile(directory, "fr.json", {
          dev: snapshot.directoryIdentity.dev,
          ino: snapshot.directoryIdentity.ino + 1n,
        }),
      ).rejects.toThrow("unchanged regular directory");
    });
  });

  it("rejects real directory links and never follows a generated output into its target", async () => {
    await fixture(async (directory) => {
      const privateDirectory = path.join(directory, "fixture-target");
      await mkdir(privateDirectory);
      const target = path.join(privateDirectory, "target.txt");
      await writeFile(target, "fixture-only private sentinel");
      // Windows directory junctions need no file-symlink privilege. POSIX
      // additionally qualifies an actual file link below; neither fixture
      // touches host profiles or changes production permission policy.
      await symlink(
        privateDirectory,
        path.join(directory, "fr.json"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(readRegularLocaleCatalogFile(directory, "fr.json")).rejects.toThrow(
        "regular file",
      );
      await expect(
        publishRegularRepositoryTextFile(directory, "fr.json", "replacement", null),
      ).rejects.toThrow("regular-file identity");
      if (process.platform !== "win32") {
        await symlink(target, path.join(directory, "de.json"), "file");
        await expect(readRegularLocaleCatalogFile(directory, "de.json")).rejects.toThrow(
          "regular file",
        );
        await expect(
          publishRegularRepositoryTextFile(directory, "de.json", "replacement", null),
        ).rejects.toThrow("regular-file identity");
      }
      expect(await readFile(target, "utf8")).toBe("fixture-only private sentinel");
    });
  });

  it("publishes exact generated outputs atomically while preserving future target catalogs", async () => {
    await fixture(async (directory) => {
      await writeFile(path.join(directory, "en.json"), "old English");
      await writeFile(path.join(directory, "fr.json"), "future target stays untouched");
      const english = await readRegularRepositoryTextFile(directory, "en.json");
      await publishRegularRepositoryTextFile(directory, "en.json", "new English", english);
      await publishRegularRepositoryTextFile(directory, "messages.json", "metadata", null);
      expect(await readFile(path.join(directory, "en.json"), "utf8")).toBe("new English");
      expect(await readFile(path.join(directory, "messages.json"), "utf8")).toBe("metadata");
      expect(await readFile(path.join(directory, "fr.json"), "utf8")).toBe(
        "future target stays untouched",
      );
      expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      await expect(
        publishRegularRepositoryTextFile(directory, "en.json", "stale English", english),
      ).rejects.toThrow("observed regular-file identity");
      expect(await readFile(path.join(directory, "en.json"), "utf8")).toBe("new English");
    });
  });

  it("preserves exclusive temporary evidence and sanitizes an uncertain rename failure", async () => {
    await fixture(async (directory) => {
      await writeFile(path.join(directory, "en.json"), "old English");
      const english = await readRegularRepositoryTextFile(directory, "en.json");
      vi.mocked(fsPromises.rename).mockRejectedValueOnce(
        new Error("arbitrary private native path"),
      );
      const result = await publishRegularRepositoryTextFile(
        directory,
        "en.json",
        "candidate English",
        english,
      ).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(
        /^generated output publication failed; inspect temporary \.en\.json\.i18n-[a-f0-9-]+\.tmp$/,
      );
      expect((result as Error).message).not.toContain("private");
      const temporary = (await readdir(directory)).filter(
        (name) => name.startsWith(".en.json.i18n-") && name.endsWith(".tmp"),
      );
      expect(temporary).toHaveLength(1);
      expect(await readFile(path.join(directory, temporary[0]!), "utf8")).toBe("candidate English");
      expect(await readFile(path.join(directory, "en.json"), "utf8")).toBe("old English");
    });
  });

  it("refuses an exact fixture-owned output change before rename and preserves temporary evidence", async () => {
    await fixture(async (directory) => {
      const destination = path.join(directory, "en.json");
      await writeFile(destination, "old English");
      const english = await readRegularRepositoryTextFile(directory, "en.json");
      const nativeLstat = vi.mocked(fsPromises.lstat).getMockImplementation()!;
      let outputObservations = 0;
      vi.mocked(fsPromises.lstat).mockImplementation((async (target, options) => {
        if (target === destination && ++outputObservations === 2)
          await writeFile(destination, "fixture-owned concurrent replacement");
        return nativeLstat(target, options);
      }) as typeof fsPromises.lstat);
      await expect(
        publishRegularRepositoryTextFile(directory, "en.json", "candidate English", english),
      ).rejects.toThrow("inspect temporary");
      expect(fsPromises.rename).not.toHaveBeenCalled();
      expect(await readFile(destination, "utf8")).toBe("fixture-owned concurrent replacement");
      const temporary = (await readdir(directory)).filter(
        (name) => name.startsWith(".en.json.i18n-") && name.endsWith(".tmp"),
      );
      expect(temporary).toHaveLength(1);
      expect(await readFile(path.join(directory, temporary[0]!), "utf8")).toBe("candidate English");
    });
  });
});
