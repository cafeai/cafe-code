import babel from "@rolldown/plugin-babel";
// These test-owned native paths outlive Vite's pending transforms and close.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, rmSync } from "node:fs";
// The synthetic server must use the host's actual temporary path spelling.
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { expect, it, type TestContext } from "vitest";
import { prepareBrowserCompilation } from "../browserCompilationReadiness.ts";
import { reactCompilerConfig } from "../reactCompilerConfig.ts";

const names = ["root", "child", "cycle"] as const;
const specifier = (name: (typeof names)[number]) => `virtual:cafe-compilation/${name}.ts`;
const moduleId = (name: (typeof names)[number]) => `\0${specifier(name)}`;
// Direct environment transforms consume graph URLs, not HTTP middleware's
// escaped /@id/ wire spelling for a NUL virtual-module identifier.
const rootUrl = moduleId("root");

async function fixture({ onTestFinished, signal }: TestContext) {
  let announceEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    announceEntered = resolve;
  });
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  const pending = new Set<Promise<unknown>>();
  const loads: string[] = [];
  const transformed = new Set<string>();
  let failChild = false;
  let retired = false;
  let directory: string | undefined;
  let serverPromise: Promise<ViteDevServer> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const retire = () => {
    retired = true;
    releaseHeld();
  };
  const assertActive = () => {
    if (retired || signal.aborted) throw new Error("The compilation fixture was retired.");
  };
  // Register ownership before directory/server creation or any awaited load.
  // A timeout releases only this gate, joins admitted work, then closes the
  // exact middleware server before removing its private root/cache.
  onTestFinished(() => {
    cleanupPromise ??= (async () => {
      retire();
      signal.removeEventListener("abort", retire);
      const server = await serverPromise?.catch(() => undefined);
      await Promise.allSettled([...pending]);
      try {
        await server?.close();
      } finally {
        if (directory) rmSync(directory, { recursive: true, force: true });
      }
    })();
    return cleanupPromise;
  });
  signal.addEventListener("abort", retire, { once: true });
  assertActive();
  directory = mkdtempSync(join(tmpdir(), "cafe-browser-compilation-"));
  const virtualModules: Plugin = {
    name: "cafe-owned-compilation-fixture",
    resolveId(id) {
      const name = names.find(
        (candidate) => id === specifier(candidate) || id === moduleId(candidate),
      );
      return name ? moduleId(name) : undefined;
    },
    async load(id) {
      if (!names.some((name) => id === moduleId(name))) return;
      assertActive();
      loads.push(id);
      if (id === moduleId("root"))
        return `import { child } from "${specifier("child")}"; throw new Error("The compiler fixture must never execute."); export const identity = <A>(value: A): A => value; export { child };`;
      if (id === moduleId("child")) {
        announceEntered();
        await held;
        assertActive();
        if (failChild) throw new Error("Synthetic current child compilation failure.");
        return `import { cycle } from "${specifier("cycle")}"; export const child: number = cycle;`;
      }
      return `import "${specifier("root")}"; export const cycle: number = 1;`;
    },
  };
  const observeTransforms: Plugin = {
    name: "cafe-owned-compilation-observation",
    enforce: "post",
    configResolved(config) {
      // The real compiler preset also recommends prebundling React's runtime.
      // This non-executing graph has no React runtime imports: disable only
      // unrelated optimizer discovery, never the compiler or its options.
      config.optimizeDeps.noDiscovery = true;
      config.optimizeDeps.include = [];
    },
    transform(_code, id) {
      if (names.some((name) => id === moduleId(name))) transformed.add(id);
    },
  };
  serverPromise = createServer({
    configFile: false,
    envDir: false,
    publicDir: false,
    root: directory,
    cacheDir: join(directory, ".vite"),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      middlewareMode: true,
      watch: null,
      hmr: false,
      ws: false,
      preTransformRequests: false,
    },
    plugins: [virtualModules, babel(reactCompilerConfig), observeTransforms],
  });
  const server = await serverPromise;
  assertActive();
  const environment = server.environments.client;
  if (!environment) throw new Error("The fixture has no native Vite client environment.");
  expect(server.httpServer).toBeNull();
  return {
    environment,
    entered,
    release: releaseHeld,
    loads,
    transformed,
    failCurrentChild: () => {
      assertActive();
      failChild = true;
      environment.moduleGraph.invalidateAll();
    },
    prepare: (urls: readonly string[], admission: () => void = () => undefined) => {
      assertActive();
      const operation = prepareBrowserCompilation(environment, urls, () => {
        assertActive();
        admission();
      });
      pending.add(operation);
      // Only cleanup's duplicate drain ignores rejection. The original promise
      // is returned unchanged, so the test still observes every real failure.
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    },
  };
}

it("awaits the real transitive compiler graph, terminates cycles and rejects a changed current load", async (context) => {
  const owned = await fixture(context);
  let settled = false;
  const preparation = owned.prepare([rootUrl]);
  void preparation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.race([
    owned.entered,
    preparation.then(() => {
      throw new Error("Compilation completed without reaching the held child.");
    }),
  ]);
  expect(settled).toBe(false);
  expect(owned.transformed.has(moduleId("root"))).toBe(true);
  expect(owned.transformed.has(moduleId("child"))).toBe(false);
  expect(owned.transformed.has(moduleId("cycle"))).toBe(false);
  owned.release();
  expect(await preparation).toBe(3);
  expect(owned.transformed).toEqual(new Set(names.map(moduleId)));
  expect(owned.loads).toEqual(names.map(moduleId));
  const root = await owned.environment.moduleGraph.getModuleByUrl(rootUrl);
  expect(root?.transformResult?.code).toContain("identity");
  expect(root?.transformResult?.code).not.toContain("<A>");

  // A prior successful walk is not a result cache. The same real environment
  // must see a current load failure after its public graph is invalidated.
  owned.failCurrentChild();
  await expect(owned.prepare([rootUrl])).rejects.toThrow(
    "Synthetic current child compilation failure.",
  );
  expect(owned.loads.filter((id) => id === moduleId("child"))).toHaveLength(2);
});

it("refuses oversized URLs and module inventories before admitting any real transform", async (context) => {
  const owned = await fixture(context);
  await expect(owned.prepare(["x".repeat(8193)])).rejects.toThrow("unsupported module URL");
  const tooMany = Array.from({ length: 20_001 }, (_, index) => `/virtual-${index}.ts`);
  await expect(owned.prepare(tooMany)).rejects.toThrow("finite module bound");
  expect(owned.loads).toEqual([]);
  expect(owned.transformed.size).toBe(0);
});

it("joins an admitted real transform but fences later compilation after retirement", async (context) => {
  const owned = await fixture(context);
  const stopped = new Error("Synthetic compilation admission retired.");
  let retired = false;
  const preparation = owned.prepare([rootUrl], () => {
    if (retired) throw stopped;
  });
  // Install the rejection observer before releasing the exact held native load.
  const refused = preparation.then(
    () => {
      throw new Error("Retired compilation unexpectedly completed.");
    },
    (error: unknown) => error,
  );
  await Promise.race([
    owned.entered,
    refused.then((error) => {
      throw error;
    }),
  ]);
  retired = true;
  owned.release();
  expect(await refused).toBe(stopped);
  expect(owned.loads).toEqual([moduleId("root"), moduleId("child")]);
  expect(owned.transformed.has(moduleId("cycle"))).toBe(false);
});
