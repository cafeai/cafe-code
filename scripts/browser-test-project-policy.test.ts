import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(import.meta.dirname, "..");
const browserConfigPath = resolve(repoRoot, "apps/web/vitest.browser.config.ts");
const browserConfigSource = readFileSync(browserConfigPath, "utf8");
const touchFile = "src/components/chat/MessagesTimeline.touch.browser.tsx";
const fluidFile = "src/components/visualizations/VisualizationFluid.browser.tsx";
const reducedFiles = [
  "src/components/chat/CodexContextWindowControl.motion.browser.tsx",
  "src/components/chat/ProviderDiagnosticWorkEntry.motion.browser.tsx",
  "src/components/visualizations/Visualizations.motion.browser.tsx",
];

interface ProjectPolicy {
  readonly name: string;
  readonly groupOrder: number;
  readonly includes: readonly string[];
  readonly excludes: readonly string[];
  readonly inheritedExcludes: boolean;
  readonly providerOptions: unknown;
  readonly instance: string;
  readonly viewport: unknown;
}

/** Read only the finite AST forms used by this configuration. In particular,
 * this is not an evaluator: importing Vite or calling a provider factory on the
 * default Node test path would create a different ownership boundary. Unknown
 * selectors, computed keys, spreads or calls must require deliberate review. */
