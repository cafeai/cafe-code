import { describe, expect, it, vi } from "vitest";
import {
  executeNativeControlTool,
  projectNativeObservation,
  projectNativeWindows,
  ELECTRON_TEXT_REFUSAL_REASON,
} from "./NativeControlActions.ts";
import { nativeToolArguments, type NativeToolResult } from "@cafecode/shared/nativeControl";

const main = {
  pid: 10,
  window_id: 20,
  title: "Browser",
  bounds: { width: 1200, height: 800 },
  on_current_space: true,
  is_on_screen: false,
};
const preview = {
  ...main,
  window_id: 21,
  title: "Browser Preview - YouTube",
  bounds: { width: 20, height: 1 },
  is_on_screen: true,
};
const ok = (data: Record<string, unknown> = {}): NativeToolResult => ({
  content: [],
  structuredContent: data,
});
const refused = (code = "same_pid_keyboard_ambiguity"): NativeToolResult => ({
  isError: true,
  content: [],
  structuredContent: { code, effect: "refused", pid: 10, window_id: 20 },
});
const page = {
  pid: 10,
  window_id: 20,
  snapshot_id: "s00000001",
  elements: [
    { role: "AXTextField", value: "https://www.youtube.com/", element_token: "s00000001:1" },
    { role: "AXWebArea", label: "YouTube", in_web_content: true },
    {
      role: "AXPopUpButton",
      label: "Account menu",
      in_web_content: true,
      element_token: "s00000001:3",
    },
  ],
  truncated: false,
};

describe("Cafe native action recovery", () => {
  it("retries a refused background key in foreground once and returns a fresh observation", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(refused())
      .mockResolvedValueOnce(ok({ effect: "unverifiable" }))
      .mockResolvedValueOnce(ok(page));
    const response = await executeNativeControlTool(
      "press_key",
      { pid: 10, window_id: 20, key: "return" },
      invoke,
    );
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "press_key",
      "press_key",
      "get_window_state",
    ]);
    expect(invoke.mock.calls[1]![1]).toMatchObject({
      pid: 10,
      window_id: 20,
      delivery_mode: "foreground",
      key: "return",
    });
    expect(response.structuredContent).toMatchObject({
      effect: "unverifiable",
      cafe_fallback: { reason: "same_pid_keyboard_ambiguity" },
      observation: { snapshot_id: "s00000001" },
    });
  });
  it.each(["minimized_or_hidden_window", "off_space_or_ax_unresolved"])(
    "recovers a definite %s refusal",
    async (code) => {
      const invoke = vi
        .fn()
        .mockResolvedValueOnce(refused(code))
        .mockResolvedValueOnce(ok({ effect: "unverifiable" }));
      await executeNativeControlTool(
        "click",
        { pid: 10, window_id: 20, x: 5, y: 5, observe_after: false },
        invoke,
      );
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke.mock.calls[1]![1]).toMatchObject({ delivery_mode: "foreground", x: 5, y: 5 });
    },
  );
  it.each([
    {
      isError: true,
      content: [],
      structuredContent: { code: "same_pid_keyboard_ambiguity", effect: "unverifiable" },
    },
    refused("owner_pid_mismatch"),
    refused("element_outside_target_window"),
    ok({ effect: "unverifiable" }),
    ok({ effect: "partial", delivery: { delivered_count: 3 } }),
  ])("never replays an uncertain, partial, successful or unrelated refusal", async (response) => {
    const invoke = vi.fn().mockResolvedValue(response);
    await executeNativeControlTool("type_text", { pid: 10, window_id: 20, text: "hello" }, invoke);
    expect(invoke.mock.calls.filter(([name]) => name === "type_text")).toHaveLength(1);
  });
  it("honors background-only requests and propagates a lost reply without replay", async () => {
    const invoke = vi.fn().mockResolvedValue(refused());
    await executeNativeControlTool(
      "press_key",
      { pid: 10, window_id: 20, key: "return", auto_foreground: false },
      invoke,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![1]).not.toHaveProperty("auto_foreground");
    invoke.mockReset().mockRejectedValue(new Error("lost native reply"));
    await expect(
      executeNativeControlTool("press_key", { pid: 10, window_id: 20, key: "return" }, invoke),
    ).rejects.toThrow("lost native reply");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("acts and observes in one call while preserving fresh tokens and refusing observation-only failures separately", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ok({ effect: "unverifiable" }))
      .mockResolvedValueOnce(ok(page));
    const response = await executeNativeControlTool(
      "click",
      {
        pid: 10,
        window_id: 20,
        element_token: "s00000000:3",
        observe_after: true,
        observe_query: "Account",
      },
      invoke,
    );
    expect(response.structuredContent?.observation).toMatchObject({
      elements: expect.arrayContaining([expect.objectContaining({ element_token: "s00000001:3" })]),
    });
    expect(invoke.mock.calls[1]![1]).toMatchObject({
      query: "Account",
      max_elements: 4000,
      timeout_ms: 3000,
    });
    expect(invoke.mock.calls[0]![1]).not.toHaveProperty("observe_after");
    expect(invoke.mock.calls[0]![1]).not.toHaveProperty("observe_query");
  });
});

