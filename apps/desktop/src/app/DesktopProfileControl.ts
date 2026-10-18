/**
 * Local profile-control requests travel only through Electron's userData-scoped
 * single-instance channel. The label is not an authentication capability: the
 * native channel and the already-selected userData directory own admission.
 * Keeping the complete selected profile in the receipt also makes a wrongly
 * routed or stale request harmless instead of treating an argv flag as proof.
 */
export const DESKTOP_RESTART_EXISTING_FLAG = "--cafe-restart-existing";

export interface DesktopProfileControlOwner {
  readonly dataProfile: "production" | "debug";
  readonly stateDir: string;
}

const PROFILE_CONTROL_PROTOCOL = "cafecode.profile-control.v1";
const requestKeys = ["protocol", "action", "dataProfile", "stateDir"] as const;

export function createDesktopRestartRequest(owner: DesktopProfileControlOwner) {
  return Object.freeze({
    protocol: PROFILE_CONTROL_PROTOCOL,
    action: "restart" as const,
    dataProfile: owner.dataProfile,
    stateDir: owner.stateDir,
  });
}

/** Reject unknown shapes without evaluating received getters or coercions. */
export function acceptsDesktopRestartRequest(
  received: unknown,
  owner: DesktopProfileControlOwner,
): boolean {
  try {
    if (typeof received !== "object" || received === null || Array.isArray(received)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(received);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(received);
    if (
      keys.length !== requestKeys.length ||
      keys.some((key) => !requestKeys.includes(key as (typeof requestKeys)[number]))
    ) {
      return false;
    }
    const values = requestKeys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(received, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    });
    return (
      values[0] === PROFILE_CONTROL_PROTOCOL &&
      values[1] === "restart" &&
      (values[2] === "production" || values[2] === "debug") &&
      values[2] === owner.dataProfile &&
      typeof values[3] === "string" &&
      values[3].length > 0 &&
      values[3].length <= 32_768 &&
      !values[3].includes("\0") &&
      values[3] === owner.stateDir
    );
  } catch {
    // Proxy/descriptor failures are not a reason to stop the current owner.
    return false;
  }
}

/** A control-only argument must not survive into the relaunched process. */
export function desktopRelaunchArguments(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  return argv.filter((argument) => argument !== DESKTOP_RESTART_EXISTING_FLAG);
}