function readProjects(source: string): readonly ProjectPolicy[] {
  const file = ts.createSourceFile(browserConfigPath, source, ts.ScriptTarget.Latest, true);
  const bindings = new Map<string, ts.Expression>();
  const imports = new Map<string, string>();
  const namedImports = new Set<string>();
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      assert(ts.isStringLiteral(statement.moduleSpecifier), "literal import source required");
      const origin = statement.moduleSpecifier.text;
      const clause = statement.importClause;
      if (clause?.name) {
        assert(!imports.has(clause.name.text), "duplicate imported binding");
        imports.set(clause.name.text, origin);
      }
      if (clause?.namedBindings) {
        assert(ts.isNamedImports(clause.namedBindings), "namespace imports are not policy proof");
        for (const binding of clause.namedBindings.elements) {
          assert(!binding.propertyName, "policy imports must not be renamed");
          assert(!imports.has(binding.name.text), "duplicate imported binding");
          imports.set(binding.name.text, origin);
          namedImports.add(binding.name.text);
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      assert(statement.declarationList.flags & ts.NodeFlags.Const, "immutable policy constants");
      for (const binding of statement.declarationList.declarations) {
        assert(
          ts.isIdentifier(binding.name) && binding.initializer,
          "finite named constant required",
        );
        assert(
          !bindings.has(binding.name.text) && !imports.has(binding.name.text),
          "duplicate binding",
        );
        bindings.set(binding.name.text, binding.initializer);
      }
    } else {
      assert(ts.isExportAssignment(statement), "no uninspected top-level policy execution");
    }
  }
  for (const name of ["configDefaults", "defineConfig", "mergeConfig"]) {
    assert.equal(imports.get(name), "vitest/config", `real Vitest ${name} import`);
    assert(namedImports.has(name), "direct named Vitest policy import");
  }
  assert.equal(imports.get("playwright"), "@vitest/browser-playwright", "real native provider");
  assert(namedImports.has("playwright"), "direct named native provider import");
  assert.equal(imports.get("viteConfig"), "./vite.config.ts", "existing Vite base only");
  assert(!namedImports.has("viteConfig"), "existing default Vite import");
  assert.deepEqual(
    [...bindings.keys()].sort(),
    [
      "browserOptions",
      "contextMotionFile",
      "diagnosticMotionFile",
      "srcPath",
      "touchTimelineFile",
      "touchViewport",
      "visualizationFluidFile",
      "visualizationMotionFile",
    ].sort(),
    "finite reviewed policy constants only",
  );
  // This pre-existing path helper is the only non-literal constant. Bind its
  // known syntax instead of executing it or permitting arbitrary helper calls.
  assert.equal(imports.get("fileURLToPath"), "node:url");
  assert.equal(
    bindings.get("srcPath")?.getText(file).replace(/\s+/g, ""),
    'fileURLToPath(newURL("./src",import.meta.url))',
  );

  function dereference(expression: ts.Expression, seen = new Set<string>()): ts.Expression {
    if (!ts.isIdentifier(expression)) return expression;
    assert(!seen.has(expression.text), "cyclic policy constant");
    const value = bindings.get(expression.text);
    assert(value, `unknown policy constant: ${expression.text}`);
    return dereference(value, new Set([...seen, expression.text]));
  }

  function fields(expression: ts.Expression, allowedSpread?: string) {
    const object = dereference(expression);
    assert(ts.isObjectLiteralExpression(object), "literal policy object required");
    const result = new Map<string, ts.Expression>();
    let spreads = 0;
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        assert(allowedSpread && ts.isIdentifier(property.expression), "unknown object spread");
        assert.equal(property.expression.text, allowedSpread, "exact inherited browser policy");
        assert.equal(++spreads, 1, "no duplicate policy spread");
        // An inherited spread belongs before explicit properties. A later
        // spread could silently replace an already-inspected provider policy.
        assert.equal(result.size, 0, "policy spread must precede owned fields");
        continue;
      }
      assert(ts.isPropertyAssignment(property), "plain policy property required");
      assert(
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name),
        "computed policy keys are not admitted",
      );
      const key = property.name.text;
      assert(!result.has(key), `duplicate policy key: ${key}`);
      result.set(key, property.initializer);
    }
    if (allowedSpread) assert.equal(spreads, 1, "shared native browser options required");
    return result;
  }

  function required(values: ReadonlyMap<string, ts.Expression>, name: string) {
    const expression = values.get(name);
    assert(expression, `missing policy field: ${name}`);
    return expression;
  }

  function keys(values: ReadonlyMap<string, ts.Expression>, expected: readonly string[]) {
    assert.deepEqual([...values.keys()].sort(), [...expected].sort(), "exact policy keys");
  }

  function literal(expression: ts.Expression, depth = 0): unknown {
    assert(depth <= 16, "bounded literal policy nesting");
    const value = dereference(expression);
    if (ts.isStringLiteral(value) || ts.isNumericLiteral(value))
      return ts.isStringLiteral(value) ? value.text : Number(value.text);
    if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (ts.isArrayLiteralExpression(value)) {
      return value.elements.map((item) => {
        assert(ts.isExpression(item) && !ts.isSpreadElement(item), "finite literal array element");
        return literal(item, depth + 1);
      });
    }
    return Object.fromEntries(
      [...fields(value)].map(([name, item]) => [name, literal(item, depth + 1)]),
    );
  }

  function selectors(expression: ts.Expression, allowDefaults = false) {
    const value = dereference(expression);
    assert(ts.isArrayLiteralExpression(value), "literal selector array required");
    const paths: string[] = [];
    let inheritedExcludes = false;
    for (const item of value.elements) {
      if (ts.isSpreadElement(item)) {
        assert(
          allowDefaults && paths.length === 0 && !inheritedExcludes,
          "unknown selector spread",
        );
        const spread = item.expression;
        assert(
          ts.isPropertyAccessExpression(spread) &&
            ts.isIdentifier(spread.expression) &&
            spread.expression.text === "configDefaults" &&
            spread.name.text === "exclude",
          "only the existing Vitest default exclusions are inherited",
        );
        inheritedExcludes = true;
      } else {
        assert(ts.isExpression(item), "finite selector required");
        const path = literal(item);
        assert.equal(typeof path, "string", "literal file selector required");
        assert(typeof path === "string");
        paths.push(path);
      }
    }
    assert.equal(new Set(paths).size, paths.length, "duplicate file selectors");
    return { paths, inheritedExcludes };
  }

  function call(expression: ts.Expression, name: string, count: number) {
    assert(ts.isCallExpression(expression), "known policy factory call required");
    assert(ts.isIdentifier(expression.expression), "direct imported policy factory required");
    assert.equal(expression.expression.text, name, "exact policy factory");
    assert.equal(expression.arguments.length, count, "exact policy factory arguments");
    assert(!expression.typeArguments, "no provider type-expression substitution");
    return expression;
  }

  const exports = file.statements.filter(ts.isExportAssignment);
  assert.equal(exports.length, 1, "single configured browser test export");
  assert(!exports[0]!.isExportEquals, "ordinary default configuration export");
  const merge = call(exports[0]!.expression, "mergeConfig", 2);
  const base = merge.arguments[0]!;
  assert(ts.isIdentifier(base) && base.text === "viteConfig");
  const define = call(merge.arguments[1]!, "defineConfig", 1);
  const root = fields(define.arguments[0]!);
  keys(root, ["cacheDir", "optimizeDeps", "resolve", "server", "test"]);
  const test = fields(required(root, "test"));
  // A root include/browser array would be concatenated by project inheritance;
  // an extra worker, timeout, setup, retry or input field is not neutral here.
  keys(test, ["api", "clearMocks", "testTimeout", "hookTimeout", "projects"]);
  assert.deepEqual(literal(required(test, "api")), { strictPort: false });
  assert.equal(literal(required(test, "clearMocks")), false);
  assert.equal(literal(required(test, "testTimeout")), 30_000);
  assert.equal(literal(required(test, "hookTimeout")), 30_000);
  const sharedBrowser = bindings.get("browserOptions");
  assert(sharedBrowser, "shared browser options must be explicit");
  assert.deepEqual(literal(sharedBrowser), {
    enabled: true,
    headless: true,
    locators: { exact: false },
  });
  const projects = dereference(required(test, "projects"));
  assert(ts.isArrayLiteralExpression(projects), "finite browser project list required");
  return projects.elements.map((element): ProjectPolicy => {
    assert(
      ts.isExpression(element) && !ts.isSpreadElement(element),
      "owned project literal required",
    );
    const project = fields(element);
    keys(project, ["extends", "test"]);
    assert.equal(literal(required(project, "extends")), true, "inherited deadlines and worker cap");
    const options = fields(required(project, "test"));
    const name = literal(required(options, "name"));
    assert(typeof name === "string", "finite project name");
    keys(
      options,
      name === "desktop"
        ? ["name", "include", "exclude", "sequence", "browser"]
        : ["name", "include", "sequence", "browser"],
    );
    const include = selectors(required(options, "include"));
    const exclude = options.has("exclude")
      ? selectors(required(options, "exclude"), true)
      : { paths: [], inheritedExcludes: false };
    const sequence = fields(required(options, "sequence"));
    keys(sequence, ["groupOrder"]);
    const groupOrder = literal(required(sequence, "groupOrder"));
    assert(
      typeof groupOrder === "number" && Number.isSafeInteger(groupOrder),
      "finite project order",
    );
    const browser = fields(required(options, "browser"), "browserOptions");
    keys(
      browser,
      name === "touch" ? ["provider", "viewport", "instances"] : ["provider", "instances"],
    );
    const provider = required(browser, "provider");
    const providerCall = call(provider, "playwright", name === "desktop" ? 0 : 1);
    const providerOptions = providerCall.arguments.length
      ? literal(providerCall.arguments[0]!)
      : null;
    const instances = literal(required(browser, "instances"));
    assert(Array.isArray(instances) && instances.length === 1, "one native Chromium instance");
    const nativeInstances: readonly unknown[] = instances;
    const instance = nativeInstances[0];
    assert(instance !== null && typeof instance === "object", "finite native browser instance");
    assert.deepEqual(Object.keys(instance).sort(), ["browser", "name"]);
    assert("browser" in instance && instance.browser === "chromium", "native Chromium only");
    assert("name" in instance && typeof instance.name === "string", "exact public instance name");
    return {
      name,
      groupOrder,
      includes: include.paths,
      excludes: exclude.paths,
      inheritedExcludes: exclude.inheritedExcludes,
      providerOptions,
      instance: instance.name,
      viewport: browser.has("viewport") ? literal(required(browser, "viewport")) : null,
    };
  });
}

