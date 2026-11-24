// Explicit opt-in native qualification. Only a fresh private AppKit fixture is
// observed/controlled; the OpenAI runtime receives no provider credentials.
// @effect-diagnostics nodeBuiltinImport:off
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { GlideRuntime } from "../src/glide/openAiRuntime.ts";
import { resolveOpenAiComputerInstallation } from "../src/glide/openAiInstallation.ts";

interface Receipt {
  kind: string;
  field: string;
  status: string;
  frontmost: boolean;
  visibility?: {
    visible: boolean;
    onActiveSpace: boolean;
    occluded: boolean;
    hidden: boolean;
    minimized: boolean;
  };
}
it.skipIf(process.platform !== "darwin")(
  "uses OpenAI's actual kernel, permissions, screenshot and background input through Cafe's adapter",
  async (context) => {
    let retired = false,
      root: string | undefined,
      child: ChildProcess | undefined;
    let childClosed: Promise<void> | undefined,
      runtime: GlideRuntime | undefined,
      watcher: FSWatcher | undefined;
    let preparation: Promise<void> | undefined, cleanupPromise: Promise<void> | undefined;
    let phase = "preparing";
    let visibility: Receipt["visibility"];
    context.onTestFailed(() => {
      // Public Vitest failure callback, outside Effect; fixed phases/booleans only.
      // @effect-diagnostics-next-line globalConsole:off
      console.info("openai-native-fixture-failure", { phase, visibility });
    });
    const ready = Promise.withResolvers<Receipt[]>();
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        retired = true;
        watcher?.close();
        ready.reject(new Error("Native fixture retired."));
        await runtime?.close();
        child?.stdin?.end();
        // Escalation is only to this exact launch owner; its fixture child has an
        // independent retained kernel-birth/parent-exit fence.
        // @effect-diagnostics-next-line globalTimers:off
        const force = setTimeout(() => child?.kill("SIGKILL"), 2000);
        try {
          await childClosed;
        } finally {
          clearTimeout(force);
        }
        await preparation?.catch(() => undefined);
        if (root) await rm(root, { recursive: true, force: true });
      })());
    void ready.promise.catch(() => undefined);
    context.signal.addEventListener(
      "abort",
      () => {
        void cleanup();
      },
      { once: true },
    );
    context.onTestFinished(cleanup);
    const alive = () => {
      if (retired) throw new Error("Native fixture retired before admission.");
    };
    const bundleId = `com.cafecode.openai-fixture.${randomUUID()}`;
    let bundle = "",
      receipt = "";
    preparation = (async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "cafe-openai-mac-")));
      alive();
      bundle = join(root, "OpenAIComputerFixture.app");
      receipt = join(root, "events");
      const executable = join(bundle, "Contents/MacOS/Fixture");
      await mkdir(dirname(executable), { recursive: true });
      alive();
      await writeFile(
        join(bundle, "Contents/Info.plist"),
        `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>Cafe OpenAI Qualification</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`,
      );
      alive();
      const build = spawnSync(
        "xcrun",
        [
          "swiftc",
          fileURLToPath(new URL("./fixtures/openai-computer.fixture.swift", import.meta.url)),
          "-o",
          executable,
        ],
        { shell: false, encoding: "utf8", timeout: 30000 },
      );
      expect(build.status, build.stderr).toBe(0);
      alive();
      const launcher = join(root, "LaunchOwner");
      await copyFile(executable, launcher);
      alive();
      watcher = watch(root, (_event, name) => {
        if (name !== "events" || retired) return;
        void readFile(receipt, "utf8").then(
          (text) => {
            if (retired) return;
            const events = JSON.parse(text) as Receipt[];
            visibility = events.at(-1)?.visibility;
            if (events.some((event) => event.kind === "ready")) ready.resolve(events);
          },
          () => undefined,
        );
      });
      child = spawn(launcher, ["--launch-owned", bundle, receipt], {
        shell: false,
        stdio: ["pipe", "ignore", "pipe"],
        env: { PATH: process.env.PATH, HOME: root, CFFIXED_USER_HOME: root, TMPDIR: root },
      });
      childClosed = new Promise<void>((resolve, reject) => {
        child!.once("close", () => resolve());
        child!.once("error", reject);
      });
      child.stderr?.resume();
      child.stdin?.on("error", () => undefined);
      void childClosed.then(
        () => ready.reject(new Error("Fixture closed before readiness.")),
        (error) => ready.reject(error),
      );
    })();
    try {
      await preparation;
      alive();
      phase = "window readiness";
      await ready.promise;
      alive();
      const installation = await resolveOpenAiComputerInstallation();
      alive();
      if (!installation)
        throw new Error(
          "Install the qualified OpenAI desktop runtime and its Computer Use component before this opt-in command.",
        );
      const turn = randomUUID();
      runtime = new GlideRuntime({
        installation,
        turnId: () => turn,
        authority: { authorize: async () => ({ apps: [bundleId], current: () => !retired }) },
      });
      phase = "native observation";
      const observed = await runtime.execute({
        code: `var {sky}=await import("@oai/sky"); var initial=await sky.get_app_state({app:${JSON.stringify(bundle)},disableDiff:true}); nodeRepl.write(initial.text); if(!initial.screenshot)throw Error("Native PNG missing"); await nodeRepl.emitImage(initial.screenshot.url); nodeRepl.write({heap:(await import("node:v8")).getHeapStatistics().heap_size_limit});`,
      });
      expect(
        observed.isError,
        observed.content
          .filter((item) => item.type === "text")
          .map((item) => item.text.slice(0, 512))
          .join("\n"),
      ).not.toBe(true);
      expect(
        observed.content.filter((item) => item.type === "image").map((item) => item.mimeType),
      ).toEqual(expect.arrayContaining([expect.stringMatching(/^image\/(png|jpeg|webp)$/)]));
      const body = observed.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      const heap = Number(body.match(/heap:\s*(\d+)/)?.[1]);
      expect(heap).toBeGreaterThan(0);
      expect(heap).toBeLessThanOrEqual(320 * 1024 * 1024);
      phase = "native input";
      const result = await runtime.execute({
        code: `var fields=[...initial.text.matchAll(/^\\s*(\\d+) text field.*Description: Background input,/gm)]; if(fields.length!==1)throw Error("Ambiguous fixture field"); await sky.click({app:${JSON.stringify(bundle)},element_index:Number(fields[0][1])}); await sky.press_key({app:${JSON.stringify(bundle)},key:"super+a"}); await sky.type_text({app:${JSON.stringify(bundle)},text:"OpenAI native"}); var fresh=await sky.get_app_state({app:${JSON.stringify(bundle)},disableDiff:true}); if(!fresh.text.includes("OpenAI native"))throw Error("ASCII typing was not observed"); await sky.press_key({app:${JSON.stringify(bundle)},key:"super+a"}); await sky.paste({app:${JSON.stringify(bundle)},text:"OpenAI café 👩‍💻",format:"text"}); fresh=await sky.get_app_state({app:${JSON.stringify(bundle)},disableDiff:true}); if(!fresh.text.normalize("NFC").includes("OpenAI café 👩‍💻"))throw Error("Unicode paste was not observed"); var buttons=[...fresh.text.matchAll(/^\\s*(\\d+) button Apply background fixture/gm)]; if(buttons.length!==1)throw Error("Ambiguous fixture action"); await sky.click({app:${JSON.stringify(bundle)},element_index:Number(buttons[0][1])}); var final=await sky.get_app_state({app:${JSON.stringify(bundle)},disableDiff:true}); if(!final.text.normalize("NFC").includes("applied: OpenAI café 👩‍💻"))throw Error("Native result not observed"); nodeRepl.write("qualified native application result");`,
      });
      expect(
        result.isError,
        result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text.slice(0, 512))
          .join("\n"),
      ).not.toBe(true);
      const events = JSON.parse(await readFile(receipt, "utf8")) as Receipt[];
      phase = "application result";
      expect(events.at(-1)).toMatchObject({
        field: "OpenAI café 👩‍💻",
        status: "applied: OpenAI café 👩‍💻",
      });
      // Observe only this exact owned app: unrelated human desktop activity
      // cannot establish whether OpenAI moved a global pointer or focus owner.
      expect(events.every((event) => event.frontmost === false)).toBe(true);
      await runtime.endTurn(turn);
      await runtime.close();
      runtime = undefined;
      phase = "closed";
    } finally {
      await cleanup();
    }
  },
);
