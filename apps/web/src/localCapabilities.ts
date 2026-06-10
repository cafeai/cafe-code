export interface LocalShellCapabilities {
  readonly canOpenLocalEditor: boolean;
  readonly canOpenLocalTerminal: boolean;
  readonly canOpenLocalPath: boolean;
  readonly canPickLocalFolder: boolean;
}

export function getLocalShellCapabilities(): LocalShellCapabilities {
  const hasDesktopBridge =
    typeof window !== "undefined" && Boolean(window.desktopBridge || window.nativeApi);
  return {
    canOpenLocalEditor: hasDesktopBridge,
    canOpenLocalTerminal: hasDesktopBridge,
    canOpenLocalPath: hasDesktopBridge,
    canPickLocalFolder: hasDesktopBridge,
  };
}
