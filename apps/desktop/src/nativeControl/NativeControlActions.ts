import {
  nativeControlError,
  nativeToolArguments,
  type NativeToolResult,
} from "@cafecode/shared/nativeControl";

type Fields = Record<string, unknown>;
export type NativeInvoke = (name: string, args: Fields) => Promise<NativeToolResult>;
const inputTools = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
]);
const browserInputTools = new Set([
  "browser_click",
  "browser_type",
  "browser_pointer",
  "browser_navigate",
]);
const foregroundRefusals = new Set([
  "same_pid_keyboard_ambiguity",
  "minimized_or_hidden_window",
  "off_space_or_ax_unresolved",
]);
const cafeArguments = new Set([
  "auto_foreground",
  "observe_after",
  "observe_query",
  "max_results",
  "max_windows",
  "include_auxiliary_windows",
  "include_page_state",
]);
const browsers = new Set([
  "com.kagi.kagimacOS",
  "com.apple.Safari",
  "com.google.Chrome",
  "com.brave.Browser",
  "com.microsoft.edgemac",
  "company.thebrowser.Browser",
  "org.mozilla.firefox",
  "com.vivaldi.Vivaldi",
]);

function fields(value: unknown): Fields | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}
function records(value: unknown): Fields[] {
  return Array.isArray(value)
    ? value.map(fields).filter((item): item is Fields => item !== undefined)
    : [];
}
function bound(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : fallback;
}
function result(data: Fields, original?: NativeToolResult): NativeToolResult {
  return { ...original, content: original?.content ?? [], structuredContent: data };
}
function targetOf(args: Fields): { pid: number; window_id?: number } | undefined {
  const target = fields(args.target);
  if (args.scope === "desktop" || target?.kind === "desktop") return undefined;
  const pid = target?.pid ?? args.pid;
  const window_id = target?.window_id ?? args.window_id;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return undefined;
  return { pid, ...(typeof window_id === "number" ? { window_id } : {}) };
}

export function isAuxiliaryWindow(window: Fields): boolean {
  const size = fields(window.bounds);
  return (
    typeof size?.width !== "number" ||
    typeof size.height !== "number" ||
    size.width < 100 ||
    size.height < 80 ||
    /^completions$/iu.test(String(window.title ?? ""))
  );
}

/** A main window outranks tiny previews/popovers even when they are on-screen.
 * Current-Space and visible windows outrank historical/off-Space browser tabs.
 * Recommendations are selection hints, not proof of focus or navigation. */
export function rankNativeWindows(windows: Fields[]): Fields[] {
  const score = (window: Fields): number => {
    const size = fields(window.bounds);
    const area = Number(size?.width ?? 0) * Number(size?.height ?? 0);
    return (
      (isAuxiliaryWindow(window) ? -1_000_000 : 0) +
      (area >= 120_000 ? 100_000 : 0) +
      (window.on_current_space === true ? 10_000 : 0) +
      (window.is_on_screen === true ? 5000 : 0) +
      (String(window.title ?? "").trim() ? 1000 : 0) +
      Math.min(area / 1000, 999) +
      Number(window.z_index ?? 0) / 1000
    );
  };
  return windows.toSorted((a, b) => score(b) - score(a));
}

export function projectNativeWindows(data: Fields, args: Fields): Fields {
  const all = records(data.windows);
  const query = typeof args.query === "string" ? args.query.toLowerCase() : undefined;
  const candidates = rankNativeWindows(
    all.filter(
      (window) =>
        (args.include_auxiliary_windows === true || !isAuxiliaryWindow(window)) &&
        (!query || `${window.app_name ?? ""} ${window.title ?? ""}`.toLowerCase().includes(query)),
    ),
  );
  const windows = candidates.slice(0, bound(args.max_windows, 8, 100));
  return {
    ...data,
    windows,
    total_window_count: all.length,
    matching_window_count: candidates.length,
    auxiliary_window_count: all.filter(isAuxiliaryWindow).length,
    windows_truncated: candidates.length > windows.length,
    recommended_window: candidates.find((window) => !isAuxiliaryWindow(window)) ?? null,
    ...(data.launch_state
      ? {
          navigation_verified: false,
          launch_state: {
            ...fields(data.launch_state),
            window_ready: candidates.some((window) => !isAuxiliaryWindow(window)),
          },
        }
      : {}),
  };
}

