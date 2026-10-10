import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  decodeComputerAct,
  decodeComputerAdvanced,
  decodeComputerObserve,
  decodeComputerSelect,
  NATIVE_CONTROL_ADVANCED_TOOLS,
  nativeControlError,
  validateNativeToolCall,
  type ComputerAction,
  type ComputerObserve,
  type ComputerSelect,
  type NativeToolResult,
} from "@cafecode/shared/nativeControl";
import {
  executeNativeControlTool,
  rankNativeWindows,
  isAuxiliaryWindow,
  type NativeInvoke,
} from "./NativeControlActions.ts";

type Fields = Record<string, unknown>;
type Binding = {
  handle: string;
  native: { pid: number; window_id: number } | undefined;
  browser: { target_id: string; tab_id: string } | undefined;
  state: Fields | undefined;
  reportedState: Fields | undefined;
  query: string | undefined;
  dirty: boolean;
};
const object = (value: unknown): Fields | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
const rows = (value: unknown): Fields[] =>
  Array.isArray(value) ? value.flatMap((v) => (object(v) ? [object(v)!] : [])) : [];
const output = (data: Fields, source?: NativeToolResult): NativeToolResult => ({
  content: [
    { type: "text", text: JSON.stringify(data) },
    ...(source?.content.filter((part) => part.type !== "text") ?? []),
  ],
  ...(source?.isError ? { isError: true } : {}),
  structuredContent: data,
});
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const clipboardTextTypes = new Set([
  "public.utf8-plain-text",
  "public.utf16-external-plain-text",
  "public.plain-text",
  "NSStringPboardType",
  "text/plain",
]);
const elements = (binding: Binding) =>
  rows(binding.browser ? binding.state?.refs : binding.state?.elements);
const token = (entry: Fields) => String(entry.element_token ?? entry.ref ?? "");
const semantic = (entry: Fields): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(entry).filter(([key]) => !["element_token", "ref"].includes(key)),
    ),
  );
const fingerprint = (binding: Binding, state: Fields): string =>
  JSON.stringify({
    elements: rows(binding.browser ? state.refs : state.elements).map((entry) =>
      semantic(
        Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "screenshot_frame")),
      ),
    ),
    page: state.page,
    outline: state.outline,
    title: state.window_title,
  });
const windowObservation = (state: Fields): Fields => {
  const all = rows(state.elements);
  const bounds = object(state.window_bounds);
  const roots = all.filter((entry) => {
    const frame = object(entry.frame);
    return (
      entry.role === "AXWindow" &&
      bounds &&
      frame &&
      frame.x === bounds.x &&
      frame.y === bounds.y &&
      frame.w === bounds.width &&
      frame.h === bounds.height
    );
  });
  // Cua's exact-window tree can include the entire application menu first.
  // Scope before limiting output so hundreds of menu items cannot push the
  // requested field out of the model's state or internal verification reads.
  const root = roots.length === 1 ? roots[0]!.element_index : undefined;
  const byIndex = new Map(all.map((entry) => [entry.element_index, entry]));
  const inWindow =
    root === undefined
      ? all
      : all.filter((entry) => {
          let current: Fields | undefined = entry;
          const visited = new Set<unknown>();
          while (current && !visited.has(current.element_index)) {
            if (current.element_index === root) return true;
            visited.add(current.element_index);
            current = byIndex.get(current.parent_index);
          }
          return false;
        });
  return {
    ...state,
    elements: inWindow.slice(0, 200),
    returned_element_count: Math.min(inWindow.length, 200),
    window_element_count: inWindow.length,
    omitted_nonwindow_elements: all.length - inWindow.length,
    output_truncated: state.output_truncated === true || inWindow.length > 200,
  };
};
const uncertain = (response: NativeToolResult): boolean => {
  const data = response.structuredContent;
  const delivery = object(data?.delivery);
  return (
    response.isError === true ||
    ["partial", "indeterminate", "uncertain", "refused"].includes(String(data?.effect)) ||
    (typeof delivery?.delivered_count === "number" &&
      typeof delivery.sent_count === "number" &&
      delivery.delivered_count < delivery.sent_count)
  );
};

