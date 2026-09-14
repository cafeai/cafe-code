import { CheckCircle2Icon, CircleAlertIcon, RefreshCwIcon } from "lucide-react";
import type { VirtualDesktopPrerequisites } from "@cafecode/contracts";
import { Button } from "../ui/button";

const components = [
  { id: "sway", name: "Sway", description: "Runs the virtual desktop." },
  { id: "xwayland", name: "Xwayland", description: "Supports X11 applications." },
  { id: "dbus", name: "D-Bus", description: "Provides application services through dbus-daemon." },
  { id: "helper", name: "Cafe desktop component", description: "Included with Cafe for Linux." },
] as const;

export function DesktopSetup({
  prerequisites,
  available,
  reason,
  busy,
  onRecheck,
}: {
  prerequisites: VirtualDesktopPrerequisites | undefined;
  available: boolean;
  reason: string | null;
  busy: boolean;
  onRecheck: () => void;
}) {
  const installed =
    prerequisites && components.every(({ id }) => prerequisites[id] === "installed");
  const missingPackages =
    prerequisites &&
    components.some(({ id }) => id !== "helper" && prerequisites[id] !== "installed");
  const checklist = prerequisites ? (
    <ul className="divide-y divide-border/60" aria-label="Required desktop components">
      {components.map(({ id, name, description }) => {
        const status = prerequisites[id];
        const ready = status === "installed";
        const Icon = ready ? CheckCircle2Icon : CircleAlertIcon;
        return (
          <li key={id} className="flex items-start gap-2.5 py-3">
            <Icon
              aria-hidden
              className={`mt-0.5 size-4 shrink-0 ${ready ? "text-muted-foreground" : "text-warning-foreground"}`}
            />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
                <span className="font-medium">{name}</span>
                <span className={ready ? "text-muted-foreground" : "text-warning-foreground"}>
                  {ready
                    ? id === "helper"
                      ? "Included"
                      : "Installed"
                    : status === "missing"
                      ? "Missing"
                      : "Unable to run"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{description}</p>
              {id === "helper" && !ready && (
                <p className="text-xs text-muted-foreground">
                  {status === "missing"
                    ? "This Cafe installation is missing its desktop component. Update or reinstall Cafe, then restart it."
                    : "Cafe's desktop component could not run. Check that Cafe's required system libraries are installed; if the problem persists, update or reinstall Cafe and restart it."}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  ) : null;
  return (
    <div className="space-y-3">
      {installed ? (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Required components installed
          </summary>
          {checklist}
        </details>
      ) : (
        <>
          <p className="text-sm font-medium">Finish setting up virtual desktops</p>
          <p className="text-xs text-muted-foreground">
            These components are needed on the Linux computer running this Cafe environment. You can
            keep using your current desktop environment and X11 or Wayland session.
          </p>
          {checklist}
          {missingPackages && (
            <p className="text-xs text-muted-foreground">
              Install the missing system components using your Linux distribution's package manager.
              Package names vary between distributions. Then select Check again.
            </p>
          )}
          {!prerequisites && (
            <p className="text-xs text-muted-foreground">
              Component details are unavailable. Select Check again; if details are still missing,
              restart Cafe to update its desktop runtime.
            </p>
          )}
        </>
      )}
      {!available && reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      <Button size="sm" variant="outline" disabled={busy} onClick={onRecheck}>
        <RefreshCwIcon className={busy ? "animate-spin" : ""} />
        {busy ? "Checking…" : "Check again"}
      </Button>
    </div>
  );
}
