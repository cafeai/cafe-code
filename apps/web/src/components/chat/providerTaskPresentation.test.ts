import { describe, expect, it, vi } from "vitest";
import { readProviderTaskPresentation } from "./providerTaskPresentation";

describe("provider task presentation", () => {
  it.each([
    ["Agent: {}", "Agent task", "agent"],
    ["Task: { }", "Agent task", "agent"],
    ["bash: {\n\t}", "Shell command", "command"],
    ["{}", "Provider task", "tool"],
  ])("replaces only a complete empty native placeholder: %s", (detail, title, kind) => {
    expect(readProviderTaskPresentation({ payload: { detail }, summary: "Tool activity" })).toEqual(
      { title, kind },
    );
  });

  it.each([
    "Bash: echo '{}'",
    "Agent: review {} handling",
    "UnknownTool: {}",
    'Bash: {"command":"pwd"}',
    "<script>alert('inert text')</script>",
  ])("preserves meaningful public text and unfamiliar tool names: %s", (detail) => {
    expect(
      readProviderTaskPresentation({ payload: { detail }, summary: "Tool activity" }).title,
    ).toBe(detail);
  });

  it("uses canonical categories for bare or absent labels without inspecting inputs", () => {
    const input = vi.fn(() => {
      throw new Error("must not inspect arguments");
    });
    const data = { toolName: "Bash" };
    Object.defineProperty(data, "input", { get: input });
    expect(readProviderTaskPresentation({ payload: { detail: "{}", data }, summary: "" })).toEqual({
      title: "Shell command",
      kind: "command",
    });
    expect(
      readProviderTaskPresentation({
        payload: { itemType: "collab_agent_tool_call" },
        summary: "",
      }),
    ).toEqual({ title: "Agent task", kind: "agent" });
    expect(input).not.toHaveBeenCalled();
  });

  it("preserves public descriptions and an explicit presentation override", () => {
    expect(
      readProviderTaskPresentation({
        payload: { detail: "Review exact account ownership", data: { toolName: "Agent" } },
        summary: "Agent: {}",
      }),
    ).toEqual({ title: "Review exact account ownership", kind: "agent" });
    expect(
      readProviderTaskPresentation(
        { payload: { detail: "opaque bridge invocation" }, summary: "Tool activity" },
        "Inspecting the project",
      ).title,
    ).toBe("Inspecting the project");
  });

  it("bounds every lane's text and removes hidden controls while retaining script joiners", () => {
    expect(
      readProviderTaskPresentation({ payload: { detail: "x".repeat(600) }, summary: "" }).title,
    ).toHaveLength(300);
    expect(
      readProviderTaskPresentation({ payload: {}, summary: "y".repeat(600) }).title,
    ).toHaveLength(300);
    expect(
      readProviderTaskPresentation({ payload: {}, summary: "" }, "z".repeat(600)).title,
    ).toHaveLength(300);
    expect(
      readProviderTaskPresentation({
        payload: { detail: "\u001bReview\u202e ownership\u2066 \u200c\u200d" },
        summary: "",
      }).title,
    ).toBe("Review ownership \u200c\u200d");
  });

  it("ignores inherited, accessor and non-string display fields without invoking coercion", () => {
    const getter = vi.fn(() => {
      throw new Error("must not read accessors");
    });
    const payload = Object.create({ detail: "inherited description" });
    Object.defineProperty(payload, "detail", { get: getter });
    Object.defineProperty(payload, "data", { get: getter });
    const activity = { payload, summary: "Visible summary" };
    expect(readProviderTaskPresentation(activity).title).toBe("Visible summary");
    Object.defineProperty(activity, "payload", { get: getter });
    Object.defineProperty(activity, "summary", { get: getter });
    expect(readProviderTaskPresentation(activity)).toEqual({
      title: "Provider task",
      kind: "tool",
    });
    const toString = vi.fn(() => {
      throw new Error("must not coerce objects");
    });
    expect(
      readProviderTaskPresentation({ payload: { detail: { toString } }, summary: "Public summary" })
        .title,
    ).toBe("Public summary");
    expect(getter).not.toHaveBeenCalled();
    expect(toString).not.toHaveBeenCalled();
  });
});
