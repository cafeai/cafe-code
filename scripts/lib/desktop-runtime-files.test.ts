import assert from "node:assert/strict";
// Native fixture copies exercise the actual builder filter against regular
// installed-package files; completion cleanup joins every admitted operation.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
// The builder filter consumes native paths and native Stats, including Windows
// separators; the fixture must preserve that same filesystem boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { describe, expect, it, type TestContext } from "vitest";
import { build } from "tsdown";

import {
  createPdfFixture,
  createUnicodePdfFixture,
} from "../../apps/server/integration/fixtures/pdf.ts";
import { DESKTOP_RUNTIME_FILES } from "./desktop-runtime-files.ts";

const require = createRequire(import.meta.url);
const { FileMatcher } =
  require("app-builder-lib/out/fileMatcher.js") as typeof import("app-builder-lib/out/fileMatcher.js");
const repositoryRoot = resolve(import.meta.dirname, "../..");

async function fixture(context: TestContext) {
  let retired = false;
  let root: string | undefined;
  const releases: Array<() => void> = [];
  const pending = new Set<Promise<unknown>>();
  const own = <A>(start: () => Promise<A>): Promise<A> => {
    assert.ok(!retired && !context.signal.aborted, "Packaging fixture retired.");
    const operation = start();
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  };
  const retire = () => {
    if (retired) return;
    retired = true;
    for (const release of releases) release();
  };
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(async () => {
    retire();
    // A compiler or the production PDF child may settle after cancellation.
    // Keep its exact target until its own operation/native close completes.
    while (pending.size) await Promise.allSettled([...pending]);
    if (root) await rm(root, { recursive: true, force: true });
    context.signal.removeEventListener("abort", retire);
  });
  await own(async () => {
    root = await mkdtemp(join(tmpdir(), "cafe-runtime-payload-"));
  });
  assert.ok(root);
  const parent = root;
  const directory = join(parent, "application");
  await own(() => mkdir(directory));
  const filter = new FileMatcher(directory, directory, (value) => value, [
    "**/*",
    ...DESKTOP_RUNTIME_FILES,
  ]).createFilter();
  const copyPackage = (name: string) =>
    own(async () => {
      const source = dirname(
        require.resolve(name === "@anthropic-ai/claude-agent-sdk" ? name : `${name}/package.json`),
      );
      const destination = join(directory, "node_modules", name);
      await cp(source, destination, {
        recursive: true,
        filter: async (input, output) => {
          const metadata = await lstat(input);
          assert.ok(!metadata.isSymbolicLink(), "Fixture package must contain regular entries.");
          return filter(output, metadata);
        },
      });
    });
  const defer = (release: () => void) => {
    if (retired) release();
    else releases.push(release);
  };
  return { root: directory, parent, own, filter, copyPackage, defer };
}