function assertProjectPolicy(projects: readonly ProjectPolicy[]) {
  assert.deepEqual(
    projects,
    [
      {
        name: "desktop",
        groupOrder: 0,
        includes: ["src/components/**/*.browser.tsx"],
        excludes: [touchFile, ...reducedFiles, fluidFile],
        inheritedExcludes: true,
        providerOptions: null,
        instance: "chromium",
        viewport: null,
      },
      {
        name: "touch",
        groupOrder: 1,
        includes: [touchFile],
        excludes: [],
        inheritedExcludes: false,
        providerOptions: {
          contextOptions: {
            hasTouch: true,
            isMobile: true,
            deviceScaleFactor: 1,
            viewport: { width: 430, height: 932 },
          },
        },
        instance: "chromium-touch",
        viewport: { width: 430, height: 932 },
      },
      {
        name: "visualization-fluid-motion",
        groupOrder: 2,
        includes: [fluidFile],
        excludes: [],
        inheritedExcludes: false,
        providerOptions: { contextOptions: { reducedMotion: "no-preference" } },
        instance: "chromium-visualization-fluid-motion",
        viewport: null,
      },
      {
        name: "context-reduced-motion",
        groupOrder: 3,
        includes: reducedFiles,
        excludes: [],
        inheritedExcludes: false,
        providerOptions: { contextOptions: { reducedMotion: "reduce" } },
        instance: "chromium-context-reduced-motion",
        viewport: null,
      },
    ],
    "exact independently owned input/motion projects",
  );
}

