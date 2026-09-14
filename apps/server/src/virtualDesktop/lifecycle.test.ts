import { beforeEach, expect, it, vi } from "vitest";
import { ThreadId } from "@cafecode/contracts";
import { DesktopManager } from "./DesktopManager.ts";
import type { DesktopDefinition, DesktopStore } from "./store.ts";

const native = vi.hoisted(() => ({ request: vi.fn(), identity: vi.fn(), remove: vi.fn() }));
vi.mock("./nativeClient.ts", async (original) => ({
  ...(await original<typeof import("./nativeClient.ts")>()),
  nativeRequest: native.request,
  processIdentity: native.identity,
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  rm: native.remove,
}));
beforeEach(() => vi.resetAllMocks());

function fixture() {
  const definition: DesktopDefinition = {
    id: "desktop",
    name: "Test",
    incarnation: "one",
    directory: "private-desktop",
    boot_id: "current",
    pid: 42,
    process_start: "birth",
    state: "ready",
    created_at: 1,
  };
  const definitions = new Map([[definition.id, definition]]);
  const threadId = ThreadId.make("selected");
  const attachments = new Map([[threadId, definition.id]]);
  const store: DesktopStore = {
    list: async () => [...definitions.values()],
    put: vi.fn(async (value) => {
      definitions.set(value.id, value);
    }),
    selected: async (id) => attachments.get(id) ?? null,
    attach: vi.fn(),
    retire: vi.fn(),
    attached: vi.fn(),
    deleteStopped: vi.fn(async (id) => {
      const row = definitions.get(id);
      if (row && (row.pid !== null || row.state !== "stopped")) return false;
      for (const [thread, desktop] of attachments) if (desktop === id) attachments.delete(thread);
      definitions.delete(id);
      return true;
    }),
  };
  const observations = { save: vi.fn(), setRetention: vi.fn() };
  const manager = new DesktopManager({
    store,
    observations,
    stateDir: "unused",
    mcpPort: 12345,
    policy: {
      virtualDesktopsEnabled: false,
      desktopControlMcpEnabled: false,
      desktopObservationRetention: 50,
    },
  });
  const runtime = {
    definition,
    checked: Date.now(),
    snapshot: {
      id: definition.id,
      name: definition.name,
      state: "ready",
      humanControl: false,
      viewerOpen: false,
      controllingThreadId: null,
    },
  };
  const internal = manager as unknown as {
    initialized: Promise<void>;
    supported: boolean;
    boot: string;
    desktops: Map<string, unknown>;
    ownsDirectory: () => boolean;
  };
  internal.initialized = Promise.resolve();
  internal.supported = true;
  internal.boot = "current";
  internal.ownsDirectory = () => true;
  internal.desktops.set(definition.id, runtime);
  native.identity.mockResolvedValue("birth");
  native.remove.mockResolvedValue(undefined);
  native.request.mockImplementation(async (_helper, _bootstrap, request) => {
    if (request.method === "terminate") native.identity.mockResolvedValue(null);
    return { ok: true };
  });
  return { manager, runtime, store, definitions, attachments, threadId, observations };
}

it("ends and removes a session and its selections only after verified exit, even with the feature off", async () => {
  const { manager, definitions, attachments, threadId, observations } = fixture();
  let finish!: () => void;
  native.request.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    native.identity.mockResolvedValue(null);
    return { ok: true };
  });
  const ending = manager.manage({ operation: "end", id: "desktop", threadId });
  await vi.waitFor(() => expect(native.request).toHaveBeenCalled());
  expect(definitions.has("desktop")).toBe(true);
  expect(attachments.get(threadId)).toBe("desktop");
  expect(native.remove).not.toHaveBeenCalled();
  finish();
  expect(await ending).toMatchObject({ desktops: [], selectedDesktopId: null });
  expect(definitions.size).toBe(0);
  expect(native.remove).toHaveBeenCalledExactlyOnceWith("private-desktop", {
    recursive: true,
    force: true,
  });
  expect(observations.save).not.toHaveBeenCalled();
  expect(observations.setRetention).not.toHaveBeenCalled();
  await manager.close();
});
it("retains unknown process ownership and its record for a later cleanup attempt", async () => {
  const { manager, definitions } = fixture();
  native.identity.mockRejectedValue(new Error("inconclusive process read"));
  await expect(manager.manage({ operation: "end", id: "desktop" })).rejects.toThrow();
  expect(definitions.get("desktop")).toMatchObject({
    pid: 42,
    process_start: "birth",
    state: "failed",
  });
  expect(native.remove).not.toHaveBeenCalled();
  await manager.close();
});
it("keeps failed filesystem cleanup retryable and never discards its durable exit proof", async () => {
  const { manager, definitions, attachments, threadId } = fixture();
  native.remove.mockRejectedValue(new Error("private cleanup path"));
  await expect(manager.manage({ operation: "end", id: "desktop" })).rejects.toThrow(
    "cleanup is pending",
  );
  expect(definitions.get("desktop")).toMatchObject({
    pid: null,
    process_start: null,
    state: "stopped",
  });
  expect(attachments.get(threadId)).toBe("desktop");
  native.remove.mockResolvedValue(undefined);
  expect(await manager.manage({ operation: "end", id: "desktop", threadId })).toMatchObject({
    desktops: [],
    selectedDesktopId: null,
  });
  expect(native.request).toHaveBeenCalledTimes(1);
  await manager.close();
});
it("retires an exited session discovered during status without requiring End desktop", async () => {
  const { manager, runtime, definitions, threadId } = fixture();
  runtime.checked = 0;
  native.request.mockRejectedValue(new Error("worker exited"));
  native.identity.mockResolvedValue(null);
  expect(await manager.state(threadId)).toMatchObject({ desktops: [], selectedDesktopId: null });
  expect(definitions.size).toBe(0);
  await manager.close();
});
