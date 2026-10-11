import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, rename } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export const MESSAGE_API_NAMES: ReadonlySet<string> = new Set([
  "uiText",
  "uiMessageParts",
  "UiMessage",
]);

/** Parentheses do not change a direct callee's identity. Casts, properties,
 * aliases and arbitrary expressions are deliberately not resolved/evaluated. */
export function directMessageApiName(expression: ts.Expression): string | undefined {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return ts.isIdentifier(current) && MESSAGE_API_NAMES.has(current.text) ? current.text : undefined;
}

export interface MessageApiBoundaryIssue {
  readonly node: ts.Node;
  readonly message: string;
}

/** Import ownership is caller-defined from exact admitted module identities.
 * This pure pass does not resolve/load a module or inspect its exports. */
export function messageApiImports(
  sourceFile: ts.SourceFile,
  isOwnedModule: (specifier: string) => boolean,
): { approvedNames: ReadonlySet<string>; issues: readonly MessageApiBoundaryIssue[] } {
  const approvedNames = new Set<string>();
  const issues: MessageApiBoundaryIssue[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const owned = isOwnedModule(statement.moduleSpecifier.text);
    const bindings = statement.importClause?.namedBindings;
    if (owned && bindings && ts.isNamespaceImport(bindings))
      issues.push({
        node: statement,
        message: "use named unaliased i18n imports for static catalog validation",
      });
    if (!owned || !bindings || !ts.isNamedImports(bindings)) continue;
    for (const binding of bindings.elements) {
      const original = binding.propertyName?.text ?? binding.name.text;
      if (!MESSAGE_API_NAMES.has(original)) continue;
      if (original !== binding.name.text)
        issues.push({ node: binding, message: "message APIs cannot be aliased" });
      else approvedNames.add(original);
    }
  }
  return { approvedNames, issues };
}

function jsxAttributeExpression(attribute: ts.JsxAttribute | undefined): ts.Expression | undefined {
  const value = attribute?.initializer;
  return value && ts.isJsxExpression(value)
    ? value.expression
    : value && ts.isStringLiteral(value)
      ? value
      : undefined;
}

/** Enforce an inspectable authored-call shape, not whole-program type or
 * data-flow semantics. Imported message APIs cannot escape into an alias,
 * object, callback or wrapper that the catalog collector would not recognize.
 * Only import syntax, approved direct calls and direct JSX tags are admitted.
 * Non-message imports/references are intentionally outside this boundary. */
