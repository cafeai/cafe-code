import type { NativeControlPermissionsState } from "@cafecode/contracts";

export type NativePermission = "accessibility" | "screen-recording";

export interface NativePermissionPromptDependencies {
  readonly platform: string;
  readonly read: () => NativeControlPermissionsState;
  readonly enabled: () => Promise<boolean>;
  readonly choose: (state: NativeControlPermissionsState) => Promise<NativePermission | null>;
  readonly request: (permission: NativePermission) => Promise<void>;
  readonly openSettings: (permission: NativePermission) => Promise<void>;
}

export function missingNativePermissions(state: NativeControlPermissionsState): NativePermission[] {
  return [
    ...(state.accessibility === "granted" ? [] : ["accessibility" as const]),
    ...(state.screenRecording === "granted" ? [] : ["screen-recording" as const]),
  ];
}

/** Trusted desktop UI only. Model health calls never prompt or request grants. */
export class NativePermissionPrompt {
  private automaticShown = false;
  private pending: Promise<NativeControlPermissionsState> | undefined;
  private closed = false;
  private readonly dependencies: NativePermissionPromptDependencies;

  constructor(dependencies: NativePermissionPromptDependencies) {
    this.dependencies = dependencies;
  }

  state(): NativeControlPermissionsState {
    if (this.dependencies.platform !== "darwin")
      return {
        platform: this.dependencies.platform,
        accessibility: "unknown",
        screenRecording: "unknown",
      };
    return this.dependencies.read();
  }

  prompt(automatic = false): Promise<NativeControlPermissionsState> {
    if (this.pending) return this.pending;
    const pending = this.run(automatic).finally(() => {
      if (this.pending === pending) this.pending = undefined;
    });
    this.pending = pending;
    return pending;
  }

  close(): void {
    this.closed = true;
  }

  private async canPrompt(): Promise<boolean> {
    if (this.closed || this.dependencies.platform !== "darwin") return false;
    const enabled = await this.dependencies.enabled();
    return enabled && !this.closed;
  }

  private async run(automatic: boolean): Promise<NativeControlPermissionsState> {
    if (!(await this.canPrompt())) return this.state();
    const state = this.state();
    if (!missingNativePermissions(state).length || (automatic && this.automaticShown)) return state;
    this.automaticShown = true;
    const choice = await this.dependencies.choose(state);
    // A grant may have changed in System Settings while the popup was open.
    // Turning control off or quitting also wins before any native request.
    if (!choice || !(await this.canPrompt())) return this.state();
    if (!missingNativePermissions(this.state()).includes(choice)) return this.state();
    await this.dependencies.request(choice);
    if ((await this.canPrompt()) && missingNativePermissions(this.state()).includes(choice))
      await this.dependencies.openSettings(choice);
    return this.state();
  }
}