describe("desktop runtime payload selection", () => {
  it("excludes development and fallback payloads while retaining actual runtime code and native ownership assets", async (context) => {
    const owned = await fixture(context);
    for (const [name, admitted] of [
      ["apps/server/dist/bin.mjs", true],
      ["apps/server/dist/bin.mjs.map", false],
      ["apps/server/dist/client/assets/app.js", true],
      ["apps/server/dist/client/assets/app.js.br", true],
      ["apps/desktop/prod-resources/icon.png", true],
      ["apps/desktop/prod-resources/managed-runtime/install.ps1", false],
      ["node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs", true],
      ["node_modules/@anthropic-ai/claude-agent-sdk/core.mjs", true],
      ["node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude", false],
      ["node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe", false],
      ["node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude", false],
      ["node_modules/@anthropic-ai/sdk/index.mjs", false],
      ["node_modules/@napi-rs/canvas/index.js", false],
      ["node_modules/@napi-rs/canvas-darwin-arm64/skia.node", false],
      ["node_modules/node-pty/build/Release/pty.node", true],
      ["node_modules/node-pty/build/Release/spawn-helper", true],
      ["node_modules/effect/dist/Effect.js", true],
      ["node_modules/effect/src/Effect.ts", false],
      ["node_modules/effect/LICENSE", true],
      ["node_modules/@effect/platform-node/src/NodeRuntime.ts", false],
      ["node_modules/pdfjs-dist/legacy/build/pdf.mjs", true],
      ["node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", true],
      ["node_modules/pdfjs-dist/cmaps/UniJIS-UTF16-H.bcmap", true],
      ["node_modules/pdfjs-dist/standard_fonts/FoxitSans.pfb", true],
      ["node_modules/pdfjs-dist/wasm/openjpeg.wasm", true],
      ["node_modules/pdfjs-dist/LICENSE", true],
      ["node_modules/pdfjs-dist/build/pdf.worker.mjs", false],
      ["node_modules/pdfjs-dist/legacy/build/pdf.min.mjs", false],
      ["node_modules/pdfjs-dist/web/pdf_viewer.mjs", false],
      ["node_modules/another-package/src/runtime.js", true],
    ] as const) {
      const filename = join(owned.root, name);
      await owned.own(async () => {
        await mkdir(dirname(filename), { recursive: true });
        await writeFile(filename, "synthetic payload");
        expect(owned.filter(filename, await lstat(filename)), name).toBe(admitted);
      });
    }
  });

  it("runs the real SDK with the selected executable and no bundled CLI or API peer runtime", async (context) => {
    const owned = await fixture(context);
    await owned.copyPackage("@anthropic-ai/claude-agent-sdk");
    const entry = join(owned.root, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");
    const isolatedRequire = createRequire(pathToFileURL(entry));
    assert.throws(() => isolatedRequire.resolve("@anthropic-ai/sdk"));
    assert.throws(() =>
      isolatedRequire.resolve(
        `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
      ),
    );
    const sdk = (await owned.own(
      () => import(/* @vite-ignore */ pathToFileURL(entry).href),
    )) as typeof import("@anthropic-ai/claude-agent-sdk");
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let launches = 0;
    let killed = false;
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      killed: false,
      exitCode: null as number | null,
      kill() {
        killed = true;
        child.killed = true;
        child.exitCode = 0;
        stdin.end();
        stdout.end();
        stderr.end();
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
        return true;
      },
    });
    const closed = owned.own(() => new Promise<void>((accept) => child.once("close", accept)));
    owned.defer(() => {
      child.kill();
    });
    stdin.on("finish", () => {
      child.kill();
    });
    let buffered = "";
    stdin.on("data", (chunk) => {
      buffered += String(chunk);
      for (let newline; (newline = buffered.indexOf("\n")) >= 0;) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const request = JSON.parse(line);
        if (request.type === "control_request" && request.request.subtype === "initialize") {
          stdout.write(
            JSON.stringify({
              type: "control_response",
              response: {
                subtype: "success",
                request_id: request.request_id,
                response: {
                  commands: [],
                  models: [],
                  account: { email: "fixture@example.invalid" },
                },
              },
            }) + "\n",
          );
        }
      }
    });
    const query = sdk.query({
      prompt: (async function* () {
        /* initialization only */
      })(),
      options: {
        cwd: owned.root,
        persistSession: false,
        settingSources: [],
        env: { HOME: owned.root, USERPROFILE: owned.root, CLAUDE_CONFIG_DIR: owned.root },
        pathToClaudeCodeExecutable: "selected-fixture-cli",
        spawnClaudeCodeProcess(options) {
          launches++;
          expect(options.command).toBe("selected-fixture-cli");
          return child;
        },
      },
    });
    owned.defer(() => query.close());
    try {
      const initialized = await owned.own(() => query.initializationResult());
      expect(initialized.account?.email).toBe("fixture@example.invalid");
      expect(launches).toBe(1);
    } finally {
      query.close();
      await closed;
    }
    expect(killed).toBe(true);
  }, 10_000);

  it("extracts bounded Latin and non-Latin PDF text with the packaged parser and no optional Canvas", async (context) => {
    const owned = await fixture(context);
    await owned.copyPackage("pdfjs-dist");
    const pdfEntry = join(owned.root, "node_modules/pdfjs-dist/legacy/build/pdf.mjs");
    const borrowed = join(owned.parent, "borrowed-canvas.txt");
    await owned.own(async () => {
      const ancestorCanvas = join(owned.parent, "node_modules/@napi-rs/canvas");
      await mkdir(ancestorCanvas, { recursive: true });
      await writeFile(
        join(ancestorCanvas, "package.json"),
        JSON.stringify({ name: "@napi-rs/canvas", main: "index.cjs" }),
      );
      await writeFile(
        join(ancestorCanvas, "index.cjs"),
        `require("node:fs").writeFileSync(${JSON.stringify(borrowed)}, "borrowed"); module.exports = {};`,
      );
      // An unguarded library resolve really can borrow this exact parent file.
      // Windows may return its 8.3 alias, so compare native canonical paths
      // rather than treating the spelling of a temp directory as identity.
      expect(
        await realpath(createRequire(pathToFileURL(pdfEntry)).resolve("@napi-rs/canvas")),
      ).toBe(await realpath(join(ancestorCanvas, "index.cjs")));
    });
    expect(await readdir(dirname(pdfEntry))).toEqual(
      expect.arrayContaining(["pdf.mjs", "pdf.worker.mjs"]),
    );
    await owned.own(() =>
      build({
        config: false,
        entry: {
          extraction: join(repositoryRoot, "apps/server/src/provider/fileAttachmentExtraction.ts"),
        },
        outDir: owned.root,
        clean: false,
        dts: false,
        sourcemap: false,
        deps: { alwaysBundle: (id) => id.startsWith("@cafecode/") },
      }),
    );
    const extraction = (await owned.own(
      () => import(/* @vite-ignore */ pathToFileURL(join(owned.root, "extraction.mjs")).href),
    )) as typeof import("../../apps/server/src/provider/fileAttachmentExtraction.ts");
    for (const [bytes, text] of [
      [createPdfFixture("Packaged PDF body"), "Packaged PDF body"],
      [createUnicodePdfFixture("日本語 한글"), "日本語 한글"],
    ] as const) {
      const result = await owned.own(() => extraction.extractFileAttachmentText("pdf", bytes));
      expect(result).toMatchObject({
        hasText: true,
        pagesRead: 1,
        totalPages: 1,
        truncated: false,
      });
      expect(result?.text.replace(/\s+/gu, " ")).toContain(text);
    }
    const bounded = await owned.own(() =>
      extraction.extractFileAttachmentText("pdf", createPdfFixture("page text", 201)),
    );
    expect(bounded).toMatchObject({
      hasText: true,
      pagesRead: 200,
      totalPages: 201,
      truncated: true,
    });
    expect(bounded?.text).not.toContain("[Page 201]");
    const empty = await owned.own(() =>
      extraction.extractFileAttachmentText("pdf", createPdfFixture("")),
    );
    expect(empty).toMatchObject({ hasText: false, pagesRead: 1, totalPages: 1 });
    expect(
      await owned.own(() =>
        extraction.extractFileAttachmentText("pdf", Buffer.from("%PDF-1.4\nmalformed")),
      ),
    ).toBeUndefined();
    await expect(lstat(borrowed)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("executes the bundled backend patch parser without the browser diff/highlighter dependency tree", async (context) => {
    const owned = await fixture(context);
    const { default: configs } = await import("../../apps/server/tsdown.config.ts");
    assert.ok(Array.isArray(configs));
    const production = configs[0];
    assert.ok(production && typeof production === "object" && "deps" in production);
    const deps = production.deps;
    assert.ok(deps);
    await owned.own(() =>
      build({
        config: false,
        entry: { diffs: join(repositoryRoot, "apps/server/src/checkpointing/Diffs.ts") },
        outDir: owned.root,
        clean: false,
        dts: false,
        sourcemap: false,
        deps,
      }),
    );
    const parser = (await owned.own(
      () => import(/* @vite-ignore */ pathToFileURL(join(owned.root, "diffs.mjs")).href),
    )) as typeof import("../../apps/server/src/checkpointing/Diffs.ts");
    expect(
      parser.parseTurnDiffFilesFromUnifiedDiff(
        "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1,2 @@\n-old\n+new\n+added\n",
      ),
    ).toEqual([{ path: "example.ts", additions: 2, deletions: 1 }]);
  }, 20_000);
});