export function messageApiBoundaryIssues(
  sourceFile: ts.SourceFile,
  approvedNames: ReadonlySet<string>,
): readonly MessageApiBoundaryIssue[] {
  const issues: MessageApiBoundaryIssue[] = [];
  const report = (node: ts.Node, message: string) => issues.push({ node, message });
  function visit(node: ts.Node): void {
    // A fourth explicit locale argument uses the global `undefined` spelling
    // for an omitted context. Reject local value bindings in message-source
    // files rather than pretending that spelling proves the global identity.
    // This conservative syntactic guard never evaluates source or imports.
    const declaredName =
      ts.isParameter(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isImportClause(node) ||
      ts.isImportSpecifier(node) ||
      ts.isNamespaceImport(node)
        ? node.name
        : undefined;
    if (
      approvedNames.size > 0 &&
      declaredName &&
      !ts.isStringLiteral(declaredName) &&
      bindingNames(declaredName).includes("undefined")
    )
      report(node, "message source cannot shadow the global undefined context sentinel");
    if (
      (ts.isParameter(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node)) &&
      node.name &&
      bindingNames(node.name).some((name) => MESSAGE_API_NAMES.has(name))
    )
      report(node, "message APIs cannot be shadowed");

    if (ts.isIdentifier(node) && MESSAGE_API_NAMES.has(node.text)) {
      const parent = node.parent;
      // Import spelling/ownership is checked independently by the collector.
      // Property names and type-only references do not escape a runtime value.
      const importName = ts.isImportSpecifier(parent);
      const propertyName =
        (ts.isPropertyAssignment(parent) ||
          ts.isMethodDeclaration(parent) ||
          ts.isGetAccessorDeclaration(parent) ||
          ts.isSetAccessorDeclaration(parent)) &&
        parent.name === node;
      const typeName = ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent);
      const binding =
        ((ts.isParameter(parent) ||
          ts.isVariableDeclaration(parent) ||
          ts.isFunctionDeclaration(parent) ||
          ts.isFunctionExpression(parent) ||
          ts.isClassDeclaration(parent) ||
          ts.isClassExpression(parent)) &&
          parent.name === node) ||
        (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node));
      let callee: ts.Node = node;
      while (ts.isParenthesizedExpression(callee.parent)) callee = callee.parent;
      const directCall =
        node.text !== "UiMessage" &&
        ts.isCallExpression(callee.parent) &&
        callee.parent.expression === callee;
      const directTag =
        node.text === "UiMessage" &&
        (ts.isJsxOpeningElement(parent) ||
          ts.isJsxSelfClosingElement(parent) ||
          ts.isJsxClosingElement(parent)) &&
        parent.tagName === node;
      if (!importName && !propertyName && !typeName && !binding) {
        if (!approvedNames.has(node.text))
          report(node, "message API must be the approved named import");
        else if (!directCall && !directTag)
          report(
            node,
            "message APIs cannot be aliased or referenced outside an approved direct call/tag",
          );
      }
      if (ts.isBindingElement(parent) && parent.propertyName === node && parent.name !== node)
        report(node, "message APIs cannot be destructured into aliases");
    }

    if (
      ts.isCallExpression(node) &&
      ((ts.isPropertyAccessExpression(node.expression) &&
        MESSAGE_API_NAMES.has(node.expression.name.text)) ||
        (ts.isElementAccessExpression(node.expression) &&
          node.expression.argumentExpression &&
          ts.isStringLiteral(node.expression.argumentExpression) &&
          MESSAGE_API_NAMES.has(node.expression.argumentExpression.text)))
    )
      report(node, "use approved unaliased named message imports, not namespace/member calls");

    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(sourceFile) === "UiMessage"
    ) {
      const names = new Set<string>();
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attribute)) {
          // A later spread could replace the inspected message/argument object;
          // an earlier one could introduce uninspected context or rich values.
          report(
            attribute,
            "UiMessage props must be explicit; JSX spreads cannot establish a static contract",
          );
        } else {
          const name = attribute.name.getText(sourceFile);
          if (names.has(name)) report(attribute, "UiMessage attributes cannot be duplicated");
          names.add(name);
        }
      }
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const values = argumentNames(
        jsxAttributeExpression(
          attributes.find((attribute) => attribute.name.getText(sourceFile) === "values"),
        ),
      );
      const slotsAttribute = attributes.find(
        (attribute) => attribute.name.getText(sourceFile) === "slots",
      );
      const slots = argumentNames(jsxAttributeExpression(slotsAttribute));
      if (values && slots && [...values].some((name) => slots.has(name)))
        // The adapter intentionally turns slots into callbacks. A duplicate
        // name would replace a scalar argument and invalidate the inspected
        // contract even though set-union name checking alone accepts it.
        report(slotsAttribute ?? node, "UiMessage values and slots cannot overlap");
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return issues;
}

/** Catalog authors must retain the complete named-argument contract. This is
 * source/build validation, not permission to evaluate a parameter expression. */
export function messageContract(source: string): { values: Set<string>; tags: Set<string> } {
  const values = new Set<string>();
  const tags = new Set<string>();
  function visit(elements: readonly MessageFormatElement[]): void {
    for (const element of elements) {
      if (
        [TYPE.argument, TYPE.number, TYPE.date, TYPE.time, TYPE.select, TYPE.plural].includes(
          element.type,
        )
      )
        values.add((element as { value: string }).value);
      if (element.type === TYPE.select || element.type === TYPE.plural)
        for (const option of Object.values(element.options)) visit(option.value);
      if (element.type === TYPE.tag) {
        tags.add(element.value);
        visit(element.children);
      }
    }
  }
  visit(parse(source));
  return { values, tags };
}

/** Released catalogs preserve executable ICU control structure, independently
 * of prose order. Future incomplete authoring catalogs retain the existing
 * partial/value/tag checks; a release additionally binds branch keys, offsets
 * and argument kinds. Literal text and rich-slot order are not evaluated. */
function messageControlShape(source: string): string {
  const controls: string[] = [];
  function visit(
    elements: readonly MessageFormatElement[],
    branchPath: readonly string[] = [],
  ): void {
    for (const element of elements) {
      if (element.type === TYPE.select || element.type === TYPE.plural) {
        controls.push(
          JSON.stringify([
            branchPath,
            element.type,
            element.value,
            Object.keys(element.options).sort(),
            element.type === TYPE.plural ? element.offset : null,
            element.type === TYPE.plural ? element.pluralType : null,
          ]),
        );
        for (const [key, option] of Object.entries(element.options))
          visit(option.value, [...branchPath, JSON.stringify([element.type, element.value, key])]);
      } else if ([TYPE.argument, TYPE.number, TYPE.date, TYPE.time].includes(element.type)) {
        controls.push(
          JSON.stringify([
            branchPath,
            element.type,
            (element as { value: string }).value,
            "style" in element ? element.style : null,
          ]),
        );
      } else if (element.type === TYPE.pound)
        controls.push(JSON.stringify([branchPath, TYPE.pound]));
      else if (element.type === TYPE.tag) visit(element.children, branchPath);
    }
  }
  visit(parse(source));
  return JSON.stringify(controls.sort());
}

