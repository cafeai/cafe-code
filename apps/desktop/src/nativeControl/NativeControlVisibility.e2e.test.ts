import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  requestNativeControlHost,
  type NativeControlHostConnection,
} from "@cafecode/shared/nativeControl";
import { fieldFixture } from "./__fixtures__/electronFixture.ts";

it.runIf(process.platform === "darwin" && process.env.CAFE_CODE_CUA_VISIBILITY_E2E === "1")(
  "qualifies native tray/panel, capture admission, provider labeling and exact Stop with owned fixtures",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cafe-indicator-fixture-"));
    const repo = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const field = await fieldFixture();
    let child: ReturnType<typeof spawn> | undefined;
    let exited: Promise<void> | undefined;
    try {
      await promisify(execFile)(
        "corepack",
        [
          "yarn",
          "workspace",
          "@cafecode/desktop",
          "exec",
          "tsdown",
          "--config",
          "src/nativeControl/__fixtures__/indicator-host.config.ts",
          "--out-dir",
          root,
        ],
        { cwd: repo, timeout: 30_000, maxBuffer: 1024 * 1024 },
      );
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      child = spawn(
        createRequire(import.meta.url)("electron") as string,
        [
          join(root, "indicator-host.cjs"),
          join(root, "profile"),
          join(repo, "native/cua-driver/runtime/darwin-arm64"),
        ],
        { env, shell: false, stdio: ["pipe", "pipe", "pipe"] },
      );
      const processChild = child;
      exited = new Promise<void>((resolve) => processChild.once("close", () => resolve()));
      processChild.stderr!.resume();
      const responses = new Map<number, (value: any) => void>();
      const ready = Promise.withResolvers<any>();
      const lines = createInterface({ input: processChild.stdout! });
      processChild.once("error", ready.reject);
      lines.on("line", (line) => {
        const value = JSON.parse(line);
        if (value.ready) ready.resolve(value);
        else if (value.error) ready.reject(new Error(value.error));
        else responses.get(value.id)?.(value);
      });
      let id = 0;
      const request = (operation: string, args: Record<string, unknown> = {}) =>
        new Promise<any>((resolve, reject) => {
          const requestId = ++id;
          const timer = setTimeout(() => {
            responses.delete(requestId);
            reject(new Error("Indicator fixture reply timed out"));
          }, 10_000);
          responses.set(requestId, (value) => {
            clearTimeout(timer);
            responses.delete(requestId);
            resolve(value);
          });
          processChild.stdin!.write(JSON.stringify({ id: requestId, operation, ...args }) + "\n");
        });
      const timeout = setTimeout(
        () => ready.reject(new Error("Indicator fixture readiness timed out")),
        25_000,
      );
      const info = await ready.promise.finally(() => clearTimeout(timeout));
      const connection = info.connection as NativeControlHostConnection;
      await field.reveal();
      const binding = await requestNativeControlHost(connection, "bind", {
        threadId: "indicator-fixture",
        providerInstanceId: "isolated-account",
        provider: "claudeAgent",
      });
      await requestNativeControlHost(connection, "activate", { token: binding.token });
      await requestNativeControlHost(connection, "begin-turn", { token: binding.token });
      const rpc = async (name: string, args: unknown) => {
        const response = await fetch(String(binding.url), {
          method: "POST",
          headers: { Authorization: `Bearer ${binding.token}` },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        });
        expect(response.ok).toBe(true);
        const result = (await response.json()).result;
        const text = result.content.find((part: { type: string }) => part.type === "text")?.text;
        return {
          ...result,
          data: typeof text === "string" && text.startsWith("{") ? JSON.parse(text) : undefined,
        };
      };
      const selected = await rpc("computer_select", {
        pid: field.pid,
        window_id: field.windowId,
        view: "both",
      });
      expect(selected.isError, JSON.stringify(selected)).not.toBe(true);
      const capturedEpisode = (await request("state")).activity.episode;
      // Capture may finish while AppKit's startup ordering is still settling.
      // Refresh geometry separately, without capturing or repeating input.
      await request("refresh", { episode: capturedEpisode });
      const state = await request("state");
      expect(state.activity).toMatchObject({
        provider: "claudeAgent",
        providerInstanceId: "isolated-account",
        phase: "idle",
        target: { scope: "window", pid: field.pid },
      });
      if (state.activity.lastCaptureAt === null) {
        const health = await rpc("health", {});
        throw new Error(
          JSON.stringify({
            activity: state.activity,
            screenshot_error: selected.data?.state?.screenshot_error,
            tcc: (health.data ?? health.structuredContent)?.checks?.filter((c: { name: string }) =>
              c.name.startsWith("tcc_"),
            ),
          }),
        );
      }
      expect(state.activity.lastCaptureAt).toBeGreaterThan(0);
      expect(state.panels).toHaveLength(1);
      expect(state.panels[0], JSON.stringify(state.activity)).toMatchObject({
        visible: true,
        focusable: false,
        title: "Cafe computer-use indicator",
      });
      expect(state.panels[0].badge).toContain("Claude");
      expect(state.panels[0].badge).not.toMatch(/uploaded|confirmed|recording/iu);
      const observation = selected.data.state;
      const wheel = observation.elements.find(
        (e: { label: string }) => e.label === "Cafe fixture color wheel",
      );
      expect(wheel).toBeDefined();
      const frame = wheel.screenshot_frame;
      const priorPointer = (await field.state()).pointer;
      const clicked = await rpc("computer_advanced", {
        operation: "call",
        name: "click",
        arguments: {
          pid: field.pid,
          window_id: observation.window_id,
          capture_id: observation.capture_id,
          input_route: "pointer",
          delivery_mode: "foreground",
          x: frame.x + frame.w * 0.1,
          y: frame.y + frame.h / 2,
          observe_after: false,
        },
      });
      expect(clicked.isError, JSON.stringify(clicked)).not.toBe(true);
      const afterClick = await field.state();
      expect(afterClick.pointer).toEqual(priorPointer);
      expect((afterClick.wheelClicks as { x: number }[])[0]?.x).toBeGreaterThan(20);
      expect((afterClick.wheelClicks as { x: number }[])[0]?.x).toBeLessThan(45);
      expect((await request("state")).transitions).toContainEqual({
        phase: "controlling",
        usingSystemPointer: true,
      });
      const resized = await field.scene("resize");
      await request("refresh", { episode: state.activity.episode });
      const moved = await request("state");
      expect(moved.activity.target.bounds).toEqual(resized.bounds);
      expect(moved.panels[0].bounds).toEqual(resized.bounds);
      await field.scene("occlude");
      await request("refresh", { episode: state.activity.episode });
      const occluded = await request("state");
      expect(occluded.activity.target).toMatchObject({
        visible: false,
        visibilityReason: "occluded",
      });
      expect(occluded.panels[0].visible).toBe(false);
      expect(occluded.activity.phase).toBe("idle");
      await field.scene("unocclude");
      await expect
        .poll(
          async () => {
            await request("refresh", { episode: state.activity.episode });
            return (await request("state")).panels[0].visible;
          },
          { timeout: 2500, interval: 100 },
        )
        .toBe(true);
      const fullscreen = await field.scene("fullscreen");
      // The native enter-full-screen event precedes the WindowServer Space
      // transition settling. Poll only the metadata, without capture/input.
      await expect
        .poll(
          async () => {
            await request("refresh", { episode: state.activity.episode });
            return (await request("state")).panels[0].visible;
          },
          { timeout: 5000, interval: 100 },
        )
        .toBe(true);
      const full = await request("state");
      expect(full.activity.target.bounds).toEqual(fullscreen.bounds);
      expect(full.panels[0].visible).toBe(true);
      expect(full.panels[0].focusable).toBe(false);
      const onScreen = await promisify(execFile)(
        "xcrun",
        [
          "swift",
          "-e",
          `import CoreGraphics
        import Foundation
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String:Any]] ?? []
        let ids = windows.filter { ($0["kCGWindowOwnerPID"] as? Int) == ${processChild.pid!} }
          .compactMap { $0["kCGWindowNumber"] as? Int }
        print(String(data:try! JSONSerialization.data(withJSONObject:ids),encoding:.utf8)!)`,
        ],
        { timeout: 10_000, maxBuffer: 4096 },
      );
      expect(JSON.parse(onScreen.stdout)).toContain(full.panels[0].nativeWindowId);
      await field.scene("exit-fullscreen");
      await request("stop", { episode: "stale-episode" });
      expect((await request("state")).activity.episode).toBe(state.activity.episode);
      await request("stop", { episode: state.activity.episode });
      expect(await request("state")).toMatchObject({
        activity: { phase: "inactive", episode: null, lastCaptureAt: null },
        panels: [],
      });
      expect(
        (
          await rpc("get_window_state", {
            pid: field.pid,
            window_id: state.activity.target.windowId,
          })
        ).isError,
      ).toBe(true);
      lines.close();
    } finally {
      child?.stdin?.end();
      if (child && exited) {
        const timer = setTimeout(() => child!.kill("SIGTERM"), 5000);
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
      await field.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
