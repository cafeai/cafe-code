import { describe, expect, it } from "vitest";
import { buildSwayCommand, decodeSwayQuery, resolveSwayCommand } from "./swayTools.ts";
import { boundedSwayResult, describeSwayTree, swaySubtree } from "./swayState.ts";

describe("Sway tool boundaries", () => {
  it("uses exact window/container selectors and unambiguous pixel sizes", () => {
    expect(
      buildSwayCommand("window", { windowId: 6, action: { type: "resize", height: 500 } }),
    ).toEqual({
      command: "[con_id=6] resize set width 0 px height 500 px",
      windowIds: [6],
      containerIds: [],
    });
    expect(
      buildSwayCommand("window", { windowId: 6, action: { type: "swap", otherWindowId: 8 } })
        ?.windowIds,
    ).toEqual([6, 8]);
    expect(
      buildSwayCommand("layout", { containerId: 2, action: { type: "set", layout: "tabbed" } }),
    ).toEqual({
      command: "[con_id=2] layout tabbed",
      windowIds: [],
      containerIds: [2],
      layoutTarget: 2,
    });
    expect(
      buildSwayCommand("workspace", {
        action: { type: "rename", name: "1: 日本語", newName: "Work + notes" },
      })?.command,
    ).toBe('rename workspace "1: 日本語" to "Work + notes"');
    expect(buildSwayCommand("focus", { direction: "parent" })?.command).toBe("focus parent");
  });
  it("rejects injection, ambiguous actions and socket overrides at the runtime boundary", () => {
    for (const name of [
      'x"; exec touch /tmp/escape',
      "$var",
      "x\\y",
      "__i3_scratch",
      "next",
      "x\nexit",
      " leading",
      " ",
    ])
      expect(() => buildSwayCommand("workspace", { action: { type: "switch", name } })).toThrow();
    for (const windowId of [-1, 1.2, Number.MAX_SAFE_INTEGER + 1, "6] kill"])
      expect(() => buildSwayCommand("window", { windowId, action: { type: "close" } })).toThrow();
    for (const args of [{}, { windowId: 1, direction: "parent" }, { windowId: 1, socket: "/host" }])
      expect(() => buildSwayCommand("focus", args)).toThrow();
    expect(() => buildSwayCommand("window", { windowId: 1, action: { type: "resize" } })).toThrow();
    expect(() => buildSwayCommand("sway_command", { command: "nop", socket: "/host" })).toThrow();
    expect(() => buildSwayCommand("sway_command", { command: "nop\0exit" })).toThrow();
    expect(() => buildSwayCommand("sway_command", { command: "日".repeat(3000) })).toThrow();
    expect(() => decodeSwayQuery({ query: "subscribe" })).toThrow();
    expect(() => decodeSwayQuery({ query: "workspaces", containerId: 1 })).toThrow();
    expect(() => decodeSwayQuery({ query: "tree", socket: "/host" })).toThrow();
  });
  it("preserves deliberately unrestricted fallback syntax without pretending it is structured argv", () => {
    const command = 'exec printf "hello"; [con_id=6] fullscreen enable; exit';
    expect(buildSwayCommand("sway_command", { command })).toEqual({
      command,
      windowIds: [],
      containerIds: [],
    });
  });
});

describe("Sway state", () => {
  const app = (id: number, extra: Record<string, unknown> = {}) => ({
    id,
    type: "con",
    pid: 123,
    app_id: "terminal",
    name: "Window",
    visible: false,
    ...extra,
  });
  const tree = {
    id: 1,
    type: "root",
    nodes: [
      {
        id: 2,
        type: "output",
        nodes: [
          {
            id: 3,
            type: "workspace",
            name: "1",
            layout: "tabbed",
            nodes: [app(4), app(5, { focused: true, visible: true, fullscreen_mode: 1 })],
            floating_nodes: [
              app(6, { floating: "user_on", scratchpad_state: "fresh", visible: true }),
            ],
          },
          {
            id: 7,
            type: "workspace",
            name: "__i3_scratch",
            floating_nodes: [
              {
                id: 8,
                type: "con",
                layout: "tabbed",
                scratchpad_state: "fresh",
                nodes: [
                  app(9, { app_id: null, window: 456, window_properties: { class: "XTerm" } }),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  it("reports hidden tabs, fullscreen, floating, Xwayland and nested scratchpad membership", () => {
    const state = describeSwayTree(tree);
    expect(state.truncated).toBe(false);
    expect(state.windows.find((w) => w.id === 4)).toMatchObject({
      parentId: 3,
      parentLayout: "tabbed",
      workspaceId: 3,
      workspace: "1",
      visible: false,
      floating: false,
    });
    expect(state.windows.find((w) => w.id === 5)).toMatchObject({
      fullscreenMode: 1,
      focused: true,
      visible: true,
    });
    expect(state.windows.find((w) => w.id === 6)).toMatchObject({
      floating: true,
      hiddenInScratchpad: false,
      scratchpadState: "fresh",
    });
    expect(state.windows.find((w) => w.id === 9)).toMatchObject({
      parentId: 8,
      floating: true,
      appId: "XTerm",
      hiddenInScratchpad: true,
      scratchpadState: "fresh",
    });
    expect(swaySubtree(tree, 8)).toHaveProperty("nodes");
    expect(() => swaySubtree(tree, 999)).toThrow();
    expect(
      resolveSwayCommand(
        buildSwayCommand("layout", { containerId: 3, action: { type: "set", layout: "tabbed" } })!,
        state,
      ),
    ).toBe("[con_id=4] layout tabbed");
    expect(() =>
      resolveSwayCommand(
        buildSwayCommand("layout", { containerId: 6, action: { type: "set", layout: "tabbed" } })!,
        state,
      ),
    ).toThrow();
  });
  it("bounds traversal and result bytes without fabricating missing state", () => {
    const state = describeSwayTree({
      id: 1,
      type: "root",
      nodes: Array.from({ length: 200 }, (_, i) => app(i + 2)),
    });
    expect(state.windows).toHaveLength(128);
    expect(state.truncated).toBe(true);
    expect(() => boundedSwayResult({ name: "x".repeat(65536) })).toThrow();
    expect(boundedSwayResult({ ok: true })).toEqual({ ok: true });
  });
});