/** A structurally valid, canonical BCP 47 filename is a catalog identity, not
 * evidence that its language is enabled, registered or supported by a host's
 * locale data. Never normalize an ambiguous filename into an admitted path. */
export function canonicalLocaleCatalogFilename(filename: string): string | undefined {
  if (!filename.endsWith(".json") || filename.includes("/") || filename.includes("\\"))
    return undefined;
  const locale = filename.slice(0, -".json".length);
  try {
    const canonical = Intl.getCanonicalLocales(locale);
    return canonical.length === 1 && canonical[0] === locale ? locale : undefined;
  } catch {
    return undefined;
  }
}

/** Partial bundled catalogs intentionally retain English fallback. Supplied
 * entries, however, must identify an exact generated source/context key and
 * retain its complete, separate scalar-value and code-owned rich-tag names.
 * No value type, translation quality or numeric/date semantics are inferred.
 * Diagnostics contain ordinals/reasons only, never supplied keys or text. */
export function localeCatalogIssues(
  candidate: unknown,
  englishSources: ReadonlyMap<string, string>,
  requireComplete = false,
): readonly string[] {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
    return ["catalog must be a JSON object of string entries"];
  const issues: string[] = [];
  let properties: Record<string, PropertyDescriptor>;
  try {
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null)
      return ["catalog must be a JSON object of string entries"];
    if (Object.getOwnPropertySymbols(candidate).length)
      return ["catalog cannot contain non-JSON property keys"];
    // JSON.parse produces own data descriptors. Refuse accessors rather than
    // invoking arbitrary getters if this pure validator is called directly.
    properties = Object.getOwnPropertyDescriptors(candidate);
  } catch {
    return ["catalog properties cannot be inspected"];
  }
  if (requireComplete) {
    const missing = [...englishSources.keys()].filter(
      (key) => !Object.hasOwn(properties, key),
    ).length;
    if (missing) issues.push(`released catalog is missing ${missing} source entries`);
  }
  for (const [index, [key, property]] of Object.entries(properties).entries()) {
    const prefix = `entry ${index + 1}: `;
    if (!("value" in property) || typeof property.value !== "string") {
      issues.push(prefix + "catalog value must be a string data property");
      continue;
    }
    const source = englishSources.get(key);
    if (source === undefined) {
      issues.push(prefix + "unknown generated source/context key");
      continue;
    }
    let sourceContract: ReturnType<typeof messageContract>;
    let targetContract: ReturnType<typeof messageContract>;
    try {
      sourceContract = messageContract(source);
    } catch {
      issues.push(prefix + "generated English ICU is invalid");
      continue;
    }
    try {
      targetContract = messageContract(property.value);
    } catch {
      issues.push(prefix + "target ICU is invalid");
      continue;
    }
    const equalNames = (expected: ReadonlySet<string>, supplied: ReadonlySet<string>) =>
      expected.size === supplied.size && [...expected].every((name) => supplied.has(name));
    if (!equalNames(sourceContract.values, targetContract.values))
      issues.push(prefix + "target value names must exactly match generated English");
    if (!equalNames(sourceContract.tags, targetContract.tags))
      issues.push(prefix + "target rich-tag names must exactly match generated English");
    if (requireComplete) {
      if (messageControlShape(source) !== messageControlShape(property.value))
        issues.push(prefix + "released target ICU controls must match generated English");
      if (
        source.match(/^\s*/)?.[0] !== property.value.match(/^\s*/)?.[0] ||
        source.match(/\s*$/)?.[0] !== property.value.match(/\s*$/)?.[0]
      )
        issues.push(prefix + "released target boundary whitespace must match generated English");
    }
  }
  return issues;
}

export type CatalogFileIdentity = Pick<BigIntStats, "dev" | "ino">;
type RepositoryFileRevision = Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">;

export interface RepositoryTextSnapshot {
  readonly directory: string;
  readonly filename: string;
  readonly contents: string;
  readonly directoryIdentity: CatalogFileIdentity;
  readonly fileRevision: RepositoryFileRevision;
}

