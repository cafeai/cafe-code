// Native fixture owns exact child argv, stdio handles and retirement; keep that process boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { watch, type FSWatcher } from "node:fs";
// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// Native fixture paths retain host drive, separator and namespace semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { readGlideFrames, writeGlideFrame } from "../src/glide/framing.ts";
import { GlideRuntime, glideChildEnvironment } from "../src/glide/runtime.ts";

// Explicit opt-in native qualification. Missing macOS permissions fail this
// command; they never become an automatic skip or a synthetic success claim.
it.skipIf(process.platform !== "darwin")(
  "observes and edits only a test-owned AppKit application",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cafe-glide-mac-"));
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const bundle = join(directory, "GlideFixture.app");
    const executable = join(bundle, "Contents", "MacOS", "GlideFixture");
    let runtime: GlideRuntime | undefined, watcher: FSWatcher | undefined;
    let phase = "setup";
    const nativePhases: string[] = [];
    let child: ReturnType<typeof spawn> | undefined;
    let exited: Promise<void> | undefined;
    const peers: {
      child: ChildProcessWithoutNullStreams;
      exited: Promise<void>;
      frames: AsyncGenerator<unknown>;
    }[] = [];
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        watcher?.close();
        for (const peer of peers) {
          peer.child.stdin.end();
          peer.child.kill("SIGTERM");
          // Native opt-in fixture retains its exact wall-clock deadline, callback and child cleanup.
          // @effect-diagnostics-next-line globalTimers:off
          const force = setTimeout(() => peer.child.kill("SIGKILL"), 1500);
          try {
            await peer.exited;
            await peer.frames.return(undefined);
          } finally {
            clearTimeout(force);
            peer.child.stdout.destroy();
            peer.child.stderr.destroy();
          }
        }
        await runtime?.close();
        if (child && exited) {
          child.kill("SIGTERM");
          // Native opt-in fixture retains its exact wall-clock deadline, callback and child cleanup.
          // @effect-diagnostics-next-line globalTimers:off
          const force = setTimeout(() => child?.kill("SIGKILL"), 1000);
          try {
            await exited;
          } finally {
            clearTimeout(force);
          }
        }
        await rm(directory, { recursive: true, force: true });
      })());
    // Own cleanup before readiness awaits: finally alone does not retire a
    // native process when Vitest times out an unresolved asynchronous body.
    onTestFinished(cleanup);
    const bounded = async <A>(
      promise: Promise<A>,
      milliseconds: number,
      label: string,
    ): Promise<A> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_resolve, reject) => {
            // Native opt-in fixture retains its exact wall-clock deadline, callback and child cleanup.
            // @effect-diagnostics-next-line globalTimers:off
            timer = setTimeout(() => reject(new Error(label)), milliseconds);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      await mkdir(dirname(executable), { recursive: true });
      await writeFile(
        join(bundle, "Contents", "Info.plist"),
        `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.cafecode.glide-fixture</string><key>CFBundleExecutable</key><string>GlideFixture</string><key>CFBundleName</key><string>GlideFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
      );
      const compiler = spawnSync(
        "xcrun",
        [
          "swiftc",
          "-target",
          `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
          fileURLToPath(new URL("./fixtures/glide-mac.fixture.swift", import.meta.url)),
          "-o",
          executable,
        ],
        { shell: false, timeout: 30_000, encoding: "utf8" },
      );
      expect(compiler.status, compiler.stderr).toBe(0);
      const launcher = join(directory, "FixtureLauncher");
      await copyFile(executable, launcher);
      const receipt = join(directory, "ready");
      const ready = new Promise<void>((resolveReady, reject) => {
        watcher = watch(directory, (_event, name) => {
          if (name !== "ready") return;
          void readFile(receipt, "utf8").then(
            (text) => {
              if (text === "ready") resolveReady();
            },
            () => undefined,
          );
        });
        watcher.once("error", reject);
      });
      child = spawn(launcher, ["--launch-owned", bundle, receipt], {
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        env: {
          ...glideChildEnvironment(process.env),
          HOME: directory,
          CFFIXED_USER_HOME: directory,
          TMPDIR: directory,
        },
      });
      exited = new Promise<void>((resolveExit, reject) => {
        child!.once("exit", () => resolveExit());
        child!.once("error", reject);
      });
      phase = "fixture readiness";
      await bounded(
        Promise.race([
          ready,
          exited.then(() => {
            throw new Error("Native fixture exited before readiness.");
          }),
        ]),
        10_000,
        "Native fixture did not publish readiness.",
      );
      watcher?.close();
      watcher = undefined;
      runtime = new GlideRuntime({
        helperPath: join(root, "apps/desktop/native/build", process.arch, "mac-glide"),
        allowedApps: ["com.cafecode.glide-fixture"],
        inputMode: "foreground",
        onNativePhase: (phase) => {
          if (nativePhases.length < 64) nativePhases.push(phase);
        },
      });
      phase = "observation";
      const initial = await runtime.execute({
        code: 'nodeRepl.write(await glide.listApps({emit:false})); var app = await glide.getApp("com.cafecode.glide-fixture"); await app.getAXStateAndScreenshot();',
      });
      expect(
        initial.isError,
        (await readFile(receipt + ".identity", "utf8")) +
          JSON.stringify(initial.content.filter((item) => item.type === "text")),
      ).not.toBe(true);
      expect(
        initial.content.some((item) => item.type === "image"),
        "Screen Recording permission must be available for native screenshot qualification.",
      ).toBe(true);
      const text = initial.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const fieldLine = text
        .split("\n")
        .find((line) => line.includes("AXTextField") && line.includes("initial"));
      const index = fieldLine?.match(/\b(\d+): AXTextField/)?.[1];
      expect(index, text).toBeDefined();
      phase = "AX write";
      const edit = await runtime.execute({
        code: `await app.setValue(${index}, "café 👩‍💻"); await app.getAXState({disableDiffing:true});`,
      });
      expect(edit.isError, JSON.stringify(edit.content)).not.toBe(true);
      expect(
        edit.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      ).toContain("café 👩‍💻");
      phase = "click/key/Unicode chain";
      const typed = await runtime.execute({
        code: `await app.click(${index}); await app.pressKey("super+a"); await app.typeText("typed 👩‍💻"); await app.getAXState({disableDiffing:true});`,
      });
      expect(typed.isError, JSON.stringify(typed.content)).not.toBe(true);
      expect(
        typed.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      ).toContain("typed 👩‍💻");
      phase = "text selection";
      const selected = await runtime.execute({
        code: `await app.selectText(${index}, "typed", {selectionType:"cursor_after"}); await app.typeText(" café"); await app.getAXState({disableDiffing:true});`,
      });
      expect(selected.isError, JSON.stringify(selected.content)).not.toBe(true);
      expect(
        selected.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      ).toContain("typed café 👩‍💻");
      phase = "clipboard paste";
      const pasted = await runtime.execute({
        code: 'await app.pressKey("super+a"); await app.paste("pasted café"); await app.getAXState({disableDiffing:true});',
      });
      expect(pasted.isError, JSON.stringify(pasted.content)).not.toBe(true);
      const pastedText = pasted.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      expect(pastedText).toContain("pasted café");
      const button = pastedText
        .split("\n")
        .find((line) => line.includes("AXButton") && line.includes("Apply fixture"))
        ?.match(/\b(\d+): AXButton/)?.[1];
      expect(button).toBeDefined();
      phase = "advertised action";
      const applied = await runtime.execute({
        code: `await app.performSecondaryAction(${button}, "AXPress"); await app.getAXState({disableDiffing:true});`,
      });
      expect(applied.isError, JSON.stringify(applied.content)).not.toBe(true);
      expect(
        applied.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      ).toContain("applied: pasted café");
      phase = "rich paste";
      const rich = await runtime.execute({
        code:
          "await app.click(" +
          index +
          '); await app.pressKey("super+a"); await app.paste("**Markdown café**",{format:"md"}); await app.getAXState({disableDiffing:true});',
      });
      expect(rich.isError, JSON.stringify(rich.content)).not.toBe(true);
      expect(
        rich.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      ).toContain("Markdown café");
      const html = await runtime.execute({
        code: 'await app.pressKey("super+a"); await app.paste("<b>HTML café</b>",{format:"html"}); await app.getAXState({disableDiffing:true});',
      });
      expect(html.isError, JSON.stringify(html.content)).not.toBe(true);
      const htmlText = html.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      expect(htmlText).toContain("HTML café");
      const unsafe = await runtime.execute({
        code: 'await app.paste("<script>unsupported</script>",{format:"html"});',
      });
      expect(unsafe.isError).toBe(true);

      phase = "coordinate input";
      const area = htmlText.split("\n").find((line) => line.includes("Fixture pointer area"));
      const coordinates = area
        ?.match(/bounds=\[([^\]]+)\]/)?.[1]
        ?.split(",")
        .map(Number);
      expect(coordinates?.length).toBe(4);
      const [x, y, width, height] = coordinates!;
      const center = [x! + width! / 2, y! + height! / 2];
      const click = await runtime.execute({
        code:
          "await app.click(" +
          JSON.stringify(center) +
          "); await app.getAXState({disableDiffing:true});",
      });
      expect(click.isError, JSON.stringify(click.content)).not.toBe(true);
      expect(
        click.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      ).toContain("pointer clicked");
      const drag = await runtime.execute({
        code:
          "await app.drag(" +
          JSON.stringify([x! + 10, center[1]]) +
          "," +
          JSON.stringify([x! + width! - 10, center[1]]) +
          "); await app.getAXState({disableDiffing:true});",
      });
      expect(drag.isError, JSON.stringify(drag.content)).not.toBe(true);
      expect(
        drag.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      ).toContain("pointer dragged");
      const scroll = await runtime.execute({
        code:
          "await app.click(" +
          index +
          "); await app.scroll(" +
          JSON.stringify(center) +
          ',"down",0.25); await app.getAXState({disableDiffing:true});',
      });
      expect(scroll.isError, JSON.stringify(scroll.content)).not.toBe(true);
      expect(
        scroll.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n"),
      ).toContain("pointer scrolled down");

      const denied = await runtime.execute({
        code: 'await sky.get_app_state({app:"com.apple.finder"});',
      });
      expect(denied.isError).toBe(true);
      expect(denied.content).toEqual([
        {
          type: "text",
          text: "Error: Application is not allowed, not running, or ambiguous. Use listApps and its exact path.",
        },
      ]);
      await runtime.close();
      runtime = undefined;
      phase = "cross-session input ownership and parent EOF";
      const helper = join(root, "apps/desktop/native/build", process.arch, "mac-glide");
      const makePeer = async (name: string) => {
        const temporary = join(directory, name);
        await mkdir(temporary);
        const child = spawn(
          helper,
          ["--allow-app", "com.cafecode.glide-fixture", "--input-mode", "foreground"],
          {
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              ...glideChildEnvironment(process.env),
              TMPDIR: temporary,
            },
          },
        );
        const exited = new Promise<void>((resolveExit, reject) => {
          child.once("exit", () => resolveExit());
          child.once("error", reject);
        });
        const trace: string[] = [];
        child.stderr.on("data", (chunk: Buffer) => {
          for (const value of chunk
            .toString("utf8")
            .match(
              /glide\.phase=(?:native\.(?:initializing|ready|request|dispatch|lease)|state\.(?:window|ax|capture|commit)|capture\.(?:inventory|filter|image|encode))/g,
            ) ?? []) {
            if (trace.length < 64) trace.push(value);
          }
        });
        const peer = { child, exited, frames: readGlideFrames(child.stdout), trace, name };
        peers.push(peer);
        child.stderr.resume();
        return peer;
      };
      const first = await makePeer("first-native"),
        second = await makePeer("second-native");
      const ask = async (peer: typeof first, id: number, method: string, input: unknown) => {
        await writeGlideFrame(peer.child.stdin, { id, method, input, timeout_ms: 10_000 });
        const response = await bounded(
          peer.frames.next(),
          12_000,
          "Native peer did not respond during " + phase,
        ).catch((error: unknown) => {
          throw new Error(
            "Native peer " + peer.name + " request " + id + " stalled: " + peer.trace.join(","),
            { cause: error },
          );
        });
        expect(response.done).not.toBe(true);
        const result = response.value as { id: number; result?: unknown; error?: string };
        expect(result.id).toBe(id);
        return result;
      };
      expect(
        (await ask(first, 1, "get_app_state", { app: "com.cafecode.glide-fixture" })).error,
      ).toBeUndefined();
      expect(
        (await ask(second, 1, "get_app_state", { app: "com.cafecode.glide-fixture" })).error,
      ).toContain("Another session owns Glide input");
      expect(second.trace).not.toContain("glide.phase=state.window");
      expect(second.trace).not.toContain("glide.phase=capture.image");
      const held = new Promise<void>((resolveHeld) => {
        let tail = "";
        first.child.stderr.on("data", (chunk: Buffer) => {
          tail = (tail + chunk.toString("utf8")).slice(-256);
          if (tail.includes("glide.phase=key.down\n")) resolveHeld();
        });
      });
      await writeGlideFrame(first.child.stdin, {
        id: 2,
        method: "press_key",
        input: { app: "com.cafecode.glide-fixture", key: "a", duration: 5 },
        timeout_ms: 10_000,
      });
      phase = "native held-key admission";
      await bounded(
        Promise.race([
          held,
          first.frames.next().then((reply) => {
            throw new Error("Held input ended before admission: " + JSON.stringify(reply.value));
          }),
          first.exited.then(() => {
            throw new Error("Native input owner exited before admission.");
          }),
        ]),
        12_000,
        "Native key-down receipt was not delivered.",
      );
      const busy = await ask(second, 2, "press_key", {
        app: "com.cafecode.glide-fixture",
        key: "b",
      });
      expect(busy.error).toContain("Another session owns Glide input");
      first.child.stdin.end();
      let expiry: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          first.exited,
          new Promise<never>((_resolve, reject) => {
            // Native opt-in fixture retains its exact wall-clock deadline, callback and child cleanup.
            // @effect-diagnostics-next-line globalTimers:off
            expiry = setTimeout(
              () => reject(new Error("Native helper did not retire after parent EOF.")),
              3000,
            );
          }),
        ]);
      } finally {
        clearTimeout(expiry);
      }
      expect(
        (await ask(second, 3, "get_app_state", { app: "com.cafecode.glide-fixture" })).error,
      ).toBeUndefined();
      expect(
        (await ask(second, 4, "press_key", { app: "com.cafecode.glide-fixture", key: "b" })).error,
      ).toBeUndefined();
    } catch (error) {
      throw new Error(
        "Native fixture failed during " + phase + "; native phases: " + nativePhases.join(","),
        { cause: error },
      );
    } finally {
      await cleanup();
    }
  },
);
