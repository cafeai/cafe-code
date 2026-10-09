import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeControlHost, type NativeController } from "./NativeControlHost.ts";
import type { ThreadId } from "@cafecode/contracts";
import {
  NATIVE_CONTROL_HOST_FILE,
  readNativeControlHost,
  requestNativeControlHost,
  type NativeControlHostConnection,
  type NativeToolResult,
} from "@cafecode/shared/nativeControl";

async function fixture(fault?: "action" | "cleanup") {
  const request = vi.fn(async (body: Record<string, unknown>) => {
    if (body.method === "trusted_session_end")
      return fault === "cleanup"
        ? { closed: false, code: "session_cleanup_pending" }
        : { closed: true };
    if (fault === "action") throw new Error("synthetic uncertain action");
    return { content: [{ type: "text", text: "isolated native response" }] };
  });
  const controller: NativeController = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    session: vi.fn(async () => ({ request, close: vi.fn() })),
    health: vi.fn(async () => ({ content: [{ type: "text", text: "permission fixture" }] })),
  };
  const host = new NativeControlHost({
    stateDirectory: "unused-without-publication",
    runtimeRoot: "unused-injected-runtime",
    hostBundleId: "com.cafe.fixture",
    controller,
    platform: "darwin",
  });
  const connection = await host.listen(false);
  await host.setEnabled(true);
  // Existing action fixtures explicitly opt in; the separate admission case
  // below proves that a newly bound chat never inherits that choice.
  await host.setChatEnabled("fixture-thread" as ThreadId, true);
  async function bind(threadId = "fixture-thread") {
    const value = await requestNativeControlHost(connection, "bind", {
      threadId,
      providerInstanceId: "fixture-account",
      provider: "codex",
    });
    const token = value.token as string;
    const url = value.url as string;
    const update = (operation: string) =>
      requestNativeControlHost(connection, operation, { token });
    const rpc = async (method: string, params?: unknown) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
      });
      if (!response.ok) throw new Error(`denied ${response.status}`);
      return (await response.json()) as {
        result: NativeToolResult & { tools?: readonly { name: string }[] };
      };
    };
    return {
      token,
      url,
      update,
      rpc,
      call: (name: string, args: unknown = {}) => rpc("tools/call", { name, arguments: args }),
    };
  }
  return { host, connection, controller, request, bind };
}

