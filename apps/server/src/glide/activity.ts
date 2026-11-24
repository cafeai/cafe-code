import type { GlideThreadActivity } from "@cafecode/contracts";

export type GlideActivityEvent =
  | { phase: "start"; operation: number; method: string; appName: string; app: string }
  | { phase: "end"; operation: number };
export interface GlideTrayRow {
  owner: string;
  chat: string;
  provider: string;
  appName: string;
  windowTitle: string;
  state: GlideThreadActivity["state"];
  preview?: string;
  capturedAt?: string;
}
export interface GlideTraySnapshot {
  applicationName?: string;
  reveal?: number;
  state: "ready" | "stopping" | "stopped" | "unavailable";
  rows: GlideTrayRow[];
}
interface Entry {
  chat: string;
  provider: string;
  running: boolean;
  stopping: boolean;
  active?: { operation: number; appName: string };
}
/** Cafe presents its own owner/session state. A native app approval request
 * proves neither input dispatch nor capture; OpenAI owns previews and outcomes. */
export class GlideActivity {
  private readonly entries = new Map<string, Entry>();
  private state: GlideTraySnapshot["state"] = "ready";
  grant(owner: string, chat: string, provider: string) {
    if (!this.entries.has(owner)) {
      if (this.entries.size >= 32) throw new Error("Computer use roster is full.");
      this.entries.set(owner, {
        chat: chat.slice(0, 128),
        provider,
        running: false,
        stopping: false,
      });
    }
    this.state = "ready";
  }
  revoke(owner: string) {
    this.entries.delete(owner);
  }
  running(owner: string, running: boolean) {
    const entry = this.entries.get(owner);
    if (!entry) return;
    entry.running = running;
    if (running) entry.stopping = false;
    else delete entry.active;
  }
  stop(owner: string) {
    const entry = this.entries.get(owner);
    if (entry) {
      entry.stopping = true;
      delete entry.active;
    }
  }
  transition(state: GlideTraySnapshot["state"]) {
    this.state = state;
    for (const entry of this.entries.values()) delete entry.active;
    if (state === "stopped") this.entries.clear();
  }
  event(owner: string, event: GlideActivityEvent) {
    const entry = this.entries.get(owner);
    if (!entry?.running || entry.stopping || this.state !== "ready") return;
    if (event.phase === "start")
      entry.active = { operation: event.operation, appName: event.appName.slice(0, 128) };
    else if (entry.active?.operation === event.operation) delete entry.active;
  }
  activity(owner: string): GlideThreadActivity {
    const entry = this.entries.get(owner);
    if (entry?.stopping) return { state: "stopping" };
    if (this.state === "stopping" || this.state === "unavailable") return { state: this.state };
    return entry?.active
      ? { state: "working", appName: entry.active.appName }
      : { state: entry ? "ready" : "stopped" };
  }
  snapshot(): GlideTraySnapshot {
    const rows: GlideTrayRow[] = [];
    for (const [owner, entry] of this.entries) {
      if (!entry.running) continue;
      rows.push({
        owner,
        chat: entry.chat,
        provider: entry.provider,
        appName: entry.active?.appName ?? "Computer use",
        windowTitle: "",
        state:
          this.state === "stopping" || this.state === "unavailable"
            ? this.state
            : entry.stopping
              ? "stopping"
              : entry.active
                ? "working"
                : "ready",
      });
    }
    return { state: this.state, rows };
  }
}
