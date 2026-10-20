import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstat, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parse } from "@formatjs/icu-messageformat-parser";
import { collectCopySites, migrateUiCopy } from "./ui-copy-ast.ts";
import {
  argumentNames,
  canonicalLocaleCatalogFilename,
  checkMessageArguments,
  directMessageApiName,
  localeCatalogIssues,
  messageApiBoundaryIssues,
  messageApiImports,
  publishRegularRepositoryTextFile,
  readRegularLocaleCatalogFile,
  readRegularRepositoryTextFile,
  type RepositoryTextSnapshot,
} from "./ui-message-validation.ts";
import { browserUiCopy } from "../packages/shared/src/browserUiCopy.ts";
import { formatGeneratedCatalogJson } from "./ui-catalog-format.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const roots = [
  "apps/web/src",
  "apps/desktop/src",
  "apps/server/src",
  "packages/shared/src",
  "scripts",
];
const excluded =
  /(?:\.(?:test|browser|e2e)\.|(?:BrowserTest|BrowserContext|ChatViewBrowser)|(?:^|\/)(?:test|fixtures)\/|(?:^|\/)i18n(?:\.|\/)|(?:^|\/)internationalization\.|(?:^|\/)ui-copy-ast\.|routeTree\.gen\.|\.d\.ts$)/;
const generated = "packages/shared/src/locales";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (["node_modules", "dist", "build", "target", ".git", "locales"].includes(entry.name))
      continue;
    const relative = path.posix.join(directory, entry.name);
    // Do not follow links or traverse outside the explicit repository roots.
    if (entry.isDirectory()) files.push(...(await sourceFiles(relative)));
    else if (entry.isFile() && /\.tsx?$/.test(relative) && !excluded.test(relative))
      files.push(relative);
  }
  return files.sort();
}

interface CatalogEntry {
  message: string;
  context?: string;
  locations: string[];
}
const mode = process.argv[2] ?? "--check";
if (!["--migrate", "--extract", "--check"].includes(mode))
  throw new Error("Use --migrate, --extract or --check");
const files = (await Promise.all(roots.map(sourceFiles))).flat().sort();
const selectedFiles = process.argv.slice(3);
if (selectedFiles.some((file) => !files.includes(file)))
  throw new Error("Migration targets must be exact inventoried production source paths");
