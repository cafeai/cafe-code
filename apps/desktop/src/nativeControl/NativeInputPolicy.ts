import {
  nativeControlError,
  type NativeToolResult,
  type ComputerInputPolicy,
} from "@cafecode/shared/nativeControl";

/** Host policy is checked on every native subcall, including composites and
 * recovery. A request may tighten it but can never permit a host-denied route. */
export function nativeInputPolicyRefusal(
  policy: ComputerInputPolicy,
  name: string,
  args: Record<string, unknown>,
): NativeToolResult | undefined {
  if (policy !== "background-only") return;
  if (
    name === "get_desktop_state" ||
    name === "get_window_state" ||
    name.startsWith("list_") ||
    name.startsWith("get_browser_")
  )
    return;
  const target = args.target as Record<string, unknown> | undefined;
  if (
    args.delivery_mode === "foreground" ||
    args.scope === "desktop" ||
    target?.kind === "desktop" ||
    name === "bring_to_front" ||
    name === "browser_prepare" ||
    name === "invoke_menu" ||
    args.activate === true ||
    (name === "open_url" && !(args.target_id && args.tab_id))
  ) {
    return {
      ...nativeControlError(
        "Background-only policy refused a route that can activate an app or use the system pointer. Use a background route or change the user policy.",
      ),
      structuredContent: { code: "input_policy_refused", effect: "refused", input_policy: policy },
    };
  }
}
