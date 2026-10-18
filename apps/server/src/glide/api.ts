import { inspect } from "node:util";
import {
  appListSchema,
  actionReceiptSchema,
  glideRequestSchema,
  installedAppSchema,
  unknownActionReceipt,
  observationSchema,
  windowListSchema,
  type GlideObservation,
  type GlideRequest,
  type GlideActionReceipt,
} from "./protocol.ts";

type Target = number | readonly [number, number];
type ObserveOptions = { emit?: boolean; disableDiffing?: boolean };
type ClickOptions = {
  mouseButton?: "left" | "right" | "middle";
  clickCount?: number;
  key?: string;
  durationMs?: number;
};
export type GlideBridge = (request: GlideRequest) => Promise<unknown>;

export class GlideActionError extends Error {
  readonly receipt: GlideActionReceipt;
  constructor(receipt: GlideActionReceipt) {
    super(
      receipt.message ??
        `Glide ${receipt.method}: ${receipt.status}. Inspect fresh state before more input.`,
    );
    this.name = "GlideActionError";
    this.receipt = receipt;
  }
}

function targetInput(target: Target) {
  return typeof target === "number" ? { element_index: target } : { x: target[0], y: target[1] };
}

/** All model facades use the same broker. No app handle contains a native pipe,
 * process handle or authorization credential. The broker validates every call. */
