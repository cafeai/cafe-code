// Retain the local-shell entrypoint while sharing one accessible presentation
// between browser and Electron. Native menus cannot follow Cafe's color theme.
export { showContextMenu } from "./contextMenuView";
export { showContextMenu as showContextMenuFallback } from "./contextMenuView";