/** One instance belongs to one acknowledged native control episode. Every
 * backend call uses the host's admission callback; bindings carry no authority
 * outside it. No scripts, native session names or arbitrary routes are accepted. */
export class NativeComputerSession {
  private readonly bindings = new Map<string, Binding>();
  private readonly invoke: NativeInvoke;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(invoke: NativeInvoke, options?: { sleep?: (ms: number) => Promise<void> }) {
    this.invoke = invoke;
    this.sleep = options?.sleep ?? pause;
  }

  clear(): void {
    this.bindings.clear();
  }

  private callNative(name: string, args: Fields): Promise<NativeToolResult> {
    return executeNativeControlTool(name, args, this.invoke);
  }

  async call(name: string, args: Fields): Promise<NativeToolResult> {
    if (name === "computer_select") return this.select(decodeComputerSelect(args));
    if (name === "computer_observe") {
      const input = decodeComputerObserve(args);
      const binding = this.bindings.get(input.target);
      return binding
        ? this.observe(binding, input)
        : nativeControlError(
            "This target has expired or belongs to another control episode. Select the app again.",
          );
    }
    if (name === "computer_act") return this.act(args);
    if (name === "computer_advanced") {
      const input = decodeComputerAdvanced(args);
      if (input.operation === "list") {
        const query = input.query?.toLowerCase();
        return output({
          tools: NATIVE_CONTROL_ADVANCED_TOOLS.filter(
            (tool) => !query || `${tool.name} ${tool.description}`.toLowerCase().includes(query),
          ),
        });
      }
      validateNativeToolCall("computer_advanced", input);
      // The catalog call can mutate snapshots, windows, geometry or browser
      // state. Keep bindings, but never silently preserve stale grounding.
      this.invalidate();
      return this.callNative(input.name, input.arguments ?? {});
    }
    this.invalidate();
    return this.callNative(name, args);
  }

  private invalidate(except?: Binding): void {
    for (const binding of this.bindings.values())
      if (binding !== except) {
        binding.state = undefined;
        binding.reportedState = undefined;
        binding.dirty = true;
      }
  }

