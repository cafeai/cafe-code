import assert from "node:assert/strict";
// These synthetic native children are held through close, including aborts;
// they import only an inert fixture graph, never an application or provider.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFile } from "node:child_process";
// Native no-follow/hard-link tests exercise the same owned filesystem boundary
// as the dependency preparer. Cleanup joins every operation before retirement.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
// The actual loader consumes native paths, including Windows separators.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "tsdown";
import { describe, expect, it, type TestContext } from "vitest";
import { prepareRuntimeDependencies } from "./prepare-runtime-dependencies.ts";
import { createServerDevelopmentController } from "../../apps/server/scripts/dev.mjs";
import { pruneCopiedElectronLocales } from "./electron-locale-files.ts";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");

async function fixture(context: TestContext) {
  let root: string | undefined;
  let retired = false;
  const pending = new Set<Promise<unknown>>();
  const own = <A>(start: () => Promise<A>): Promise<A> => {
    assert.ok(!retired && !context.signal.aborted);
    const operation = start();
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  };
  const retire = () => {
    retired = true;
  };
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(async () => {
    retire();
    while (pending.size) await Promise.allSettled(pending);
    if (root) await rm(root, { recursive: true, force: true });
    context.signal.removeEventListener("abort", retire);
  });
  await own(async () => {
    root = await mkdtemp(join(tmpdir(), "cafe-runtime-parity-"));
  });
  assert.ok(root);
  const directory = root;
  const put = (name: string, value: string) =>
    own(async () => {
      const target = join(directory, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, value);
    });
  const packageAt = async (
    name: string,
    files: Record<string, string>,
    dependencies: Record<string, string> = {},
  ) => {
    await put(
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, version: "1.0.0", main: "index.cjs", dependencies }),
    );
    for (const [file, value] of Object.entries(files))
      await put(`node_modules/${name}/${file}`, value);
  };
  const compilePolicy = async () => {
    const output = join(directory, "compiled");
    await own(() =>
      build({
        config: false,
        entry: { policy: join(repository, "packages/shared/src/runtimeDependencies.ts") },
        outDir: output,
        dts: false,
        sourcemap: false,
      }),
    );
    return pathToFileURL(join(output, "policy.mjs")).href;
  };
  const run = (program: string) =>
    own(async () => {
      const operation = execute(process.execPath, ["--input-type=module", "--eval", program], {
        env: {
          HOME: directory,
          USERPROFILE: directory,
          ELECTRON_RUN_AS_NODE: "1",
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        },
        cwd: directory,
        signal: context.signal,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
        windowsHide: true,
      });
      const closed = new Promise<void>((accept) => operation.child.once("close", () => accept()));
      try {
        return await operation;
      } finally {
        await closed;
      }
    });
  return { root: directory, own, put, packageAt, compilePolicy, run };
}

