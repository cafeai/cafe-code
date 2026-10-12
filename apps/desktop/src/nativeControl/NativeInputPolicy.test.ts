import { expect, it, vi } from "vitest";
import { executeNativeControlTool } from "./NativeControlActions.ts";
import { nativeInputPolicyRefusal } from "./NativeInputPolicy.ts";

it.each([
  ["click", { delivery_mode: "foreground", pid: 1, window_id: 2 }],
  ["drag", { target: { kind: "desktop" } }],
  ["move_cursor", { scope: "desktop" }],
  ["bring_to_front", { pid: 1 }],
  ["browser_prepare", {}],
  ["launch_app", { activate: true }],
])("refuses background-only %s before native dispatch", async (name, args) => {
  const invoke = vi.fn();
  const result = await executeNativeControlTool(
    name as string,
    args as Record<string, unknown>,
    invoke,
    "background-only",
  );
  expect(result.structuredContent).toMatchObject({
    code: "input_policy_refused",
    effect: "refused",
  });
  expect(invoke).not.toHaveBeenCalled();
});
it("does not escalate definite background refusals under a stricter policy", async () => {
  const invoke = vi.fn().mockResolvedValue({
    content: [],
    isError: true,
    structuredContent: {
      code: "same_pid_keyboard_ambiguity",
      effect: "refused",
      pid: 1,
      window_id: 2,
    },
  });
  await executeNativeControlTool(
    "press_key",
    { pid: 1, window_id: 2, key: "return", observe_after: false },
    invoke,
    "background-only",
  );
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0]![1].delivery_mode).not.toBe("foreground");
});
it("permits observation and exact DOM navigation under background-only policy", () => {
  expect(
    nativeInputPolicyRefusal("background-only", "get_desktop_state", { scope: "desktop" }),
  ).toBeUndefined();
  expect(
    nativeInputPolicyRefusal("background-only", "open_url", { target_id: "t", tab_id: "a" }),
  ).toBeUndefined();
});