  private async select(input: ComputerSelect): Promise<NativeToolResult> {
    if (this.bindings.size >= 32)
      return nativeControlError(
        "The target limit for this control episode was reached. Release control before selecting more apps.",
      );
    let native: Binding["native"];
    let browser: Binding["browser"];
    if ("target_id" in input) browser = { target_id: input.target_id, tab_id: input.tab_id };
    else {
      let pid: number;
      if ("pid" in input) pid = input.pid;
      else {
        const listed = await this.callNative("list_apps", {});
        if (listed.isError) return listed;
        const requested = input.app.toLowerCase();
        const matches = rows(listed.structuredContent?.apps).filter((app) =>
          [app.bundle_id, app.name, app.app_name, app.path].some(
            (value) => typeof value === "string" && value.toLowerCase() === requested,
          ),
        );
        const running = matches.filter(
          (app) => app.running === true && typeof app.pid === "number",
        );
        if (running.length > 1) return output({ selection_required: true, apps: running });
        if (running.length === 1) pid = Number(running[0]!.pid);
        else {
          if (matches.length > 1) return output({ selection_required: true, apps: matches });
          const launched = await this.callNative(
            "launch_app",
            typeof matches[0]?.bundle_id === "string"
              ? { bundle_id: matches[0].bundle_id }
              : { name: input.app },
          );
          if (launched.isError) return launched;
          if (typeof launched.structuredContent?.pid !== "number")
            return nativeControlError(
              "The requested app did not report a running process. Inspect advanced app discovery.",
            );
          pid = launched.structuredContent.pid;
        }
      }
      let windowId = input.window_id;
      if (windowId === undefined) {
        const listed = await this.callNative("list_windows", {
          pid,
          max_windows: 100,
          include_auxiliary_windows: true,
        });
        if (listed.isError) return listed;
        const windows = rankNativeWindows(
          rows(listed.structuredContent?.windows).filter((window) => !isAuxiliaryWindow(window)),
        );
        if (windows.length !== 1)
          return output({
            selection_required: true,
            pid,
            windows,
            detail: windows.length
              ? "Choose the requested window_id and select again."
              : "Open a window for the requested app, then select again.",
          });
        windowId = Number(windows[0]!.window_id);
      }
      native = { pid, window_id: windowId };
      if (input.browser === true) {
        let connected = await this.callNative("get_browser_state", {
          ...native,
          include_page_state: false,
        });
        if (
          connected.isError &&
          object(connected.structuredContent?.refusal)?.code === "browser_requires_setup"
        ) {
          const prepared = await this.callNative("browser_prepare", {
            ...native,
            strategy: { kind: "existing_profile" },
          });
          if (prepared.isError) return prepared;
          connected = await this.callNative("get_browser_state", {
            ...native,
            include_page_state: false,
          });
        }
        if (connected.isError) return connected;
        const tabs = rows(connected.structuredContent?.tabs);
        const candidates = input.tab_id
          ? tabs.filter((tab) => tab.tab_id === input.tab_id)
          : tabs.filter((tab) => tab.active === true);
        if (candidates.length !== 1 || typeof connected.structuredContent?.target_id !== "string")
          return output({
            selection_required: true,
            ...native,
            tabs,
            detail: "Choose an exact tab_id and select again.",
          });
        if (connected.structuredContent.mutation_allowed !== true)
          return nativeControlError(
            "The browser binding is not exact enough for input. Use native app control or connect the exact browser window.",
          );
        browser = {
          target_id: connected.structuredContent.target_id,
          tab_id: String(candidates[0]!.tab_id),
        };
      }
    }
    const binding: Binding = {
      handle: randomUUID(),
      native,
      browser,
      state: undefined,
      reportedState: undefined,
      query: undefined,
      dirty: false,
    };
    const observation = await this.observe(binding, {
      ...input,
      target: binding.handle,
      full: true,
    });
    if (!observation.isError) this.bindings.set(binding.handle, binding);
    return observation;
  }

  private async read(binding: Binding, options: ComputerObserve): Promise<NativeToolResult> {
    const visual = options.view === "screenshot" || options.view === "both";
    const observed = await this.callNative(
      binding.browser ? "get_browser_state" : "get_window_state",
      {
        ...(binding.browser ?? binding.native),
        ...(options.query === undefined ? {} : { query: options.query }),
        include_screenshot: visual,
        ...(!binding.browser
          ? { include_accessibility_tree: options.view !== "screenshot", max_results: 2000 }
          : {}),
      },
    );
    return !binding.browser &&
      options.view !== "screenshot" &&
      observed.structuredContent &&
      !observed.isError
      ? { ...observed, structuredContent: windowObservation(observed.structuredContent) }
      : observed;
  }

