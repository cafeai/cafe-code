import { describe, expect, it, vi } from "vitest";
import { createGlideApi, GlideActionError } from "./api.ts";
import { actionReceiptSchema, glideRequestSchema, type GlideActionReceipt } from "./protocol.ts";

const receipt = (
  method: string,
  overrides: Partial<GlideActionReceipt> = {},
): GlideActionReceipt => ({
  actionId: "fixture-action",
  method,
  status: "unverified",
  dispatch: "dispatched",
  osAcceptance: "unacknowledged",
  stage: "input-posted",
  progress: { axAttempted: 0, axAccepted: 0, eventsPosted: 2, textScalarsPosted: 0 },
  verification: { kind: "none", matched: null },
  ...overrides,
});

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2WQAAAAASUVORK5CYII=";
const state = {
  app: "/fixture/Notes.app",
  text: '1: AXTextField title="Document"',
  screenshot: { url: `data:image/png;base64,${png}` },
  revision: 1,
  pid: 42,
  windowId: 7,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  screenshotWidth: 100,
  screenshotHeight: 100,
  capturedAt: "2026-10-16T00:00:00.000Z",
};
function fixture() {
  const invoke = vi.fn(async (request: unknown): Promise<unknown> => {
    const parsed = glideRequestSchema.parse(request);
    return parsed.method === "get_app_state"
      ? { ...state, screenshot: parsed.input.includeScreenshot === false ? null : state.screenshot }
      : parsed.method === "list_apps"
        ? [{ name: "Notes", bundleId: "fixture.notes", path: state.app, pid: 42 }]
        : parsed.method === "list_windows"
          ? [{ id: state.windowId, title: "Owned", bounds: state.bounds, onScreen: true }]
          : parsed.method === "resolve_app"
            ? { name: "Notes", bundleId: "fixture.notes", path: state.app }
            : receipt(parsed.method);
  });
  const write = vi.fn(),
    emitImage = vi.fn(async () => undefined);
  return {
    ...createGlideApi({ invoke, write, emitImage }),
    invoke,
    writeText: write,
    emitImage,
  };
}