if (mode === "--migrate") {
  let sites = 0;
  let changed = 0;
  for (const file of files.filter(
    (file) =>
      file.startsWith("apps/web/src/") &&
      file.endsWith(".tsx") &&
      (selectedFiles.length === 0 || selectedFiles.includes(file)),
  )) {
    const code = await readFile(path.join(root, file), "utf8");
    const result = migrateUiCopy(code, file);
    if (result.count) {
      // The one-time migration is a bulk AST-based mechanical rewrite, never a
      // runtime transform or DOM observer. Source edits remain reviewable.
      await writeFile(path.join(root, file), result.code);
      sites += result.count;
      changed++;
    }
  }
  Effect.runSync(
    Console.log(`Migrated ${sites} direct display sites in ${changed} renderer files.`),
  );
} else {
  const catalog = new Map<string, CatalogEntry>();
  const failures: string[] = [];
  for (const filename of files) {
    const code = await readFile(path.join(root, filename), "utf8");
    const file = ts.createSourceFile(
      filename,
      code,
      ts.ScriptTarget.Latest,
      true,
      filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const imports = messageApiImports(file, (module) => {
      const target = module.startsWith(".")
        ? path.resolve(root, path.dirname(filename), module).replace(/\.(?:tsx?|js)$/, "")
        : "";
      return (
        module === "@cafecode/shared/i18n" ||
        module === "~/i18n" ||
        [
          path.join(root, "packages/shared/src/i18n"),
          path.join(root, "apps/web/src/i18n"),
        ].includes(target)
      );
    });
    const approved = imports.approvedNames;
    function location(node: ts.Node): string {
      return `${filename}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
    }
    function add(
      node: ts.Node,
      message: ts.Expression | undefined,
      context?: ts.Expression,
      supplied?: Set<string>,
    ): void {
      if (
        !message ||
        !(ts.isStringLiteral(message) || ts.isNoSubstitutionTemplateLiteral(message))
      ) {
        failures.push(
          `${location(node)}: translation source must be a static literal, never received data`,
        );
        return;
      }
      // Explicit no-context is needed when a fourth finite locale argument is
      // supplied. Accept only this exact spelling, never evaluated expressions.
      if (
        context &&
        !ts.isStringLiteral(context) &&
        !(ts.isIdentifier(context) && context.text === "undefined")
      ) {
        failures.push(`${location(node)}: context must be a static literal`);
        return;
      }
      try {
        parse(message.text);
        const contractError = checkMessageArguments(message.text, supplied);
        if (contractError) {
          failures.push(`${location(node)}: ${contractError}`);
          return;
        }
      } catch (error) {
        failures.push(
          `${location(node)}: invalid ICU message (${error instanceof Error ? error.message : "syntax"})`,
        );
        return;
      }
      const contextText = context && ts.isStringLiteral(context) ? context.text : undefined;
      if (message.text.includes("\u0004") || contextText?.includes("\u0004")) {
        failures.push(
          `${location(node)}: source/context cannot contain the catalog identity separator`,
        );
        return;
      }
      const key = contextText ? contextText + "\u0004" + message.text : message.text;
      const entry = catalog.get(key) ?? {
        message: message.text,
        ...(contextText ? { context: contextText } : {}),
        locations: [],
      };
      entry.locations.push(location(node));
      catalog.set(key, entry);
    }
    function visit(node: ts.Node): void {
      const callName = ts.isCallExpression(node)
        ? directMessageApiName(node.expression)
        : undefined;
      if (
        ts.isCallExpression(node) &&
        callName !== undefined &&
        ["uiText", "uiMessageParts"].includes(callName)
      ) {
        add(node, node.arguments[0], node.arguments[2], argumentNames(node.arguments[1]));
      } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (node.tagName.getText(file) === "UiMessage") {
          if (!approved.has("UiMessage"))
            failures.push(`${location(node)}: UiMessage must be the approved named import`);
          const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
          const attributeValue = (name: string): ts.Expression | undefined => {
            const value = attributes.find(
              (attribute) => attribute.name.getText(file) === name,
            )?.initializer;
            return value && ts.isJsxExpression(value)
              ? value.expression
              : value && ts.isStringLiteral(value)
                ? value
                : undefined;
          };
          const values = argumentNames(attributeValue("values"));
          const slots = argumentNames(attributeValue("slots"));
          add(
            node,
            attributeValue("message"),
            attributeValue("context"),
            values && slots ? new Set([...values, ...slots]) : undefined,
          );
        }
      }
      ts.forEachChild(node, visit);
    }
    for (const issue of [...imports.issues, ...messageApiBoundaryIssues(file, approved)])
      failures.push(`${location(issue.node)}: ${issue.message}`);
    visit(file);
    // Native/shared/server copy is classified at explicit view construction
    // boundaries. Raw protocol error/log literals are not renderer copy.
    if (filename.startsWith("apps/web/src/") && filename.endsWith(".tsx")) {
      for (const site of collectCopySites(file, true)) {
        failures.push(
          `${filename}:${file.getLineAndCharacterOfPosition(site.start).line + 1}: unlocalized ${site.kind} ${JSON.stringify(site.source)}`,
        );
      }
    }
  }
  // Optional bundled translations are build inputs only. Discover no paths
  // outside this exact source-owned directory, and never register a language
  // or overwrite a supplied target catalog during English extraction.
  const catalogDirectory = path.join(root, generated);
  const catalogSnapshots = new Map<string, RepositoryTextSnapshot>();
  const englishSources = new Map([...catalog].map(([key, entry]) => [key, entry.message]));
  let catalogParent = null;
  try {
    catalogParent = await lstat(catalogDirectory, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      failures.push(`${generated}: catalog directory cannot be inspected`);
  }
  if (catalogParent && (!catalogParent.isDirectory() || catalogParent.isSymbolicLink())) {
    failures.push(`${generated}: catalog directory must be a regular directory, never a symlink`);
  } else if (catalogParent) {
    const names: string[] = await readdir(catalogDirectory).catch((): string[] => {
      failures.push(`${generated}: catalog directory cannot be read`);
      return [];
    });
    if (mode === "--check") {
      for (const released of ["ja.json", "ko.json"]) {
        if (!names.includes(released)) failures.push(`${generated}: released catalog is absent`);
      }
    }
    for (const filename of names.sort().filter((name) => /\.json$/i.test(name))) {
      const generatedOutput = filename === "en.json" || filename === "messages.json";
      if (!generatedOutput && !canonicalLocaleCatalogFilename(filename)) {
        // Invalid names can contain control characters or arbitrary text.
        // Report only the reason, not an unadmitted directory-entry spelling.
        failures.push(`${generated}: catalog filename must be a canonical Intl locale plus .json`);
        continue;
      }
      let snapshot: RepositoryTextSnapshot;
      try {
        snapshot = await readRegularLocaleCatalogFile(catalogDirectory, filename, catalogParent);
        catalogSnapshots.set(filename, snapshot);
      } catch {
        failures.push(
          `${generated}/${filename}: catalog must remain a readable regular file, never a symlink`,
        );
        continue;
      }
      if (generatedOutput) continue;
      let target: unknown;
      try {
        target = JSON.parse(snapshot.contents);
      } catch {
        failures.push(`${generated}/${filename}: catalog JSON is invalid`);
        continue;
      }
      for (const issue of localeCatalogIssues(
        target,
        englishSources,
        mode === "--check" && (filename === "ja.json" || filename === "ko.json"),
      ))
        failures.push(`${generated}/${filename}: ${issue}`);
    }
  }
  // Only owned presentation fields are regenerated. Keep scripts, deployment
  // URLs, product identity, authentication and manifest launch policy unchanged.
  const publicCopy = browserUiCopy();
  const htmlPath = path.join(root, "apps/web/index.html");
  const publicSnapshot = async (output: string): Promise<RepositoryTextSnapshot | null> => {
    try {
      return await readRegularRepositoryTextFile(path.dirname(output), path.basename(output));
    } catch {
      failures.push(
        `${path.relative(root, output)}: public output must remain a readable regular file, never a symlink`,
      );
      return null;
    }
  };
  const htmlSnapshot = await publicSnapshot(htmlPath);
  const html = htmlSnapshot?.contents ?? "";
  const escapeAttribute = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  if (
    (html.match(/<html lang="[^"]*"(?: dir="[^"]*")?>/g)?.length ?? 0) !== 1 ||
    (html.match(/<div id="boot-shell-card" aria-label="[^"]*">/g)?.length ?? 0) !== 1
  )
    failures.push("Public startup HTML must retain one exact locale/splash-copy generation target");
  const expectedHtml = html
    .replace(
      /<html lang="[^"]*"(?: dir="[^"]*")?>/,
      () => `<html lang="${publicCopy.locale}" dir="${publicCopy.direction}">`,
    )
    .replace(
      /(<div id="boot-shell-card" aria-label=")[^"]*(">)/,
      (_, start: string, end: string) => start + escapeAttribute(publicCopy.splashLabel) + end,
    );
  const manifestPath = path.join(root, "apps/web/public/manifest.webmanifest");
  const manifestSnapshot = await publicSnapshot(manifestPath);
  let manifest: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(manifestSnapshot?.contents ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("manifest object required");
    manifest = parsed as Record<string, unknown>;
  } catch {
    failures.push("apps/web/public/manifest.webmanifest: public manifest JSON object is invalid");
  }
  if (
    mode !== "--extract" &&
    (html !== expectedHtml ||
      manifest.lang !== publicCopy.locale ||
      manifest.dir !== publicCopy.direction ||
      manifest.description !== publicCopy.manifestDescription)
  ) {
    failures.push("Public startup HTML/manifest locale copy is stale; run yarn i18n:extract");
  }
  const localizedManifests: {
    output: string;
    contents: string;
    snapshot: RepositoryTextSnapshot | null;
  }[] = [];
  for (const locale of ["ja", "ko"] as const) {
    const output = path.join(root, `apps/web/public/manifest.${locale}.webmanifest`);
    const snapshot = await publicSnapshot(output);
    const copy = browserUiCopy(locale);
    const contents =
      JSON.stringify(
        { ...manifest, lang: locale, dir: copy.direction, description: copy.manifestDescription },
        null,
        2,
      ) + "\n";
    // Language variants cannot change launch identity, icons, scope, URLs or
    // credentials. Only the three owned presentation fields differ from base.
    try {
      const candidate = JSON.parse(snapshot?.contents ?? "");
      if (
        JSON.stringify(candidate) !== JSON.stringify(JSON.parse(contents)) &&
        mode !== "--extract"
      )
        failures.push("Public localized manifest is stale; run yarn i18n:extract");
    } catch {
      failures.push("Public localized manifest JSON is invalid");
    }
    localizedManifests.push({ output, contents, snapshot });
  }
  const messages = Object.fromEntries(
    [...catalog]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, entry.message]),
  );
  const metadata = Object.fromEntries(
    [...catalog]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, { ...entry, locations: [...new Set(entry.locations)].sort() }]),
  );
  const outputs = { "en.json": "", "messages.json": "" };
  if (!failures.length) {
    try {
      // Both formatted catalogs must be prepared before *any* public output
      // can be published. Never print formatter parser errors/codeframes.
      outputs["en.json"] = await formatGeneratedCatalogJson(
        "en.json",
        JSON.stringify(messages, null, 2) + "\n",
      );
      outputs["messages.json"] = await formatGeneratedCatalogJson(
        "messages.json",
        JSON.stringify(metadata, null, 2) + "\n",
      );
    } catch {
      failures.push(
        `${generated}: generated catalog JSON formatting failed; no outputs were published`,
      );
    }
  }
  if (failures.length) {
    Effect.runSync(Console.error(failures.join("\n")));
    process.exitCode = 1;
  } else {
    const publishOutput = async (
      output: string,
      contents: string,
      snapshot: RepositoryTextSnapshot | null,
    ): Promise<boolean> => {
      try {
        await publishRegularRepositoryTextFile(
          path.dirname(output),
          path.basename(output),
          contents,
          snapshot,
        );
        return true;
      } catch (error) {
        // The owned publisher emits content-free reasons/temporary basenames;
        // do not print native exceptions, stacks, target JSON or private bytes.
        Effect.runSync(
          Console.error(
            `${path.relative(root, output)}: ${error instanceof Error ? error.message : "generated output publication failed"}`,
          ),
        );
        process.exitCode = 1;
        return false;
      }
    };
    if (mode === "--extract") {
      // Validate every source/contract first: a failed extraction must publish
      // neither catalog files nor half-updated inert public copy.
      if (await publishOutput(htmlPath, expectedHtml, htmlSnapshot))
        await publishOutput(
          manifestPath,
          JSON.stringify(
            {
              ...manifest,
              lang: publicCopy.locale,
              dir: publicCopy.direction,
              description: publicCopy.manifestDescription,
            },
            null,
            2,
          ) + "\n",
          manifestSnapshot,
        );
      for (const localized of localizedManifests) {
        if (process.exitCode) break;
        await publishOutput(localized.output, localized.contents, localized.snapshot);
      }
    }
    for (const [name, contents] of Object.entries(outputs)) {
      const output = path.join(root, generated, name);
      if (mode === "--extract") {
        if (process.exitCode) break;
        try {
          await mkdir(path.dirname(output), { recursive: true });
        } catch {
          Effect.runSync(
            Console.error(`${generated}: generated output directory cannot be created`),
          );
          process.exitCode = 1;
          break;
        }
        if (!(await publishOutput(output, contents, catalogSnapshots.get(name) ?? null))) break;
      } else {
        const actual = catalogSnapshots.get(name)?.contents ?? "";
        if (actual !== contents) {
          Effect.runSync(Console.error(`${generated}/${name} is stale; run yarn i18n:extract`));
          process.exitCode = 1;
        }
      }
    }
    Effect.runSync(
      Console.log(
        `${catalog.size} unique ICU messages across ${files.length} production modules; display-sink coverage ${process.exitCode ? "failed" : "passed"}.`,
      ),
    );
  }
}