/** Only this source subtree is inventoried. Do not follow symlinks or silently
 * skip an unfamiliar entry: neither a generated/dependency tree nor another
 * directory can become browser-test ownership evidence through a traversal. */
function browserFiles(): readonly string[] {
  const root = resolve(repoRoot, "apps/web/src/components");
  const files: string[] = [];
  let entries = 0;
  function visit(directory: string, relativeParts: readonly string[], depth: number) {
    assert(depth <= 16, "bounded browser fixture directory depth");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert(++entries <= 10_000, "bounded browser fixture inventory");
      assert(!entry.isSymbolicLink(), "browser source inventory does not follow symlinks");
      const parts = [...relativeParts, entry.name];
      if (entry.isDirectory()) visit(join(directory, entry.name), parts, depth + 1);
      else {
        assert(entry.isFile(), "ordinary browser source entry required");
        if (entry.name.endsWith(".browser.tsx"))
          files.push(["src", "components", ...parts].join("/"));
      }
    }
  }
  visit(root, [], 0);
  return files.sort();
}

function assertInventory(projects: readonly ProjectPolicy[], files: readonly string[]) {
  assert(files.length > 0, "nonempty real browser fixture inventory");
  for (const project of projects) {
    for (const path of [...project.includes, ...project.excludes]) {
      if (path === "src/components/**/*.browser.tsx") continue;
      assert(files.includes(path), `selector must identify a current browser file: ${path}`);
    }
  }
  for (const path of files) {
    const owners = projects.filter(
      (project) =>
        project.includes.some(
          (selector) => selector === path || selector === "src/components/**/*.browser.tsx",
        ) && !project.excludes.includes(path),
    );
    assert.equal(owners.length, 1, `browser file must have exactly one project owner: ${path}`);
  }
}

function replaceOnce(source: string, before: string, after: string) {
  assert.equal(
    source.split(before).length,
    2,
    "negative fixture must replace one actual policy node",
  );
  return source.replace(before, after);
}

/** Count the real finite Vitest registrations without evaluating test bodies.
 * The existing five-opacity and two-width tables must remain complete; a skip,
 * dynamic registration or a smaller table is not ordinary-motion coverage. */
