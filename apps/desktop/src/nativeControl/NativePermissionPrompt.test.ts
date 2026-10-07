import type { NativeControlPermissionsState } from "@cafecode/contracts";
import { describe, expect, it, vi } from "vitest";
import { NativePermissionPrompt, type NativePermission } from "./NativePermissionPrompt.ts";

function fixture(platform = "darwin") {
  let enabled = true;
  let state: NativeControlPermissionsState = {
    platform,
    accessibility: "missing",
    screenRecording: "granted",
  };
  const dependencies = {
    platform,
    read: vi.fn(() => state),
    enabled: vi.fn(async () => enabled),
    choose: vi.fn(
      async (_state: NativeControlPermissionsState): Promise<NativePermission | null> => null,
    ),
    request: vi.fn(async (_permission: NativePermission) => {}),
    openSettings: vi.fn(async (_permission: NativePermission) => {}),
  };
  return {
    prompt: new NativePermissionPrompt(dependencies),
    dependencies,
    disable: () => {
      enabled = false;
    },
    grant: () => {
      state = { ...state, accessibility: "granted" };
    },
  };
}

describe("trusted Mac computer-use permission prompts", () => {
  it("checks without prompting, suppresses automatic dismissal retries, and permits an explicit retry", async () => {
    const f = fixture();
    expect(f.prompt.state().accessibility).toBe("missing");
    expect(f.dependencies.choose).not.toHaveBeenCalled();
    await f.prompt.prompt(true);
    await f.prompt.prompt(true);
    expect(f.dependencies.choose).toHaveBeenCalledTimes(1);
    await f.prompt.prompt();
    expect(f.dependencies.choose).toHaveBeenCalledTimes(2);
    expect(f.dependencies.request).not.toHaveBeenCalled();
    expect(f.dependencies.openSettings).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux"])("never touches Mac APIs or dialogs on %s", async (platform) => {
    const f = fixture(platform);
    await f.prompt.prompt();
    expect(f.dependencies.read).not.toHaveBeenCalled();
    expect(f.dependencies.enabled).not.toHaveBeenCalled();
    expect(f.dependencies.choose).not.toHaveBeenCalled();
    expect(f.dependencies.request).not.toHaveBeenCalled();
  });

  it("does not prompt for disabled control or already-granted permissions", async () => {
    const disabled = fixture();
    disabled.disable();
    await disabled.prompt.prompt();
    expect(disabled.dependencies.choose).not.toHaveBeenCalled();
    const granted = fixture();
    granted.grant();
    await granted.prompt.prompt();
    expect(granted.dependencies.choose).not.toHaveBeenCalled();
  });

  it.each(["disable", "close", "grant"] as const)(
    "joins concurrent prompts and rechecks %s before requesting",
    async (change) => {
      const f = fixture();
      let accept!: (permission: NativePermission) => void;
      f.dependencies.choose.mockImplementation(
        () =>
          new Promise((resolve) => {
            accept = resolve;
          }),
      );
      const first = f.prompt.prompt(true);
      const second = f.prompt.prompt();
      expect(second).toBe(first);
      await vi.waitFor(() => expect(f.dependencies.choose).toHaveBeenCalledTimes(1));
      if (change === "disable") f.disable();
      else if (change === "close") f.prompt.close();
      else f.grant();
      accept("accessibility");
      await Promise.all([first, second]);
      expect(f.dependencies.request).not.toHaveBeenCalled();
      expect(f.dependencies.openSettings).not.toHaveBeenCalled();
    },
  );

  it("opens only the selected missing permission and stops once it is granted", async () => {
    const f = fixture();
    f.dependencies.choose.mockResolvedValue("accessibility");
    await f.prompt.prompt();
    expect(f.dependencies.request).toHaveBeenCalledExactlyOnceWith("accessibility");
    expect(f.dependencies.openSettings).toHaveBeenCalledExactlyOnceWith("accessibility");
    f.dependencies.request.mockImplementation(async () => {
      f.grant();
    });
    await f.prompt.prompt();
    expect(f.dependencies.openSettings).toHaveBeenCalledTimes(1);
    await f.prompt.prompt();
    expect(f.dependencies.choose).toHaveBeenCalledTimes(2);
  });
});