describe("Glide model API", () => {
  it("discovers windows and pins an explicit selection for later observation and input", async () => {
    const f = fixture();
    expect(await f.glide.listWindows("Notes", { emit: false })).toEqual([
      { id: state.windowId, title: "Owned", bounds: state.bounds, onScreen: true },
    ]);
    const app = await f.glide.getApp("Notes", { windowId: state.windowId });
    expect(app.windowId).toBe(state.windowId);
    expect(f.invoke).toHaveBeenLastCalledWith({
      method: "get_app_state",
      input: {
        app: "Notes",
        windowId: state.windowId,
        disableDiff: true,
        includeScreenshot: false,
      },
    });
    await app.typeText("exact window");
    expect(f.invoke).toHaveBeenLastCalledWith({
      method: "type_text",
      input: {
        app: state.app,
        windowId: state.windowId,
        text: "exact window",
      },
    });
  });
  it("emits the initial full state and binds later input to the resolved app path", async () => {
    const f = fixture();
    const app = await f.glide.getApp("Notes");
    expect(f.writeText).toHaveBeenCalledExactlyOnceWith(state.text);
    expect(f.invoke).toHaveBeenCalledWith({
      method: "get_app_state",
      input: { app: "Notes", disableDiff: true, includeScreenshot: false },
    });
    await app.click(1, { clickCount: 2, durationMs: 250 });
    expect(f.invoke).toHaveBeenLastCalledWith({
      method: "click",
      input: {
        app: state.app,
        windowId: state.windowId,
        element_index: 1,
        click_count: 2,
        duration: 0.25,
      },
    });
    expect(Object.isFrozen(app)).toBe(true);
    expect(await app.typeText("hello")).toEqual(receipt("type_text"));
  });
  it("preserves observation return types and emit:false without losing image bytes", async () => {
    const f = fixture();
    const app = await f.glide.getApp("Notes");
    f.writeText.mockClear();
    expect(await app.getAXState({ emit: false, disableDiffing: true })).toBe(state.text);
    expect(f.invoke).toHaveBeenLastCalledWith({
      method: "get_app_state",
      input: {
        app: state.app,
        windowId: state.windowId,
        disableDiff: true,
        includeScreenshot: false,
      },
    });
    const bytes = await app.getScreenshot({ emit: false });
    expect(f.invoke).toHaveBeenLastCalledWith({
      method: "get_app_state",
      input: {
        app: state.app,
        windowId: state.windowId,
        disableDiff: false,
        includeScreenshot: true,
      },
    });
    expect(Buffer.from(bytes).toString("base64")).toBe(png);
    expect(await app.getAXStateAndScreenshot({ emit: false })).toEqual({
      state: state.text,
      screenshot: bytes,
    });
    expect(f.invoke).toHaveBeenLastCalledWith({
      method: "get_app_state",
      input: {
        app: state.app,
        windowId: state.windowId,
        disableDiff: false,
        includeScreenshot: true,
      },
    });
    expect(f.writeText).not.toHaveBeenCalled();
    expect(f.emitImage).not.toHaveBeenCalled();
    await app.getAXStateAndScreenshot();
    expect(f.writeText).toHaveBeenCalledExactlyOnceWith(state.text);
    expect(f.emitImage).toHaveBeenCalledExactlyOnceWith(state.screenshot.url);
  });
  it("translates coordinates, units, selection and paste arguments through one broker", async () => {
    const f = fixture();
    const app = await f.glide.getApp("Notes");
    await app.click([12, 24], { mouseButton: "right", key: "shift" });
    expect(f.invoke).toHaveBeenLastCalledWith({
      method: "click",
      input: {
        app: state.app,
        windowId: state.windowId,
        x: 12,
        y: 24,
        mouse_button: "right",
        key: "shift",
      },
    });
    await app.scroll(1, "down", 2);
    expect(f.invoke).toHaveBeenLastCalledWith({
      method: "scroll",
      input: {
        app: state.app,
        windowId: state.windowId,
        element_index: 1,
        direction: "down",
        pages: 2,
      },
    });
    expect(() => app.scroll(1, "down", { pixels: 100 })).toThrow("pages");
    await app.pressKey("super+a", { durationMs: 500 });
    expect(f.invoke).toHaveBeenLastCalledWith({
      method: "press_key",
      input: { app: state.app, windowId: state.windowId, key: "super+a", duration: 0.5 },
    });
    await app.selectText(1, "café", { prefix: "a ", selectionType: "cursor_after" });
    expect(f.invoke).toHaveBeenLastCalledWith({
      method: "select_text",
      input: {
        app: state.app,
        windowId: state.windowId,
        element_index: 1,
        text: "café",
        prefix: "a ",
        selection_type: "cursor_after",
      },
    });
    await app.paste("hello");
    expect(f.invoke).toHaveBeenLastCalledWith({
      method: "paste",
      input: { app: state.app, windowId: state.windowId, text: "hello", format: "text" },
    });
  });
  it("offers legacy discovery and validates input before invoking the backend", async () => {
    const f = fixture();
    expect(await f.sky.list_apps()).toEqual([
      { id: "fixture.notes", displayName: "Notes", isRunning: true },
    ]);
    const calls = f.invoke.mock.calls.length;
    await expect(f.sky.click({ app: "Notes", element_index: 1, x: 20, y: 30 })).rejects.toThrow();
    await expect(f.sky.scroll({ app: "Notes", direction: "down" })).rejects.toThrow();
    expect(f.invoke).toHaveBeenCalledTimes(calls);
    expect(
      glideRequestSchema.safeParse({
        method: "set_value",
        input: { app: "Notes", element_index: 1, value: "0.35", shell: true },
      }).success,
    ).toBe(false);
    expect(
      glideRequestSchema.safeParse({
        method: "press_key",
        input: { app: "Notes", key: "return", duration: 999 },
      }).success,
    ).toBe(false);
    expect(
      glideRequestSchema.safeParse({
        method: "get_app_state",
        input: { app: "Notes", includeScreenshot: "false" },
      }).success,
    ).toBe(false);
  });
  it("returns and emits the exact receipt, retaining prior steps when a no-op stops a chain", async () => {
    const f = fixture();
    const app = await f.glide.getApp("Notes");
    await app.click(1);
    const noOp = receipt("set_value", {
      status: "not-observed",
      osAcceptance: "accepted",
      progress: { axAttempted: 1, axAccepted: 1, eventsPosted: 0, textScalarsPosted: 0 },
      verification: { kind: "value", matched: false, before: "old", after: "old" },
      message: "Write accepted but requested value not observed.",
    });
    f.invoke.mockResolvedValueOnce(noOp);
    let error: unknown;
    try {
      await app.setValue(1, "new");
      await app.typeText("must not run");
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(GlideActionError);
    expect((error as GlideActionError).receipt).toEqual(noOp);
    expect(f.invoke.mock.calls.map(([request]) => (request as { method: string }).method)).toEqual([
      "get_app_state",
      "click",
      "set_value",
    ]);
    expect(f.writeText).toHaveBeenLastCalledWith(`Glide action ${JSON.stringify(noOp)}`);
    expect(f.glide.getActionReceipts({ emit: false })).toEqual([receipt("click"), noOp]);
    const copy = f.glide.getActionReceipts({ emit: false });
    copy[0]!.progress.eventsPosted = 999;
    expect(f.glide.getActionReceipts({ emit: false })[0]!.progress.eventsPosted).toBe(2);
    expect(f.glide.getActionReceipts({ emit: false, clear: true })).toHaveLength(2);
    expect(f.glide.getActionReceipts({ emit: false })).toEqual([]);
  });
  it("does not turn an uncertain AX error or missing transport response into success or retry", async () => {
    const f = fixture();
    const app = await f.glide.getApp("Notes");
    const uncertain = receipt("perform_secondary_action", {
      status: "uncertain",
      osAcceptance: "rejected",
      osStatus: -25205,
      message: "May have taken effect.",
    });
    f.invoke.mockResolvedValueOnce(uncertain);
    await expect(app.performSecondaryAction(1, "AXOpen")).rejects.toMatchObject({
      receipt: uncertain,
    });
    f.invoke.mockRejectedValueOnce(new Error("peer lost"));
    await expect(app.typeText("partial")).rejects.toMatchObject({
      receipt: { status: "uncertain", dispatch: "unknown", osAcceptance: "unknown" },
    });
    expect(f.invoke).toHaveBeenCalledTimes(3);
    expect(f.glide.getActionReceipts({ emit: false })).toHaveLength(2);
  });
  it("exposes targeted focus/typing and lifecycle operations through the same exact window", async () => {
    const f = fixture();
    expect(await f.glide.resolveApp("fixture.notes", { emit: false })).toEqual({
      name: "Notes",
      bundleId: "fixture.notes",
      path: state.app,
    });
    await f.glide.launchApp(state.app);
    expect(f.invoke).toHaveBeenLastCalledWith({ method: "launch_app", input: { app: state.app } });
    const app = await f.glide.getApp("Notes");
    await app.focus(1);
    expect(f.invoke).toHaveBeenLastCalledWith({
      method: "focus_element",
      input: { app: state.app, windowId: 7, element_index: 1 },
    });
    await app.typeInto(1, "café 👩‍💻", { replace: true });
    expect(f.invoke).toHaveBeenLastCalledWith({
      method: "type_into",
      input: { app: state.app, windowId: 7, element_index: 1, text: "café 👩‍💻", replace: true },
    });
    await app.restoreWindow();
    expect(f.invoke).toHaveBeenLastCalledWith({
      method: "restore_window",
      input: { app: state.app, windowId: 7 },
    });
  });
  it("bounds receipt history and rejects malformed native diagnostics without manufacturing evidence", async () => {
    const f = fixture();
    const app = await f.glide.getApp("Notes");
    for (let i = 0; i < 70; i++) await app.click(1);
    expect(f.glide.getActionReceipts({ emit: false })).toHaveLength(64);
    f.invoke.mockResolvedValueOnce({ ...receipt("set_value"), progress: { eventsPosted: -1 } });
    await expect(app.setValue(1, "bad")).rejects.toMatchObject({
      receipt: { status: "uncertain", osAcceptance: "unknown" },
    });
    expect(
      actionReceiptSchema.safeParse({
        ...receipt("click"),
        interruption: { event: "scroll", source: "physical-human", key: "secret" },
      }).success,
    ).toBe(false);
    expect(actionReceiptSchema.safeParse(receipt("click", { status: "verified" })).success).toBe(
      false,
    );
  });
});