function assertCompleteFluidCases() {
  const path = resolve(repoRoot, "apps/web", fluidFile);
  const source = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let cases = 0;
  function visit(node: ts.Node) {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["it", "describe"].includes(node.expression.text)
    ) {
      assert.equal(node.name.text, "each", "no skipped/focused/conditional fluid registration");
    }
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === "it") {
        assert(
          node.arguments[0] && ts.isStringLiteral(node.arguments[0]),
          "literal fluid test name",
        );
        cases += 1;
      } else if (ts.isCallExpression(node.expression)) {
        const table = node.expression;
        if (
          ts.isPropertyAccessExpression(table.expression) &&
          ts.isIdentifier(table.expression.expression) &&
          table.expression.expression.text === "it"
        ) {
          assert.equal(table.expression.name.text, "each");
          assert.equal(table.arguments.length, 1, "one finite fluid table");
          const values = table.arguments[0];
          assert(values && ts.isArrayLiteralExpression(values), "literal fluid case table");
          assert(values.elements.every(ts.isNumericLiteral), "existing finite numeric fluid table");
          const numbers = values.elements.map((value) => Number(value.getText(file)));
          assert(
            numbers.every(Number.isFinite) && new Set(numbers).size === numbers.length,
            "unique finite fluid cases",
          );
          cases += numbers.length;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.equal(cases, 25, "complete ordinary-motion fluid lifecycle coverage");
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

describe("native browser project input and motion ownership", () => {
  it("binds exactly four sequential native contexts without executing the Vite configuration", () => {
    assertProjectPolicy(readProjects(browserConfigSource));
  });

  it("assigns every actual browser file exactly once with no silently omitted motion fixtures", () => {
    const projects = readProjects(browserConfigSource);
    assertProjectPolicy(projects);
    const files = browserFiles();
    expect(files).toEqual(expect.arrayContaining([touchFile, fluidFile, ...reducedFiles]));
    assertInventory(projects, files);
    assertCompleteFluidCases();
  });

  it("refuses duplicate and omitted ownership instead of accepting a smaller passing inventory", () => {
    const projects = readProjects(browserConfigSource);
    const files = browserFiles();
    const duplicate = projects.map((project) =>
      project.name === "desktop"
        ? { ...project, excludes: project.excludes.filter((path) => path !== fluidFile) }
        : project,
    );
    expect(() => assertInventory(duplicate, files)).toThrow(/exactly one project owner/);
    expect(() =>
      assertInventory(
        projects.filter((project) => project.name !== "visualization-fluid-motion"),
        files,
      ),
    ).toThrow(/exactly one project owner/);
  });

  it("refuses interpreted policy, inherited root selectors and local worker or deadline overrides", () => {
    const mutations: readonly (readonly [string, string])[] = [
      ['reducedMotion: "no-preference"', "reducedMotion: getMotionPolicy()"],
      ['reducedMotion: "no-preference"', 'reducedMotion: "reduce"'],
      ['name: "visualization-fluid-motion",', 'name: "visualization-fluid-motion", maxWorkers: 3,'],
      ["clearMocks: false,", 'clearMocks: false, include: ["src/components/**/*.browser.tsx"],'],
      ["clearMocks: false,", "clearMocks: false, browser: { instances: [] },"],
      ["testTimeout: 30_000,", "testTimeout: 60_000,"],
      ["hookTimeout: 30_000,", "hookTimeout: 60_000,"],
      ["sequence: { groupOrder: 2 }", "sequence: { groupOrder: 1 }"],
    ];
    for (const [before, after] of mutations) {
      const changed = replaceOnce(browserConfigSource, before, after);
      expect(() => assertProjectPolicy(readProjects(changed)), before).toThrow();
    }
  });

  it("retains complete Linux and exact ordinary-motion native-host CI selection with the original worker cap", () => {
    const workflow: unknown = parse(
      readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8"),
    );
    assert(record(workflow));
    const jobs = workflow.jobs;
    assert(record(jobs));
    const quality = jobs.quality;
    assert(record(quality) && Array.isArray(quality.steps));
    const steps: readonly unknown[] = quality.steps;
    assert(steps.every(record), "finite structured workflow steps");
    const linux = steps.filter((step) => record(step) && step.name === "Browser tests");
    expect(linux).toEqual([
      {
        name: "Browser tests",
        if: "runner.os == 'Linux'",
        run: "corepack yarn workspace @cafecode/web test:browser",
      },
    ]);
    const shared = steps.filter(
      (step) =>
        record(step) &&
        step.name === "Cross-platform Markdown, timeline, menus and file action browser tests",
    );
    expect(shared).toHaveLength(1);
    const step = shared[0];
    assert(record(step) && typeof step.run === "string");
    expect(Object.keys(step).sort()).toEqual(["if", "name", "run"]);
    expect(step.if).toBe("runner.os != 'Linux'");
    const argv = step.run.trim().split(/\s+/);
    expect(argv.slice(0, 5)).toEqual([
      "corepack",
      "yarn",
      "workspace",
      "@cafecode/web",
      "test:browser",
    ]);
    expect(argv.at(-1)).toBe("--maxWorkers=2");
    const selectors = argv.slice(5, -1);
    for (const path of selectors) expect(path).toMatch(/^src\/components\/[\w./-]+\.browser\.tsx$/);
    expect(selectors.filter((path) => path === fluidFile)).toEqual([fluidFile]);
    expect(selectors.filter((path) => path === touchFile)).toEqual([touchFile]);
    for (const path of reducedFiles)
      expect(selectors.filter((item) => item === path)).toEqual([path]);
  });
});
