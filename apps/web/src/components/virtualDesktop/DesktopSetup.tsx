import { CheckCircle2Icon, ChevronRightIcon, CircleAlertIcon, RefreshCwIcon } from "lucide-react";
import type { VirtualDesktopPrerequisites } from "@cafecode/contracts";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { InfoTip } from "../ui/info-tip";
import { Spinner } from "../ui/spinner";

const components = [
  { id: "sway", name: "Sway", description: "Runs the virtual desktop." },
  { id: "xwayland", name: "Xwayland", description: "Supports X11 applications." },
  { id: "dbus", name: "D-Bus", description: "Provides app services." },
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
    <ul className="divide-y divide-border-subtle" aria-label="Required desktop components">
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
                    ? "Update or reinstall Cafe, then restart it."
                    : "Check Cafe's required system libraries, or update or reinstall Cafe and restart it."}
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
        <Collapsible>
          <CollapsibleTrigger className="focus-ring group flex items-center gap-1.5 rounded-sm text-sm font-medium">
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 text-muted-foreground transition-transform duration-(--duration-fast) ease-out group-data-panel-open:rotate-90"
            />
            Required components installed
          </CollapsibleTrigger>
          <CollapsiblePanel>{checklist}</CollapsiblePanel>
        </Collapsible>
      ) : (
        <>
          <p className="text-sm font-medium">Finish setting up virtual desktops</p>
          <p className="text-xs text-muted-foreground">
            Needed on the Linux computer running this Cafe environment.{" "}
            <InfoTip label="About desktop requirements">
              You can keep your current desktop environment and X11 or Wayland session.
            </InfoTip>
          </p>
          {checklist}
          {missingPackages && (
            <p className="text-xs text-muted-foreground">
              Install the missing system components with your package manager, then Check again.{" "}
              <InfoTip label="About package names">
                Package names vary between Linux distributions.
              </InfoTip>
            </p>
          )}
          {!prerequisites && (
            <p className="text-xs text-muted-foreground">
              Component details are unavailable. Check again, or restart Cafe to update it.
            </p>
          )}
        </>
      )}
      {!available && reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      <Button size="sm" variant="outline" disabled={busy} onClick={onRecheck}>
        {/* The spinner takes the icon's place so the label and width stay put. */}
        {busy ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
        Check again
      </Button>
    </div>
  );
}
