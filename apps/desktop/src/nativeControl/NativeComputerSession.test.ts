import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeComputerSession } from "./NativeComputerSession.ts";
import type { NativeInvoke } from "./NativeControlActions.ts";
import { compactNativeToolResult, type NativeToolResult } from "@cafecode/shared/nativeControl";

type Fields = Record<string, unknown>;
const reply = (data: Fields = {}, isError = false): NativeToolResult => ({
  content: [],
  structuredContent: data,
  ...(isError ? { isError: true } : {}),
});
const image = { type: "image", mimeType: "image/png", data: "synthetic" };

function fixture() {
  let snapshot = 0;
  let value = "";
  let clipboard = "original clipboard";
  let webContent = false;
  const state = (args: Fields) => {
    snapshot++;
    const id = "s" + snapshot.toString(16).padStart(8, "0");
    const visual = args.include_screenshot === true;
    return {
      pid: args.pid,
      window_id: args.window_id,
      window_title: "Fixture",
      ...(args.include_accessibility_tree === false
        ? {}
        : {
            snapshot_id: id,
            elements: [
              {
                element_token: id + ":1",
                element_index: 1,
                role: "AXTextField",
                label: "Message",
                value,
                in_web_content: webContent,
                frame: { x: 5, y: 10, w: 50, h: 20 },
                ...(visual ? { screenshot_frame: { x: 10, y: 20, w: 100, h: 40 } } : {}),
              },
              { element_token: id + ":2", element_index: 2, role: "AXButton", label: "Send" },
            ],
          }),
      ...(visual
        ? { capture_id: "capture-" + snapshot, screenshot_width: 400, screenshot_height: 300 }
        : {}),
    };
  };
  const invoke = vi.fn<NativeInvoke>(async (name, args) => {
    if (name === "list_apps")
      return reply({
        apps: [{ name: "Fixture", bundle_id: "com.fixture", pid: 10, running: true }],
      });
    if (name === "launch_app") return reply({ pid: 10 });
    if (name === "list_windows")
      return reply({ windows: [{ pid: 10, window_id: 20, bounds: { width: 400, height: 300 } }] });
    if (name === "get_window_state")
      return { ...reply(state(args)), content: args.include_screenshot ? [image] : [] };
    if (name === "clipboard_read")
      return reply({ types: ["public.utf8-plain-text"], text: clipboard });
    if (name === "clipboard_write") {
      clipboard = String(args.text);
      return reply();
    }
    if (name === "hotkey" && (args.keys as string[])?.includes("v")) value += clipboard;
    if (name === "type_text") value += String(args.text);
    if (name === "set_value") value = String(args.value);
    return reply({ effect: "unverifiable" });
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const computer = new NativeComputerSession(invoke, { sleep });
  const select = (args: Fields = {}) =>
    computer.call("computer_select", { pid: 10, window_id: 20, ...args });
  return {
    invoke,
    computer,
    select,
    sleep,
    setWebContent: () => {
      webContent = true;
    },
    clipboard: () => clipboard,
  };
}
const data = (result: NativeToolResult) => result.structuredContent!;
const stateOf = (result: NativeToolResult) => data(result).state as Fields;
const firstElement = (result: NativeToolResult) =>
  (stateOf(result).elements as Fields[])[0]!.element_token as string;

describe("bound native computer interface", () => {
  it("scopes the bound window before the output limit so application menus cannot hide its fields", async () => {
    const f = fixture();
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (name, args) => {
      const result = await original(name, args);
      if (name === "get_window_state") {
        const state = result.structuredContent!;
        const children = state.elements as Fields[];
        for (const [index, entry] of children.entries()) {
          entry.element_index = 301 + index;
          entry.parent_index = 300;
          entry.element_token = String(state.snapshot_id) + ":" + (301 + index);
        }
        state.window_bounds = { x: 0, y: 0, width: 200, height: 150 };
        state.elements = [
          ...Array.from({ length: 210 }, (_, index) => ({
            role: "AXMenuItem",
            element_index: index,
            label: "Menu " + index,
          })),
          { role: "AXWindow", element_index: 300, frame: { x: 0, y: 0, w: 200, h: 150 } },
          ...children,
        ];
      }
      return result;
    });
    const selected = await f.select();
    const state = stateOf(selected);
    expect(state).toMatchObject({
      returned_element_count: 3,
      omitted_nonwindow_elements: 210,
      output_truncated: false,
    });
    const field = (state.elements as Fields[]).find((entry) => entry.role === "AXTextField")!;
    const typed = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [{ type: "type", element: field.element_token, text: "hello" }],
    });
    expect(data(typed)).toMatchObject({
      batch: "completed",
      results: [expect.objectContaining({ text_observed: true })],
    });
  });
  it("resolves a running app once and reuses the exact bound window across calls", async () => {
    const f = fixture();
    const selected = await f.computer.call("computer_select", { app: "com.fixture" });
    const target = data(selected).target;
    await f.computer.call("computer_observe", { target });
    await f.computer.call("computer_act", { target, actions: [{ type: "key", keys: ["return"] }] });
    expect(f.invoke.mock.calls.filter(([name]) => name === "list_apps")).toHaveLength(1);
    expect(f.invoke.mock.calls.filter(([name]) => name === "list_windows")).toHaveLength(1);
    expect(f.invoke).toHaveBeenCalledWith(
      "press_key",
      expect.objectContaining({ pid: 10, window_id: 20, key: "return" }),
    );
  });
  it("launches only the explicitly requested app when it is not running", async () => {
    const f = fixture();
    f.invoke.mockImplementationOnce(async () => reply({ apps: [] }));
    await f.computer.call("computer_select", { app: "Other App" });
    expect(f.invoke).toHaveBeenCalledWith("launch_app", { name: "Other App" });
  });
  it("reports ambiguous windows without choosing one or sending input", async () => {
    const f = fixture();
    f.invoke.mockImplementationOnce(async () =>
      reply({
        windows: [
          { window_id: 20, bounds: { width: 400, height: 300 } },
          { window_id: 21, bounds: { width: 500, height: 400 } },
        ],
      }),
    );
    const selected = await f.computer.call("computer_select", { pid: 10 });
    expect(data(selected)).toMatchObject({ selection_required: true });
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it("rejects handles from another control episode and clears released targets", async () => {
    const f = fixture();
    const selected = await f.select();
    const second = new NativeComputerSession(f.invoke);
    expect((await second.call("computer_observe", { target: data(selected).target })).isError).toBe(
      true,
    );
    f.computer.clear();
    expect(
      (
        await f.computer.call("computer_act", {
          target: data(selected).target,
          actions: [{ type: "key", keys: ["return"] }],
        })
      ).isError,
    ).toBe(true);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it("validates malformed later steps and stale elements before any batch input", async () => {
    const f = fixture();
    const selected = await f.select();
    const target = data(selected).target;
    const before = f.invoke.mock.calls.length;
    await expect(
      f.computer.call("computer_act", {
        target,
        actions: [
          { type: "key", keys: ["return"] },
          { type: "type", text: "secret", pid: 99 },
        ],
      }),
    ).rejects.toThrow();
    expect(
      (
        await f.computer.call("computer_act", {
          target,
          actions: [
            { type: "key", keys: ["return"] },
            { type: "click", element: "foreign:1" },
          ],
        })
      ).isError,
    ).toBe(true);
    expect(f.invoke).toHaveBeenCalledTimes(before);
  });
  it("batches click, verified text insertion and a key, then returns fresh state", async () => {
    const f = fixture();
    const selected = await f.select();
    const element = firstElement(selected);
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [
        { type: "click", element },
        { type: "type", element, text: "hello" },
        { type: "key", keys: ["return"] },
      ],
    });
    expect(data(response)).toMatchObject({
      batch: "completed",
      attempted_steps: 3,
      settling: "stable",
      results: [
        expect.anything(),
        expect.objectContaining({ text_observed: true, application_acceptance: "observed" }),
        expect.anything(),
      ],
    });
    expect(
      f.invoke.mock.calls
        .filter(([name]) => ["click", "type_text", "press_key"].includes(name))
        .map(([name]) => name),
    ).toEqual(["click", "type_text", "press_key"]);
    expect(firstElement(response)).not.toBe(element);
  });
  it.each(["partial", "indeterminate", "uncertain"])(
    "stops %s delivery without replay or subsequent input",
    async (effect) => {
      const f = fixture();
      const selected = await f.select();
      f.invoke.mockImplementationOnce(async () => reply({ effect }, true));
      const response = await f.computer.call("computer_act", {
        target: data(selected).target,
        actions: [
          { type: "type", text: "hello" },
          { type: "key", keys: ["return"] },
        ],
      });
      expect(response.isError).toBe(true);
      expect(data(response)).toMatchObject({ batch: "stopped", attempted_steps: 1, stopped_at: 0 });
      expect(f.invoke.mock.calls.filter(([name]) => name === "type_text")).toHaveLength(1);
      expect(f.invoke.mock.calls.some(([name]) => name === "press_key")).toBe(false);
      expect(JSON.parse(String(compactNativeToolResult(response).content[0]!.text))).toHaveProperty(
        "state",
      );
    },
  );
  it("stops an acknowledged incomplete delivery even without an error flag", async () => {
    const f = fixture();
    const selected = await f.select();
    f.invoke.mockImplementationOnce(async () =>
      reply({ delivery: { delivered_count: 1, sent_count: 2 } }),
    );
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [
        { type: "type", text: "hi" },
        { type: "key", keys: ["return"] },
      ],
    });
    expect(data(response).batch).toBe("stopped");
    expect(f.invoke.mock.calls.some(([name]) => name === "press_key")).toBe(false);
  });
  it("refuses unchanged native text without equating a delivery acknowledgement to success", async () => {
    const f = fixture();
    const selected = await f.select();
    f.invoke.mockImplementationOnce(async () => reply({ effect: "unverifiable" }));
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [
        { type: "type", element: firstElement(selected), text: "hello" },
        { type: "key", keys: ["return"] },
      ],
    });
    expect(data(response)).toMatchObject({
      batch: "stopped",
      results: [expect.objectContaining({ text_observed: false, effect: "uncertain" })],
    });
    expect(f.invoke.mock.calls.some(([name]) => name === "press_key")).toBe(false);
  });
  it("grounds Electron text in the current screenshot and keeps an AX echo unverified", async () => {
    const f = fixture();
    f.setWebContent();
    const selected = await f.select();
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [{ type: "type", element: firstElement(selected), text: "hello" }],
    });
    expect(f.invoke).toHaveBeenCalledWith(
      "click",
      expect.objectContaining({
        pid: 10,
        window_id: 20,
        x: 60,
        y: 40,
        delivery_mode: "foreground",
      }),
    );
    expect(f.invoke).toHaveBeenCalledWith(
      "type_text",
      expect.objectContaining({
        pid: 10,
        window_id: 20,
        text: "hello",
        delivery_mode: "foreground",
      }),
    );
    const typed = f.invoke.mock.calls.find(([name]) => name === "type_text")![1];
    expect(typed).not.toHaveProperty("x");
    expect(data(response)).toMatchObject({
      results: [
        expect.objectContaining({ text_observed: true, application_acceptance: "unverified" }),
      ],
    });
  });
  it("refreshes the exact Electron field when menu changes shift AX traversal indices", async () => {
    const f = fixture();
    f.setWebContent();
    const selected = await f.select();
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (name, args) => {
      const result = await original(name, args);
      if (name === "get_window_state")
        for (const entry of result.structuredContent!.elements as Fields[])
          entry.element_index = Number(entry.element_index) + 20;
      return result;
    });
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [
        { type: "type", element: firstElement(selected), text: "hello" },
        { type: "key", keys: ["return"] },
      ],
    });
    expect(data(response)).toMatchObject({
      batch: "completed",
      results: [expect.objectContaining({ text_observed: true }), expect.anything()],
    });
    expect(f.invoke.mock.calls.filter(([name]) => name === "type_text")).toHaveLength(1);
    expect(f.invoke).toHaveBeenCalledWith(
      "press_key",
      expect.objectContaining({
        pid: 10,
        window_id: 20,
        key: "return",
        delivery_mode: "foreground",
      }),
    );
  });
  it.each(["type", "paste"])(
    "stops %s before text or clipboard changes when the renderer focus click is uncertain",
    async (type) => {
      const f = fixture();
      f.setWebContent();
      const selected = await f.select();
      const original = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementation(async (name, args) =>
        name === "click" ? reply({ effect: "uncertain" }) : original(name, args),
      );
      const response = await f.computer.call("computer_act", {
        target: data(selected).target,
        actions: [
          { type, element: firstElement(selected), text: "hello" },
          { type: "key", keys: ["return"] },
        ],
      });
      expect(data(response)).toMatchObject({ batch: "stopped", attempted_steps: 1 });
      expect(f.invoke.mock.calls.filter(([name]) => name === "click")).toHaveLength(1);
      expect(
        f.invoke.mock.calls.some(([name]) =>
          ["type_text", "clipboard_write", "press_key"].includes(name),
        ),
      ).toBe(false);
      expect(f.clipboard()).toBe("original clipboard");
    },
  );
  it.each(["ambiguous", "moved", "missing_bounds"])(
    "refuses %s Electron field identity before text input",
    async (identity) => {
      const f = fixture();
      f.setWebContent();
      const selected = await f.select();
      const original = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementation(async (name, args) => {
        const result = await original(name, args);
        if (name === "get_window_state") {
          const entries = result.structuredContent!.elements as Fields[];
          if (identity === "ambiguous") entries.push({ ...entries[0], element_index: 100 });
          if (identity === "moved") entries[0]!.frame = { x: 6, y: 10, w: 50, h: 20 };
          if (identity === "missing_bounds") delete entries[0]!.frame;
        }
        return result;
      });
      const response = await f.computer.call("computer_act", {
        target: data(selected).target,
        actions: [{ type: "type", element: firstElement(selected), text: "hello" }],
      });
      expect(response.isError).toBe(true);
      expect(f.invoke.mock.calls.some(([name]) => name === "type_text")).toBe(false);
    },
  );
  it("stops after a web AX value echo instead of using it to authorize a subsequent submit", async () => {
    const f = fixture();
    f.setWebContent();
    const selected = await f.select();
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [
        { type: "set_value", element: firstElement(selected), value: "hello" },
        { type: "key", keys: ["return"] },
      ],
    });
    expect(data(response)).toMatchObject({
      batch: "stopped",
      results: [
        expect.objectContaining({
          text_observed: true,
          application_acceptance: "unverified",
          effect: "uncertain",
        }),
      ],
    });
    expect(f.invoke.mock.calls.some(([name]) => name === "press_key")).toBe(false);
  });
  it("diffs unchanged native records while publishing fresh tokens, with a full-state escape hatch", async () => {
    const f = fixture();
    const selected = await f.select();
    const observed = await f.computer.call("computer_observe", { target: data(selected).target });
    expect(stateOf(observed)).toMatchObject({
      elements: [],
      diff: {
        from_snapshot: "s00000001",
        token_updates: [
          { from: "s00000001:1", to: "s00000002:1" },
          { from: "s00000001:2", to: "s00000002:2" },
        ],
      },
    });
    const full = await f.computer.call("computer_observe", {
      target: data(selected).target,
      full: true,
    });
    expect(stateOf(full)).not.toHaveProperty("diff");
    expect(stateOf(full).elements).toHaveLength(2);
  });
  it("clears coordinate grounding on accessibility-only reads and preserves images after pixel actions", async () => {
    const f = fixture();
    const selected = await f.select({ view: "both" });
    const target = data(selected).target;
    const response = await f.computer.call("computer_act", {
      target,
      actions: [{ type: "click", point: { x: 100, y: 100 } }],
    });
    expect(response.content).toContainEqual(image);
    expect(stateOf(response)).toHaveProperty("capture_id");
    expect(f.invoke).toHaveBeenCalledWith(
      "click",
      expect.objectContaining({ capture_id: "capture-1" }),
    );
    await f.computer.call("computer_observe", { target });
    const before = f.invoke.mock.calls.length;
    expect(
      (
        await f.computer.call("computer_act", {
          target,
          actions: [{ type: "click", point: { x: 100, y: 100 } }],
        })
      ).isError,
    ).toBe(true);
    expect(f.invoke).toHaveBeenCalledTimes(before);
  });
  it("bounds settling without claiming that a changing view is stable", async () => {
    const f = fixture();
    const selected = await f.select();
    f.invoke.mockImplementation(async (name) =>
      name === "get_window_state"
        ? reply({ elements: [{ role: "AXProgressIndicator" }], snapshot_id: "s00000002" })
        : reply(),
    );
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [{ type: "key", keys: ["return"] }],
    });
    expect(data(response).settling).toBe("budget_exhausted");
    expect(f.sleep).toHaveBeenCalledTimes(4);
  });
  it("pastes into a grounded field, observes it before restoring plain-text clipboard content", async () => {
    const f = fixture();
    const selected = await f.select();
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [{ type: "paste", element: firstElement(selected), text: "hello" }],
    });
    expect(data(response)).toMatchObject({
      batch: "completed",
      results: [expect.objectContaining({ text_observed: true, clipboard: "restored" })],
    });
    expect(f.clipboard()).toBe("original clipboard");
    const writes = f.invoke.mock.calls.filter(([name]) => name === "clipboard_write");
    expect(writes.map(([, args]) => args)).toEqual([
      { text: "hello" },
      { text: "original clipboard" },
    ]);
    expect(JSON.stringify(response)).not.toContain("original clipboard");
  });
  it("refuses unsupported clipboard formats without destroying them", async () => {
    const f = fixture();
    const selected = await f.select();
    f.invoke.mockImplementationOnce(async () => reply({ types: ["public.png"], text: null }));
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [{ type: "paste", element: firstElement(selected), text: "hello" }],
    });
    expect(data(response).batch).toBe("stopped");
    expect(
      f.invoke.mock.calls.some(([name]) => name === "clipboard_write" || name === "hotkey"),
    ).toBe(false);
  });
  it("restores supported clipboard text after failed input without repeating the paste", async () => {
    const f = fixture();
    const selected = await f.select();
    const ordinary = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (name, args) =>
      name === "hotkey" ? reply({ effect: "partial" }, true) : ordinary(name, args),
    );
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [{ type: "paste", element: firstElement(selected), text: "hello" }],
    });
    expect(data(response).batch).toBe("stopped");
    expect(f.clipboard()).toBe("original clipboard");
    expect(f.invoke.mock.calls.filter(([name]) => name === "hotkey")).toHaveLength(1);
  });
  it("preserves a newer clipboard copy instead of restoring an obsolete value", async () => {
    const f = fixture();
    const selected = await f.select();
    const ordinary = f.invoke.getMockImplementation()!;
    let changed = false;
    f.invoke.mockImplementation(async (name, args) => {
      if (name === "clipboard_read" && changed)
        return reply({ types: ["public.utf8-plain-text"], text: "user's new copy" });
      const response = await ordinary(name, args);
      if (name === "hotkey") changed = true;
      return response;
    });
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [{ type: "paste", element: firstElement(selected), text: "hello" }],
    });
    expect(data(response)).toMatchObject({
      results: [expect.objectContaining({ clipboard: "newer_value_preserved" })],
    });
    expect(f.invoke.mock.calls.filter(([name]) => name === "clipboard_write")).toHaveLength(1);
  });
  it("restores clipboard text after an uncertain clipboard write and dispatches no paste", async () => {
    const f = fixture();
    const selected = await f.select();
    const ordinary = f.invoke.getMockImplementation()!;
    let firstWrite = true;
    f.invoke.mockImplementation(async (name, args) => {
      const response = await ordinary(name, args);
      if (name === "clipboard_write" && firstWrite) {
        firstWrite = false;
        return reply({ effect: "partial" }, true);
      }
      return response;
    });
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [{ type: "paste", element: firstElement(selected), text: "hello" }],
    });
    expect(data(response)).toMatchObject({ batch: "stopped" });
    expect(f.clipboard()).toBe("original clipboard");
    expect(f.invoke.mock.calls.some(([name]) => name === "hotkey")).toBe(false);
  });
  it("rejects an out-of-image later action before sending the earlier key", async () => {
    const f = fixture();
    const selected = await f.select({ view: "both" });
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [
        { type: "key", keys: ["return"] },
        { type: "click", point: { x: 400, y: 10 } },
      ],
    });
    expect(response.isError).toBe(true);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it("stops a pixel step when preceding text verification cleared its capture without throwing or replaying", async () => {
    const f = fixture();
    const selected = await f.select({ view: "both" });
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [
        { type: "type", element: firstElement(selected), text: "hello" },
        { type: "click", point: { x: 100, y: 100 } },
      ],
    });
    expect(data(response)).toMatchObject({ batch: "stopped", attempted_steps: 1, stopped_at: 1 });
    expect(f.invoke.mock.calls.some(([name]) => name === "click")).toBe(false);
    expect(response.content).toContainEqual(image);
  });
  it("keeps advanced discovery read-only but invalidates grounding after legacy calls", async () => {
    const f = fixture();
    const selected = await f.select();
    const catalog = await f.computer.call("computer_advanced", {
      operation: "list",
      query: "menu",
    });
    expect(data(catalog).tools).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "invoke_menu" })]),
    );
    expect(f.invoke).toHaveBeenCalledTimes(1);
    await f.computer.call("list_apps", {});
    expect(
      (
        await f.computer.call("computer_act", {
          target: data(selected).target,
          actions: [{ type: "key", keys: ["return"] }],
        })
      ).isError,
    ).toBe(true);
    await expect(
      f.computer.call("computer_advanced", {
        operation: "call",
        name: "computer_act",
        arguments: {},
      }),
    ).rejects.toThrow();
  });
});