describe("Electron-owned native control authority", () => {
  it("keeps each new chat off until trusted opt-in, including health and resumed bindings", async () => {
    const f = await fixture();
    const threadId = "new-chat" as ThreadId;
    try {
      expect((await f.host.chatState(threadId)).enabled).toBe(false);
      const binding = await f.bind(threadId);
      await binding.update("activate");
      await binding.update("begin-turn");
      expect((await binding.call("health")).result.isError).toBe(true);
      expect(
        (await binding.call("launch_app", { bundle_id: "com.apple.calculator" })).result.isError,
      ).toBe(true);
      expect(f.controller.health).not.toHaveBeenCalled();
      expect(f.controller.session).not.toHaveBeenCalled();
      await f.host.setChatEnabled(threadId, true);
      expect(
        (await binding.call("get_window_state", { pid: 1, window_id: 2 })).result.isError,
      ).not.toBe(true);
      expect(f.controller.session).toHaveBeenCalledWith(
        expect.stringMatching(/^Codex · [0-9a-f]{8}$/u),
      );
      expect(f.request).toHaveBeenCalledWith({
        method: "trusted_session_call",
        name: "get_window_state",
        args: {
          pid: 1,
          window_id: 2,
          include_screenshot: false,
          max_elements: 250,
          max_depth: 18,
          max_image_dimension: 1280,
        },
      });
      expect((await f.host.chatState("other-new-chat" as ThreadId)).enabled).toBe(false);
      await f.host.setChatEnabled(threadId, false);
      const resumed = await f.bind(threadId);
      await resumed.update("activate");
      await resumed.update("begin-turn");
      expect((await resumed.call("get_screen_size")).result.isError).toBe(true);
    } finally {
      await f.host.close();
    }
  });
  it("disables one chat, releases its session, and can re-enable its still-active turn", async () => {
    const f = await fixture();
    const threadId = "computer-use-fixture" as ThreadId;
    try {
      await f.host.setChatEnabled(threadId, true);
      const first = await f.bind(threadId);
      await first.update("activate");
      await first.update("begin-turn");
      expect((await f.host.chatState(threadId)).enabled).toBe(true);
      await first.call("get_screen_size");
      const state = await f.host.setChatEnabled(threadId, false);
      expect(state.enabled).toBe(false);
      expect(state.control.enabled).toBe(true);
      expect(f.request).toHaveBeenCalledWith({ method: "trusted_session_end" });
      expect((await first.call("health")).result.isError).toBe(true);
      expect(f.controller.health).not.toHaveBeenCalled();

      const second = await f.bind("another-chat");
      await f.host.setChatEnabled("another-chat" as ThreadId, true);
      await second.update("activate");
      await second.update("begin-turn");
      expect((await second.call("get_screen_size")).result.isError).not.toBe(true);
      await second.update("end-turn");

      await f.host.setChatEnabled(threadId, true);
      expect((await first.call("get_screen_size")).result.isError).not.toBe(true);
      expect(f.controller.stop).not.toHaveBeenCalled();
    } finally {
      await f.host.close();
    }
  });

  it("keeps a disabled chat denied when its provider binding is replaced", async () => {
    const f = await fixture();
    const threadId = "disabled-replacement" as ThreadId;
    try {
      await f.host.setChatEnabled(threadId, false);
      for (let index = 0; index < 2; index++) {
        const binding = await f.bind(threadId);
        await binding.update("activate");
        await binding.update("begin-turn");
        expect((await binding.call("get_screen_size")).result.isError).toBe(true);
      }
      expect(f.controller.session).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    } finally {
      await f.host.close();
    }
  });

  it.skipIf(process.platform === "win32")(
    "publishes private credentials inside Cafe's existing 0755 directory without changing it",
    async () => {
      const root = await fs.mkdtemp(join(tmpdir(), "cafe-native-publication-"));
      const stateDirectory = join(root, "userdata");
      const f = await fixture();
      const controller = { ...f.controller, start: vi.fn(async () => {}) };
      const host = new NativeControlHost({
        stateDirectory,
        runtimeRoot: "unused",
        hostBundleId: "fixture",
        platform: "darwin",
        controller,
      });
      try {
        await fs.mkdir(stateDirectory, { mode: 0o755 });
        await fs.chmod(stateDirectory, 0o755);
        const connection = await host.listen();
        const file = join(stateDirectory, NATIVE_CONTROL_HOST_FILE);
        expect(await readNativeControlHost(file)).toEqual(connection);
        expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(stateDirectory)).mode & 0o777).toBe(0o755);
        expect(controller.start).not.toHaveBeenCalled();
        await host.close();
        await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await fs.stat(stateDirectory)).mode & 0o777).toBe(0o755);
      } finally {
        await host.close();
        await f.host.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a state directory writable by other users without publishing credentials",
    async () => {
      const root = await fs.mkdtemp(join(tmpdir(), "cafe-native-publication-"));
      const f = await fixture();
      const host = new NativeControlHost({
        stateDirectory: root,
        runtimeRoot: "unused",
        hostBundleId: "fixture",
        platform: "darwin",
        controller: f.controller,
      });
      try {
        await fs.chmod(root, 0o777);
        await expect(host.listen()).rejects.toThrow("publication failed");
        await expect(fs.lstat(join(root, NATIVE_CONTROL_HOST_FILE))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await host.close();
        await f.host.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["linux", "win32"] as const)(
    "does not publish or start a controller on %s",
    async (platform) => {
      const f = await fixture();
      const controller = { ...f.controller, start: vi.fn(async () => {}) };
      const host = new NativeControlHost({
        stateDirectory: "unused",
        runtimeRoot: "unused",
        hostBundleId: "fixture",
        platform,
        controller,
      });
      try {
        await expect(host.listen(false)).rejects.toThrow("unavailable on this platform");
        expect((await host.setEnabled(true)).runtimeAvailable).toBe(false);
        expect(controller.start).not.toHaveBeenCalled();
      } finally {
        await host.close();
        await f.host.close();
      }
    },
  );

  it("serializes overlapping end-turn and dispose into one native cleanup", async () => {
    const f = await fixture();
    const cleanup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    try {
      const b = await f.bind();
      await b.update("activate");
      await b.update("begin-turn");
      await b.call("click", { x: 10, y: 20 });
      f.request.mockImplementation(async (body) => {
        expect(body.method).toBe("trusted_session_end");
        entered.resolve();
        await cleanup.promise;
        return { closed: true };
      });
      const ending = b.update("end-turn");
      await entered.promise;
      const disposing = b.update("dispose");
      cleanup.resolve();
      await Promise.all([ending, disposing]);
      expect(
        f.request.mock.calls.filter(([body]) => body.method === "trusted_session_end"),
      ).toHaveLength(1);
      expect(f.controller.stop).not.toHaveBeenCalled();
    } finally {
      cleanup.resolve();
      await f.host.close();
    }
  });

  it("does not become enabled when disable arrives during native startup", async () => {
    const f = await fixture();
    await f.host.setEnabled(false);
    const startup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    vi.mocked(f.controller.start).mockImplementation(async () => {
      entered.resolve();
      await startup.promise;
    });
    try {
      const enabling = f.host.setEnabled(true);
      await entered.promise;
      const disabling = f.host.setEnabled(false);
      expect((await f.host.state()).enabled).toBe(false);
      startup.resolve();
      await Promise.all([enabling, disabling]);
      expect(await f.host.state()).toMatchObject({ enabled: false, phase: "off" });
    } finally {
      startup.resolve();
      await f.host.close();
    }
  });
  it("allows pending discovery but requires activation and an active turn for actions", async () => {
    const f = await fixture();
    try {
      const b = await f.bind();
      const catalog = (await b.rpc("tools/list")).result.tools!;
      expect(catalog.some((tool) => tool.name === "click")).toBe(true);
      expect(catalog.some((tool) => /install|update|model|remote|session/u.test(tool.name))).toBe(
        false,
      );
      expect(catalog.some((tool) => tool.name === "launch_app")).toBe(true);
      expect(catalog.some((tool) => tool.name === "browser_click")).toBe(true);
      expect((await b.call("click", {})).result.isError).toBe(true);
      await b.update("activate");
      expect((await b.call("click", {})).result.isError).toBe(true);
      await b.update("begin-turn");
      expect((await b.call("click", { x: 10, y: 20 })).result.isError).not.toBe(true);
      await b.update("end-turn");
      expect(f.request).toHaveBeenCalledWith({ method: "trusted_session_end" });
      expect((await b.call("click", {})).result.isError).toBe(true);
    } finally {
      await f.host.close();
    }
  });

  it("rejects remote tools, file outputs and forged session metadata without native calls", async () => {
    const f = await fixture();
    try {
      const b = await f.bind();
      await b.update("activate");
      await b.update("begin-turn");
      for (const [name, args] of [
        ["install_extension", {}],
        ["check_for_update", {}],
        ["get_desktop_state", { screenshot_out_file: "untrusted" }],
        ["click", { target: { session_id: "foreign" } }],
        ["click", { _meta: { token: "foreign" } }],
      ] as const)
        expect((await b.call(name, args)).result.isError).toBe(true);
      expect(f.request).not.toHaveBeenCalled();
    } finally {
      await f.host.close();
    }
  });

  it("binds one exclusive owner and permits another only after acknowledged cleanup", async () => {
    const f = await fixture();
    try {
      const first = await f.bind("first");
      const second = await f.bind("second");
      await f.host.setChatEnabled("first" as ThreadId, true);
      await f.host.setChatEnabled("second" as ThreadId, true);
      await first.update("activate");
      await second.update("activate");
      await first.update("begin-turn");
      await second.update("begin-turn");
      await first.call("get_desktop_state");
      expect((await second.call("click", {})).result.isError).toBe(true);
      await first.update("end-turn");
      expect((await second.call("click", {})).result.isError).not.toBe(true);
      expect(
        f.request.mock.calls.filter(([body]) => body.method === "trusted_session_end"),
      ).toHaveLength(1);
    } finally {
      await f.host.close();
    }
  });

  it("invalidates superseded and competing staged generations without accepting arbitrary provider IDs", async () => {
    const f = await fixture();
    try {
      const first = await f.bind();
      const competing = await f.bind();
      await first.update("activate");
      await expect(competing.update("activate")).rejects.toThrow();
      const next = await f.bind();
      await next.update("activate");
      await expect(first.rpc("tools/list")).rejects.toThrow();
      await expect(
        requestNativeControlHost(f.connection, "bind", {
          threadId: "other",
          providerInstanceId: "other",
          provider: "grok",
        }),
      ).rejects.toThrow();
    } finally {
      await f.host.close();
    }
  });

  it.each(["action", "cleanup"] as const)(
    "stops the helper on %s uncertainty and never replays input",
    async (fault) => {
      const f = await fixture(fault);
      try {
        const b = await f.bind();
        await b.update("activate");
        await b.update("begin-turn");
        await b.call("click", { x: 1, y: 2 });
        if (fault === "cleanup") await b.update("end-turn");
        expect(f.controller.stop).toHaveBeenCalled();
        expect((await f.host.state()).enabled).toBe(false);
        expect(
          f.request.mock.calls.filter(([body]) => body.method === "trusted_session_call"),
        ).toHaveLength(1);
        expect((await b.call("click", {})).result.isError).toBe(true);
      } finally {
        await f.host.close();
      }
    },
  );

  it("revokes fresh admission on disable and denies unauthenticated model-side enable attempts", async () => {
    const f = await fixture();
    try {
      const b = await f.bind();
      await b.update("activate");
      await b.update("begin-turn");
      const response = await fetch(`${f.connection.url}/enable`, {
        method: "POST",
        headers: { Authorization: `Bearer ${b.token}` },
        body: "{}",
      });
      expect(response.status).toBe(403);
      await f.host.setEnabled(false);
      expect((await b.call("click", {})).result.isError).toBe(true);
      expect(f.controller.stop).toHaveBeenCalledTimes(1);
    } finally {
      await f.host.close();
    }
  });
});
