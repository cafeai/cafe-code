import { randomUUID } from "node:crypto";
import { desktopRuntimeDirectory } from "@cafecode/shared/desktopRuntime";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { ThreadId } from "@cafecode/contracts";
import { DesktopManager } from "../src/virtualDesktop/DesktopManager.ts";
import type { DesktopDefinition, DesktopStore } from "../src/virtualDesktop/store.ts";
import { processIdentity } from "../src/virtualDesktop/nativeClient.ts";
import type { describeSwayTree } from "../src/virtualDesktop/swayState.ts";

const enabled = process.platform === "linux" && process.env.CAFE_CODE_VIRTUAL_DESKTOP_E2E === "1";
it.skipIf(!enabled)(
  "adopts owned workers, keeps active selections pinned, revokes tools, and terminates only its own apps",
  async () => {
    const definitions = new Map<string, DesktopDefinition>(),
      attachments = new Map<ThreadId, string>();
    const store: DesktopStore = {
      list: async () => [...definitions.values()],
      put: async (v) => {
        definitions.set(v.id, v);
      },
      selected: async (id) => attachments.get(id) ?? null,
      attached: async (id) => [...attachments.values()].includes(id),
      attach: async (id, desktop) => {
        if (desktop) attachments.set(id, desktop);
        else attachments.delete(id);
      },
      retire: async (id) => {
        for (const [thread, desktop] of attachments) if (desktop === id) attachments.delete(thread);
      },
      deleteStopped: async (id) => {
        const definition = definitions.get(id);
        if (
          definition &&
          (definition.state !== "stopped" ||
            definition.pid !== null ||
            definition.process_start !== null)
        )
          return false;
        for (const [thread, desktop] of attachments) if (desktop === id) attachments.delete(thread);
        definitions.delete(id);
        return true;
      },
    };
    const stateDir = `/fixture-${randomUUID()}`;
    const root = desktopRuntimeDirectory(stateDir, process.getuid!());
    const helper =
      process.env.CAFE_CODE_DESKTOP_TEST_HELPER ??
      fileURLToPath(new URL("../dist/cafe-desktop-native", import.meta.url));
    const policy = {
      virtualDesktopsEnabled: true,
      desktopControlMcpEnabled: true,
      desktopObservationRetention: 0,
    };
    // This opt-in probe qualifies worker/input ownership. Private observation
    // persistence has deterministic store/HTTP tests and its own UI coverage.
    const observations = { save: vi.fn(), setRetention: vi.fn().mockResolvedValue(undefined) };
    const options = { store, observations, stateDir, helper, mcpPort: 12345, policy };
    let manager = new DesktopManager(options);
    const threadId = ThreadId.make("desktop-draft"),
      otherThread = ThreadId.make("desktop-other");
    try {
      const created = await manager.manage({
        operation: "create",
        name: "First",
        threadId,
        resolution: { width: 1600, height: 1200 },
      });
      expect(created).toMatchObject({ supported: true, enabled: true, available: true });
      const id = created.selectedDesktopId!;
      expect(created.desktops[0]).toMatchObject({ id, name: "First", state: "ready" });
      const pid = definitions.get(id)!.pid!;
      await expect(manager.manage({ operation: "delete", id })).rejects.toThrow("End this desktop");
      expect(await processIdentity(pid)).not.toBeNull();
      const binding = await manager.bind(threadId);
      const config = JSON.parse(await fs.readFile(binding.connectionPath!, "utf8")) as {
        token: string;
      };
      expect((await fs.stat(binding.connectionPath!)).mode & 0o777).toBe(0o600);
      await expect(manager.tool(config.token, "observe", {})).rejects.toThrow();
      await binding.startTurn();
      await expect(
        manager.tool(config.token, "act", { kind: "click", x: 20, y: 20 }),
      ).rejects.toThrow();
      await expect(manager.tool(config.token, "sway_command", { command: "nop" })).rejects.toThrow(
        "Observe",
      );
      expect(await manager.tool(config.token, "observe", {})).toHaveProperty("image");
      expect(await manager.tool(config.token, "get_display", {})).toMatchObject({
        width: 1600,
        height: 1200,
        canResize: true,
      });
      expect(
        await manager.tool(config.token, "set_display", { width: 1080, height: 1920 }),
      ).toMatchObject({ width: 1080, height: 1920, observeBeforeActing: true });
      await expect(
        manager.tool(config.token, "act", { kind: "click", x: 20, y: 20 }),
      ).rejects.toThrow("Observe");
      expect(await manager.tool(config.token, "observe", {})).toMatchObject({
        width: 1080,
        height: 1920,
      });
      expect(
        await manager.tool(config.token, "act", {
          kind: "drag",
          x: 50,
          y: 50,
          toX: 1000,
          toY: 1800,
        }),
      ).toMatchObject({ ok: true });
      await manager.tool(config.token, "sway_command", { command: "output * mode 1920x1080" });
      await expect(
        manager.tool(config.token, "act", { kind: "click", x: 1800, y: 1000 }),
      ).rejects.toThrow("Observe");
      expect(await manager.tool(config.token, "observe", {})).toMatchObject({
        width: 1920,
        height: 1080,
      });
      expect(
        await manager.tool(config.token, "act", {
          kind: "drag",
          x: 50,
          y: 50,
          toX: 1800,
          toY: 1000,
        }),
      ).toMatchObject({ ok: true });
      await manager.manage({
        operation: "set-display",
        id,
        resolution: { width: 1280, height: 800 },
      });
      await expect(
        manager.tool(config.token, "act", { kind: "click", x: 20, y: 20 }),
      ).rejects.toThrow("Observe");
      expect(await manager.tool(config.token, "observe", {})).toMatchObject({
        width: 1280,
        height: 800,
      });
      if (process.env.CAFE_CODE_DESKTOP_WINDOW_E2E === "1") {
        // Opt-in: two real Alacritty processes reproduce the application socket
        // filename that exceeded sun_path before compact runtime directories.
        const tool = (name: string, args: Record<string, unknown> = {}) =>
          manager.tool(config.token, name, args);
        const windows = async () =>
          (await tool("windows", { detail: true })) as ReturnType<typeof describeSwayTree>;
        const waitForWindow = async (
          windowId: number,
          ready: (window: ReturnType<typeof describeSwayTree>["windows"][number]) => boolean,
        ) => {
          for (let i = 0; i < 50; i++) {
            const window = (await windows()).windows.find((w) => w.id === windowId);
            if (window && ready(window)) return window;
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
          throw new Error("Window state did not settle.");
        };
        for (const title of ["Cafe window test A", "Cafe window test B"])
          expect(
            await tool("launch", {
              command: "alacritty",
              args: ["--title", title, "-e", "sleep", "600"],
            }),
          ).toHaveProperty("opened", true);
        const first = (await windows()).windows.find((w) => w.title === "Cafe window test A")!;
        const second = (await windows()).windows.find((w) => w.title === "Cafe window test B")!;
        expect(first?.id).toBeGreaterThan(0);
        expect(second?.id).toBeGreaterThan(0);
        const window = (windowId: number, action: Record<string, unknown>) =>
          tool("window", { windowId, action });
        const workspace = async (action: Record<string, unknown>) => {
          const result = await tool("workspace", { action });
          expect(result, JSON.stringify(result)).toHaveProperty("ok", true);
          return result;
        };
        expect(
          await tool("layout", {
            containerId: first.parentId,
            action: { type: "set", layout: "tabbed" },
          }),
        ).toHaveProperty("ok", true);
        await tool("focus", { windowId: first.id });
        expect(await waitForWindow(first.id, (w) => w.visible === true)).toHaveProperty(
          "parentLayout",
          "tabbed",
        );
        await waitForWindow(second.id, (w) => w.visible === false);
        await window(first.id, { type: "fullscreen", enabled: true });
        await waitForWindow(first.id, (w) => w.fullscreenMode === 1);
        await window(first.id, { type: "fullscreen", enabled: false });
        await window(second.id, { type: "floating", enabled: true });
        await window(second.id, { type: "resize", width: 500, height: 300 });
        await waitForWindow(second.id, (w) => w.width === 500 && w.height === 300 && w.floating);
        await window(second.id, { type: "position", x: 40, y: 60 });
        await waitForWindow(second.id, (w) => w.x === 40 && w.y === 60);
        await window(second.id, { type: "sticky", enabled: true });
        await waitForWindow(second.id, (w) => w.sticky);
        await window(second.id, { type: "sticky", enabled: false });
        expect(await window(second.id, { type: "center" })).toHaveProperty("ok", true);
        await window(second.id, { type: "hide" });
        await waitForWindow(second.id, (w) => w.hiddenInScratchpad);
        await window(second.id, { type: "restore" });
        await waitForWindow(second.id, (w) => !w.hiddenInScratchpad && w.visible === true);
        await window(second.id, { type: "restore" });
        await waitForWindow(second.id, (w) => !w.hiddenInScratchpad);
        await workspace({ type: "move", windowId: second.id, name: "2: test" });
        await workspace({ type: "switch", name: "2: test" });
        await workspace({ type: "rename", name: "2: test", newName: "2: renamed" });
        await waitForWindow(second.id, (w) => w.workspace === "2: renamed" && w.visible === true);
        expect(await tool("workspaces")).toEqual(
          expect.arrayContaining([expect.objectContaining({ name: "2: renamed", focused: true })]),
        );
        expect(await tool("sway_query", { query: "tree", containerId: second.id })).toHaveProperty(
          "id",
          second.id,
        );
        expect(
          await tool("sway_command", {
            command: `[con_id=${second.id}] fullscreen enable; [con_id=99999999] focus`,
          }),
        ).toMatchObject({
          success: false,
          partialFailure: true,
          results: [{ success: true }, { success: false }],
          observeBeforeRetry: true,
        });
        await waitForWindow(second.id, (w) => w.fullscreenMode === 1);
        await window(second.id, { type: "fullscreen", enabled: false });
        await workspace({ type: "move", windowId: second.id, name: first.workspace });
        await workspace({ type: "switch", name: first.workspace });
        await window(second.id, { type: "floating", enabled: false });
        expect(await window(second.id, { type: "swap", otherWindowId: first.id })).toHaveProperty(
          "ok",
          true,
        );
        expect(
          await tool("layout", {
            containerId: first.id,
            action: { type: "split", direction: "vertical" },
          }),
        ).toHaveProperty("ok", true);
        await tool("focus", { windowId: second.id });
        expect(await tool("focus", { direction: "prev" })).toHaveProperty("ok", true);
        const directory = definitions.get(id)!.directory;
        const sockets = (await fs.readdir(directory)).filter(
          (name) => name.startsWith("Alacritty") && name.endsWith(".sock"),
        );
        expect(sockets.length).toBeGreaterThanOrEqual(2);
        for (const socket of sockets)
          expect((await fs.lstat(path.join(directory, socket))).isSocket()).toBe(true);
        await tool("sway_command", {
          command: `exec touch '${path.join(directory, "exec-proof")}'`,
        });
        for (
          let i = 0;
          i < 50 &&
          !(await fs.access(path.join(directory, "exec-proof")).then(
            () => true,
            () => false,
          ));
          i++
        )
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(await fs.readFile(path.join(directory, "exec-proof"), "utf8")).toBe("");
        await window(first.id, { type: "close" });
        await window(second.id, { type: "close" });
      }
      await expect(
        manager.manage({ operation: "attach", id, threadId: otherThread }),
      ).rejects.toMatchObject({ code: "busy" });
      await binding.endTurn();
      await manager.manage({ operation: "attach", id, threadId: otherThread });
      await binding.startTurn();
      const competing = await manager.bind(otherThread);
      await expect(competing.startTurn()).rejects.toThrow();
      await competing.dispose();
      await manager.manage({ operation: "attach", id: null, threadId });
      expect(await manager.state(threadId)).toMatchObject({
        selectedDesktopId: null,
        activeDesktopId: id,
        selectionPending: true,
      });
      await manager.setPolicy({ ...policy, desktopControlMcpEnabled: false });
      expect(() => manager.authorize(config.token)).toThrow();
      expect(await processIdentity(pid)).not.toBeNull();
      await manager.setPolicy(policy);
      await manager.manage({ operation: "attach", id, threadId });
      const renewed = await manager.bind(threadId);
      await renewed.startTurn();
      expect(renewed.signature).not.toBe(binding.signature);
      await manager.manage({ operation: "rename", id, name: "Renamed" });
      await manager.close();
      expect(await processIdentity(pid)).not.toBeNull();
      manager = new DesktopManager({ ...options, policy });
      const adopted = await manager.state(threadId);
      expect(adopted).toMatchObject({ selectedDesktopId: id, activeDesktopId: null });
      expect(adopted.desktops[0]).toMatchObject({ name: "Renamed", state: "ready" });
      expect(definitions.get(id)!.pid).toBe(pid);
      expect(() => manager.authorize(config.token)).toThrow();
      const originalDefinition = definitions.get(id)!;
      await manager.manage({ operation: "end", id });
      expect(await processIdentity(pid)).toBeNull();
      expect(await manager.state(threadId)).toMatchObject({ selectedDesktopId: null });
      expect(
        await fs.access(originalDefinition.directory).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(definitions.has(id)).toBe(false);
      expect((await manager.state()).desktops).toHaveLength(0);
      // A stale persisted PID must never authorize a kill of the current test host.
      const staleId = randomUUID();
      definitions.set(staleId, {
        ...originalDefinition,
        id: staleId,
        pid: process.pid,
        process_start: "not-this-process",
        state: "ready",
      });
      await manager.close();
      manager = new DesktopManager({ ...options, policy });
      expect((await manager.state()).desktops.find((d) => d.id === staleId)).toBeUndefined();
      expect(definitions.has(staleId)).toBe(false);
      expect(await processIdentity(process.pid)).not.toBeNull();
      const previousBoot = randomUUID();
      definitions.set(previousBoot, {
        ...originalDefinition,
        id: previousBoot,
        boot_id: "previous-boot",
        pid: process.pid,
        process_start: (await processIdentity(process.pid))!,
      });
      attachments.set(threadId, previousBoot);
      await manager.close();
      manager = new DesktopManager({ ...options, policy });
      expect(await manager.state(threadId)).toMatchObject({
        desktops: [],
        selectedDesktopId: null,
      });
      expect(definitions.has(previousBoot)).toBe(false);
      expect(await processIdentity(process.pid)).not.toBeNull();
      // Explicit Quit must still reap an authenticated worker when its daemon
      // is gone. The next manager removes its ended session.
      const recovery = await manager.manage({ operation: "create", name: "Quit recovery" });
      const recoveryId = recovery.desktops.find((d) => d.state === "ready")!.id;
      const recoveryPid = definitions.get(recoveryId)!.pid!;
      await manager.close();
      // Load the desktop-owned fallback only in this opt-in cross-package
      // test; the server production TypeScript project must not include it.
      const cleanupModule = new URL(
        "../../desktop/src/backend/VirtualDesktopCleanup.ts",
        import.meta.url,
      ).href;
      const { stopDesktopWorkers } = (await import(cleanupModule)) as {
        stopDesktopWorkers(stateDir: string, backendEntryPath: string): Promise<boolean>;
      };
      expect(await stopDesktopWorkers(stateDir, path.join(path.dirname(helper), "bin.mjs"))).toBe(
        true,
      );
      expect(await processIdentity(recoveryPid)).toBeNull();
      manager = new DesktopManager({ ...options, policy });
      expect((await manager.state()).desktops.find((d) => d.id === recoveryId)).toBeUndefined();
      if (process.env.CAFE_CODE_DESKTOP_WINDOW_E2E === "1") {
        // Raw exit is deliberately part of full Sway access. It must leave no
        // live worker behind and must revoke the associated model capability.
        const exitState = await manager.manage({ operation: "create", threadId, name: "Raw exit" });
        const exitId = exitState.selectedDesktopId!;
        const exitPid = definitions.get(exitId)!.pid!;
        const exitBinding = await manager.bind(threadId);
        const { token } = JSON.parse(await fs.readFile(exitBinding.connectionPath!, "utf8")) as {
          token: string;
        };
        await exitBinding.startTurn();
        await manager.tool(token, "observe", {});
        // Sway may close IPC before its ACK; that is an uncertain response, not
        // a reason to repeat exit. Observe process/state exactly once afterward.
        await manager.tool(token, "sway_command", { command: "exit" }).catch(() => undefined);
        for (let i = 0; i < 100 && (await processIdentity(exitPid)); i++)
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(await processIdentity(exitPid)).toBeNull();
        for (
          let i = 0;
          i < 60 &&
          (await manager.state()).desktops.find((d) => d.id === exitId)?.state === "ready";
          i++
        )
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect((await manager.state()).desktops.find((d) => d.id === exitId)).toBeUndefined();
        expect(() => manager.authorize(token)).toThrow();
      }
      await manager.setPolicy({
        ...policy,
        virtualDesktopsEnabled: false,
        desktopControlMcpEnabled: false,
      });
      expect(
        (await manager.manage({ operation: "end", id })).desktops.some((d) => d.id === id),
      ).toBe(false);
      expect(definitions.has(id)).toBe(false);
      await manager.close();
      manager = new DesktopManager({ ...options, policy });
      expect((await manager.state()).desktops.some((d) => d.id === id)).toBe(false);
    } finally {
      await manager.terminateAll();
      await manager.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