const sameFileIdentity = (left: CatalogFileIdentity, right: CatalogFileIdentity) =>
  left.dev === right.dev && left.ino === right.ino;
const sameFileRevision = (left: RepositoryFileRevision, right: RepositoryFileRevision) =>
  sameFileIdentity(left, right) &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;
const singleRepositoryFilename = (filename: string) =>
  filename.length > 0 && filename !== "." && filename !== ".." && !/[\/\\\u0000]/.test(filename);

/** Read a repository-owned catalog through its held regular-file descriptor.
 * Path and parent identities are rechecked before bytes are read; a link or
 * replacement is never admitted from a preceding directory-entry snapshot.
 * This is shared Node metadata qualification, not a native namespace lease or
 * permission policy. No target file is changed, imported or executed. */
export async function readRegularRepositoryTextFile(
  directory: string,
  filename: string,
  expectedDirectory?: CatalogFileIdentity,
): Promise<RepositoryTextSnapshot> {
  if (!singleRepositoryFilename(filename))
    throw new Error("repository output filename must be one exact path component");
  const catalogPath = path.join(directory, filename);
  const reject = (reason: string): never => {
    throw new Error(reason);
  };
  const directoryBefore = await lstat(directory, { bigint: true }).catch(() =>
    reject("catalog directory cannot be inspected"),
  );
  if (
    !directoryBefore.isDirectory() ||
    directoryBefore.isSymbolicLink() ||
    (expectedDirectory && !sameFileIdentity(directoryBefore, expectedDirectory))
  )
    reject("catalog directory must be the unchanged regular directory");
  const before = await lstat(catalogPath, { bigint: true }).catch(() =>
    reject("catalog file cannot be inspected"),
  );
  if (!before.isFile() || before.isSymbolicLink())
    reject("catalog must be a regular file, never a symlink");
  // O_NOFOLLOW is additional host support, not the only admission fence: the
  // held metadata and namespace comparisons are required on every host.
  const handle = await open(catalogPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
    () => reject("catalog regular-file descriptor cannot be opened"),
  );
  try {
    const held = await handle.stat({ bigint: true });
    const [current, parent] = await Promise.all([
      lstat(catalogPath, { bigint: true }),
      lstat(directory, { bigint: true }),
    ]);
    if (
      !held.isFile() ||
      !sameFileIdentity(before, held) ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      !sameFileIdentity(current, held) ||
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      !sameFileIdentity(parent, directoryBefore)
    )
      reject("catalog namespace changed before its regular-file read");
    const contents = await handle.readFile("utf8");
    const [afterHeld, afterPath, afterParent] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(catalogPath, { bigint: true }),
      lstat(directory, { bigint: true }),
    ]);
    if (
      !afterHeld.isFile() ||
      !sameFileIdentity(afterHeld, held) ||
      afterHeld.size !== held.size ||
      afterHeld.mtimeNs !== held.mtimeNs ||
      afterHeld.ctimeNs !== held.ctimeNs ||
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      !sameFileIdentity(afterPath, held) ||
      !afterParent.isDirectory() ||
      afterParent.isSymbolicLink() ||
      !sameFileIdentity(afterParent, directoryBefore)
    )
      reject("catalog changed during its regular-file read");
    return {
      directory,
      filename,
      contents,
      directoryIdentity: { dev: parent.dev, ino: parent.ino },
      fileRevision: {
        dev: held.dev,
        ino: held.ino,
        size: held.size,
        mtimeNs: held.mtimeNs,
        ctimeNs: held.ctimeNs,
      },
    };
  } catch {
    // Native filesystem errors can include arbitrary paths. Keep this build
    // diagnostic content-free instead of printing exceptions or file bytes.
    return reject("catalog could not be read as an unchanged regular file");
  } finally {
    await handle.close().catch(() => {
      throw new Error("catalog regular-file descriptor could not be closed");
    });
  }
}

/** Catalog-only wrapper retains the canonical locale-name admission; the one
 * generated metadata filename is not itself a locale and is never registered. */
export async function readRegularLocaleCatalogFile(
  directory: string,
  filename: string,
  expectedDirectory?: CatalogFileIdentity,
): Promise<RepositoryTextSnapshot> {
  if (filename !== "messages.json" && !canonicalLocaleCatalogFilename(filename))
    throw new Error("catalog filename must be a canonical Intl locale");
  return readRegularRepositoryTextFile(directory, filename, expectedDirectory);
}