function browserFixture() {
  const f = fixture();
  let snapshot = 0;
  const ordinary = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (name, args) => {
    if (name === "get_browser_state") {
      if (args.pid)
        return reply({
          target_id: "browser",
          mutation_allowed: true,
          tabs: [{ tab_id: "tab", active: true }],
        });
      snapshot++;
      return {
        ...reply({
          target_id: "browser",
          tab_id: "tab",
          refs: [{ ref: "p" + snapshot + ":1", role: "textbox", name: "Message" }],
          ...(args.include_screenshot
            ? {
                screenshot: {
                  width: 800,
                  height: 600,
                  pixel_to_css_scale_x: 0.5,
                  pixel_to_css_scale_y: 0.5,
                },
              }
            : {}),
        }),
        content: args.include_screenshot ? [image] : [],
      };
    }
    return ordinary(name, args);
  });
  return f;
}

describe("bound browser computer interface", () => {
  it("scales screenshot pixels into browser CSS coordinates on the exact tab", async () => {
    const f = browserFixture();
    const selected = await f.computer.call("computer_select", {
      pid: 10,
      window_id: 20,
      browser: true,
      view: "both",
    });
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [{ type: "click", point: { x: 400, y: 200 } }],
    });
    expect(f.invoke).toHaveBeenCalledWith("browser_click", {
      target_id: "browser",
      tab_id: "tab",
      x: 200,
      y: 100,
    });
    expect(response.content).toContainEqual(image);
  });
  it("routes bound field text and file assignment through DOM tools", async () => {
    const f = browserFixture();
    const selected = await f.computer.call("computer_select", {
      target_id: "browser",
      tab_id: "tab",
    });
    const file = join(tmpdir(), "isolated-computer-image.png");
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [
        { type: "type", element: "p1:1", text: "hello", replace: true },
        { type: "files", element: "p1:1", files: [file] },
      ],
    });
    expect(data(response).batch).toBe("completed");
    expect(f.invoke).toHaveBeenCalledWith("browser_type", {
      target_id: "browser",
      tab_id: "tab",
      ref: "p1:1",
      text: "hello",
      replace: true,
    });
    expect(f.invoke).toHaveBeenCalledWith("browser_set_input_files", {
      target_id: "browser",
      tab_id: "tab",
      ref: "p1:1",
      files: [file],
    });
  });
  it("prepares only the precise setup refusal, retaining the user's existing profile", async () => {
    const f = browserFixture();
    f.invoke.mockImplementationOnce(async () =>
      reply({ status: "refused", refusal: { code: "browser_requires_setup" } }, true),
    );
    await f.computer.call("computer_select", { pid: 10, window_id: 20, browser: true });
    expect(f.invoke).toHaveBeenCalledWith("browser_prepare", {
      pid: 10,
      window_id: 20,
      strategy: { kind: "existing_profile" },
    });
  });
  it("refuses native keys when the bound tab is no longer active", async () => {
    const f = browserFixture();
    const selected = await f.computer.call("computer_select", {
      pid: 10,
      window_id: 20,
      browser: true,
    });
    f.invoke.mockImplementationOnce(async () =>
      reply({ target_id: "browser", tabs: [{ tab_id: "other", active: true }] }),
    );
    const response = await f.computer.call("computer_act", {
      target: data(selected).target,
      actions: [{ type: "key", keys: ["return"] }],
    });
    expect(data(response).batch).toBe("stopped");
    expect(f.invoke.mock.calls.some(([name]) => name === "press_key")).toBe(false);
  });
});
