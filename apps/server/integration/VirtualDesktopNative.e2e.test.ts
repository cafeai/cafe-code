import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { fixturePixel, fixtureRegion, nativeResources } from "./desktopFrameFixture.ts";
import { qualifyCodexDesktop } from "./codexDesktopQualification.ts";
import { qualifyDesktopInteractions } from "./desktopInteractionQualification.ts";
import { describeSwayTree } from "../src/virtualDesktop/swayState.ts";
import { nativeRequest, processIdentity, swayRequest } from "../src/virtualDesktop/nativeClient.ts";

const soakSeconds = Math.max(
  0,
  Math.min(24 * 60 * 60, Number(process.env.CAFE_CODE_DESKTOP_SOAK_SECONDS) || 0),
);
const enabled = process.platform === "linux" && process.env.CAFE_CODE_VIRTUAL_DESKTOP_E2E === "1";
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const helper =
  process.env.CAFE_CODE_DESKTOP_TEST_HELPER ??
  path.join(repo, "apps/server/dist/cafe-desktop-native");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  let value: T | undefined;
  while (Date.now() < end) {
    try {
      value = await read();
      if (ready(value)) return value;
    } catch {
      /* bounded readiness polling */
    }
    await sleep(100);
  }
  throw new Error(
    "Native desktop fixture did not reach its expected state: " +
      (typeof value === "string" ? value.slice(0, 500) : JSON.stringify(value)),
  );
}