describe("native regression cases from the Axiom investigation", () => {
  it("recovers only the pinned before-input Electron refusal", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        ...refused("background_unavailable"),
        structuredContent: {
          ...refused("background_unavailable").structuredContent,
          reason: ELECTRON_TEXT_REFUSAL_REASON,
        },
      })
      .mockResolvedValueOnce(ok({ effect: "confirmed" }));
    await executeNativeControlTool(
      "type_text",
      { pid: 10, window_id: 20, text: "hello", observe_after: false },
      invoke,
    );
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]![1]).toMatchObject({ delivery_mode: "foreground" });
    invoke.mockReset().mockResolvedValue(refused("background_unavailable"));
    await executeNativeControlTool("type_text", { pid: 10, window_id: 20, text: "hello" }, invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("returns a new capture and image after coordinate input instead of clearing the screenshot mapping", async () => {
    const image = { type: "image", data: "new-capture", mimeType: "image/png" };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ok({ effect: "confirmed" }))
      .mockResolvedValueOnce({ ...ok({ ...page, capture_id: "fresh-capture" }), content: [image] });
    const response = await executeNativeControlTool(
      "click",
      { pid: 10, window_id: 20, x: 40, y: 50, observe_after: true },
      invoke,
    );
    expect(invoke.mock.calls[1]![1]).toMatchObject({ include_screenshot: true });
    expect(response.structuredContent?.observation).toMatchObject({ capture_id: "fresh-capture" });
    expect(response.content).toContainEqual(image);
  });
  it("observes an AX error that may already have opened a file and never repeats it", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "AXOpen -25205" }] })
      .mockResolvedValueOnce(ok(page));
    const response = await executeNativeControlTool(
      "click",
      { pid: 10, window_id: 20, element_token: "s00000000:1" },
      invoke,
    );
    expect(response.isError).toBe(true);
    expect(response.structuredContent?.observation).toMatchObject({ snapshot_id: "s00000001" });
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["click", "get_window_state"]);
  });
  it("includes direct value updates in observation without sending Cafe-only fields to Cua", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ok({ effect: "unverifiable" }))
      .mockResolvedValueOnce(ok(page));
    const response = await executeNativeControlTool(
      "set_value",
      { pid: 10, window_id: 20, value: "hello", observe_after: true },
      invoke,
    );
    expect(response.structuredContent?.observation).toBeDefined();
    expect(invoke.mock.calls[0]![1]).not.toHaveProperty("observe_after");
  });
});

describe("window selection and efficient queries", () => {
  it("recommends a main window ahead of a visible tiny preview and reports omitted records", () => {
    const data = projectNativeWindows(
      { windows: [preview, main, { ...main, window_id: 22, on_current_space: false }] },
      { max_windows: 1 },
    );
    expect(data.recommended_window).toEqual(main);
    expect(data.windows).toEqual([main]);
    expect(data).toMatchObject({
      total_window_count: 3,
      matching_window_count: 2,
      auxiliary_window_count: 1,
      windows_truncated: true,
    });
    expect(
      projectNativeWindows({ windows: [preview, main] }, { include_auxiliary_windows: true })
        .windows as unknown[],
    ).toHaveLength(2);
  });
  it("resolves an omitted window for activation rather than letting Cua choose an ambiguous process", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ok({ windows: [preview, main] }))
      .mockResolvedValueOnce(ok({ activated: true }));
    await executeNativeControlTool("bring_to_front", { pid: 10 }, invoke);
    expect(invoke.mock.calls[1]).toEqual(["bring_to_front", { pid: 10, window_id: 20 }]);
  });
  it("separates search truncation from response truncation without renumbering tokens", () => {
    const data = projectNativeObservation(
      { ...page, tree_markdown: "duplicate" },
      { max_results: 1 },
    );
    expect(data).toMatchObject({
      search_truncated: false,
      output_truncated: true,
      returned_element_count: 1,
      matching_element_count: 3,
    });
    expect(data.elements).toEqual([page.elements[0]]);
    expect(data).not.toHaveProperty("tree_markdown");
    expect(nativeToolArguments("get_window_state", { query: "Account" })).toMatchObject({
      max_elements: 4000,
      timeout_ms: 3000,
    });
    expect(
      nativeToolArguments("get_window_state", { query: "Account", max_elements: 10 }),
    ).toMatchObject({ max_elements: 10 });
  });
});

