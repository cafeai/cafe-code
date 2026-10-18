import { parse, type Node } from "acorn";

type AstNode = Node & Record<string, unknown>;
function ast(value: unknown): AstNode | undefined {
  return value !== null && typeof value === "object" && "type" in value
    ? (value as AstNode)
    : undefined;
}
function patternNames(value: unknown, names: Set<string>): void {
  const node = ast(value);
  if (!node) return;
  if (node.type === "Identifier" && typeof node.name === "string") names.add(node.name);
  else if (node.type === "RestElement") patternNames(node.argument, names);
  else if (node.type === "AssignmentPattern") patternNames(node.left, names);
  else if (node.type === "ArrayPattern" && Array.isArray(node.elements))
    for (const item of node.elements) patternNames(item, names);
  else if (node.type === "ObjectPattern" && Array.isArray(node.properties))
    for (const item of node.properties) {
      const property = ast(item);
      patternNames(property?.type === "RestElement" ? property.argument : property?.value, names);
    }
}

/** A fresh ESM cell carries prior values through a synthetic module. The source
 * is parsed rather than searched with regex, so destructuring, comments and
 * strings cannot invent bindings. Closures deliberately retain their original
 * module's lexical environment, matching the audited module-based design. */
export function prepareCellSource(code: string, previous: readonly string[]) {
  const program = parse(code, { ecmaVersion: "latest", sourceType: "module" });
  const declared = new Set<string>();
  const collect = (node: AstNode, topLevel: boolean) => {
    if (node.type.startsWith("Export"))
      throw new Error("Cell exports are reserved for persistent bindings.");
    if (node.type === "ImportDeclaration") {
      if (ast(node.source)?.value === "cafe:previous")
        throw new Error("The previous-cell module is reserved.");
      if (!topLevel) return;
      for (const item of node.specifiers as unknown[]) patternNames(ast(item)?.local, declared);
      return;
    }
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      if (topLevel) patternNames(node.id, declared);
      return;
    }
    // Never collect nested function/class locals as persistent module bindings.
    if (
      node.type.includes("Function") ||
      node.type === "ClassExpression" ||
      node.type === "ArrowFunctionExpression"
    )
      return;
    if (node.type === "VariableDeclaration") {
      if (topLevel || node.kind === "var")
        for (const item of node.declarations as unknown[]) patternNames(ast(item)?.id, declared);
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        for (const item of value) {
          const child = ast(item);
          if (child) collect(child, false);
        }
      else {
        const child = ast(value);
        if (child) collect(child, false);
      }
    }
  };
  for (const statement of program.body) collect(statement as AstNode, true);
  if (declared.has("__cafe_previous")) throw new Error("The __cafe_previous binding is reserved.");
  const carried = previous.filter((name) => !declared.has(name));
  const names = [...carried, ...declared];
  const prefix = carried.length
    ? `import * as __cafe_previous from "cafe:previous";\n${carried.map((name) => `let ${name} = __cafe_previous[${JSON.stringify(name)}];`).join("\n")}\n`
    : "";
  return {
    code: `${prefix}${code}\n${names.length ? `export { ${names.join(", ")} };` : ""}`,
    names,
  };
}
