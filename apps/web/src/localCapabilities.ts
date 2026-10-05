export interface LocalShellCapabilities {
  readonly canOpenLocalEditor: boolean;
  readonly canOpenLocalTerminal: boolean;
  readonly canOpenLocalPath: boolean;
  readonly canPickLocalFolder: boolean;
}

export function getLocalShellCapabilities(
  environmentId?: EnvironmentId | null,
): LocalShellCapabilities {
  const hasDesktopBridge =
    typeof window !== "undefined" &&
    Boolean(window.desktopBridge || window.nativeApi) &&
    (!environmentId || environmentId === readPrimaryEnvironmentDescriptor()?.environmentId);
  return {
    canOpenLocalEditor: hasDesktopBridge,
    canOpenLocalTerminal: hasDesktopBridge,
    canOpenLocalPath: hasDesktopBridge,
    canPickLocalFolder: hasDesktopBridge,
  };
}
import type { EnvironmentId } from "@cafecode/contracts";
import { readPrimaryEnvironmentDescriptor } from "./environments/primary";
