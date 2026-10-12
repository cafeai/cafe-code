import ts from "typescript";
import { decodeString } from "micromark-util-decode-string";

/** Only presentation properties are eligible. IDs, roles, commands, URLs,
 * enum values and classes must never become locale-dependent data. */
const displayProperties = new Set([
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "alt",
  "title",
  "placeholder",
  "label",
  "description",
  "tooltip",
  "emptyMessage",
  "emptyText",
  "loadingText",
  "confirmLabel",
  "cancelLabel",
  "errorMessage",
  "helperText",
  "heading",
  "subtitle",
  "buttonLabel",
  "children",
]);
const richContainers = new Set([
  "p",
  "span",
  "label",
  "small",
  "h1",
  "h2",
  "h3",
  "h4",
  "strong",
  "em",
  "DialogDescription",
  "AlertDialogDescription",
  "EmptyDescription",
  "TooltipPopup",
]);

export interface CopySite {
  readonly start: number;
  readonly end: number;
  readonly source: string;
  readonly kind: "text" | "attribute" | "expression" | "property" | "rich";
}
export interface CopyEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** React's JSX whitespace convention, not an arbitrary trim: preserve the
 * space adjoining an inline child and remove indentation/newline trivia. */
export function jsxText(text: string): string {
  const lines = text.split(/\r\n|\n|\r/);
  let last = 0;
  for (let index = 0; index < lines.length; index++) {
    if (/[^ \t]/.test(lines[index] ?? "")) last = index;
  }
  const normalized = lines
    .map((line, index) => {
      let value = line.replace(/\t/g, " ");
      if (index !== 0) value = value.replace(/^ +/, "");
      if (index !== lines.length - 1) value = value.replace(/ +$/, "");
      return value && index !== last ? value + " " : value;
    })
    .join("");
  return decodeJsxEntities(normalized);
}

export function decodeJsxEntities(text: string): string {
  // Apply Markdown's existing entity decoder ONLY to entity tokens: applying
  // its complete text decoder would incorrectly remove JSX backslash text.
  return text.replace(/&(?:#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]+);/g, (entity) =>
    decodeString(entity),
  );
}

/** ICU syntax is code-owned. Literal braces/angles and apostrophes are escaped
 * before extraction; parameter values are NEVER fed back into this function. */
export function escapeUiLiteral(text: string): string {
  return text.replace(/'/g, "''").replace(/[{}<>]/g, (char) => `'${char}'`);
}

function propertyName(node: ts.PropertyName | ts.JsxAttributeName): string {
  return ts.isStringLiteral(node) ? node.text : node.getText();
}
function isCopy(text: string): boolean {
  // Product/platform names are identity data, not interface prose.
  return (
    /\p{L}/u.test(text) &&
    !/^https?:\/\//.test(text) &&
    ![
      "Cafe Code",
      "Claude",
      "Codex",
      "Grok",
      "OpenCode",
      "GitHub",
      "GitLab",
      "Win32",
      "MacIntel",
      "Linux",
    ].includes(text)
  );
}
function isUiCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ["uiText", "uiMessageParts", "uiMessageKey"].includes(node.expression.getText())
  );
}

/** Enumerate direct display sinks, without evaluating code or walking received
 * strings. Used by the migration AND the regression gate so the gate does not
 * merely trust a pre-generated list of files. */