describe("local application dependency parity", () => {
  it("orders the actual renderer, backend and desktop builds while refreshing private runtime pointers", async (context) => {
    const f = await fixture(context);
    const configurationRoot = join(f.root, "configuration");
    await f.own(() => mkdir(configurationRoot));
    const platform = process.platform === "win32" ? "windows" : process.platform;
    const architecture = process.arch === "x64" ? "64" : process.arch;
    // Execute the pinned installed native CLI directly: no installer fallback,
    // daemon, application launch or inherited user configuration is admitted.
    const binary = createRequire(import.meta.url).resolve(
      `@turbo/${platform}-${architecture}/bin/turbo${process.platform === "win32" ? ".exe" : ""}`,
    );
    const { stdout } = await f.own(async () => {
      const operation = execute(
        binary,
        [
          "run",
          "build",
          "--filter=@cafecode/desktop",
          "--filter=@cafeai/cafe-code",
          "--dry=json",
          "--no-daemon",
        ],
        {
          cwd: repository,
          env: {
            HOME: f.root,
            USERPROFILE: f.root,
            // Turbo 2.11.4 resolves global configuration separately from HOME
            // on Windows. Give both its explicit directory selectors and the
            // native platform defaults the same empty, test-owned namespace;
            // never inherit a runner's real config, authentication or cache.
            APPDATA: configurationRoot,
            LOCALAPPDATA: configurationRoot,
            XDG_CONFIG_HOME: configurationRoot,
            TURBO_CONFIG_DIR_PATH: configurationRoot,
            VERCEL_CONFIG_DIR_PATH: configurationRoot,
            DO_NOT_TRACK: "1",
            CI: "1",
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
          },
          signal: context.signal,
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
          windowsHide: true,
        },
      );
      const closed = new Promise<void>((accept) => operation.child.once("close", () => accept()));
      try {
        return await operation;
      } finally {
        await closed;
      }
    });
    const graph = JSON.parse(stdout) as {
      tasks: {
        taskId: string;
        dependencies: string[];
        resolvedTaskDefinition: { cache: boolean };
      }[];
    };
    const tasks = new Map(graph.tasks.map((task) => [task.taskId, task]));
    const dependencies = (id: string, seen = new Set<string>()): Set<string> => {
      const task = tasks.get(id);
      assert.ok(task, `Missing build task: ${id}`);
      for (const dependency of task.dependencies) {
        if (seen.has(dependency)) continue;
        seen.add(dependency);
        dependencies(dependency, seen);
      }
      return seen;
    };
    expect(dependencies("@cafeai/cafe-code#build")).toContain("@cafecode/web#build");
    expect(dependencies("@cafecode/desktop#build")).toContain("@cafeai/cafe-code#build");
    for (const id of ["@cafeai/cafe-code#build", "@cafecode/desktop#build"])
      expect(tasks.get(id)?.resolvedTaskDefinition.cache).toBe(false);
  });
  it("physically omits the shipping exclusions and refuses both import and require fallback to parent development packages", async (context) => {
    const f = await fixture(context);
    await f.packageAt("retained", {
      "index.cjs": "module.exports = { value: 17 };",
      "index.cjs.map": "not runtime",
      "symbols.pdb": "not runtime",
      "native.dll": "inert Windows fixture",
      "native.exe": "inert Windows fixture",
    });
    await f.packageAt("@napi-rs/canvas", { "index.cjs": "module.exports = 'must not load';" });
    await f.packageAt("@anthropic-ai/sdk", { "index.cjs": "module.exports = 'must not load';" });
    await f.packageAt("development-only", { "index.cjs": "module.exports = 'must not load';" });
    await f.own(() => mkdir(join(f.root, "dist")));
    const prepared = prepareRuntimeDependencies(f.root, join(f.root, "dist"), {
      retained: "1.0.0",
      "@napi-rs/canvas": "1.0.0",
    });
    const generation = JSON.parse(prepared.code).generation as string;
    await expect(lstat(join(generation, "node_modules/@napi-rs/canvas"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      lstat(join(generation, "node_modules/retained/index.cjs.map")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      lstat(join(generation, "node_modules/retained/symbols.pdb")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const file of ["native.dll", "native.exe"]) {
      const candidate = join(generation, "node_modules/retained", file);
      if (process.platform === "win32") expect((await lstat(candidate)).isFile()).toBe(true);
      else await expect(lstat(candidate)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const policy = await f.compilePolicy();
    const result = await f.run(`
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      import { installRuntimeDependencyRoot } from ${JSON.stringify(policy)};
      const request = createRequire(${JSON.stringify(pathToFileURL(join(f.root, "dist/entry.mjs")).href)});
      assert.ok(request.resolve("development-only").endsWith("index.cjs"));
      const guard = installRuntimeDependencyRoot(${JSON.stringify(generation)});
      try {
        assert.equal(request("retained").value, 17);
        assert.equal((await import("retained")).default.value, 17);
        for (const name of ["@napi-rs/canvas", "@anthropic-ai/sdk", "development-only"]) {
          assert.throws(() => request(name), { code: "MODULE_NOT_FOUND" });
          await assert.rejects(import(name), { code: "MODULE_NOT_FOUND" });
        }
        console.log("retained code loaded; all development fallbacks refused");
      } finally { guard.deregister(); }
    `);
    expect(result.stdout).toContain("all development fallbacks refused");
  }, 20_000);

  it("preserves exact nested dependency versions and refuses a missing retained file instead of borrowing a parent", async (context) => {
    const f = await fixture(context);
    await f.packageAt(
      "retained",
      { "index.cjs": "module.exports = require('versioned');" },
      { versioned: "1.0.0" },
    );
    await f.packageAt("versioned", { "index.cjs": "module.exports = 2;" });
    await f.put(
      "node_modules/retained/node_modules/versioned/package.json",
      JSON.stringify({ name: "versioned", version: "1.0.0", main: "index.cjs" }),
    );
    await f.put("node_modules/retained/node_modules/versioned/index.cjs", "module.exports = 1;");
    await f.own(() => mkdir(join(f.root, "dist")));
    const prepared = prepareRuntimeDependencies(f.root, join(f.root, "dist"), {
      retained: "1.0.0",
      versioned: "2.0.0",
    });
    const generation = JSON.parse(prepared.code).generation as string;
    const policy = await f.compilePolicy();
    const first = await f.run(
      `import {createRequire} from "node:module"; import {installRuntimeDependencyRoot} from ${JSON.stringify(policy)}; const require=createRequire(${JSON.stringify(pathToFileURL(join(f.root, "dist/entry.mjs")).href)}); const guard=installRuntimeDependencyRoot(${JSON.stringify(generation)}); try { console.log(JSON.stringify([require("retained"),require("versioned")])); } finally { guard.deregister(); }`,
    );
    expect(JSON.parse(first.stdout)).toEqual([1, 2]);
    await f.own(() => rm(join(generation, "node_modules/versioned/index.cjs")));
    const missing = await f.run(
      `import assert from "node:assert/strict"; import{createRequire}from"node:module"; import{installRuntimeDependencyRoot}from${JSON.stringify(policy)}; const require=createRequire(${JSON.stringify(pathToFileURL(join(f.root, "dist/entry.mjs")).href)}); const guard=installRuntimeDependencyRoot(${JSON.stringify(generation)});try{assert.throws(()=>require("versioned"),{code:"MODULE_NOT_FOUND"});console.log("missing file refused");}finally{guard.deregister();}`,
    );
    expect(missing.stdout).toContain("missing file refused");
  }, 20_000);

  it("rechecks complete generation bytes and retains a corrupt old generation while publishing a fresh copy", async (context) => {
    const f = await fixture(context);
    await f.packageAt("retained", { "index.cjs": "module.exports = 1;" });
    await f.own(() => mkdir(join(f.root, "dist")));
    const first = prepareRuntimeDependencies(f.root, join(f.root, "dist"), { retained: "1.0.0" });
    const original = JSON.parse(first.code).generation as string;
    expect(
      prepareRuntimeDependencies(f.root, join(f.root, "dist"), { retained: "1.0.0" }).code,
    ).toBe(first.code);
    await f.own(async () => {
      const file = join(original, "node_modules/retained/index.cjs");
      await chmod(file, 0o600);
      await writeFile(file, "module.exports = 2;");
    });
    const next = JSON.parse(
      prepareRuntimeDependencies(f.root, join(f.root, "dist"), { retained: "1.0.0" }).code,
    ).generation as string;
    expect(next).not.toBe(original);
    expect(await readFile(join(original, "node_modules/retained/index.cjs"), "utf8")).toBe(
      "module.exports = 2;",
    );
    expect(await readFile(join(next, "node_modules/retained/index.cjs"), "utf8")).toBe(
      "module.exports = 1;",
    );
  });

  it("rejects linked installed payloads before writing a runtime generation", async (context) => {
    const f = await fixture(context);
    await f.packageAt("retained", { "index.cjs": "module.exports = 1;" });
    await f.own(() => mkdir(join(f.root, "dist")));
    await f.own(() =>
      link(join(f.root, "node_modules/retained/index.cjs"), join(f.root, "linked-payload.cjs")),
    );
    expect(() =>
      prepareRuntimeDependencies(f.root, join(f.root, "dist"), { retained: "1.0.0" }),
    ).toThrow("Unsafe runtime dependency file");
    expect(await readdir(join(f.root, "dist"))).toEqual([]);
  });

  it("requires the local pointer and never falls through to a staged manifest after its generation is missing", async (context) => {
    const f = await fixture(context);
    await f.put(
      "package.json",
      JSON.stringify({ name: "@cafecode/desktop-runtime", private: true }),
    );
    await f.put("apps/server/dist/entry.mjs", "// inert application entry\n");
    await f.packageAt("retained", { "index.cjs": "module.exports = 1;" });
    const prepared = prepareRuntimeDependencies(f.root, join(f.root, "apps/server/dist"), {
      retained: "1.0.0",
    });
    const pointer = JSON.parse(prepared.code) as { generation: string };
    await f.own(() => rm(pointer.generation, { recursive: true }));
    const policy = await f.compilePolicy();
    const result = await f.run(
      `import assert from "node:assert/strict"; import{installApplicationRuntimeDependencies}from${JSON.stringify(policy)};assert.throws(()=>installApplicationRuntimeDependencies(${JSON.stringify(join(f.root, "apps/server/dist/entry.mjs"))}),{code:"ENOENT"});console.log("missing generation refused");`,
    );
    expect(result.stdout).toContain("missing generation refused");
  }, 20_000);
});

describe("source Electron locale selection", () => {
  it.for(["darwin", "linux", "win32"] as const)(
    "prunes only unsupported locales from the owned %s layout",
    async (platform, context) => {
      const f = await fixture(context);
      const directories =
        platform === "darwin"
          ? [
              "Contents/Resources",
              "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources",
            ]
          : ["locales"];
      const suffix = platform === "darwin" ? ".lproj" : ".pak";
      for (const directory of directories) {
        for (const language of ["en", "en-US", "ja", "ko", "fr", "de"])
          await f.put(
            `electron/${directory}/${language}${suffix}${platform === "darwin" ? "/locale.txt" : ""}`,
            "fixture",
          );
        await f.put(`electron/${directory}/icudtl.dat`, "retained native data");
      }
      pruneCopiedElectronLocales(join(f.root, "electron"), platform);
      for (const directory of directories)
        expect((await readdir(join(f.root, "electron", directory))).toSorted()).toEqual(
          [`en${suffix}`, `en-US${suffix}`, `ja${suffix}`, `ko${suffix}`, "icudtl.dat"].toSorted(),
        );
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a linked locale directory without following or removing its target",
    async (context) => {
      const f = await fixture(context);
      await f.put("outside/fr.pak", "retained outside fixture target");
      await f.own(() => mkdir(join(f.root, "electron")));
      await f.own(() => symlink(join(f.root, "outside"), join(f.root, "electron/locales"), "dir"));
      expect(() => pruneCopiedElectronLocales(join(f.root, "electron"), "linux")).toThrow(
        "Invalid copied Electron locale directory",
      );
      expect(await readFile(join(f.root, "outside/fr.pak"), "utf8")).toBe(
        "retained outside fixture target",
      );
    },
  );
});

describe("qualified backend watch admission", () => {
  it("joins the exact old child before replacement and coalesces identical successful build receipts", async () => {
    let build: string | undefined = "first";
    const started: number[] = [];
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const stopping = new Promise<void>((accept) => {
      entered = accept;
    });
    const gate = new Promise<void>((accept) => {
      release = accept;
    });
    const controller = createServerDevelopmentController({
      qualify: () => build,
      start: () => {
        const child = started.length + 1;
        started.push(child);
        return child;
      },
      stop: async (child) => {
        if (child === 1) {
          entered!();
          await gate;
        }
      },
    });
    try {
      await controller.built();
      await controller.built();
      expect(started).toEqual([1]);
      build = "second";
      const replacement = controller.built();
      await stopping;
      expect(started).toEqual([1]);
      release!();
      await replacement;
      expect(started).toEqual([1, 2]);
      build = undefined;
      await controller.built();
      expect(started).toEqual([1, 2]);
    } finally {
      release!();
      await controller.close();
    }
  });

  it("fences a queued replacement when retirement arrives during the old native close", async () => {
    let build = "first";
    let starts = 0;
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const stopping = new Promise<void>((accept) => {
      entered = accept;
    });
    const gate = new Promise<void>((accept) => {
      release = accept;
    });
    const controller = createServerDevelopmentController({
      qualify: () => build,
      start: () => ++starts,
      stop: async () => {
        entered!();
        await gate;
      },
    });
    try {
      await controller.built();
      build = "second";
      const replacement = controller.built();
      await stopping;
      const closed = controller.close();
      release!();
      await replacement;
      await closed;
      expect(starts).toBe(1);
      await controller.built();
      expect(starts).toBe(1);
    } finally {
      release!();
      await controller.close();
    }
  });
});