/** Publish a generated text output without opening/following its destination.
 * The temporary is exclusive and in the admitted directory; the observed
 * output (or absence), parent and temporary identities are rechecked before
 * atomic rename. A stale read or uncertain namespace preserves the temporary
 * for inspection. This trusted-checkout guard is not a hostile concurrent
 * namespace compare-and-swap, native file capability or multi-file transaction. */
export async function publishRegularRepositoryTextFile(
  directory: string,
  filename: string,
  contents: string,
  expected: RepositoryTextSnapshot | null,
): Promise<void> {
  if (
    !singleRepositoryFilename(filename) ||
    (expected && (expected.directory !== directory || expected.filename !== filename))
  )
    throw new Error("generated output must match its exact repository read");
  const destination = path.join(directory, filename);
  const parent = await lstat(directory, { bigint: true }).catch(() => {
    throw new Error("generated output directory cannot be inspected");
  });
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (expected && !sameFileIdentity(parent, expected.directoryIdentity))
  )
    throw new Error("generated output directory must be the unchanged regular directory");
  const observeOutput = async () => {
    try {
      return await lstat(destination, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("generated output cannot be inspected");
    }
  };
  const before = await observeOutput();
  if (
    (before && (!before.isFile() || before.isSymbolicLink())) ||
    (expected ? !before || !sameFileRevision(before, expected.fileRevision) : before !== null)
  )
    throw new Error("generated output must retain its observed regular-file identity or absence");
  const temporaryName = `.${filename}.i18n-${randomUUID()}.tmp`;
  const temporaryPath = path.join(directory, temporaryName);
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let held: BigIntStats;
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      held = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    const [currentParent, currentTemporary, currentOutput] = await Promise.all([
      lstat(directory, { bigint: true }),
      lstat(temporaryPath, { bigint: true }),
      observeOutput(),
    ]);
    if (
      !currentParent.isDirectory() ||
      currentParent.isSymbolicLink() ||
      !sameFileIdentity(currentParent, parent) ||
      !held.isFile() ||
      !currentTemporary.isFile() ||
      currentTemporary.isSymbolicLink() ||
      !sameFileRevision(currentTemporary, held) ||
      (before
        ? !currentOutput ||
          !currentOutput.isFile() ||
          currentOutput.isSymbolicLink() ||
          !sameFileRevision(currentOutput, before)
        : currentOutput !== null)
    )
      throw new Error("generated output namespace changed before publication");
    // rename replaces the destination entry itself; it never follows a link
    // into its target. All four writable outputs are caller-owned constants.
    await rename(temporaryPath, destination);
  } catch {
    // Do not delete uncertain evidence or expose native error paths/contents.
    // The generated basename and fresh temporary basename are inert metadata.
    throw new Error(`generated output publication failed; inspect temporary ${temporaryName}`);
  }
}

/** Exact own property names can be inspected without running code. Spreads or
 * computed keys cannot establish a static message contract and are rejected at
 * authored call sites (the trusted adapter itself is separately qualified). */
export function argumentNames(expression: ts.Expression | undefined): Set<string> | undefined {
  if (!expression || (ts.isIdentifier(expression) && expression.text === "undefined"))
    return new Set();
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    return argumentNames(expression.expression);
  if (!ts.isObjectLiteralExpression(expression)) return undefined;
  const names = new Set<string>();
  for (const property of expression.properties) {
    // Accessors are not own data properties, and methods cannot establish the
    // scalar/rich named-value contract. Explicit callback-valued assignments
    // remain supported for trusted rich tags without evaluating the callback.
    if (
      (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) ||
      ts.isComputedPropertyName(property.name)
    )
      return undefined;
    const name = property.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name) && !ts.isNumericLiteral(name))
      return undefined;
    // This object-literal spelling sets the prototype rather than creating an
    // own property. A shorthand remains an ordinary own-data argument.
    if (ts.isPropertyAssignment(property) && name.text === "__proto__") return undefined;
    if (names.has(name.text)) return undefined;
    names.add(name.text);
  }
  return names;
}

/** Destructuring is still a binding and must not shadow an approved API. */
export function bindingNames(name: ts.BindingName | ts.Identifier): readonly string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

export function checkMessageArguments(
  source: string,
  supplied: Set<string> | undefined,
): string | undefined {
  const contract = messageContract(source);
  const expected = new Set([...contract.values, ...contract.tags]);
  if (!supplied) return "named arguments must be a static own-property object";
  const missing = [...expected].filter((name) => !supplied.has(name));
  const extra = [...supplied].filter((name) => !expected.has(name));
  return missing.length || extra.length
    ? `message argument mismatch (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`
    : undefined;
}