export function projectNativeObservation(data: Fields, args: Fields): Fields {
  const elements = records(data.elements);
  const returned = elements.slice(0, bound(args.max_results, 200, 2000));
  const { tree_markdown: _duplicate, _note, ...metadata } = data;
  return {
    ...metadata,
    elements: returned,
    returned_element_count: returned.length,
    matching_element_count: elements.length,
    search_truncated: data.truncated === true,
    output_truncated: elements.length > returned.length,
  };
}

function addressUrl(data: Fields): string | undefined {
  for (const element of records(data.elements)) {
    if (element.role !== "AXTextField" || element.in_web_content === true) continue;
    const value = String(element.value ?? element.label ?? "").trim();
    if (/^https?:\/\/\S+$/iu.test(value)) return value;
    if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]\S*)?$/iu.test(value)) return `https://${value}`;
  }
  return undefined;
}
function pageObserved(data: Fields): boolean {
  const elements = records(data.elements);
  return (
    elements.some(
      (element) =>
        element.role === "AXWebArea" &&
        String(element.label ?? "").trim() &&
        !/^(?:start page|new tab|about:blank|loading(?:…|\.\.\.)?)$/iu.test(String(element.label)),
    ) && elements.some((element) => element.in_web_content === true && element.role !== "AXWebArea")
  );
}
function sameDestination(actual: string, requested: string): boolean {
  try {
    const a = new URL(actual);
    const b = new URL(requested);
    return (
      a.hostname.replace(/^www\./u, "") === b.hostname.replace(/^www\./u, "") &&
      a.port === b.port &&
      a.pathname.replace(/\/$/u, "") === b.pathname.replace(/\/$/u, "") &&
      a.search === b.search &&
      a.hash === b.hash
    );
  } catch {
    return false;
  }
}

/** One public call stays inside the host's exclusive in-flight operation. The
 * invoke callback rechecks chat/turn authority before EVERY native subcall. */
class NativeControlActions {
  private readonly invoke: NativeInvoke;
  constructor(invoke: NativeInvoke) {
    this.invoke = invoke;
  }

  private native(name: string, args: Fields): Promise<NativeToolResult> {
    const nativeArgs = Object.fromEntries(
      Object.entries(args).filter(
        ([key]) => !cafeArguments.has(key) && !(name === "list_windows" && key === "query"),
      ),
    );
    return this.invoke(name, nativeToolArguments(name, nativeArgs));
  }

  private async window(pid: number): Promise<{ window?: Fields; error?: NativeToolResult }> {
    // Native enumeration stays unprojected internally; the public list is small.
    const found = await this.native("list_windows", { pid });
    if (found.isError) return { error: found };
    const window = rankNativeWindows(records(found.structuredContent?.windows)).find(
      (candidate) => !isAuxiliaryWindow(candidate),
    );
    return window
      ? { window }
      : {
          error: nativeControlError(
            "No usable window is available for this app. Open a main window and retry, or supply its exact window_id.",
          ),
        };
  }

  private async read(args: Fields): Promise<NativeToolResult> {
    const read = await this.native("get_window_state", args);
    return read.isError || !read.structuredContent
      ? read
      : result(projectNativeObservation(read.structuredContent, args), read);
  }

  private async action(name: string, args: Fields): Promise<NativeToolResult> {
    let response = await this.native(name, args);
    const refusal = response.structuredContent;
    let fallback: Fields | undefined;
    const requested = targetOf(args);
    const target = requested && {
      pid: requested.pid,
      window_id: requested.window_id ?? refusal?.window_id,
    };
    // Only these BEFORE-DISPATCH targeting refusals qualify. A successful post,
    // partial text delivery, AX echo or lost response can never trigger replay.
    if (
      args.auto_foreground !== false &&
      args.delivery_mode !== "foreground" &&
      response.isError === true &&
      refusal?.effect === "refused" &&
      foregroundRefusals.has(String(refusal.code)) &&
      target &&
      typeof target.window_id === "number"
    ) {
      response = await this.native(name, { ...args, ...target, delivery_mode: "foreground" });
      fallback = {
        from: "background",
        to: "foreground",
        reason: refusal.code,
        target,
        focus_may_change: true,
      };
    }
    if (response.isError) return response;
    const observe =
      args.observe_after === true || (fallback !== undefined && args.observe_after !== false);
    const data: Fields = {
      ...response.structuredContent,
      ...(fallback ? { cafe_fallback: fallback } : {}),
    };
    const observationTarget =
      requested?.window_id !== undefined
        ? requested
        : target && typeof target.window_id === "number"
          ? { pid: target.pid, window_id: target.window_id }
          : targetOf(data);
    if (observe && observationTarget?.window_id !== undefined) {
      const observation = await this.read({
        ...observationTarget,
        ...(typeof args.observe_query === "string" ? { query: args.observe_query } : {}),
        max_results: 200,
      });
      if (observation.isError) data.observation_error = observation.content;
      else data.observation = observation.structuredContent;
    } else if (observe) {
      data.observation_error =
        "Supply exact pid/window_id to include a post-action window observation.";
    }
    return fallback || observe ? result(data, response) : response;
  }