export function collectCopySites(
  sourceFile: ts.SourceFile,
  traceBindings = false,
): readonly CopySite[] {
  const sites: CopySite[] = [];
  const labelArguments = new Map<string, number[]>();
  const bindings = new Map<string, ts.Node[]>();
  const traced = new Set<ts.Node>();
  function parameterInventory(node: ts.Node): void {
    if (
      (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      bindings.set(node.name.text, [...(bindings.get(node.name.text) ?? []), node]);
    if (ts.isFunctionDeclaration(node) && node.name) {
      const indexes = node.parameters.flatMap((parameter, index) =>
        /^(?:label|title|description|tooltip|placeholder)$/.test(parameter.name.getText(sourceFile))
          ? [index]
          : [],
      );
      if (indexes.length) labelArguments.set(node.name.text, indexes);
    }
    ts.forEachChild(node, parameterInventory);
  }
  parameterInventory(sourceFile);
  function expression(node: ts.Expression, kind: CopySite["kind"]): void {
    if (isUiCall(node)) return;
    if (traceBindings && !traced.has(node)) {
      traced.add(node);
      if (ts.isIdentifier(node)) {
        const owners = bindings.get(node.text);
        if (owners?.length === 1 && ts.isVariableDeclaration(owners[0]!) && owners[0].initializer)
          expression(owners[0].initializer, kind);
      } else if (ts.isCallExpression(node)) {
        const owners = bindings.get(node.expression.getText(sourceFile));
        const owner = owners?.length === 1 ? owners[0] : undefined;
        function returns(value: ts.Node): void {
          if (ts.isReturnStatement(value) && value.expression) expression(value.expression, kind);
          else if (!ts.isFunctionLike(value) || value === owner) ts.forEachChild(value, returns);
        }
        if (owner && ts.isFunctionDeclaration(owner) && owner.body) returns(owner);
        if (node.expression.getText(sourceFile) === "useMemo") {
          const factory = node.arguments[0];
          if (factory && ts.isArrowFunction(factory)) {
            if (ts.isBlock(factory.body)) returns(factory.body);
            else expression(factory.body, kind);
          }
        }
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (isCopy(node.text))
        sites.push({ start: node.getStart(sourceFile), end: node.end, source: node.text, kind });
    } else if (ts.isTemplateExpression(node)) {
      if (isCopy(node.head.text + node.templateSpans.map((span) => span.literal.text).join(""))) {
        sites.push({
          start: node.getStart(sourceFile),
          end: node.end,
          source: node.getText(sourceFile),
          kind,
        });
      } else {
        // A template with only whitespace can still contain authored verbs in
        // a conditional interpolation. Received names/paths remain opaque.
        for (const span of node.templateSpans) expression(span.expression, kind);
      }
    } else if (ts.isConditionalExpression(node)) {
      expression(node.whenTrue, kind);
      expression(node.whenFalse, kind);
    } else if (ts.isParenthesizedExpression(node)) {
      expression(node.expression, kind);
    } else if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(node.operatorToken.kind)
    ) {
      // The LHS of && is admission, not copy; never translate a guard value.
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken)
        expression(node.left, kind);
      expression(node.right, kind);
    }
  }
  function visit(node: ts.Node): void {
    if (isUiCall(node)) return;
    if (ts.isJsxText(node)) {
      const value = jsxText(node.text);
      if (isCopy(value))
        sites.push({ start: node.pos, end: node.end, source: value, kind: "text" });
    } else if (ts.isJsxAttribute(node) && displayProperties.has(propertyName(node.name))) {
      if (node.initializer && ts.isStringLiteral(node.initializer)) {
        if (isCopy(node.initializer.text))
          sites.push({
            start: node.initializer.getStart(sourceFile),
            end: node.initializer.end,
            source: decodeJsxEntities(node.initializer.text),
            kind: "attribute",
          });
      } else if (
        node.initializer &&
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression
      )
        expression(node.initializer.expression, "expression");
    } else if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      expression(node.expression, "expression");
    } else if (ts.isPropertyAssignment(node) && displayProperties.has(propertyName(node.name))) {
      expression(node.initializer, "property");
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      /(?:LABELS?|DESCRIPTIONS?|TOOLTIPS?|PLACEHOLDERS?)$|(?:Label|Description|Tooltip|Placeholder)$/.test(
        node.name.getText(sourceFile),
      )
    ) {
      function displayMap(value: ts.Node): void {
        if (
          ts.isStringLiteral(value) ||
          ts.isNoSubstitutionTemplateLiteral(value) ||
          ts.isTemplateExpression(value)
        )
          expression(value, "property");
        else if (ts.isPropertyAssignment(value)) {
          if (
            ![
              "id",
              "value",
              "day",
              "side",
              "className",
              "command",
              "kind",
              "role",
              "status",
              "mode",
              "key",
              "slug",
              "type",
              "action",
              "path",
              "route",
            ].includes(propertyName(value.name))
          )
            displayMap(value.initializer);
        } else if (ts.isAsExpression(value) || ts.isParenthesizedExpression(value))
          displayMap(value.expression);
        else if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value))
          ts.forEachChild(value, displayMap);
        else if (ts.isConditionalExpression(value)) {
          displayMap(value.whenTrue);
          displayMap(value.whenFalse);
        }
      }
      displayMap(node.initializer);
    } else if (ts.isCallExpression(node)) {
      for (const index of labelArguments.get(node.expression.getText(sourceFile)) ?? []) {
        const argument = node.arguments[index];
        if (argument) expression(argument, "expression");
      }
      // These setters are presentation-state boundaries, not provider command
      // builders. The received Error.message branch remains opaque; only its
      // authored fallback is eligible. Canonical state/id setters are absent.
      const name = node.expression.getText(sourceFile);
      const feedbackArgument = /^set(?:\w*(?:Error|Feedback)|StatusMessage)$/.test(name)
        ? 0
        : ["setThreadError", "describeSendFailureMessage"].includes(name)
          ? 1
          : name === "blockFollowUpQueueItem"
            ? 2
            : undefined;
      if (feedbackArgument !== undefined) {
        const argument = node.arguments[feedbackArgument];
        if (argument) expression(argument, "expression");
      }
      if (
        /^(?:window\.confirm|(?:\w+\.)+(?:confirm|showMessageBox))$/.test(
          node.expression.getText(sourceFile),
        )
      ) {
        const argument = node.arguments[0];
        if (argument) expression(argument, "expression");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  // An attribute expression can be visited by more than one category. Exactly
  // one edit per source range is necessary to preserve original node ownership.
  return [...new Map(sites.map((site) => [site.start, site])).values()].sort(
    (a, b) => a.start - b.start,
  );
}

function callFor(node: ts.Expression, file: ts.SourceFile): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return `uiText(${JSON.stringify(escapeUiLiteral(node.text))})`;
  }
  if (ts.isTemplateExpression(node)) {
    let message = escapeUiLiteral(node.head.text);
    const values: string[] = [];
    node.templateSpans.forEach((span, index) => {
      const key = `value${index}`;
      message += `{${key}}` + escapeUiLiteral(span.literal.text);
      values.push(`${key}: ${span.expression.getText(file)}`);
    });
    return `uiText(${JSON.stringify(message)}, { ${values.join(", ")} })`;
  }
  throw new Error("Copy edit must bind an exact string/template node");
}