describe("native and DOM browser navigation", () => {
  it("reuses a running browser and submits a fresh AX address value through grounded keyboard input", async () => {
    const address = {
      ...page.elements[0],
      actions: ["AXConfirm"],
      screenshot_frame: { x: 20, y: 10, w: 600, h: 24 },
    };
    const invoke = vi.fn(async (name: string): Promise<NativeToolResult> => {
      if (name === "list_apps")
        return ok({ apps: [{ running: true, pid: 10, bundle_id: "com.apple.Safari" }] });
      if (name === "list_windows") return ok({ windows: [preview, main] });
      if (name === "get_browser_state") return refused("browser_not_supported");
      if (name === "get_window_state")
        return ok({ ...page, elements: [address, ...page.elements.slice(1)] });
      return ok({ effect: "confirmed" });
    });
    const response = await executeNativeControlTool(
      "open_url",
      { url: "https://www.youtube.com", bundle_id: "com.apple.Safari", new_tab: false },
      invoke,
    );
    expect(response.structuredContent?.navigation_verified).toBe(true);
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "list_apps",
      "list_windows",
      "get_browser_state",
      "bring_to_front",
      "hotkey",
      "get_window_state",
      "set_value",
      "press_key",
      "get_window_state",
    ]);
    expect(invoke).toHaveBeenCalledWith("set_value", {
      pid: 10,
      window_id: 20,
      element_token: "s00000001:1",
      value: "https://www.youtube.com/",
    });
    expect(invoke).toHaveBeenCalledWith("press_key", {
      pid: 10,
      window_id: 20,
      delivery_mode: "foreground",
      key: "return",
      x: 320,
      y: 22,
    });
  });
  it("opens an existing signed-in browser using real address-bar input and observes the page", async () => {
    const invoke = vi.fn(
      async (name: string, _args: Record<string, unknown>): Promise<NativeToolResult> => {
        if (name === "list_windows") return ok({ windows: [preview, main] });
        if (name === "get_browser_state") return refused("browser_not_supported");
        if (name === "get_window_state") return ok(page);
        return ok({ effect: "unverifiable" });
      },
    );
    const response = await executeNativeControlTool(
      "open_url",
      { url: "https://www.youtube.com", pid: 10, bundle_id: "com.kagi.kagimacOS" },
      invoke,
    );
    expect(response.structuredContent).toMatchObject({
      pid: 10,
      window_id: 20,
      route: "native_address_bar",
      navigation_verified: true,
      verification: { address_matches: true, page_observed: true },
    });
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "list_windows",
      "get_browser_state",
      "bring_to_front",
      "hotkey",
      "hotkey",
      "get_window_state",
      "type_text",
      "press_key",
      "get_window_state",
    ]);
    expect(invoke.mock.calls.find(([name]) => name === "type_text")![1]).toMatchObject({
      delivery_mode: "foreground",
      text: "https://www.youtube.com/",
    });
    expect(invoke.mock.calls.some(([name]) => name === "browser_prepare")).toBe(false);
  });
  it("uses exact DOM navigation when an existing browser is already connected", async () => {
    const invoke = vi.fn(
      async (name: string, args: Record<string, unknown>): Promise<NativeToolResult> => {
        if (name === "list_windows") return ok({ windows: [main] });
        if (name === "get_browser_state" && !args.target_id)
          return ok({
            target_id: "owned-target",
            mutation_allowed: true,
            tabs: [{ tab_id: "active-tab", active: true }],
          });
        if (name === "get_browser_state")
          return ok({ page: { url: "https://www.youtube.com/" }, refs: [{ ref: "p2:1" }] });
        return ok();
      },
    );
    const response = await executeNativeControlTool(
      "open_url",
      { pid: 10, url: "https://www.youtube.com", new_tab: false },
      invoke,
    );
    expect(response.structuredContent).toMatchObject({
      route: "browser_dom",
      navigation_verified: true,
      target_id: "owned-target",
      tab_id: "active-tab",
    });
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "list_windows",
      "get_browser_state",
      "browser_navigate",
      "get_browser_state",
    ]);
    expect(invoke.mock.calls[2]![1]).toEqual({
      target_id: "owned-target",
      tab_id: "active-tab",
      url: "https://www.youtube.com/",
    });
  });
  it("returns fresh DOM refs after input without a separate agent read", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ok({ status: "ok" }))
      .mockResolvedValueOnce(
        ok({ refs: [{ ref: "p3:1" }], page: { url: "https://www.youtube.com/" } }),
      );
    const response = await executeNativeControlTool(
      "browser_click",
      { target_id: "t", tab_id: "tab", ref: "p2:1", observe_query: "channel" },
      invoke,
    );
    expect(response.structuredContent?.observation).toMatchObject({ refs: [{ ref: "p3:1" }] });
    expect(invoke.mock.calls[1]).toEqual([
      "get_browser_state",
      {
        target_id: "t",
        tab_id: "tab",
        query: "channel",
        snapshot_format: "semantic_v2",
        include_screenshot: false,
      },
    ]);
  });
  it("prepares a supported existing profile once, then navigates its exact DOM tab", async () => {
    let prepared = false;
    const invoke = vi.fn(
      async (name: string, args: Record<string, unknown>): Promise<NativeToolResult> => {
        if (name === "list_windows") return ok({ windows: [main] });
        if (name === "browser_prepare") {
          prepared = true;
          return ok({ prepared: true });
        }
        if (name === "get_browser_state" && !args.target_id)
          return prepared
            ? ok({
                target_id: "t",
                mutation_allowed: true,
                tabs: [{ tab_id: "tab", active: true }],
              })
            : refused("connection_required");
        if (name === "get_browser_state")
          return ok({ page: { url: "https://www.youtube.com/" }, refs: [] });
        return ok();
      },
    );
    const response = await executeNativeControlTool(
      "open_url",
      {
        pid: 10,
        bundle_id: "com.google.Chrome",
        url: "https://www.youtube.com",
        new_tab: false,
      },
      invoke,
    );
    expect(response.structuredContent).toMatchObject({
      route: "browser_dom",
      navigation_verified: true,
    });
    expect(invoke).toHaveBeenCalledWith("browser_prepare", {
      pid: 10,
      window_id: 20,
      strategy: { kind: "existing_profile" },
    });
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      "list_windows",
      "get_browser_state",
      "browser_prepare",
      "get_browser_state",
      "browser_navigate",
      "get_browser_state",
    ]);
  });
  it("includes the uniquely active tab snapshot in a binding and honors an explicit snapshot format", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(ok({ target_id: "t", tabs: [{ tab_id: "tab", active: true }] }))
      .mockResolvedValueOnce(ok({ refs: [{ ref: "r1" }] }));
    const response = await executeNativeControlTool(
      "get_browser_state",
      {
        pid: 10,
        window_id: 20,
        snapshot_format: "dom_refs_v1",
      },
      invoke,
    );
    expect(response.structuredContent?.observation).toEqual({ refs: [{ ref: "r1" }] });
    expect(invoke.mock.calls[1]).toEqual([
      "get_browser_state",
      {
        target_id: "t",
        tab_id: "tab",
        snapshot_format: "dom_refs_v1",
        include_screenshot: false,
      },
    ]);
    invoke
      .mockClear()
      .mockResolvedValueOnce(ok({ target_id: "t", tabs: [{ tab_id: "tab", active: true }] }));
    await executeNativeControlTool(
      "get_browser_state",
      { pid: 10, window_id: 20, include_page_state: false },
      invoke,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("does not fall back to keyboard input after a DOM mutation's failed acknowledgement", async () => {
    const invoke = vi.fn().mockResolvedValueOnce(refused("navigation_uncertain"));
    const response = await executeNativeControlTool(
      "open_url",
      { url: "https://www.youtube.com", target_id: "t", tab_id: "tab" },
      invoke,
    );
    expect(response.isError).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0]).toBe("browser_navigate");
  });
  it("rejects invalid navigation arguments before touching a user app", async () => {
    const invoke = vi.fn();
    expect(
      (await executeNativeControlTool("open_url", { url: "file:///private/file" }, invoke)).isError,
    ).toBe(true);
    expect(
      (
        await executeNativeControlTool(
          "open_url",
          { url: "https://www.youtube.com", window_id: 20 },
          invoke,
        )
      ).isError,
    ).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});
