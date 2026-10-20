// Native fixture owns exact child argv, stdio handles and retirement; keep that process boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn, spawnSync } from "node:child_process";
// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { watch, type FSWatcher } from "node:fs";
// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// Native fixture paths retain host drive, separator and namespace semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { GlideRuntime, glideChildEnvironment } from "../src/glide/runtime.ts";

interface Receipt {
  kind: string;
  sequence: number;
  foreground: { pid: number; birth: { seconds: number; microseconds: number } };
  pointer: { x: number; y: number };
  pid: number;
  birth: { seconds: number; microseconds: number };
  windows: number[];
}

// Opt-in live application compatibility, with a new process and private file.
// Existing TextEdit processes/documents are never selected or terminated. The
// owner uses Apple's test-only process argument to ignore restored documents.
it.skipIf(process.platform !== "darwin")(
  "edits only a fresh TextEdit document while retaining external foreground and pointer",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cafe-glide-textedit-"));
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const receiptPath = join(directory, "events");
    const executable = join(directory, "Owner");
    let owner: ReturnType<typeof spawn> | undefined;
    let ownerExit: Promise<void> | undefined;
    let runtime: GlideRuntime | undefined;
    let watcher: FSWatcher | undefined;
    let retired = false;
    let receipts: Receipt[] = [];
    let receiptError: unknown;
    let ownerDiagnostics = "";
    let windowDiscovery: unknown;
    const waiting = new Set<{
      accept: (values: Receipt[]) => boolean;
      resolve: () => void;
      reject: (error: unknown) => void;
    }>();
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        retired = true;
        watcher?.close();
        for (const value of waiting) value.reject(new Error("TextEdit owner retired."));
        waiting.clear();
        await runtime?.close();
        if (owner && ownerExit) {
          owner.stdin?.end();
          // Native opt-in fixture retains its exact wall-clock deadline, callback and child cleanup.
          // @effect-diagnostics-next-line globalTimers:off
          const force = setTimeout(() => owner?.kill("SIGKILL"), 1500);
          try {
            await ownerExit;
          } finally {
            clearTimeout(force);
          }
        }
        await rm(directory, { recursive: true, force: true });
      })());
    onTestFinished(cleanup);
    const bounded = async <A>(promise: Promise<A>, label: string): Promise<A> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            // Native opt-in fixture retains its exact wall-clock deadline, callback and child cleanup.
            // @effect-diagnostics-next-line globalTimers:off
            timer = setTimeout(() => reject(new Error(label)), 10_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const readReceipts = async () => {
      const source = await readFile(receiptPath, "utf8").catch(() => undefined);
      if (retired || source === undefined) return;
      const values = JSON.parse(source) as Receipt[];
      expect(Array.isArray(values) && values.length <= 128).toBe(true);
      if (values.length < receipts.length) return;
      receipts = values;
      const initial = receipts[0]!;
      for (const value of receipts) {
        expect(value.foreground).toEqual(initial.foreground);
        expect(value.pointer).toEqual(initial.pointer);
      }
      for (const value of waiting)
        if (value.accept(receipts)) {
          waiting.delete(value);
          value.resolve();
        }
    };
    const fail = (error: unknown) => {
      receiptError = error;
      for (const value of waiting) value.reject(error);
      waiting.clear();
      void runtime?.close();
    };
    const until = (accept: (values: Receipt[]) => boolean) =>
      new Promise<void>((resolveReady, reject) => {
        if (receiptError) {
          reject(receiptError);
          return;
        }
        if (accept(receipts)) {
          resolveReady();
          return;
        }
        waiting.add({ accept, resolve: resolveReady, reject });
      });
    try {
      await writeFile(
        join(directory, "Private Glide Qualification.txt"),
        "private initial marker\n",
        { mode: 0o600 },
      );
      const compiler = spawnSync(
        "xcrun",
        [
          "swiftc",
          "-target",
          `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
          fileURLToPath(new URL("./fixtures/glide-textedit-owner.fixture.swift", import.meta.url)),
          "-o",
          executable,
        ],
        { shell: false, timeout: 30_000, encoding: "utf8" },
      );
      expect(compiler.error).toBeUndefined();
      expect(compiler.status, compiler.stderr).toBe(0);
      watcher = watch(directory, (_event, name) => {
        if (name?.toString() === "events") void readReceipts().catch(fail);
      });
      watcher.on("error", fail);
      const ready = until((values) => values.some((value) => value.kind === "ready"));
      owner = spawn(executable, [directory], {
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
        env: {
          ...glideChildEnvironment(process.env),
          HOME: directory,
          CFFIXED_USER_HOME: directory,
          TMPDIR: directory,
        },
      });
      owner.stderr!.on("data", (chunk: Buffer) => {
        ownerDiagnostics = (ownerDiagnostics + chunk.toString("utf8")).slice(0, 4096);
      });
      ownerExit = new Promise<void>((resolveExit, reject) => {
        owner!.once("exit", (code, signal) => {
          ownerDiagnostics += `\nexit=${code} signal=${signal}`;
          resolveExit();
        });
        owner!.once("error", reject);
      });
      void ownerExit.catch(() => undefined);
      void ownerExit.then(() => {
        if (!retired) fail(new Error("Fresh owned TextEdit process/owner retired."));
      }, fail);
      await bounded(
        Promise.race([
          ready,
          ownerExit.then(() => {
            throw new Error("Fresh TextEdit owner exited before private document readiness.");
          }),
        ]),
        "Fresh TextEdit document readiness deadline.",
      );
      const owned = receipts.find((value) => value.kind === "ready")!;
      expect(owned.pid).toBeGreaterThan(0);
      expect(owned.birth.seconds).toBeGreaterThan(0);
      expect(owned.windows.length).toBeLessThanOrEqual(1);
      runtime = new GlideRuntime({
        helperPath: join(root, "apps/desktop/native/build", process.arch, "mac-glide"),
        allowedApps: ["com.apple.TextEdit"],
        inputMode: "background",
      });
      const probe = async () => {
        const before = receipts.length;
        const accepted = until((values) =>
          values.some((value) => value.sequence >= before && value.kind === "probe"),
        );
        owner!.stdin!.write("probe\n");
        await bounded(accepted, "Owned TextEdit preservation receipt deadline.");
        if (receiptError) throw receiptError;
      };
      const execute = async (code: string) => {
        await probe();
        const result = await runtime!.execute({ code });
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        await probe();
        return {
          result,
          text: result.content
            .filter((value) => value.type === "text")
            .map((value) => value.text)
            .join("\n"),
        };
      };
      const discovery = await execute(
        'nodeRepl.write(JSON.stringify(await glide.listWindows("com.apple.TextEdit",{emit:false})));',
      );
      windowDiscovery = JSON.parse(discovery.text);
      const privateWindows = (windowDiscovery as { id: number; title: string }[]).filter((value) =>
        value.title.startsWith("Private Glide Qualification"),
      );
      expect(privateWindows, discovery.text).toHaveLength(1);
      const initial = await execute(
        `var app = await glide.getApp("com.apple.TextEdit",{windowId:${privateWindows[0]!.id}}); await app.getAXStateAndScreenshot({disableDiffing:true});`,
      );
      expect(initial.text).toContain(`pid=${owned.pid} window=`);
      expect(initial.text).toContain("private initial marker");
      expect(initial.result.content.some((value) => value.type === "image")).toBe(true);
      const windowID = Number(initial.text.match(/\bwindow=(\d+)/)?.[1]);
      expect(windowID).toBeGreaterThan(0);
      const binding = until((values) =>
        values.some((value) => value.kind === "bound" && value.windows[0] === windowID),
      );
      owner!.stdin!.write(`bind ${windowID}\n`);
      await bounded(binding, "Owned TextEdit window binding deadline.");
      const area = initial.text
        .split("\n")
        .find((line) => line.includes("AXTextArea") && line.includes("private initial marker"))
        ?.match(/\b(\d+): AXTextArea/)?.[1];
      expect(area, initial.text).toBeDefined();
      const edited = await execute(
        `await app.click(${area}); await app.pressKey("super+a"); await app.typeText("Glide private TextEdit 👩‍💻 café"); await app.getAXState({disableDiffing:true});`,
      );
      expect(edited.text).toContain("Glide private TextEdit 👩‍💻 café");
      const selected = await execute(
        `await app.selectText(${area},"private",{selectionType:"cursor_after"}); await app.typeText(" verified"); await app.getAXStateAndScreenshot({disableDiffing:true});`,
      );
      expect(selected.text).toContain("Glide private verified TextEdit 👩‍💻 café");
      const image = selected.result.content.find((value) => value.type === "image");
      expect(image).toBeDefined();
      await mkdir(join(root, ".logs"), { recursive: true });
      await writeFile(
        join(root, ".logs/glide-textedit-fixture.png"),
        Buffer.from(image!.data, "base64"),
      );
      await writeFile(
        join(root, ".logs/glide-textedit-receipts.json"),
        JSON.stringify(receipts, null, 2) + "\n",
      );
    } catch (error) {
      await mkdir(join(root, ".logs"), { recursive: true });
      const ownReceipts = await readFile(receiptPath, "utf8").catch(() => "[]");
      await writeFile(
        join(root, ".logs/glide-textedit-failure.json"),
        JSON.stringify(
          { diagnostics: ownerDiagnostics, receipts: JSON.parse(ownReceipts), windowDiscovery },
          null,
          2,
        ),
      );
      throw new Error(`Owned TextEdit qualification failed: ${ownerDiagnostics}`, { cause: error });
    } finally {
      await cleanup();
    }
  },
  60_000,
);