  private async browserAction(name: string, args: Fields): Promise<NativeToolResult> {
    const response = await this.native(name, args);
    if (response.isError || args.observe_after === false) return response;
    const observation = await this.native("get_browser_state", {
      target_id: args.target_id,
      tab_id: args.tab_id,
      ...(typeof args.observe_query === "string" ? { query: args.observe_query } : {}),
    });
    return result(
      {
        ...response.structuredContent,
        ...(observation.isError
          ? { observation_error: observation.content }
          : { observation: observation.structuredContent }),
      },
      response,
    );
  }

  private async browserState(args: Fields): Promise<NativeToolResult> {
    const response = await this.native("get_browser_state", args);
    if (response.isError || args.target_id || args.include_page_state === false) return response;
    const active = records(response.structuredContent?.tabs).filter((tab) => tab.active === true);
    if (active.length !== 1) return response;
    const observation = await this.native("get_browser_state", {
      target_id: response.structuredContent?.target_id,
      tab_id: active[0]!.tab_id,
      ...(typeof args.query === "string" ? { query: args.query } : {}),
      ...(typeof args.snapshot_format === "string"
        ? { snapshot_format: args.snapshot_format }
        : {}),
      include_screenshot: args.include_screenshot === true,
    });
    return result(
      {
        ...response.structuredContent,
        ...(observation.isError
          ? { observation_error: observation.content }
          : { observation: observation.structuredContent }),
      },
      { ...response, content: observation.content },
    );
  }

  async call(name: string, original: Fields): Promise<NativeToolResult> {
    if (name === "open_url") return this.openUrl(original);
    let args = original;
    const target = targetOf(args);
    if (
      target &&
      target.window_id === undefined &&
      !args.element_token &&
      (name === "get_window_state" || name === "bring_to_front" || inputTools.has(name))
    ) {
      const selection = await this.window(target.pid);
      if (selection.error) return selection.error;
      args = {
        ...args,
        window_id: selection.window!.window_id,
        ...(fields(args.target)
          ? { target: { ...fields(args.target), window_id: selection.window!.window_id } }
          : {}),
      };
    }
    if (name === "get_window_state") return this.read(args);
    if (name === "get_browser_state") return this.browserState(args);
    if (browserInputTools.has(name)) return this.browserAction(name, args);
    if (inputTools.has(name)) return this.action(name, args);
    const response = await this.native(name, args);
    if (response.isError || !response.structuredContent) return response;
    if (name === "list_windows" || name === "launch_app")
      return result(projectNativeWindows(response.structuredContent, args), response);
    return response;
  }

  private async openDom(args: Fields, url: string): Promise<NativeToolResult> {
    const navigated = await this.native("browser_navigate", {
      target_id: args.target_id,
      tab_id: args.tab_id,
      url,
    });
    if (navigated.isError) return navigated;
    const observation = await this.native("get_browser_state", {
      target_id: args.target_id,
      tab_id: args.tab_id,
      ...(typeof args.query === "string" ? { query: args.query } : {}),
      include_screenshot: args.include_screenshot === true,
    });
    if (observation.isError)
      return result(
        {
          ...navigated.structuredContent,
          navigation_verified: false,
          observation_error: observation.content,
        },
        navigated,
      );
    const page = fields(observation.structuredContent?.page);
    const actual = page?.url ?? observation.structuredContent?.url;
    const verified = typeof actual === "string" && sameDestination(actual, url);
    return result(
      {
        route: "browser_dom",
        target_id: args.target_id,
        tab_id: args.tab_id,
        requested_url: url,
        observed_url: actual ?? null,
        navigation_verified: verified,
        navigation_state: verified ? "verified" : actual ? "redirected" : "unverified",
        observation: observation.structuredContent,
      },
      observation,
    );
  }

