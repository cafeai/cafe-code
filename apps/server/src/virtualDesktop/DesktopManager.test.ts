import { describe, it, expect, vi } from "vitest";
import { ThreadId } from "@cafecode/contracts";
import { DesktopManager } from "./DesktopManager.ts";
import type { DesktopStore } from "./store.ts";
import { checkDesktopPrerequisites } from "./prerequisites.ts";

vi.mock("./prerequisites.ts", () => ({ checkDesktopPrerequisites: vi.fn() }));

describe("desktop setup status", () => {
  it("caches checks across status reads, rechecks explicitly, and preserves session failures", async () => {
    const prerequisites = {
      sway: "installed",
      xwayland: "installed",
      dbus: "installed",
      helper: "installed",
    } as const;
    vi.mocked(checkDesktopPrerequisites).mockReset();
    vi.mocked(checkDesktopPrerequisites)
      .mockResolvedValueOnce({ ...prerequisites, sway: "missing" })
      .mockResolvedValue(prerequisites);
    const manager = new DesktopManager({
      store: {} as DesktopStore,
      observations: { save: vi.fn(), setRetention: vi.fn() },
      stateDir: "unused",
      mcpPort: 12345,
      policy: {
        virtualDesktopsEnabled: false,
        desktopControlMcpEnabled: false,
        desktopObservationRetention: 50,
      },
    });
    // Seed an empty Linux runtime without touching host processes/directories.
    // The test checks owner-side caching and readiness policy on every test OS.
    const internal = manager as unknown as {
      initialized: Promise<void>;
      supported: boolean;
      root: string;
      reason: string | null;
    };
    internal.initialized = Promise.resolve();
    internal.supported = true;
    internal.root = "test-private-runtime";
    expect(await manager.manage({ operation: "recheck" })).toMatchObject({
      available: false,
      prerequisites: { ...prerequisites, sway: "missing" },
    });
    await manager.state();
    await manager.state();
    expect(checkDesktopPrerequisites).toHaveBeenCalledTimes(1);
    expect(await manager.manage({ operation: "recheck" })).toMatchObject({
      available: true,
      prerequisites,
      reason: null,
    });
    expect(checkDesktopPrerequisites).toHaveBeenCalledTimes(2);
    internal.root = "";
    internal.reason = "Start Cafe from your logged-in desktop session.";
    expect(await manager.manage({ operation: "recheck" })).toMatchObject({
      available: false,
      prerequisites,
      reason: internal.reason,
    });
    await manager.close();
  });
});

describe("disabled desktop runtime", () => {
  it("does not let observation-storage failure block an access policy change", async () => {
    const observations = {
      save: vi.fn(),
      setRetention: vi.fn().mockRejectedValue(new Error("storage unavailable")),
    };
    const manager = new DesktopManager({
      store: {} as DesktopStore,
      observations,
      stateDir: "unused",
      mcpPort: 12345,
      policy: {
        virtualDesktopsEnabled: true,
        desktopControlMcpEnabled: true,
        desktopObservationRetention: 50,
      },
    });
    await expect(
      manager.setPolicy({
        virtualDesktopsEnabled: false,
        desktopControlMcpEnabled: false,
        desktopObservationRetention: 0,
      }),
    ).resolves.toBeUndefined();
    expect(observations.setRetention).toHaveBeenCalledWith(0);
    expect(
      (await manager.bind(ThreadId.make("disabled-after-cleanup-error"))).connectionPath,
    ).toBeNull();
    await manager.close();
  });
  it("does not touch processes or persistence for an unattached disabled Codex session", async () => {
    const store: DesktopStore = {
      list: vi.fn(),
      put: vi.fn(),
      selected: vi.fn(),
      attach: vi.fn(),
      retire: vi.fn(),
      deleteStopped: vi.fn(),
      attached: vi.fn().mockResolvedValue(false),
    };
    const manager = new DesktopManager({
      store,
      observations: { save: vi.fn(), setRetention: vi.fn() },
      stateDir: "unused",
      mcpPort: 12345,
      policy: {
        virtualDesktopsEnabled: false,
        desktopControlMcpEnabled: false,
        desktopObservationRetention: 50,
      },
    });
    const binding = await manager.bind(ThreadId.make("disabled"));
    expect(binding.connectionPath).toBeNull();
    expect(binding.signature).toBe("disabled");
    await binding.startTurn();
    await binding.endTurn();
    await binding.dispose();
    await manager.close();
    expect(store.list).not.toHaveBeenCalled();
    expect(store.selected).not.toHaveBeenCalled();
  });
  it("keeps the disabled transport valid on unsupported hosts", async () => {
    const store: DesktopStore = {
      list: vi.fn(),
      put: vi.fn(),
      selected: vi.fn(),
      attach: vi.fn(),
      retire: vi.fn(),
      deleteStopped: vi.fn(),
      attached: vi.fn().mockResolvedValue(false),
    };
    const manager = new DesktopManager({
      store,
      observations: { save: vi.fn(), setRetention: vi.fn() },
      stateDir: "unused",
      mcpPort: 12345,
      supported: false,
      policy: {
        virtualDesktopsEnabled: true,
        desktopControlMcpEnabled: true,
        desktopObservationRetention: 50,
      },
    });
    const binding = await manager.bind(ThreadId.make("unsupported"));
    expect(binding.connectionPath).toBeNull();
    await binding.startTurn();
    expect(await manager.state()).toMatchObject({
      supported: false,
      available: false,
      desktops: [],
    });
    expect(store.list).not.toHaveBeenCalled();
    await manager.close();
  });
});
