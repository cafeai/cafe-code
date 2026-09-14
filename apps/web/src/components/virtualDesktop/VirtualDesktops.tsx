import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  EllipsisIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import type { EnvironmentId, ThreadId, VirtualDesktopSnapshot } from "@cafecode/contracts";
import { usePrimaryEnvironmentId } from "~/environments/primary";
import { useServerSettings } from "~/rpc/serverState";
import { useStore } from "~/store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Badge } from "../ui/badge";
import { Dialog, DialogPopup, DialogTitle, DialogDescription, DialogHeader } from "../ui/dialog";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../ui/menu";
import { SidebarMenuItem, SidebarMenuButton } from "../ui/sidebar";
import { useVirtualDesktops } from "./useVirtualDesktops";
import { DesktopPreview } from "./DesktopPreview";
import { DesktopSetup } from "./DesktopSetup";
import { DesktopSessionDialog } from "./DesktopSessionDialog";

function desktopStatus(desktop: VirtualDesktopSnapshot) {
  if (desktop.state === "stopped" || desktop.state === "terminating") return "Ending";
  if (desktop.state !== "ready") return desktop.state[0]!.toUpperCase() + desktop.state.slice(1);
  return desktop.humanControl
    ? "You have control"
    : desktop.controllingThreadId
      ? "Codex working"
      : "Ready";
}
function DesktopRow({
  desktop,
  controls,
  environmentId,
  revision,
  onOpenThread,
}: {
  desktop: VirtualDesktopSnapshot;
  controls: ReturnType<typeof useVirtualDesktops>;
  environmentId: EnvironmentId;
  revision: number;
  onOpenThread?: () => void;
}) {
  const [name, setName] = useState(desktop.name);
  const [renaming, setRenaming] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [details, setDetails] = useState(false);
  const thread = useStore((state) =>
    desktop.controllingThreadId
      ? state.environmentStateById[environmentId]?.threadShellById[desktop.controllingThreadId]
      : undefined,
  );
  const canOpen = controls.local && controls.data?.enabled && desktop.state === "ready";
  return (
    <article className="overflow-hidden rounded-xl border border-border bg-card">
      <DesktopPreview
        environmentId={environmentId}
        id={desktop.id}
        name={desktop.name}
        enabled={Boolean(controls.data?.enabled && desktop.state === "ready")}
        revision={revision}
      />
      <div className="space-y-3 p-4">
        {renaming ? (
          <form
            className="flex min-w-0 flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void controls
                .change({ operation: "rename", id: desktop.id, name: name.trim() })
                .then((ok) => {
                  if (ok) setRenaming(false);
                });
            }}
          >
            <Input
              autoFocus
              aria-label="Desktop name"
              className="min-w-0 flex-1"
              maxLength={80}
              value={name}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setRenaming(false);
                }
              }}
              onChange={(event) => setName(event.target.value)}
            />
            <Button size="xs" type="submit" disabled={controls.busy || !name.trim()}>
              Save
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
            <h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={desktop.name}>
              {desktop.name}
            </h3>
            <Badge
              variant={
                desktop.humanControl
                  ? "warning"
                  : desktop.state === "failed"
                    ? "error"
                    : "secondary"
              }
            >
              {desktopStatus(desktop)}
            </Badge>
          </div>
        )}
        {thread && desktop.controllingThreadId ? (
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: desktop.controllingThreadId }}
            onClick={onOpenThread}
            className="block truncate text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {thread.title}
          </Link>
        ) : (
          <p className="text-xs text-muted-foreground">
            {desktop.reason ??
              (desktop.humanControl
                ? "Agent input is paused until control is returned or reclaimed."
                : desktop.controllingThreadId
                  ? "An agent is using this desktop."
                  : desktop.resolution
                    ? `${desktop.resolution.width} × ${desktop.resolution.height}`
                    : "Available for your conversations.")}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={controls.busy || !canOpen}
            title={!controls.local ? "Open from the local Cafe Linux app" : undefined}
            onClick={() => void controls.connect(desktop.id)}
          >
            {controls.pendingId === desktop.id ? "Opening / updating…" : "Open desktop"}
            <ArrowUpRightIcon className="size-3.5" />
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${desktop.name}`} />
              }
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end" className="w-60">
              <MenuItem
                disabled={controls.busy}
                onClick={() => {
                  setName(desktop.name);
                  setRenaming(true);
                }}
              >
                Rename
              </MenuItem>
              <MenuItem onClick={() => setDetails((v) => !v)}>Technical details</MenuItem>
              <MenuItem
                disabled={
                  !controls.data?.enabled || desktop.state !== "ready" || !desktop.canResize
                }
                onClick={() => setDisplayOpen(true)}
              >
                Display settings
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                variant="destructive"
                disabled={controls.busy || desktop.state === "terminating"}
                onClick={() =>
                  void controls.change({
                    operation: "end",
                    id: desktop.id,
                  })
                }
              >
                <span>
                  End desktop
                  <span className="block text-xs opacity-75">
                    Closes its apps and removes this desktop
                  </span>
                </span>
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
        {details && (
          <div className="text-xs text-muted-foreground">
            {desktop.renderer === "gles2" ? "GPU rendering" : "Software rendering"} ·{" "}
            {desktop.transfer === "dma-buf" ? "Direct GPU frames" : "Shared-memory frames"} ·{" "}
            {desktop.viewerOpen ? "Viewer open" : "Viewer closed"}
            {desktop.toolUsage && (
              <p className="mt-1">
                Since runtime start: {desktop.toolUsage.calls.toLocaleString()} tool calls ·{" "}
                {desktop.toolUsage.actions.toLocaleString()} input actions ·{" "}
                {desktop.toolUsage.screenshots.toLocaleString()} screenshots sent ·{" "}
                {desktop.toolUsage.unchangedCaptures.toLocaleString()} unchanged captures omitted ·{" "}
                {desktop.toolUsage.replyTextChars.toLocaleString()} reply text characters ·{" "}
                {desktop.toolUsage.failures.toLocaleString()} failed calls
              </p>
            )}
          </div>
        )}
      </div>
      {displayOpen && (
        <DesktopSessionDialog
          environmentId={environmentId}
          desktop={desktop}
          onClose={() => setDisplayOpen(false)}
        />
      )}
    </article>
  );
}
export function VirtualDesktopList({
  environmentId,
  live = true,
  onOpenThread,
}: {
  environmentId: EnvironmentId | null;
  live?: boolean;
  onOpenThread?: () => void;
}) {
  const controls = useVirtualDesktops(environmentId, null, live);
  const [revision, setRevision] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Button
          size="sm"
          disabled={controls.busy || !controls.data?.enabled || !controls.data.available}
          onClick={() => setCreateOpen(true)}
        >
          <PlusIcon className="size-3.5" />
          New desktop
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={controls.busy}
          aria-label="Refresh desktops and previews"
          onClick={() =>
            void controls.change({ operation: "recheck" }).then(() => setRevision((v) => v + 1))
          }
        >
          <RefreshCwIcon
            className={`size-3.5 ${controls.pendingId === "recheck" ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>
      {controls.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading desktops…
        </p>
      )}
      {controls.data?.supported && !controls.data.available && (
        <div className="rounded-xl border border-border p-4">
          <DesktopSetup
            prerequisites={controls.data.prerequisites}
            available={controls.data.available}
            reason={controls.data.reason}
            busy={controls.busy}
            onRecheck={() => void controls.change({ operation: "recheck" })}
          />
        </div>
      )}
      {!controls.local && (
        <p className="text-xs text-muted-foreground">
          Manage desktops here. Open a viewer from the Cafe Linux app on this computer.
        </p>
      )}
      {controls.error && (
        <p role="alert" className="text-xs text-destructive">
          {controls.error}
        </p>
      )}
      {controls.data?.desktops.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
          <MonitorIcon className="size-8 text-muted-foreground/50" />
          <h3 className="text-sm font-medium">A desktop for your agent</h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            Create a desktop, attach it to a conversation, and open it to follow along.
          </p>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {environmentId &&
          controls.data?.desktops.map((desktop) => (
            <DesktopRow
              key={desktop.id}
              desktop={desktop}
              controls={controls}
              environmentId={environmentId}
              revision={revision}
              {...(onOpenThread ? { onOpenThread } : {})}
            />
          ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Previews refresh when you open this view or press Refresh. Closing a viewer leaves apps
        running. Ending a desktop or restarting your computer removes its session.
      </p>
      {createOpen && (
        <DesktopSessionDialog environmentId={environmentId} onClose={() => setCreateOpen(false)} />
      )}
    </div>
  );
}
export function VirtualDesktopManager({
  environmentId,
  open,
  onOpenChange,
}: {
  environmentId: EnvironmentId | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-4xl" bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>Desktops</DialogTitle>
          <DialogDescription>
            Separate workspaces for your apps and conversations.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[72vh] overflow-y-auto px-6 pb-6">
          {open && (
            <VirtualDesktopList
              environmentId={environmentId}
              onOpenThread={() => onOpenChange(false)}
            />
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
export function VirtualDesktopsNavigation() {
  const settings = useServerSettings();
  return settings.virtualDesktopsEnabled && settings.desktopControlMcpEnabled ? (
    <EnabledVirtualDesktopsNavigation />
  ) : null;
}
function EnabledVirtualDesktopsNavigation() {
  const environmentId = usePrimaryEnvironmentId();
  const [open, setOpen] = useState(false);
  const status = useVirtualDesktops(environmentId, null, false);
  if (!status.data?.supported) return null;
  return (
    <>
      <SidebarMenuItem className="flex w-full items-center gap-1">
        <SidebarMenuButton
          size="sm"
          className={`min-w-0 flex-1 select-none gap-2 px-2 py-1.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground ${open ? "bg-accent text-foreground" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <MonitorIcon className="size-3.5" />
          <span className="truncate text-xs">Desktops</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <VirtualDesktopManager environmentId={environmentId} open={open} onOpenChange={setOpen} />
    </>
  );
}
export function DesktopPicker({
  environmentId,
  threadId,
  provider,
  compact,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  provider: string;
  compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const controls = useVirtualDesktops(environmentId, threadId, true, provider === "codex");
  if (!controls.data?.supported || !controls.data.enabled || provider !== "codex" || !threadId)
    return null;
  const data = controls.data;
  const selected = data.desktops.find((d) => d.id === data.selectedDesktopId);
  const active = data.desktops.find((d) => d.id === data.activeDesktopId);
  const viewing = active ?? selected;
  const title = data.selectionPending
    ? `Current: ${active?.name ?? "None"}. Next turn: ${selected?.name ?? "None"}`
    : selected
      ? `${selected.name} · ${desktopStatus(selected)}`
      : "Desktop";
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="max-w-56 shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80 sm:px-3"
              aria-label={`Desktop${selected ? `: ${selected.name}` : ""}`}
              title={title}
            />
          }
        >
          <MonitorIcon />
          <span className={compact ? "sr-only" : "truncate"}>{selected?.name ?? "Desktop"}</span>
          {compact && selected && (
            <span aria-label="Desktop attached" className="size-1.5 rounded-full bg-primary" />
          )}
          {data.selectionPending && (
            <span className="text-xs text-warning-foreground">Next turn</span>
          )}
          <ChevronDownIcon className="size-3 opacity-60" />
        </MenuTrigger>
        <MenuPopup side="top" align="start" className="w-80 max-w-[calc(100vw-1rem)]">
          <div className="px-2 py-2 text-xs font-medium text-muted-foreground">
            Desktop for this conversation
          </div>
          {viewing && (
            <div className="px-2 pb-2">
              <div className="mb-2 overflow-hidden rounded-md">
                <DesktopPreview
                  environmentId={environmentId}
                  id={viewing.id}
                  name={viewing.name}
                  enabled={viewing.state === "ready"}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {data.selectionPending ? `Current: ${viewing.name} · ` : ""}
                {desktopStatus(viewing)}
              </p>
            </div>
          )}
          <MenuRadioGroup
            value={selected?.id ?? "none"}
            onValueChange={(value) => {
              if (value)
                void controls
                  .change({ operation: "attach", id: value === "none" ? null : value, threadId })
                  .then((ok) => {
                    if (ok) setOpen(false);
                  });
            }}
          >
            <MenuRadioItem value="none" disabled={controls.busy}>
              None
            </MenuRadioItem>
            {data.desktops
              .filter((d) => d.state !== "stopped")
              .map((desktop) => {
                const occupied =
                  desktop.controllingThreadId !== null && desktop.controllingThreadId !== threadId;
                const status = occupied ? "Busy in another chat" : desktopStatus(desktop);
                return (
                  <MenuRadioItem
                    key={desktop.id}
                    value={desktop.id}
                    aria-label={`${desktop.name} ${status}`}
                    disabled={controls.busy || desktop.state !== "ready" || occupied}
                  >
                    <span className="flex min-w-0 items-center justify-between gap-3">
                      <span className="min-w-0 truncate">{desktop.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
                    </span>
                  </MenuRadioItem>
                );
              })}
          </MenuRadioGroup>
          <MenuSeparator />
          {viewing && (
            <MenuItem
              disabled={controls.busy || !controls.local || viewing.state !== "ready"}
              onClick={() => void controls.connect(viewing.id)}
            >
              <ArrowUpRightIcon />
              Open {viewing.name}
            </MenuItem>
          )}
          <MenuItem
            disabled={controls.busy || !data.available}
            onClick={() => {
              setOpen(false);
              setCreateOpen(true);
            }}
          >
            <PlusIcon />
            New desktop
          </MenuItem>
          <MenuItem onClick={() => setManagerOpen(true)}>
            <MonitorIcon />
            {data.available ? "Manage desktops" : "Set up desktops"}
          </MenuItem>
          {data.selectionPending && (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              Next turn: {selected?.name ?? "None"}. The current turn keeps{" "}
              {active?.name ?? "its desktop"}.
            </p>
          )}
          {!data.controlEnabled && (
            <p className="p-2 text-xs text-muted-foreground">
              Enable Desktop control in Settings → Desktop control to give Codex access.
            </p>
          )}
          {controls.error && (
            <p role="alert" className="px-2 py-2 text-xs text-destructive">
              {controls.error}
            </p>
          )}
        </MenuPopup>
      </Menu>
      {viewing && !compact && (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Open desktop: ${viewing.name}`}
          title={`Open ${viewing.name} · ${desktopStatus(viewing)}`}
          disabled={controls.busy || !controls.local || viewing.state !== "ready"}
          onClick={() => void controls.connect(viewing.id)}
        >
          <ArrowUpRightIcon className="size-3.5" />
        </Button>
      )}
      {controls.error && !open && (
        <span role="alert" className="max-w-56 text-xs text-destructive">
          {controls.error}
        </span>
      )}
      <VirtualDesktopManager
        environmentId={environmentId}
        open={managerOpen}
        onOpenChange={setManagerOpen}
      />
      {createOpen && (
        <DesktopSessionDialog
          environmentId={environmentId}
          threadId={threadId}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </>
  );
}
