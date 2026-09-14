import * as fs from "node:fs/promises";
import type { VirtualDesktopPrerequisites } from "@cafecode/contracts";
import { executable, nativeHelperReady } from "./nativeClient.ts";

async function helperStatus(helper: string): Promise<VirtualDesktopPrerequisites["helper"]> {
  try {
    if (!(await fs.stat(helper)).isFile()) return "unavailable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
  }
  // A present executable can still fail to load its shared libraries. Keep that
  // separate from a missing packaged component, and never publish loader output.
  return (await nativeHelperReady(helper)) ? "installed" : "unavailable";
}

/** Cached by the runtime owner; status polling must not launch helper probes. */
export async function checkDesktopPrerequisites(
  helper: string,
): Promise<VirtualDesktopPrerequisites> {
  const [sway, xwayland, dbus, helperResult] = await Promise.all([
    executable("sway"),
    executable("Xwayland"),
    executable("dbus-daemon"),
    helperStatus(helper),
  ]);
  return {
    sway: sway ? "installed" : "missing",
    xwayland: xwayland ? "installed" : "missing",
    dbus: dbus ? "installed" : "missing",
    helper: helperResult,
  };
}
