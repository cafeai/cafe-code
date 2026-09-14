import { z } from "zod";
import { desktopError } from "./nativeClient.ts";
import type { describeSwayTree } from "./swayState.ts";

const id = z.number().int().positive().safe();
const direction = z.enum(["left", "right", "up", "down"]);
const size = z.number().int().min(1).max(16384);
// Structured workspace names deliberately exclude Sway syntax and expansion.
// Advanced names/commands remain available through the explicit raw tool.
const workspaceName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N} _.:+-]+$/u)
  .refine(
    (v) =>
      v.trim() === v &&
      !v.startsWith("__") &&
      !v.startsWith("-") &&
      ![
        "next",
        "prev",
        "current",
        "back_and_forth",
        "next_on_output",
        "prev_on_output",
        "number",
      ].includes(v.toLowerCase()),
  );
export const focusInput = {
  windowId: id.optional(),
  direction: z
    .enum(["left", "right", "up", "down", "next", "prev", "parent", "child", "tiling", "floating"])
    .optional(),
};
export const windowInput = {
  windowId: id,
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("fullscreen"), enabled: z.boolean() }).strict(),
    z.object({ type: z.literal("floating"), enabled: z.boolean() }).strict(),
    z.object({ type: z.literal("sticky"), enabled: z.boolean() }).strict(),
    z
      .object({ type: z.literal("resize"), width: size.optional(), height: size.optional() })
      .strict(),
    z.object({ type: z.literal("move"), direction }).strict(),
    z
      .object({
        type: z.literal("position"),
        x: z.number().int().min(-32768).max(32767),
        y: z.number().int().min(-32768).max(32767),
      })
      .strict(),
    z.object({ type: z.literal("swap"), otherWindowId: id }).strict(),
    z.object({ type: z.literal("center") }).strict(),
    z.object({ type: z.literal("close") }).strict(),
    z.object({ type: z.literal("hide") }).strict(),
    z.object({ type: z.literal("restore") }).strict(),
  ]),
};
export const layoutInput = {
  containerId: id,
  action: z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("set"),
        layout: z.enum(["splith", "splitv", "tabbed", "stacking", "default"]),
      })
      .strict(),
    z
      .object({ type: z.literal("split"), direction: z.enum(["horizontal", "vertical", "none"]) })
      .strict(),
  ]),
};
export const workspaceInput = {
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("switch"), name: workspaceName }).strict(),
    z
      .object({
        type: z.literal("navigate"),
        direction: z.enum(["next", "prev", "back_and_forth"]),
      })
      .strict(),
    z.object({ type: z.literal("move"), windowId: id, name: workspaceName }).strict(),
    z.object({ type: z.literal("rename"), name: workspaceName, newName: workspaceName }).strict(),
  ]),
};
export const swayCommandInput = {
  command: z
    .string()
    .min(1)
    .max(8192)
    .refine((v) => !v.includes("\0") && Buffer.byteLength(v) <= 8192),
};
export const swayQueryInput = {
  query: z.enum([
    "tree",
    "workspaces",
    "outputs",
    "marks",
    "inputs",
    "seats",
    "version",
    "binding_modes",
    "binding_state",
  ]),
  containerId: id.optional(),
};
export const swayQueryTypes = {
  tree: 4,
  workspaces: 1,
  outputs: 3,
  marks: 5,
  inputs: 100,
  seats: 101,
  version: 7,
  binding_modes: 8,
  binding_state: 12,
} as const;

function decode<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success)
    throw desktopError(
      "invalid_request",
      "Invalid desktop tool arguments. Follow the tool's schema; structured workspace names use letters, numbers, spaces, _ . : + or -.",
    );
  return parsed.data;
}
export const decodeSwayQuery = (args: unknown) => {
  const value = decode(z.object(swayQueryInput).strict(), args);
  if (value.containerId !== undefined && value.query !== "tree")
    throw desktopError("invalid_request", "containerId is only supported for tree queries.");
  return value;
};

export interface SwayCommand {
  command: string;
  windowIds: number[];
  containerIds: number[];
  layoutTarget?: number;
  restoreTarget?: number;
}
const result = (
  command: string,
  windowIds: number[] = [],
  containerIds: number[] = [],
): SwayCommand => ({ command, windowIds, containerIds });
const target = (windowId: number, command: string, other: number[] = []) =>
  result(`[con_id=${windowId}] ${command}`, [windowId, ...other]);