  private async observe(binding: Binding, options: ComputerObserve): Promise<NativeToolResult> {
    // Internal text verification can mint snapshots the model has never seen.
    // Diff against the last published state, never those internal reads.
    const previous = binding.reportedState;
    let observation: NativeToolResult;
    let settled: boolean | undefined;
    // Only recent input requests settling. Reads are bounded by both samples
    // and the wall clock; no timer creates synthetic provider/task truth.
    if (binding.dirty && options.view !== "screenshot") {
      await this.sleep(150);
      observation = await this.read(binding, { ...options, view: "accessibility" });
      const deadline = Date.now() + 1500;
      for (let sample = 0; !observation.isError && sample < 3 && Date.now() < deadline; sample++) {
        const old = observation.structuredContent ?? {};
        await this.sleep(150);
        observation = await this.read(binding, { ...options, view: "accessibility" });
        if (
          !observation.isError &&
          fingerprint(binding, old) === fingerprint(binding, observation.structuredContent ?? {}) &&
          !rows(
            binding.browser
              ? observation.structuredContent?.refs
              : observation.structuredContent?.elements,
          ).some((entry) => /progress|busy/iu.test(String(entry.role)))
        ) {
          settled = true;
          break;
        }
      }
      settled ??= false;
      if (!observation.isError && options.view === "both") {
        const stableState = observation.structuredContent ?? {};
        observation = await this.read(binding, options);
        if (
          !observation.isError &&
          fingerprint(binding, stableState) !==
            fingerprint(binding, observation.structuredContent ?? {})
        )
          settled = false;
      }
    } else observation = await this.read(binding, options);
    this.invalidate(binding);
    if (observation.isError || !observation.structuredContent) {
      binding.state = undefined;
      binding.reportedState = undefined;
      return observation.isError
        ? observation
        : nativeControlError(
            "The controller did not return target state. Select or observe again before input.",
          );
    }
    binding.state = observation.structuredContent;
    binding.reportedState = binding.state;
    binding.dirty = false;
    const state: Fields = { ...binding.state };
    // Diff only native accessibility records; browser semantic outlines and
    // content refs retain their complete native versioned representation.
    if (
      !binding.browser &&
      previous &&
      Array.isArray(previous.elements) &&
      previous.snapshot_id &&
      options.full !== true &&
      options.view !== "screenshot" &&
      options.query === binding.query
    ) {
      const old = new Map(
        rows(previous.elements).map((entry) => [
          entry.element_index ?? token(entry).split(":").at(-1),
          entry,
        ]),
      );
      const current = rows(state.elements);
      const updates: { from: string; to: string }[] = [];
      const changed = current.filter((entry) => {
        const key = entry.element_index ?? token(entry).split(":").at(-1);
        const prior = old.get(key);
        old.delete(key);
        if (prior && semantic(prior) === semantic(entry)) {
          updates.push({ from: token(prior), to: token(entry) });
          return false;
        }
        return true;
      });
      state.elements = changed;
      state.diff = {
        from_snapshot: previous.snapshot_id,
        removed: [...old.values()].map(token),
        token_updates: updates,
      };
    }
    binding.query = options.query;
    return output(
      {
        target: binding.handle,
        kind: binding.browser ? "browser" : "app",
        ...binding.native,
        ...binding.browser,
        state,
        ...(settled === undefined ? {} : { settling: settled ? "stable" : "budget_exhausted" }),
      },
      observation,
    );
  }

  private element(binding: Binding, id: string): Fields | undefined {
    return elements(binding).find((entry) => token(entry) === id);
  }