  private async openUrl(args: Fields): Promise<NativeToolResult> {
    let url: URL;
    try {
      url = new URL(String(args.url));
      if (!/^https?:$/u.test(url.protocol)) throw new Error();
    } catch {
      return nativeControlError("open_url requires an absolute http or https URL.");
    }
    if (args.target_id !== undefined || args.tab_id !== undefined) {
      if (
        typeof args.target_id !== "string" ||
        typeof args.tab_id !== "string" ||
        args.new_tab === true
      )
        return nativeControlError(
          "Supply both target_id and tab_id; bound-tab navigation requires new_tab omitted or false.",
        );
      return this.openDom(args, url.href);
    }
    if (args.window_id !== undefined && args.pid === undefined)
      return nativeControlError("Supply pid with an exact window_id.");
    let pid = typeof args.pid === "number" ? args.pid : undefined;
    let bundleId = typeof args.bundle_id === "string" ? args.bundle_id : undefined;
    if (pid === undefined) {
      const listed = await this.native("list_apps", {});
      if (listed.isError) return listed;
      const candidates = records(listed.structuredContent?.apps).filter(
        (app) =>
          app.running === true &&
          (bundleId ? app.bundle_id === bundleId : browsers.has(String(app.bundle_id))),
      );
      if (candidates.length) {
        const selected = candidates.find((app) => app.active === true) ?? candidates[0];
        if (typeof selected?.pid === "number") pid = selected.pid;
        if (typeof selected?.bundle_id === "string") bundleId = selected.bundle_id;
      }
      if (!bundleId && pid === undefined) bundleId = "com.apple.Safari";
      if (pid === undefined) {
        // Do not assume that a LaunchServices URL request loaded a page. Launch
        // the app, then navigate its selected main window through native input.
        const launched = await this.native("launch_app", { bundle_id: bundleId });
        if (launched.isError) return launched;
        const launchedPid = launched.structuredContent?.pid;
        if (typeof launchedPid !== "number" || launchedPid < 1)
          return nativeControlError("The browser did not report a running process.");
        pid = launchedPid;
        // Cua's background launch watchdog can demote the launched app for
        // eight seconds after the response. Do not race it with foreground
        // keyboard navigation. Running browsers never enter this launch path.
        if (launched.structuredContent?.self_activation_suppressed !== undefined)
          await new Promise<void>((resolve) => setTimeout(resolve, 8000));
      }
    }
    let windowId = typeof args.window_id === "number" ? args.window_id : undefined;
    if (windowId === undefined) {
      const selection = await this.window(pid);
      if (selection.error) return selection.error;
      windowId = Number(selection.window!.window_id);
    }
    const target = { pid, window_id: windowId, delivery_mode: "foreground" };
    // Read-only binding never enables browser debugging or adopts a new login
    // profile. If exact DOM access is already available, use it immediately.
    let binding = await this.native("get_browser_state", { pid, window_id: windowId });
    if (
      binding.isError &&
      (!bundleId || bundleId === "com.google.Chrome" || bundleId === "com.microsoft.edgemac")
    ) {
      const prepared = await this.native("browser_prepare", {
        pid,
        window_id: windowId,
        strategy: { kind: "existing_profile" },
      });
      if (!prepared.isError && prepared.structuredContent?.prepared === true)
        binding = await this.native("get_browser_state", { pid, window_id: windowId });
    }
    let activeTabs = records(binding.structuredContent?.tabs).filter((tab) => tab.active === true);
    if (
      !binding.isError &&
      binding.structuredContent?.mutation_allowed === true &&
      activeTabs.length === 1
    ) {
      if (args.new_tab !== false) {
        const newTab = await this.native("hotkey", { ...target, keys: ["cmd", "t"] });
        if (newTab.isError) return newTab;
        binding = await this.native("get_browser_state", { pid, window_id: windowId });
        if (binding.isError) return binding;
        activeTabs = records(binding.structuredContent?.tabs).filter((tab) => tab.active === true);
        if (binding.structuredContent?.mutation_allowed !== true || activeTabs.length !== 1)
          return nativeControlError(
            "The new browser tab could not be bound exactly. Observe the browser before navigating it.",
          );
      }
      return this.openDom(
        { ...args, target_id: binding.structuredContent?.target_id, tab_id: activeTabs[0]!.tab_id },
        url.href,
      );
    }
    // Keep the browser active for the WHOLE native address-editing sequence.
    // Exact DOM navigation above needs no native activation when reusing a tab.
    const activated = await this.native("bring_to_front", { pid, window_id: windowId });
    if (activated.isError) return activated;
    const actions: { name: string; args: Fields }[] = [
      ...(args.new_tab !== false
        ? [{ name: "hotkey", args: { ...target, keys: ["cmd", "t"] } }]
        : []),
      { name: "hotkey", args: { ...target, keys: ["cmd", "l"] } },
    ];
    for (const step of actions) {
      const delivered = await this.native(step.name, step.args);
      if (delivered.isError)
        return result(
          {
            ...delivered.structuredContent,
            requested_url: url.href,
            pid,
            window_id: windowId,
            navigation_step: step.name,
            navigation_verified: false,
          },
          delivered,
        );
    }
    // AX can echo a native address-field value without installing renderer
    // focus. Ground a real click in the address field and submit in the SAME
    // foreground key action instead of trusting AXConfirm or a remembered
    // first responder. This screenshot stays inside the host unless requested.
    const grounded = await this.native("get_window_state", {
      pid,
      window_id: windowId,
      include_screenshot: true,
      max_elements: 4000,
      max_depth: 25,
      timeout_ms: 3000,
    });
    if (grounded.isError) return grounded;
    const address = records(grounded.structuredContent?.elements).find(
      (element) =>
        element.role === "AXTextField" &&
        element.in_web_content !== true &&
        Array.isArray(element.actions) &&
        element.actions.includes("AXConfirm") &&
        fields(element.screenshot_frame),
    );
    const frame = fields(address?.screenshot_frame);
    const entered = address?.element_token
      ? await this.native("set_value", {
          pid,
          window_id: windowId,
          element_token: address.element_token,
          value: url.href,
        })
      : await this.native("type_text", { ...target, text: url.href });
    if (entered.isError) return entered;
    const submitted = await this.native("press_key", {
      ...target,
      key: "return",
      ...(frame
        ? { x: Number(frame.x) + Number(frame.w) / 2, y: Number(frame.y) + Number(frame.h) / 2 }
        : {}),
    });
    if (submitted.isError) return submitted;
    let snapshot: NativeToolResult | undefined;
    let actual: string | undefined;
    let observed = false;
    const deadline = Date.now() + 8000;
    do {
      snapshot = await this.native("get_window_state", {
        pid,
        window_id: windowId,
        max_elements: 4000,
        max_depth: 25,
        timeout_ms: 1000,
        include_screenshot: false,
      });
      if (snapshot.isError) return snapshot;
      actual = addressUrl(snapshot.structuredContent ?? {});
      observed = pageObserved(snapshot.structuredContent ?? {});
      if (actual && observed && sameDestination(actual, url.href)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    // The final filtered/screenshot read is OPTIONAL. It must not replace the
    // evidence used to distinguish entered address text from an observed page.
    if (typeof args.query === "string" || args.include_screenshot === true) {
      const final = await this.read({
        pid,
        window_id: windowId,
        ...(typeof args.query === "string" ? { query: args.query } : {}),
        include_screenshot: args.include_screenshot === true,
        max_results: args.max_results,
      });
      if (final.isError) return final;
      snapshot = final;
    }
    const verified = actual !== undefined && observed && sameDestination(actual, url.href);
    return result(
      {
        pid,
        window_id: windowId,
        requested_url: url.href,
        observed_url: actual ?? null,
        route: "native_address_bar",
        dom_available: false,
        dom_unavailable_reason: binding.structuredContent?.code ?? "no_exact_connected_tab",
        navigation_verified: verified,
        navigation_state: verified ? "verified" : observed && actual ? "redirected" : "unverified",
        verification: {
          address_matches: actual !== undefined && sameDestination(actual, url.href),
          page_observed: observed,
        },
        focus_may_change: true,
        observation: projectNativeObservation(snapshot?.structuredContent ?? {}, args),
      },
      snapshot,
    );
  }
}

export function executeNativeControlTool(
  name: string,
  args: Fields,
  invoke: NativeInvoke,
): Promise<NativeToolResult> {
  return new NativeControlActions(invoke).call(name, args);
}