/** In Sway 1.12 cmd_layout always operates on the selected container's parent,
 * and criteria never match workspace nodes. Select a direct tiling child when
 * Cafe's caller targets a group/workspace. Sway may wrap/flatten the group, so
 * callers must re-read IDs after layout changes. No focus-changing command chain.
 * https://github.com/swaywm/sway/blob/1.12/sway/commands/layout.c */
export function resolveSwayCommand(
  command: SwayCommand,
  state: ReturnType<typeof describeSwayTree>,
): string {
  if (command.layoutTarget === undefined) return command.command;
  const container = state.containers.find((c) => c.id === command.layoutTarget);
  if (!container || container.floating || container.hiddenInScratchpad)
    throw desktopError(
      "invalid_request",
      "Choose a tiling window, split container, or workspace for layout changes.",
    );
  const child = state.containers.find((c) => c.parentId === container.id && !c.floating);
  if (container.type === "workspace" && !child) {
    if (!container.focused)
      throw desktopError(
        "invalid_request",
        "Switch to this empty workspace before setting its layout.",
      );
    return command.command.replace(/^\[con_id=\d+\] /, "");
  }
  return child
    ? command.command.replace(/^\[con_id=\d+\]/, `[con_id=${child.id}]`)
    : command.command;
}

/** Sway 1.12 sway(5): criteria persist across commas, and semicolons reset them.
 * Build fixed syntax from validated numbers/enums; never interpolate an app title.
 * https://github.com/swaywm/sway/blob/1.12/sway/sway.5.scd */
export function buildSwayCommand(name: string, args: unknown): SwayCommand | undefined {
  if (name === "sway_command")
    return result(decode(z.object(swayCommandInput).strict(), args).command);
  if (name === "focus") {
    const value = decode(z.object(focusInput).strict(), args);
    if ((value.windowId === undefined) === (value.direction === undefined))
      throw desktopError("invalid_request", "Choose exactly one windowId or focus direction.");
    return value.windowId === undefined
      ? result(`focus ${value.direction}`)
      : target(value.windowId, "focus");
  }
  if (name === "layout") {
    const { containerId, action } = decode(z.object(layoutInput).strict(), args);
    return {
      ...result(
        `[con_id=${containerId}] ${action.type === "set" ? `layout ${action.layout}` : `split ${action.direction}`}`,
        [],
        [containerId],
      ),
      ...(action.type === "set" ? { layoutTarget: containerId } : {}),
    };
  }
  if (name === "workspace") {
    const { action } = decode(z.object(workspaceInput).strict(), args);
    switch (action.type) {
      case "switch":
        return result(`workspace --no-auto-back-and-forth "${action.name}"`);
      case "navigate":
        return result(`workspace ${action.direction}`);
      case "move":
        return target(
          action.windowId,
          `move --no-auto-back-and-forth container to workspace "${action.name}"`,
        );
      case "rename":
        return result(`rename workspace "${action.name}" to "${action.newName}"`);
    }
  }
  if (name !== "window") return undefined;
  const { windowId, action } = decode(z.object(windowInput).strict(), args);
  switch (action.type) {
    case "fullscreen":
    case "floating":
    case "sticky":
      return target(windowId, `${action.type} ${action.enabled ? "enable" : "disable"}`);
    case "resize":
      if (action.width === undefined && action.height === undefined)
        throw desktopError("invalid_request", "Resize requires width or height in pixels.");
      return target(
        windowId,
        `resize set width ${action.width ?? 0} px height ${action.height ?? 0} px`,
      );
    case "move":
      return target(windowId, `move ${action.direction}`);
    case "position":
      return target(windowId, `move position ${action.x} px ${action.y} px`);
    case "swap":
      return target(windowId, `swap container with con_id ${action.otherWindowId}`, [
        action.otherWindowId,
      ]);
    case "center":
      return target(windowId, "move position center");
    case "close":
      return target(windowId, "kill");
    case "hide":
      return target(windowId, "move scratchpad");
    // The worker checks hidden state immediately before dispatch because plain
    // scratchpad show toggles, and Sway workspace criteria exclude scratchpads.
    case "restore":
      return { ...target(windowId, "scratchpad show"), restoreTarget: windowId };
  }
}