it.skipIf(!enabled)(
  "captures GPU frames, types Unicode, prioritizes human input through Wayland and X11 viewers, and reaps apps",
  async () => {
    const root = await fs.mkdtemp(`/run/user/${process.getuid?.()}/cafe-desktop-e2e-`);
    await fs.chmod(root, 0o700);
    const workers: Array<{ directory: string; child: ChildProcess; start: string | null }> = [];
    const boot = async (name: string) => {
      const directory = path.join(root, name);
      await fs.mkdir(directory, { mode: 0o700 });
      const config = {
        directory,
        helper,
        socket: path.join(directory, "worker.sock"),
        token: randomBytes(32).toString("hex"),
        viewerToken: randomBytes(32).toString("hex"),
        sway: "sway",
        renderer: "gles2",
        renderDevice: process.env.CAFE_CODE_TEST_RENDER_DEVICE ?? "/dev/dri/renderD128",
      };
      await fs.writeFile(path.join(directory, "bootstrap.json"), JSON.stringify(config), {
        mode: 0o600,
      });
      const child = spawn(helper, ["worker", path.join(directory, "bootstrap.json")], {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", () => undefined);
      workers.push({
        directory,
        child,
        start: child.pid ? await processIdentity(child.pid) : null,
      });
      const call = (body: unknown, signal?: AbortSignal) =>
        nativeRequest(helper, path.join(directory, "bootstrap.json"), body, signal);
      await until(
        () => call({ method: "status" }),
        (v) => v.ok === true,
      );
      return { directory, call, config };
    };
    try {
      const prefix = path.join(repo, "build/virtual-desktop/SDL-3.4.14-minimal-v1/installed");
      const flags = execFileSync("pkg-config", ["--static", "--cflags", "--libs", "sdl3"], {
        env: { ...process.env, PKG_CONFIG_PATH: path.join(prefix, "lib/pkgconfig") },
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/);
      const fixture = path.join(root, "input-fixture");
      execFileSync("c++", [
        "-std=c++20",
        path.join(repo, "native/virtual-desktop/input-fixture.cpp"),
        ...flags,
        "-o",
        fixture,
      ]);
      const pointerFixture = path.join(root, "pointer-fixture");
      const jsonFlags = execFileSync("pkg-config", ["--cflags", "--libs", "json-c"], {
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/);
      execFileSync("c++", [
        "-std=c++20",
        path.join(repo, "native/virtual-desktop/pointer-input-fixture.cpp"),
        ...jsonFlags,
        "-o",
        pointerFixture,
      ]);
      execFileSync(pointerFixture, []);
      const inner = await boot("inner"),
        outer = await boot("outer");
      expect(await inner.call({ method: "status" })).toMatchObject({ relativePointer: true });
      await inner.call({ method: "observe" });
      expect(
        await inner.call({ method: "act", kind: "relative-move", dx256: 256, dy256: 0 }),
      ).toMatchObject({ error: "invalid_action" });
      const output = path.join(root, "input.txt");
      const visualCode = randomBytes(3).toString("hex").toUpperCase();
      const app = await inner.call({
        method: "launch",
        command: "/usr/bin/env",
        args: [
          "SDL_VIDEODRIVER=wayland",
          "CAFE_CODE_FIXTURE_HIDE_CURSOR=1",
          fixture,
          output,
          visualCode,
        ],
      });
      await until(
        () => fs.readFile(output, "utf8"),
        () => true,
      );
      await sleep(500);
      const preview = await inner.call({ method: "observe", preview: true });
      expect(preview).toMatchObject({ width: 480, height: 300 });
      expect(Buffer.from(String(preview.image), "base64").length).toBeLessThan(512 * 1024);
      const frame = await inner.call({ method: "observe" });
      expect(frame).toMatchObject({
        width: 1280,
        height: 800,
        renderer: "gles2",
        transfer: "shared-memory",
      });
      expect(Buffer.from(String(frame.image), "base64").subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      const privateEnvironment = JSON.parse(
        await fs.readFile(path.join(inner.directory, "environment.json"), "utf8"),
      ) as { SWAYSOCK: string };
      await qualifyDesktopInteractions({
        call: inner.call,
        tree: async (signal) =>
          describeSwayTree(await swayRequest(privateEnvironment.SWAYSOCK, 4, "", signal)),
      });
      expect(await inner.call({ method: "act", kind: "click", x: 200, y: 220 })).toMatchObject({
        ok: true,
      });
      expect(await inner.call({ method: "act", kind: "text", text: "café 日本語" })).toMatchObject({
        ok: true,
      });
      const typed = await until(
        () => fs.readFile(output, "utf8"),
        (v) => v.includes("語"),
      );
      expect(typed).toContain("click");
      expect(
        typed
          .split("\n")
          .filter((line) => line.startsWith("text "))
          .map((line) => line.slice(5))
          .join(""),
      ).toContain("café 日本語");
      if (process.env.CAFE_CODE_CODEX_DESKTOP_E2E === "1") {
        const before = await fs.readFile(output, "utf8");
        expect(
          await qualifyCodexDesktop({
            root,
            bridge: path.join(repo, "apps/server/dist/desktop-mcp-bridge.mjs"),
            code: visualCode,
            call: async (name, args, signal) => {
              if (name !== "observe" && name !== "act")
                throw new Error("Only observation/input are enabled in this fixture.");
              return inner.call({ ...args, method: name }, signal);
            },
          }),
        ).toMatchObject({ imageVisible: true, disabledAfterResume: true });
        const after = await fs.readFile(output, "utf8");
        expect(after.slice(before.length)).toContain("click");
        expect(
          after
            .slice(before.length)
            .split("\n")
            .filter((v) => v.startsWith("text "))
            .map((v) => v.slice(5))
            .join(""),
        ).toContain("cafe42");
      }
      const viewerFile = path.join(root, "viewer.json");
      await fs.writeFile(
        viewerFile,
        JSON.stringify({
          socket: inner.config.socket,
          token: inner.config.viewerToken,
          name: "Native viewer fixture",
        }),
        { mode: 0o600 },
      );
      for (const driver of ["wayland", "x11"]) {
        await fs.writeFile(
          viewerFile,
          JSON.stringify({
            socket: inner.config.socket,
            token: inner.config.viewerToken,
            name: "Research — Cafe Code",
            appearance: { dark: driver === "wayland", scale: driver === "wayland" ? 1 : 1.3 },
          }),
          { mode: 0o600 },
        );
        const launched = await outer.call({
          method: "launch",
          command: "/usr/bin/env",
          args: [`SDL_VIDEODRIVER=${driver}`, helper, "viewer", viewerFile],
        });
        await until(
          () => inner.call({ method: "status" }),
          (v) => v.viewerOpen === true,
        );
        await sleep(800);
        if (process.env.CAFE_CODE_DESKTOP_EXPECT_DMABUF === "1" && driver === "wayland")
          await until(
            () => inner.call({ method: "status" }),
            (v) => v.transfer === "dma-buf",
          );
        const presented = await outer.call({ method: "observe" });
        if (process.env.CAFE_CODE_DESKTOP_QA_DIR) {
          await fs.mkdir(process.env.CAFE_CODE_DESKTOP_QA_DIR, { recursive: true });
          await fs.writeFile(
            path.join(process.env.CAFE_CODE_DESKTOP_QA_DIR, `viewer-${driver}.png`),
            Buffer.from(String(presented.image), "base64"),
          );
        }
        // Guest content is letterboxed below the viewer toolbar. These points
        // sit well inside its known red/green rectangles on both host backends.
        expect(fixturePixel(String(presented.image), 220, 270)).toEqual([210, 45, 40]);
        expect(fixturePixel(String(presented.image), 520, 270)).toEqual([30, 180, 75]);
        if (soakSeconds && driver === "wayland" && typeof launched.pid === "number") {
          await sleep(5000);
          const baseline = await nativeResources(launched.pid);
          const end = Date.now() + soakSeconds * 1000;
          while (Date.now() < end) {
            await sleep(1000);
            const sample = await nativeResources(launched.pid);
            expect(sample.descriptors).toBeLessThanOrEqual(baseline.descriptors + 16);
            expect(sample.rssKiB).toBeLessThanOrEqual(baseline.rssKiB + 256 * 1024);
            expect(await inner.call({ method: "status" })).toMatchObject({ viewerOpen: true });
          }
        }
        // Hover, guest clicks and the non-button toolbar cannot claim input.
        await outer.call({ method: "act", kind: "move", x: 230, y: 270 });
        const hasHostCursor = async (x: number, y: number, background: readonly number[]) => {
          const shot = await outer.call({ method: "observe" });
          const region = fixtureRegion(String(shot.image), x, y, 24, 24);
          return region.some((value, index) => value !== background[index % 3]);
        };
        // A synthetic guest with no cursor lets us verify the host cursor's
        // actual composited pixels independently on Wayland and X11.
        await until(() => hasHostCursor(230, 270, [210, 45, 40]), Boolean);
        await outer.call({ method: "act", kind: "click", x: 400, y: 20 });
        await outer.call({ method: "act", kind: "click", x: 230, y: 270 });
        expect(await inner.call({ method: "status" })).toMatchObject({ humanControl: false });
        await outer.call({ method: "act", kind: "click", x: 1140, y: 20 });
        await until(
          () => inner.call({ method: "status" }),
          (v) => v.humanControl === true,
        );
        await outer.call({ method: "act", kind: "move", x: 230, y: 270 });
        await until(
          () => hasHostCursor(230, 270, [210, 45, 40]),
          (visible) => !visible,
        );
        // Releasing over non-image chrome must end a drag started in the
        // guest. This is the real SDL event path on both viewer backends, with
        // ownership unchanged and no focus loss to mask a missing button-up.
        for (const target of [
          { x: 400, y: 20 },
          { x: 4, y: 300 },
        ]) {
          const previousInput = await fs.readFile(output, "utf8");
          await outer.call({
            method: "act",
            kind: "drag",
            x: 230,
            y: 270,
            toX: target.x,
            toY: target.y,
          });
          const released = await until(
            () => fs.readFile(output, "utf8"),
            (value) => value.slice(previousInput.length).includes("button-up 1"),
          );
          expect(released.slice(previousInput.length)).toContain("click ");
          expect(await inner.call({ method: "status" })).toMatchObject({ humanControl: true });
        }
        await outer.call({ method: "act", kind: "move", x: 230, y: 270 });
        // The toolbar remains usable, and the margin outside the scaled guest
        // must not inherit the hidden cursor. Both are outside input mapping.
        const toolbarWithoutCursor = await outer.call({ method: "observe" });
        const toolbarRegion = fixtureRegion(String(toolbarWithoutCursor.image), 1245, 10, 24, 24);
        await outer.call({ method: "act", kind: "move", x: 1245, y: 10 });
        await until(async () => {
          const shot = await outer.call({ method: "observe" });
          return !fixtureRegion(String(shot.image), 1245, 10, 24, 24).equals(toolbarRegion);
        }, Boolean);
        await outer.call({ method: "act", kind: "move", x: 4, y: 300 });
        await until(() => hasHostCursor(4, 300, [16, 18, 23]), Boolean);
        await outer.call({ method: "act", kind: "move", x: 230, y: 270 });
        await until(
          () => hasHostCursor(230, 270, [210, 45, 40]),
          (visible) => !visible,
        );
        expect(await inner.call({ method: "act", kind: "click", x: 200, y: 220 })).toMatchObject({
          error: "human_control_active",
        });
        expect(
          await inner.call({ method: "sway_command", command: "fullscreen enable" }),
        ).toMatchObject({ error: "human_control_active" });
        const before = await fs.readFile(output, "utf8");
        await outer.call({ method: "act", kind: "text", text: driver });
        await until(
          () => fs.readFile(output, "utf8"),
          (v) =>
            v
              .slice(before.length)
              .split("\n")
              .filter((line) => line.startsWith("text "))
              .map((line) => line.slice(5))
              .join("")
              .includes(driver),
        );
        // The agent explicitly reclaims ownership, even with the viewer open.
        const oldEpoch = (await inner.call({ method: "status" })).controlEpoch;
        expect(await inner.call({ method: "take-control" })).toMatchObject({ humanControl: false });
        // A control handoff restores the host cursor without any mouse motion.
        await until(() => hasHostCursor(230, 270, [210, 45, 40]), Boolean);
        await outer.call({ method: "act", kind: "move", x: 240, y: 280 });
        await outer.call({ method: "act", kind: "text", text: "must not reach guest" });
        expect(
          await inner.call({
            method: "act",
            kind: "key",
            keys: ["Return"],
            controlEpoch: oldEpoch,
          }),
        ).toMatchObject({ error: "observation_required" });
        await until(
          () => inner.call({ method: "status" }),
          (v) => v.humanControl === false,
        );
        expect(
          await inner.call({
            method: "sway_command",
            command: "fullscreen enable",
            controlEpoch: -1,
          }),
        ).toMatchObject({ error: "observation_required" });
        expect(await inner.call({ method: "act", kind: "key", keys: ["Return"] })).toMatchObject({
          ok: true,
        });
        // Fit changes only the host viewer geometry. Floating windows let the
        // compositor honor client resize requests instead of enforcing tiles.
        const appearanceScale = driver === "wayland" ? 1 : 1.3;
        const chromeHeight = 44 * appearanceScale;
        const outerEnvironment = JSON.parse(
          await fs.readFile(path.join(outer.directory, "environment.json"), "utf8"),
        ) as { SWAYSOCK: string };
        const innerEnvironment = JSON.parse(
          await fs.readFile(path.join(inner.directory, "environment.json"), "utf8"),
        ) as { SWAYSOCK: string };
        type WindowNode = {
          pid?: number;
          rect: { x: number; y: number; width: number; height: number };
          window_rect?: { x: number; y: number; width: number; height: number };
          fullscreen_mode?: number;
          focused?: boolean;
          nodes?: WindowNode[];
          floating_nodes?: WindowNode[];
        };
        const windowNode = async (socket: string, pid: unknown) => {
          const tree = (await swayRequest(socket, 4)) as WindowNode;
          const visit = (node: WindowNode): WindowNode | undefined => {
            if (node.pid === pid) return node;
            for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])]) {
              const match = visit(child);
              if (match) return match;
            }
          };
          return visit(tree);
        };
        const viewerNode = async () => {
          const node = await windowNode(outerEnvironment.SWAYSOCK, launched.pid);
          if (!node?.window_rect) throw new Error("Viewer client geometry unavailable");
          return {
            x: node.rect.x + node.window_rect.x,
            y: node.rect.y + node.window_rect.y,
            width: node.window_rect.width,
            height: node.window_rect.height,
            fullscreen: node.fullscreen_mode !== 0,
          };
        };
        const clickFit = async () => {
          const rect = await viewerNode();
          await outer.call({
            method: "act",
            kind: "click",
            x: Math.round(rect.x + rect.width - 276 * appearanceScale),
            y: Math.round(rect.y + 22 * appearanceScale),
          });
        };
        // Keep another real window focused until the actual click. Merely
        // switching workspaces back to the viewer focuses it before clicking
        // and misses SDL's default suppression of activation clicks.
        const focusApp = await outer.call({
          method: "launch",
          command: fixture,
          args: [path.join(root, `focus-${driver}.txt`), "FOCUS"],
        });
        await until(
          () => windowNode(outerEnvironment.SWAYSOCK, focusApp.pid),
          (v) => v !== undefined,
        );
        await outer.call({
          method: "sway_command",
          command: `[pid=${focusApp.pid}] floating enable, border none, resize set 160 120, move position 0 650`,
        });
        const defocusViewer = async () => {
          await outer.call({
            method: "sway_command",
            command: `[pid=${focusApp.pid}] focus`,
          });
          await until(
            () => windowNode(outerEnvironment.SWAYSOCK, launched.pid),
            (v) => v?.focused === false,
          );
          // Allow the asynchronous focus-loss event to reach SDL. The click
          // below must itself refocus the viewer, with no retrying the click.
          await sleep(100);
        };
        const beforeToolbarClicks = await fs.readFile(output, "utf8");
        for (const humanControl of [true, false]) {
          await defocusViewer();
          const rect = await viewerNode();
          await outer.call({
            method: "act",
            kind: "click",
            x: Math.round(rect.x + rect.width - 104 * appearanceScale),
            y: Math.round(rect.y + 22 * appearanceScale),
          });
          await until(
            () => inner.call({ method: "status" }),
            (v) => v.humanControl === humanControl,
          );
        }
        expect(await fs.readFile(output, "utf8")).toBe(beforeToolbarClicks);
        // First-click delivery must not turn a watching guest click into an
        // implicit takeover, or leak a toolbar button release into the guest.
        await defocusViewer();
        const beforeFocusClick = await fs.readFile(output, "utf8");
        const focusRect = await viewerNode();
        await outer.call({
          method: "act",
          kind: "click",
          x: Math.round(focusRect.x + focusRect.width / 2),
          y: Math.round(focusRect.y + focusRect.height / 2),
        });
        await until(
          () => windowNode(outerEnvironment.SWAYSOCK, launched.pid),
          (v) => v?.focused === true,
        );
        await sleep(100);
        expect(await inner.call({ method: "status" })).toMatchObject({ humanControl: false });
        expect(await fs.readFile(output, "utf8")).toBe(beforeFocusClick);
        if (typeof focusApp.pid === "number") process.kill(focusApp.pid, "SIGTERM");
        await until(
          () => windowNode(outerEnvironment.SWAYSOCK, focusApp.pid),
          (v) => v === undefined,
        );
        const fitCases = [
          { width: 1200, height: 500, human: false },
          { width: 597, height: 720, human: true },
        ];
        for (const size of fitCases) {
          expect(
            await outer.call({
              method: "sway_command",
              command: `[pid=${launched.pid}] floating enable, border none, resize set ${size.width} ${size.height}, move position 30 30`,
            }),
          ).toMatchObject({ ok: true });
          const beforeFit = await until(
            viewerNode,
            (v) => v.width === size.width && v.height === size.height,
          );
          await sleep(150);
          if (size.human) {
            await outer.call({
              method: "act",
              kind: "click",
              x: Math.round(beforeFit.x + beforeFit.width - 104 * appearanceScale),
              y: Math.round(beforeFit.y + 22 * appearanceScale),
            });
            await until(
              () => inner.call({ method: "status" }),
              (v) => v.humanControl === true,
            );
          }
          const ownerBeforeFit = await inner.call({ method: "status" });
          await clickFit();
          const fitted = await until(
            viewerNode,
            (v) => v.width < beforeFit.width || v.height < beforeFit.height,
          );
          expect(fitted.width).toBeLessThanOrEqual(beforeFit.width);
          expect(fitted.height).toBeLessThanOrEqual(beforeFit.height);
          if (size.width === 1200) {
            expect(fitted.height).toBe(beforeFit.height);
            expect(fitted.width).toBe(Math.ceil((size.height - chromeHeight) * 1.6));
          } else {
            expect(fitted.width).toBe(beforeFit.width);
            expect(fitted.height).toBe(Math.ceil(size.width / 1.6 + chromeHeight));
          }
          expect(await inner.call({ method: "status" })).toMatchObject({
            humanControl: size.human,
            controlEpoch: ownerBeforeFit.controlEpoch,
          });
          // The image reaches every edge below the toolbar (allowing integer
          // pixel rounding); corners use the fixture's solid background.
          await outer.call({ method: "act", kind: "move", x: 5, y: 5 });
          await until(async () => {
            const shot = await outer.call({ method: "observe" });
            const top = Math.ceil(fitted.y + chromeHeight) + 3;
            const bottom = fitted.y + fitted.height - 4;
            return [fitted.x + 3, fitted.x + fitted.width - 4].every((x) =>
              [top, bottom].every((y) =>
                fixturePixel(String(shot.image), x, y).every(
                  (value, index) => value === [25, 45, 70][index],
                ),
              ),
            );
          }, Boolean);
          // Repeated fits must not chip pixels off an already fitted window.
          for (let repeat = 0; repeat < 3; repeat++) {
            await clickFit();
            await sleep(100);
            expect(await viewerNode()).toMatchObject({
              width: fitted.width,
              height: fitted.height,
            });
          }
          if (process.env.CAFE_CODE_DESKTOP_QA_DIR) {
            const shot = await outer.call({ method: "observe" });
            await fs.writeFile(
              path.join(
                process.env.CAFE_CODE_DESKTOP_QA_DIR,
                `viewer-${driver}-fit-${size.width}.png`,
              ),
              Buffer.from(String(shot.image), "base64"),
            );
          }
        }
        // Fit also leaves fullscreen before applying the contained size.
        await outer.call({
          method: "sway_command",
          command: `[pid=${launched.pid}] fullscreen enable`,
        });
        const full = await until(viewerNode, (v) => v.fullscreen);
        await sleep(150);
        await clickFit();
        const restored = await until(viewerNode, (v) => !v.fullscreen);
        expect(restored.width).toBeLessThanOrEqual(full.width);
        expect(restored.height).toBeLessThanOrEqual(full.height);
        expect(Math.abs(restored.width / 1.6 + chromeHeight - restored.height)).toBeLessThan(1);
        // Looking Glass and other captured clients consume displacement while
        // their cursor stays fixed. Exercise real relative protocols in both
        // guest backends, through both host viewer backends, without a VM.
        await inner.call({ method: "take-control" });
        for (const guestDriver of ["wayland", "x11"]) {
          const motionOutput = path.join(root, `relative-${driver}-${guestDriver}.txt`);
          const relativeApp = await inner.call({
            method: "launch",
            command: "/usr/bin/env",
            args: [
              `SDL_VIDEODRIVER=${guestDriver}`,
              "CAFE_CODE_FIXTURE_HIDE_CURSOR=1",
              fixture,
              motionOutput,
              "RELATIVE",
            ],
          });
          await until(
            () => fs.readFile(motionOutput, "utf8"),
            (v) => v.includes(`driver ${guestDriver}`),
          );
          // SDL can publish its driver before Xwayland maps the window. Wait
          // for compositor admission before targeting it or sending input.
          await until(
            () => windowNode(innerEnvironment.SWAYSOCK, relativeApp.pid),
            (v) => v !== undefined,
          );
          await inner.call({
            method: "sway_command",
            command: `[pid=${relativeApp.pid}] fullscreen enable, focus`,
          });
          await until(
            () => windowNode(innerEnvironment.SWAYSOCK, relativeApp.pid),
            (v) => v?.fullscreen_mode === 1 && v.focused === true,
          );
          const geometry = await viewerNode();
          const cx = Math.round(geometry.x + geometry.width / 2);
          const cy = Math.round(geometry.y + geometry.height / 2);
          await outer.call({
            method: "act",
            kind: "click",
            x: Math.round(geometry.x + geometry.width - 60 * appearanceScale),
            y: Math.round(geometry.y + 20 * appearanceScale),
          });
          await until(
            () => inner.call({ method: "status" }),
            (v) => v.humanControl === true,
          );
          await outer.call({ method: "act", kind: "click", x: cx, y: cy });
          await outer.call({ method: "act", kind: "key", keys: ["F12"] });
          await until(
            () => fs.readFile(motionOutput, "utf8"),
            (v) => v.includes("capture 1 1"),
          );
          await outer.call({ method: "act", kind: "key", keys: ["Control_L", "Alt_L", "m"] });
          await sleep(150);
          const motions = async () =>
            (await fs.readFile(motionOutput, "utf8"))
              .split("\n")
              .filter((line) => line.startsWith("motion "))
              .map((line) => line.split(" ").slice(1).map(Number));
          const start = (await motions()).length;
          for (const offset of [10, 10, -10]) {
            const beforeMotion = (await motions()).length;
            await outer.call({ method: "act", kind: "move", x: cx + offset, y: cy });
            await until(motions, (v) => v.length > beforeMotion);
          }
          const moved = (await motions()).slice(start);
          expect(moved).toHaveLength(3);
          expect(moved[0]![0]).toBeGreaterThan(0);
          expect(moved[1]![0]).toBeCloseTo(moved[0]![0]!, 1);
          expect(moved[2]![0]).toBeCloseTo(-moved[0]![0]!, 1);
          // Captured button delivery must not inject an absolute reposition.
          const beforeClick = (await motions()).length;
          await outer.call({ method: "act", kind: "click", x: cx, y: cy });
          await sleep(150);
          expect((await motions()).length).toBe(beforeClick);
          // Explicit release keeps human ownership and stops host confinement.
          await outer.call({ method: "act", kind: "key", keys: ["Control_L", "Alt_L", "m"] });
          await sleep(100);
          expect(await inner.call({ method: "status" })).toMatchObject({ humanControl: true });
          await outer.call({ method: "act", kind: "key", keys: ["F12"] });
          await until(
            () => fs.readFile(motionOutput, "utf8"),
            (v) => v.includes("capture 0 1"),
          );
          await outer.call({ method: "act", kind: "move", x: cx, y: cy });
          const toolbarPixels = (shot: Record<string, unknown>) =>
            fixtureRegion(
              String(shot.image),
              geometry.x,
              geometry.y,
              geometry.width,
              Math.floor(chromeHeight),
            );
          const uncapturedToolbar = toolbarPixels(await outer.call({ method: "observe" }));
          // Exercise the visible capture button as well as the shortcut. A
          // workspace focus round trip must release capture without reclaiming
          // it automatically when the viewer becomes focused again.
          await outer.call({
            method: "act",
            kind: "click",
            x: Math.round(geometry.x + geometry.width - 430 * appearanceScale),
            y: Math.round(geometry.y + 20 * appearanceScale),
          });
          const capturedShot = await until(
            () => outer.call({ method: "observe" }),
            (shot) => !toolbarPixels(shot).equals(uncapturedToolbar),
          );
          if (process.env.CAFE_CODE_DESKTOP_QA_DIR) {
            await fs.writeFile(
              path.join(
                process.env.CAFE_CODE_DESKTOP_QA_DIR,
                `viewer-${driver}-capture-${guestDriver}.png`,
              ),
              Buffer.from(String(capturedShot.image), "base64"),
            );
          }
          await outer.call({ method: "sway_command", command: "workspace number 2" });
          await sleep(100);
          await outer.call({ method: "sway_command", command: "workspace number 1" });
          await outer.call({ method: "act", kind: "move", x: cx, y: cy });
          await until(
            () => outer.call({ method: "observe" }),
            (shot) => toolbarPixels(shot).equals(uncapturedToolbar),
          );
          expect(await inner.call({ method: "status" })).toMatchObject({ humanControl: true });
          await outer.call({ method: "act", kind: "key", keys: ["Control_L", "Alt_L", "m"] });
          await sleep(100);
          await inner.call({ method: "take-control" });
          await sleep(150);
          await outer.call({ method: "act", kind: "move", x: cx + 30, y: cy });
          await until(() => hasHostCursor(cx + 30, cy, [25, 45, 70]), Boolean);
          if (typeof relativeApp.pid === "number") process.kill(relativeApp.pid, "SIGTERM");
          await until(
            () => processIdentity(relativeApp.pid as number),
            (v) => v === null,
          );
        }
        // Changing the guest mode must preserve its live applications and human
        // ownership on both SDL backends. Fit remains a separate viewer action.
        const beforeResize = await viewerNode();
        await outer.call({
          method: "act",
          kind: "click",
          x: Math.round(beforeResize.x + beforeResize.width - 60 * appearanceScale),
          y: Math.round(beforeResize.y + 20 * appearanceScale),
        });
        await until(
          () => inner.call({ method: "status" }),
          (v) => v.humanControl === true,
        );
        expect(
          await inner.call({ method: "set-display", width: 1920, height: 1080 }),
        ).toHaveProperty("error", "human_control_active");
        for (const resolution of [
          { width: 1920, height: 1080 },
          { width: 720, height: 1280 },
        ]) {
          expect(await inner.call({ method: "configure-display", ...resolution })).toMatchObject({
            ...resolution,
            humanControl: true,
          });
          const guest = await until(
            () => inner.call({ method: "observe" }),
            (v) => v.width === resolution.width && v.height === resolution.height,
          );
          await outer.call({
            method: "sway_command",
            command: `[pid=${launched.pid}] resize set 900 px 720 px, move position 20 px 20 px`,
          });
          // Sway's window resize and SDL's configure acknowledgement are
          // asynchronous. Fit is idempotent, so retry that local action until
          // the viewer has presented the new aspect instead of using a sleep.
          const fitted = await until(
            async () => {
              await clickFit();
              return viewerNode();
            },
            (v) =>
              Math.abs(
                v.width / (v.height - 44 * appearanceScale) - resolution.width / resolution.height,
              ) < 0.02,
          );
          // Compare actual presented pixels, not only IPC dimensions, to catch
          // stale-sized textures and failed DMA-BUF re-import after mode changes.
          const color = fixturePixel(
            String(guest.image),
            Math.floor(resolution.width / 2),
            Math.floor(resolution.height / 2),
          );
          await outer.call({ method: "act", kind: "move", x: 1, y: 1 });
          await until(
            () => outer.call({ method: "observe" }),
            (v) =>
              fixturePixel(
                String(v.image),
                Math.floor(fitted.x + fitted.width / 2),
                Math.floor(
                  fitted.y + 44 * appearanceScale + (fitted.height - 44 * appearanceScale) / 2,
                ),
              ).every((channel, i) => Math.abs(channel - color[i]!) < 8),
          );
          expect(await inner.call({ method: "status" })).toMatchObject({ humanControl: true });
        }
        await inner.call({ method: "take-control" });
        await inner.call({ method: "configure-display", width: 1280, height: 800 });
        await inner.call({ method: "observe" });
        if (typeof launched.pid === "number") process.kill(launched.pid, "SIGTERM");
        await until(
          () => inner.call({ method: "status" }),
          (v) => v.viewerOpen === false,
        );
        expect(await inner.call({ method: "status" })).toMatchObject({ ok: true });
      }
      const xoutput = path.join(root, "x11-input.txt");
      await inner.call({
        method: "launch",
        command: "/usr/bin/env",
        args: ["SDL_VIDEODRIVER=x11", fixture, xoutput, "X11"],
      });
      await until(
        () => fs.readFile(xoutput, "utf8"),
        (v) => v.includes("driver x11"),
      );
      await sleep(500);
      await inner.call({ method: "act", kind: "click", x: 1000, y: 300 });
      await inner.call({ method: "act", kind: "text", text: "café 日本語" });
      const xtext = await until(
        () => fs.readFile(xoutput, "utf8"),
        (v) => v.includes("語"),
      );
      expect(
        xtext
          .split("\n")
          .filter((line) => line.startsWith("text "))
          .map((line) => line.slice(5))
          .join(""),
        xtext,
      ).toContain("café 日本語");
      // A settings revocation closes the viewer/input channel but not the app.
      const takeoverViewer = await outer.call({
        method: "launch",
        command: "/usr/bin/env",
        args: ["SDL_VIDEODRIVER=wayland", helper, "viewer", viewerFile],
      });
      await until(
        () => inner.call({ method: "status" }),
        (v) => v.viewerOpen === true,
      );
      await sleep(500);
      const clickCount = (await fs.readFile(xoutput, "utf8"))
        .split("\n")
        .filter((v) => v.startsWith("click ")).length;
      const longText = inner
        .call({ method: "act", kind: "text", text: "日本語".repeat(200) })
        .catch(() => null);
      await sleep(100);
      await outer.call({ method: "act", kind: "click", x: 1140, y: 20 });
      await until(
        () => inner.call({ method: "status" }),
        (v) => v.humanControl === true,
      );
      await outer.call({ method: "act", kind: "click", x: 1000, y: 350 });
      await until(
        () => fs.readFile(xoutput, "utf8"),
        (v) => v.split("\n").filter((line) => line.startsWith("click ")).length > clickCount,
      );
      await longText;
      expect(typeof takeoverViewer.pid).toBe("number");
      await inner.call({ method: "policy", viewerEnabled: false, controlEnabled: false });
      expect(await inner.call({ method: "take-control" })).toMatchObject({
        error: "control_disabled",
      });
      expect(await inner.call({ method: "act", kind: "key", keys: ["a"] })).toMatchObject({
        error: "control_disabled",
      });
      expect(await inner.call({ method: "sway_command", command: "nop" })).toMatchObject({
        error: "control_disabled",
      });
      await inner.call({ method: "policy", viewerEnabled: false, controlEnabled: true });
      await inner.call({ method: "return-control" });
      const environmentPath = path.join(inner.directory, "environment.json");
      const ownEnvironment = await fs.readFile(environmentPath, "utf8");
      const foreignEnvironment = JSON.parse(
        await fs.readFile(path.join(outer.directory, "environment.json"), "utf8"),
      ) as { SWAYSOCK: string };
      try {
        await fs.writeFile(
          environmentPath,
          JSON.stringify({ ...JSON.parse(ownEnvironment), SWAYSOCK: foreignEnvironment.SWAYSOCK }),
        );
        expect(await inner.call({ method: "sway_command", command: "nop" })).toMatchObject({
          error: "invalid_socket",
        });
      } finally {
        await fs.writeFile(environmentPath, ownEnvironment);
      }
      expect(await inner.call({ method: "sway_command", command: "x".repeat(8193) })).toMatchObject(
        { error: "invalid_command" },
      );
      if (typeof app.pid === "number") expect(await processIdentity(app.pid)).not.toBeNull();
      await inner.call({ method: "terminate" });
      if (typeof app.pid === "number")
        await until(
          () => processIdentity(app.pid as number),
          (v) => v === null,
        );
      const environment = JSON.parse(
        await fs.readFile(path.join(outer.directory, "environment.json"), "utf8"),
      ) as { SWAYSOCK: string };
      expect(await swayRequest(environment.SWAYSOCK, 4)).toHaveProperty("type", "root");
    } finally {
      for (const worker of workers) {
        if (worker.child.pid && (await processIdentity(worker.child.pid)) === worker.start) {
          worker.child.kill("SIGTERM");
          await until(
            () => processIdentity(worker.child.pid!),
            (v) => v === null,
            6000,
          ).catch(() => undefined);
        }
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  (process.env.CAFE_CODE_CODEX_DESKTOP_E2E === "1" ? 420_000 : 60_000) + soakSeconds * 1000,
);
