import { desktopError } from "./nativeClient.ts";

export const swayRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, length = 160) =>
  typeof value === "string" ? value.slice(0, length) : "";
const number = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : 0;
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function boundedSwayResult<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024)
    throw desktopError(
      "operation_failed",
      "Compositor state exceeds the 64 KiB result limit. Query a smaller tree using containerId.",
    );
  return value;
}

/** GET_TREE distinguishes containers from app windows, and floating_nodes from
 * tiling children. Keep parent/workspace context while traversing both. Use
 * Sway's visible field: geometry/focus cannot infer tab, fullscreen or scratchpad
 * visibility. https://github.com/swaywm/sway/blob/1.12/sway/sway-ipc.7.scd */
export function describeSwayTree(tree: unknown) {
  type Container = {
    id: number;
    parentId: number | null;
    type: string;
    layout: string;
    parentLayout: string | null;
    workspaceId: number | null;
    workspace: string | null;
    focused: boolean;
    floating: boolean;
    fullscreenMode: number;
    scratchpadState: string;
    hiddenInScratchpad: boolean;
    sticky: boolean;
    urgent: boolean;
    marks: string[];
    x: number;
    y: number;
    width: number;
    height: number;
  };
  const containers: Container[] = [];
  const windows: Array<
    Container & { title: string; appId: string; visible: boolean | null; pid: number | null }
  > = [];
  let truncated = false;
  const visit = (value: unknown, parent: Container | null, floating: boolean, depth: number) => {
    if (depth > 32 || containers.length >= 512 || windows.length >= 128) {
      truncated = true;
      return;
    }
    const node = swayRecord(value),
      rect = swayRecord(node.rect),
      nodeId = number(node.id);
    if (nodeId <= 0) return;
    const isWorkspace = node.type === "workspace";
    const workspace = isWorkspace ? text(node.name) : (parent?.workspace ?? null);
    const container: Container = {
      id: nodeId,
      parentId: parent?.id ?? null,
      type: text(node.type),
      layout: text(node.layout),
      parentLayout: parent?.layout ?? null,
      workspaceId: isWorkspace ? nodeId : (parent?.workspaceId ?? null),
      workspace,
      focused: node.focused === true,
      floating: floating || node.floating === "user_on" || node.floating === "auto_on",
      fullscreenMode: number(node.fullscreen_mode),
      scratchpadState: text(node.scratchpad_state) || parent?.scratchpadState || "none",
      hiddenInScratchpad: workspace === "__i3_scratch",
      sticky: node.sticky === true,
      urgent: node.urgent === true,
      marks: array(node.marks)
        .slice(0, 32)
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.slice(0, 160)),
      x: number(rect.x),
      y: number(rect.y),
      width: number(rect.width),
      height: number(rect.height),
    };
    containers.push(container);
    if (node.app_id || number(node.window) > 0 || (node.type === "con" && number(node.pid) > 0))
      windows.push({
        ...container,
        title: text(node.name, 512),
        appId: text(node.app_id ?? swayRecord(node.window_properties).class),
        visible: typeof node.visible === "boolean" ? node.visible : null,
        pid: number(node.pid) || null,
      });
    for (const field of ["nodes", "floating_nodes"])
      for (const child of array(node[field]))
        visit(child, container, floating || field === "floating_nodes", depth + 1);
  };
  visit(tree, null, false, 0);
  return { windows, containers, truncated };
}

export function swaySubtree(tree: unknown, id: number): unknown {
  let visited = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 32 || ++visited > 4096) return undefined;
    const node = swayRecord(value);
    if (node.id === id) return value;
    for (const field of ["nodes", "floating_nodes"])
      for (const child of array(node[field])) {
        const found = visit(child, depth + 1);
        if (found !== undefined) return found;
      }
    return undefined;
  };
  const result = visit(tree, 0);
  if (result === undefined)
    throw desktopError(
      "not_found",
      "The container no longer exists. Inspect windows or workspaces again.",
    );
  return result;
}