export function createGlideApi(options: {
  invoke: GlideBridge;
  write: (value: string) => void;
  emitImage: (value: string | Uint8Array) => Promise<void>;
}) {
  const invoke: GlideBridge = (request) => options.invoke(glideRequestSchema.parse(request));
  const receipts: GlideActionReceipt[] = [];
  let sequence = 0;
  const action = async (request: GlideRequest): Promise<GlideActionReceipt> => {
    // Parse before dispatch. Validation failures cannot have native effects.
    const parsed = glideRequestSchema.parse(request);
    const actionId = `kernel:${++sequence}`;
    let receipt: GlideActionReceipt;
    try {
      const result = await invoke(parsed);
      receipt =
        result === null
          ? {
              ...unknownActionReceipt(
                parsed.method,
                actionId,
                "Legacy helper returned no outcome evidence. Refresh the helper before relying on action verification.",
              ),
              status: "unverified",
            }
          : actionReceiptSchema.parse(result);
      if (receipt.method !== parsed.method) throw new Error("Action receipt method mismatch.");
    } catch (error) {
      receipt = unknownActionReceipt(
        parsed.method,
        actionId,
        error instanceof Error
          ? error.message
          : "Action response unavailable. Inspect fresh state.",
      );
    }
    receipts.push(actionReceiptSchema.parse(receipt));
    if (receipts.length > 64) receipts.shift();
    // Emit before throwing: prior effects and the uncertain step stay visible
    // even when the model never catches the exception or prints the result.
    options.write(`Glide action ${JSON.stringify(receipt)}`);
    if (["refused", "uncertain", "not-observed"].includes(receipt.status))
      throw new GlideActionError(receipt);
    return receipt;
  };
  const sky = Object.freeze({
    list_windows: async (input: { app: string }) =>
      windowListSchema.parse(await invoke({ method: "list_windows", input })),
    list_apps: async () =>
      appListSchema
        .parse(await invoke({ method: "list_apps", input: {} }))
        .map((item) => ({ id: item.bundleId, displayName: item.name, isRunning: true })),
    resolve_app: async (input: { app: string }) =>
      installedAppSchema.parse(await invoke({ method: "resolve_app", input })),
    launch_app: (input: { app: string }) => action({ method: "launch_app", input }),
    restore_window: (input: Extract<GlideRequest, { method: "restore_window" }>["input"]) =>
      action({ method: "restore_window", input }),
    focus_element: (input: Extract<GlideRequest, { method: "focus_element" }>["input"]) =>
      action({ method: "focus_element", input }),
    type_into: (input: Extract<GlideRequest, { method: "type_into" }>["input"]) =>
      action({ method: "type_into", input }),
    get_app_state: (input: Extract<GlideRequest, { method: "get_app_state" }>["input"]) =>
      invoke({ method: "get_app_state", input }),
    click: (input: Extract<GlideRequest, { method: "click" }>["input"]) =>
      action({ method: "click", input }),
    drag: (input: Extract<GlideRequest, { method: "drag" }>["input"]) =>
      action({ method: "drag", input }),
    scroll: (input: Extract<GlideRequest, { method: "scroll" }>["input"]) =>
      action({ method: "scroll", input }),
    set_value: (input: Extract<GlideRequest, { method: "set_value" }>["input"]) =>
      action({ method: "set_value", input }),
    select_text: (input: Extract<GlideRequest, { method: "select_text" }>["input"]) =>
      action({ method: "select_text", input }),
    type_text: (input: Extract<GlideRequest, { method: "type_text" }>["input"]) =>
      action({ method: "type_text", input }),
    press_key: (input: Extract<GlideRequest, { method: "press_key" }>["input"]) =>
      action({ method: "press_key", input }),
    paste: (input: Extract<GlideRequest, { method: "paste" }>["input"]) =>
      action({ method: "paste", input }),
    perform_secondary_action: (
      input: Extract<GlideRequest, { method: "perform_secondary_action" }>["input"],
    ) => action({ method: "perform_secondary_action", input }),
  });

  const observe = async (
    app: string,
    kind: "ax" | "image" | "both",
    opts: ObserveOptions = {},
    full = false,
    windowId?: number,
  ): Promise<GlideObservation> => {
    const state = observationSchema.parse(
      await sky.get_app_state({
        app,
        ...(windowId === undefined ? {} : { windowId }),
        disableDiff: full || opts.disableDiffing === true,
        includeScreenshot: kind !== "ax",
      }),
    );
    if (opts.emit !== false) {
      if (kind !== "image") options.write(state.text);
      if (kind !== "ax" && state.screenshot) await options.emitImage(state.screenshot.url);
    }
    return state;
  };
  const glide = Object.freeze({
    getActionReceipts: (opts: { emit?: boolean; clear?: boolean } = {}) => {
      const result = receipts.map((receipt) => actionReceiptSchema.parse(receipt));
      if (opts.clear) receipts.length = 0;
      if (opts.emit !== false) options.write(JSON.stringify(result));
      return result;
    },
    resolveApp: async (app: string, opts: ObserveOptions = {}) => {
      const result = await sky.resolve_app({ app });
      if (opts.emit !== false) options.write(JSON.stringify(result));
      return result;
    },
    launchApp: (app: string) => sky.launch_app({ app }),
    listWindows: async (app: string, opts: ObserveOptions = {}) => {
      const windows = await sky.list_windows({ app });
      if (opts.emit !== false) options.write(inspect(windows, { depth: 4 }));
      return windows;
    },
    listApps: async (opts: ObserveOptions = {}) => {
      const apps = await sky.list_apps();
      if (opts.emit !== false) options.write(inspect(apps, { depth: 4 }));
      return apps;
    },
    getApp: async (app: string, options: { windowId?: number } = {}) => {
      // Resolve the name once. Later operations bind the canonical installed app
      // path returned by the trusted native service, rather than a mutable alias.
      const state = await observe(app, "ax", {}, true, options.windowId);
      const canonical = state.app;
      const identity = { app: canonical, windowId: state.windowId };
      return Object.freeze({
        windowId: state.windowId,
        restoreWindow: () => sky.restore_window(identity),
        focus: (element_index: number) => sky.focus_element({ ...identity, element_index }),
        typeInto: (element_index: number, text: string, opts: { replace?: boolean } = {}) =>
          sky.type_into({
            ...identity,
            element_index,
            text,
            ...(opts.replace === undefined ? {} : { replace: opts.replace }),
          }),
        getAXState: async (opts?: ObserveOptions) =>
          (await observe(canonical, "ax", opts, false, identity.windowId)).text,
        getScreenshot: async (opts?: ObserveOptions) => {
          const state = await observe(canonical, "image", opts, false, identity.windowId);
          if (!state.screenshot)
            throw new Error(
              "Screenshot unavailable. Grant Screen Recording permission to the launching host.",
            );
          return Uint8Array.from(
            Buffer.from(state.screenshot.url.slice("data:image/png;base64,".length), "base64"),
          );
        },
        getAXStateAndScreenshot: async (opts?: ObserveOptions) => {
          const state = await observe(canonical, "both", opts, false, identity.windowId);
          return {
            state: state.text,
            ...(state.screenshot
              ? {
                  screenshot: Uint8Array.from(
                    Buffer.from(
                      state.screenshot.url.slice("data:image/png;base64,".length),
                      "base64",
                    ),
                  ),
                }
              : {}),
          };
        },
        click: (target: Target, opts: ClickOptions = {}) =>
          sky.click({
            ...identity,
            ...targetInput(target),
            ...(opts.mouseButton === undefined ? {} : { mouse_button: opts.mouseButton }),
            ...(opts.clickCount === undefined ? {} : { click_count: opts.clickCount }),
            ...(opts.key === undefined ? {} : { key: opts.key }),
            ...(opts.durationMs === undefined ? {} : { duration: opts.durationMs / 1000 }),
          }),
        drag: (from: readonly [number, number], to: readonly [number, number]) =>
          sky.drag({ ...identity, from_x: from[0], from_y: from[1], to_x: to[0], to_y: to[1] }),
        scroll: (
          target: Target,
          direction: "up" | "down" | "left" | "right",
          distance?: number | { pixels: number },
        ) => {
          if (typeof distance === "object")
            throw new Error("macOS scroll accepts pages, not pixels.");
          return sky.scroll({
            ...identity,
            ...targetInput(target),
            direction,
            ...(distance === undefined ? {} : { pages: distance }),
          });
        },
        setValue: (element_index: number, value: string) =>
          sky.set_value({ ...identity, element_index, value }),
        selectText: (
          element_index: number,
          text: string,
          opts: {
            prefix?: string;
            suffix?: string;
            selectionType?: "text" | "cursor_before" | "cursor_after";
          } = {},
        ) =>
          sky.select_text({
            ...identity,
            element_index,
            text,
            ...(opts.prefix === undefined ? {} : { prefix: opts.prefix }),
            ...(opts.suffix === undefined ? {} : { suffix: opts.suffix }),
            ...(opts.selectionType === undefined ? {} : { selection_type: opts.selectionType }),
          }),
        typeText: (text: string) => sky.type_text({ ...identity, text }),
        pressKey: (key: string, opts: { durationMs?: number } = {}) =>
          sky.press_key({
            ...identity,
            key,
            ...(opts.durationMs === undefined ? {} : { duration: opts.durationMs / 1000 }),
          }),
        paste: (text: string, opts: { format?: "text" | "md" | "html" } = {}) =>
          sky.paste({ ...identity, text, format: opts.format ?? "text" }),
        performSecondaryAction: (element_index: number, action: string) =>
          sky.perform_secondary_action({ ...identity, element_index, action }),
      });
    },
  });
  return {
    sky,
    glide,
    cua: glide,
    write: (value: unknown) =>
      options.write(
        typeof value === "string"
          ? value
          : inspect(value, {
              depth: 4,
              maxArrayLength: 100,
              maxStringLength: 64 * 1024,
              getters: false,
            }),
      ),
  };
}