  private point(binding: Binding, point: { x: number; y: number }): { x: number; y: number } {
    const state = binding.state;
    const screenshot = object(state?.screenshot);
    const width = Number(state?.screenshot_width ?? screenshot?.width);
    const height = Number(state?.screenshot_height ?? screenshot?.height);
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      !state ||
      (!binding.browser && typeof state.capture_id !== "string") ||
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      point.x >= width ||
      point.y >= height
    )
      throw new Error("Request a fresh screenshot (view:both) and use points inside its image.");
    if (binding.browser) {
      const scaleX = Number(screenshot?.pixel_to_css_scale_x),
        scaleY = Number(screenshot?.pixel_to_css_scale_y);
      if (!(scaleX > 0 && scaleY > 0))
        throw new Error(
          "The browser screenshot has no valid pixel-to-CSS mapping. Use an element handle.",
        );
      return { x: point.x * scaleX, y: point.y * scaleY };
    }
    return point;
  }

  private preflight(binding: Binding, actions: readonly ComputerAction[]): void {
    if (!binding.state) throw new Error("Observe the target again before acting.");
    for (const action of actions) {
      if ("element" in action && action.element && !this.element(binding, action.element))
        throw new Error(
          "An element handle is stale or belongs to another target. Observe and rebuild the batch.",
        );
      if ("point" in action && action.point) this.point(binding, action.point);
      if (action.type === "click" && !action.element === !action.point)
        throw new Error("A click requires exactly one element or screenshot point.");
      if (
        action.type === "click" &&
        (action.count ?? 1) > 1 &&
        ((action.button ?? "left") !== "left" || (!binding.browser && action.element))
      )
        throw new Error("Repeated native clicks require a screenshot point and the left button.");
      if (action.type === "scroll" && action.element && action.point)
        throw new Error("A scroll accepts one element or screenshot point, not both.");
      if (action.type === "drag") {
        this.point(binding, action.from);
        this.point(binding, action.to);
      }
      if ((action.type === "navigate" || action.type === "files") && !binding.browser)
        throw new Error(
          "Navigation and file-input actions require an exact browser tab. Use open_url or native file-picker controls for apps.",
        );
      if (action.type === "navigate") {
        const url = new URL(action.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
          throw new Error("Navigation requires an HTTP or HTTPS URL without embedded credentials.");
      }
      if (
        binding.browser &&
        ["type", "paste", "set_value"].includes(action.type) &&
        !("element" in action && action.element)
      )
        throw new Error("Browser text entry requires an exact field element.");
      if (
        binding.browser &&
        action.type === "click" &&
        (action.button === "middle" || action.count === 3)
      )
        throw new Error(
          "This browser gesture is unavailable in the bound interface. Use a supported advanced operation.",
        );
      if (binding.browser && action.type === "key" && !binding.native)
        throw new Error(
          "Select the browser by app/window to use native key presses on its active tab.",
        );
      if (action.type === "paste" && !action.element)
        throw new Error("Paste requires an exact field element so its result can be observed.");
      if (
        action.type === "files" &&
        action.files.some((file) => !isAbsolute(file) || file.includes("\u0000"))
      )
        throw new Error("File input requires absolute local file paths.");
      if (!binding.browser && action.type === "type" && action.replace === true && !action.element)
        throw new Error("Native replacement requires an exact field element.");
    }
  }

  private async act(args: Fields): Promise<NativeToolResult> {
    const input = decodeComputerAct(args);
    const binding = this.bindings.get(input.target);
    if (!binding) return nativeControlError("This target has expired. Select the app again.");
    try {
      this.preflight(binding, input.actions);
    } catch (error) {
      return nativeControlError(error instanceof Error ? error.message : "Invalid action batch.");
    }
    const results: Fields[] = [];
    let stopped: number | undefined;
    let attempted = 0;
    for (const [index, action] of input.actions.entries()) {
      // A text verification read may have replaced tokens mid-batch. Refuse
      // further stale element actions rather than silently selecting a sibling.
      try {
        this.preflight(binding, [action]);
      } catch (error) {
        results.push({
          index,
          type: action.type,
          error:
            error instanceof Error
              ? error.message
              : "Grounding changed during the batch. Use the returned fresh state.",
        });
        stopped = index;
        break;
      }
      const response = await this.action(binding, action);
      attempted++;
      results.push({
        index,
        type: action.type,
        ...response.structuredContent,
        ...(response.isError
          ? { error: response.content.filter((part) => part.type === "text") }
          : {}),
      });
      binding.dirty = true;
      if (uncertain(response)) {
        stopped = index;
        break;
      }
    }
    const hasPixels = input.actions.some(
      (action) => ("point" in action && action.point) || action.type === "drag",
    );
    const observed = await this.observe(binding, {
      ...input,
      view: input.view ?? (hasPixels ? "both" : "accessibility"),
    });
    return output(
      {
        target: binding.handle,
        batch: stopped === undefined ? "completed" : "stopped",
        attempted_steps: attempted,
        ...(stopped === undefined ? {} : { stopped_at: stopped }),
        results,
        ...(observed.isError
          ? { observation_error: observed.content }
          : observed.structuredContent),
      },
      { ...observed, isError: stopped !== undefined || observed.isError === true },
    );
  }

  private async action(binding: Binding, action: ComputerAction): Promise<NativeToolResult> {
    const target = { ...(binding.browser ?? binding.native), observe_after: false };
    const entry =
      "element" in action && action.element ? this.element(binding, action.element) : undefined;
    const locator = entry
      ? binding.browser
        ? { ref: token(entry) }
        : { element_token: token(entry) }
      : "point" in action && action.point
        ? this.point(binding, action.point)
        : {};
    if (action.type === "type" || action.type === "paste" || action.type === "set_value") {
      if (binding.browser)
        return this.callNative("browser_type", {
          ...target,
          ...locator,
          text: action.type === "set_value" ? action.value : action.text,
          replace:
            action.type === "set_value" || (action.type === "type" && action.replace === true),
        });
      if (action.type === "paste") return this.paste(binding, action.text, entry);
      let nativeLocator: Fields = locator;
      let foreground = false;
      if (
        entry &&
        action.type === "type" &&
        (entry.in_web_content === true || action.replace === true)
      ) {
        const grounded = await this.read(binding, { target: binding.handle, view: "both" });
        this.invalidate(binding);
        if (grounded.isError || !grounded.structuredContent) return grounded;
        binding.state = grounded.structuredContent;
        const field = this.matchEntry(binding, entry),
          frame = object(field?.screenshot_frame);
        if (!field || !frame)
          return nativeControlError(
            "The text field could not be grounded in the exact window. Observe and select again.",
          );
        const point = this.fieldPoint(binding, {
          x: Number(frame.x) + Number(frame.w) / 2,
          y: Number(frame.y) + Number(frame.h) / 2,
        });
        if ("error" in point) return point.error;
        nativeLocator = point;
        foreground = true;
        if (field.in_web_content === true) {
          // Cua's AX focus shortcut can report a web field as focused while
          // the renderer still has BODY as its first responder. Establish
          // physical focus once before text; never retry an uncertain click.
          const focused = await this.callNative("click", {
            ...target,
            ...point,
            capture_id: binding.state.capture_id,
            delivery_mode: "foreground",
          });
          if (uncertain(focused)) return focused;
          // HID posting is asynchronous. Give the renderer the same bounded
          // focus-settling interval before sending the first text/key event.
          await this.sleep(150);
          // Replacement's pixel hotkey selects all in this now-focused field.
          // Plain typing needs no second focus attempt or caret-moving click.
          if (action.replace !== true) nativeLocator = {};
        }
      }
      if (action.type === "type" && action.replace === true) {
        const selected = await this.callNative("hotkey", {
          ...target,
          ...nativeLocator,
          keys: ["cmd", "a"],
          delivery_mode: "foreground",
        });
        if (uncertain(selected)) return selected;
        // Refocusing with another click would collapse the selection.
        nativeLocator = {};
        foreground = true;
      }
      const response = await this.callNative(
        action.type === "set_value" ? "set_value" : "type_text",
        {
          ...target,
          ...nativeLocator,
          ...(foreground ? { delivery_mode: "foreground" } : {}),
          [action.type === "set_value" ? "value" : "text"]:
            action.type === "set_value" ? action.value : action.text,
        },
      );
      if (entry && !response.isError) {
        // Observe even an AX echo; expose its trust separately. A native
        // delivery receipt or unchanged text can never be promoted to success.
        const check = await this.read(binding, { target: binding.handle });
        this.invalidate(binding);
        if (!check.isError && check.structuredContent) {
          binding.state = check.structuredContent;
          const current = this.matchEntry(binding, entry);
          const text = action.type === "set_value" ? action.value : action.text;
          const observed =
            typeof current?.value === "string" &&
            (action.type === "set_value" || action.replace === true
              ? current.value === text
              : current.value !== entry.value && current.value.includes(text));
          const untrustedEcho = action.type === "set_value" && entry.in_web_content === true;
          return output(
            {
              ...response.structuredContent,
              text_observed: observed,
              application_acceptance:
                entry.in_web_content === true ? "unverified" : observed ? "observed" : "unverified",
              ...(!observed || untrustedEcho ? { effect: "uncertain" } : {}),
            },
            { ...response, isError: !observed || untrustedEcho },
          );
        }
        binding.state = undefined;
        return output(
          { ...response.structuredContent, effect: "uncertain", verification_error: check.content },
          { ...response, isError: true },
        );
      }
      return response;
    }
    if (action.type === "click") {
      const name = binding.browser
        ? action.button === "right" || action.count === 2
          ? "browser_pointer"
          : "browser_click"
        : "click";
      return this.callNative(name, {
        ...target,
        ...locator,
        ...(binding.browser
          ? name === "browser_pointer"
            ? { action: action.button === "right" ? "right_click" : "double_click" }
            : {}
          : {
              button: action.button ?? "left",
              count: action.count ?? 1,
              ...(entry ? {} : { capture_id: binding.state?.capture_id }),
            }),
      });
    }
    if (action.type === "key") {
      if (binding.browser) {
        const tabs = await this.callNative("get_browser_state", {
          ...binding.native,
          include_page_state: false,
        });
        if (tabs.isError) return tabs;
        const active = rows(tabs.structuredContent?.tabs).filter((tab) => tab.active === true);
        if (
          active.length !== 1 ||
          active[0]!.tab_id !== binding.browser.tab_id ||
          tabs.structuredContent?.target_id !== binding.browser.target_id
        )
          return nativeControlError(
            "The bound tab is not the active tab in its native window. Use browser DOM input or select the active tab again.",
          );
        if (entry) {
          const focused = await this.callNative("browser_click", {
            ...binding.browser,
            ref: token(entry),
            observe_after: false,
          });
          if (uncertain(focused)) return focused;
        }
      }
      return this.callNative(action.keys.length === 1 ? "press_key" : "hotkey", {
        ...binding.native,
        ...(!binding.browser ? locator : {}),
        // PID-routed keys can be discarded by Chromium/Electron even after
        // text focus was established. Cua's foreground key route holds the
        // exact window through HID delivery and restores the previous app.
        ...(binding.browser || elements(binding).some((field) => field.in_web_content === true)
          ? { delivery_mode: "foreground" }
          : {}),
        observe_after: false,
        ...(action.keys.length === 1 ? { key: action.keys[0] } : { keys: action.keys }),
      });
    }
    if (action.type === "scroll")
      return this.callNative(binding.browser ? "browser_pointer" : "scroll", {
        ...target,
        ...locator,
        ...(binding.browser
          ? {
              action: "scroll",
              delta_x: ["left", "right"].includes(action.direction)
                ? (action.direction === "left" ? -1 : 1) * (action.amount ?? 500)
                : 0,
              delta_y: ["up", "down"].includes(action.direction)
                ? (action.direction === "up" ? -1 : 1) * (action.amount ?? 500)
                : 0,
            }
          : { direction: action.direction, amount: Math.min(action.amount ?? 3, 50) }),
      });
    if (action.type === "drag") {
      const from = this.point(binding, action.from),
        to = this.point(binding, action.to);
      return this.callNative(binding.browser ? "browser_pointer" : "drag", {
        ...target,
        ...(binding.browser
          ? { action: "drag", x: from.x, y: from.y }
          : { from_x: from.x, from_y: from.y, delivery_mode: "foreground" }),
        to_x: to.x,
        to_y: to.y,
      });
    }
    if (action.type === "navigate")
      return this.callNative("browser_navigate", { ...target, url: action.url });
    return this.callNative("browser_set_input_files", {
      ...target,
      ...locator,
      files: action.files,
    });
  }

  private matchEntry(binding: Binding, prior: Fields): Fields | undefined {
    // AX indices describe traversal order, not a durable element identity.
    // Electron/menu updates can shift every index between two reads. Rebind
    // only a unique field with unchanged semantic identity and native bounds.
    const bounds = object(prior.frame);
    if (!bounds || !["x", "y", "w", "h"].every((key) => Number.isFinite(bounds[key])))
      return undefined;
    const candidates = elements(binding).filter(
      (entry) =>
        entry.role === prior.role &&
        entry.label === prior.label &&
        ["x", "y", "w", "h"].every((key) => object(entry.frame)?.[key] === bounds[key]),
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private async paste(binding: Binding, text: string, entry?: Fields): Promise<NativeToolResult> {
    const clipboard = await this.callNative("clipboard_read", { include_text: true });
    if (clipboard.isError) return clipboard;
    const original = clipboard.structuredContent;
    if (
      !original ||
      !Array.isArray(original.types) ||
      !original.types.length ||
      original.types.some((type) => !clipboardTextTypes.has(String(type))) ||
      typeof original.text !== "string"
    )
      return nativeControlError(
        "Paste cannot restore the current clipboard format safely. Use type or set_value; the clipboard was left unchanged.",
      );
    let locator: Fields = {};
    if (entry) {
      const grounded = await this.read(binding, { target: binding.handle, view: "both" });
      this.invalidate(binding);
      if (grounded.isError || !grounded.structuredContent) return grounded;
      binding.state = grounded.structuredContent;
      const field = this.matchEntry(binding, entry),
        frame = object(field?.screenshot_frame);
      if (!field || !frame)
        return nativeControlError(
          "The paste field could not be grounded in the exact window. Observe and select the field again.",
        );
      const point = this.fieldPoint(binding, {
        x: Number(frame.x) + Number(frame.w) / 2,
        y: Number(frame.y) + Number(frame.h) / 2,
      });
      if ("error" in point) return point.error;
      locator = point;
      if (field.in_web_content === true) {
        const focused = await this.callNative("click", {
          ...binding.native,
          ...point,
          capture_id: binding.state.capture_id,
          delivery_mode: "foreground",
          observe_after: false,
        });
        if (uncertain(focused)) return focused;
        await this.sleep(150);
      }
    }
    let delivered: NativeToolResult = nativeControlError("Paste was not dispatched.");
    let restoration = "unchanged";
    try {
      const written = await this.callNative("clipboard_write", { text });
      if (uncertain(written)) {
        delivered = written;
      } else {
        delivered = await this.callNative("hotkey", {
          ...binding.native,
          ...locator,
          keys: ["cmd", "v"],
          delivery_mode: "foreground",
          observe_after: false,
        });
        // Observe while pasteboard data is still available to the recipient.
        let observed: NativeToolResult;
        let textObserved = false;
        for (let sample = 0; sample < 3; sample++) {
          await this.sleep(150);
          observed = await this.read(binding, { target: binding.handle });
          this.invalidate(binding);
          binding.state = observed.isError ? undefined : observed.structuredContent;
          const current = entry ? this.matchEntry(binding, entry) : undefined;
          textObserved =
            typeof current?.value === "string" &&
            current.value !== entry?.value &&
            current.value.includes(text);
          if (textObserved || observed.isError || uncertain(delivered)) break;
        }
        delivered = output(
          {
            ...delivered.structuredContent,
            text_observed: textObserved,
            application_acceptance: "unverified",
            ...(!textObserved ? { effect: "uncertain" } : {}),
          },
          { ...delivered, isError: delivered.isError || !textObserved },
        );
      }
    } finally {
      // Restoration remains inside the same host authority. Revocation denies
      // this subcall too; never send unrelated native requests outside admission.
      restoration = await this.restoreClipboard(original.text, text);
    }
    return output({ ...delivered.structuredContent, clipboard: restoration }, delivered);
  }

  private async restoreClipboard(original: string, pasted: string): Promise<string> {
    const current = await this.callNative("clipboard_read", { include_text: true });
    if (current.isError) throw new Error("Clipboard state could not be checked for restoration.");
    const data = current.structuredContent;
    if (
      data?.text !== pasted ||
      !Array.isArray(data.types) ||
      !data.types.every((type) => clipboardTextTypes.has(String(type)))
    ) {
      // Preserve a newer copy instead of replacing it with an obsolete value.
      return "newer_value_preserved";
    }
    const restored = await this.callNative("clipboard_write", { text: original });
    if (uncertain(restored)) throw new Error("Clipboard restoration could not be acknowledged.");
    return "restored";
  }

  private fieldPoint(
    binding: Binding,
    point: { x: number; y: number },
  ): { x: number; y: number } | { error: NativeToolResult } {
    try {
      return this.point(binding, point);
    } catch {
      return {
        error: nativeControlError(
          "The field is outside the current image. Reveal it and observe again before text entry.",
        ),
      };
    }
  }
}
