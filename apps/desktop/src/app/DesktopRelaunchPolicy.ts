/** The native source host owns the next child only after graceful finalization.
 * Packaged releases retain Electron's own relaunch even with inherited flags. */
export function usesDesktopRestartSupervisor(input: {
  readonly isDevelopment: boolean;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly nativeHostVersion: string | undefined;
}): boolean {
  return (
    input.isDevelopment ||
    (!input.isPackaged && input.platform === "darwin" && input.nativeHostVersion === "1")
  );
}