export function migrateUiCopy(code: string, filename: string): { code: string; count: number } {
  const file = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes = new Map<number, ts.Expression>();
  function record(node: ts.Node): void {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    )
      nodes.set(node.getStart(file), node);
    ts.forEachChild(node, record);
  }
  record(file);
  const edits: CopyEdit[] = collectCopySites(file).map((site) => {
    if (site.kind === "text")
      return { ...site, text: `{uiText(${JSON.stringify(escapeUiLiteral(site.source))})}` };
    const node = nodes.get(site.start);
    if (!node) throw new Error(`Unbound copy site in ${filename}`);
    const call =
      site.kind === "attribute"
        ? `uiText(${JSON.stringify(escapeUiLiteral(site.source))})`
        : callFor(node, file);
    return { ...site, text: site.kind === "attribute" ? `{${call}}` : call };
  });
  // Rich inline copy is a single reorderable message. Existing code-owned nodes
  // become slots; no translator can introduce markup, event handlers or URLs.
  // Apply leaf edits inside each slot before replacing the parent's children.
  const richEdits: CopyEdit[] = [];
  function rich(node: ts.Node): void {
    if (
      ts.isJsxElement(node) &&
      richContainers.has(node.openingElement.tagName.getText(file)) &&
      node.children.some((child) => ts.isJsxText(child) && isCopy(jsxText(child.text))) &&
      node.children.some((child) => !ts.isJsxText(child))
    ) {
      const begin = node.openingElement.end;
      const end = node.closingElement.getStart(file);
      let message = "";
      const values: string[] = [];
      node.children.forEach((child, index) => {
        if (ts.isJsxText(child)) message += escapeUiLiteral(jsxText(child.text));
        else if (ts.isJsxExpression(child) && !child.expression) return;
        else {
          const key = `slot${index}`;
          message += `<${key}></${key}>`;
          const value = ts.isJsxExpression(child) && child.expression ? child.expression : child;
          const ownedEdits = edits.filter(
            (edit) => edit.start >= value.getStart(file) && edit.end <= value.end,
          );
          const valueCode = applyCopyEdits(
            code.slice(value.getStart(file), value.end),
            ownedEdits.map((edit) => ({
              ...edit,
              start: edit.start - value.getStart(file),
              end: edit.end - value.getStart(file),
            })),
          );
          values.push(`${key}: (${valueCode})`);
        }
      });
      richEdits.push({
        start: begin,
        end,
        text: `<UiMessage message={${JSON.stringify(message)}} slots={{ ${values.join(", ")} }} />`,
      });
      return;
    }
    ts.forEachChild(node, rich);
  }
  rich(file);
  const selected = edits
    .filter(
      (edit) => !richEdits.some((parent) => edit.start >= parent.start && edit.end <= parent.end),
    )
    .concat(richEdits);
  if (!selected.length) return { code, count: 0 };
  let transformed = applyCopyEdits(code, selected);
  const needsText = selected.some((edit) => edit.text.includes("uiText("));
  const hasImport = (name: string) =>
    file.statements.some(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings) &&
        statement.importClause.namedBindings.elements.some((element) => element.name.text === name),
    );
  const imports = `${needsText && !hasImport("uiText") ? 'import { uiText } from "@cafecode/shared/i18n";\n' : ""}${richEdits.length && !hasImport("UiMessage") ? 'import { UiMessage } from "~/i18n";\n' : ""}`;
  // Directives retain their leading position, including the rare use-client
  // directive. This migration is source-only and does not alter module loading.
  const directive = /^([\s]*["']use client["'];\s*)/.exec(transformed);
  const offset = directive?.[0].length ?? 0;
  transformed = transformed.slice(0, offset) + imports + transformed.slice(offset);
  return { code: transformed, count: selected.length };
}

export function applyCopyEdits(code: string, edits: readonly CopyEdit[]): string {
  let result = code;
  let previous = code.length;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    if (edit.end > previous) throw new Error("Overlapping localization edits");
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    previous = edit.start;
  }
  return result;
}
