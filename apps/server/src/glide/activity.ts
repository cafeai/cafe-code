import type { GlideThreadActivity } from "@cafecode/contracts";
import type { GlideObservation } from "./protocol.ts";

export type GlideActivityEvent =
  | {
      phase: "start";
      operation: number;
      method: string;
      appName: string;
      app: string;
      windowId?: number;
      screenshot: boolean;
    }
  | { phase: "observation"; operation: number; observation: GlideObservation }
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
  windows: Map<string, GlideTrayRow>;
  running: boolean;
  active?: { operation: number; row: GlideTrayRow };
  stopping?: boolean;
}

/** Ephemeral presentation only. Neither a preview nor a retained title grants
 * native input authority. At most two 96 KiB previews per each of 32 owners;
 * revocation drops that exact owner's images, and nothing is persisted. */
export class GlideActivity {
  private readonly entries = new Map<string, Entry>();
  private state: GlideTraySnapshot["state"] = "ready";
  grant(owner: string, chat: string, provider: string) {
    if (!this.entries.has(owner)) {
      if (this.entries.size >= 32) throw new Error("Computer use roster is full.");
      this.entries.set(owner, {
        chat: chat.slice(0, 128),
        provider,
        windows: new Map(),
        running: false,
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
    if (running) delete entry.stopping;
    else {
      entry.windows.clear();
      delete entry.active;
    }
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
    if (event.phase === "start") {
      const previous = [...entry.windows].find(
        ([key]) =>
          key.startsWith(`${event.app}\0`) &&
          (event.windowId === undefined || key.endsWith(`\0${event.windowId}`)),
      )?.[1];
      entry.active = {
        operation: event.operation,
        row: {
          ...previous,
          owner,
          chat: entry.chat,
          provider: entry.provider,
          appName: event.appName.slice(0, 128),
          windowTitle:
            previous?.windowTitle ??
            (event.windowId === undefined ? "Selected window" : `Window ${event.windowId}`),
          state:
            event.method === "get_app_state"
              ? event.screenshot
                ? "capturing"
                : "reading"
              : "acting",
        },
      };
    } else if (entry.active?.operation === event.operation) {
      if (event.phase === "end") {
        delete entry.active;
        return;
      }
      const observation = event.observation;
      // Missing birth/title/preview from a legacy helper never manufactures a
      // screenshot. The full screenshot and its bounded native thumbnail must
      // both exist in this successful, already validated observation.
      const key = `${observation.app}\0${observation.processBirth ?? "unknown"}\0${observation.windowId}`;
      const row: GlideTrayRow = {
        owner,
        chat: entry.chat,
        provider: entry.provider,
        appName: entry.active.row.appName,
        state: "ready",
        windowTitle: (observation.windowTitle ?? `Window ${observation.windowId}`).slice(0, 512),
        ...(observation.screenshot &&
        observation.processBirth &&
        observation.windowTitle !== undefined &&
        observation.screenshotPreview &&
        Number.isFinite(Date.parse(observation.capturedAt))
          ? { preview: observation.screenshotPreview, capturedAt: observation.capturedAt }
          : entry.windows.get(key)?.preview
            ? {
                preview: entry.windows.get(key)!.preview!,
                capturedAt: entry.windows.get(key)!.capturedAt!,
              }
            : {}),
      };
      entry.windows.delete(key);
      if (entry.windows.size >= 2) entry.windows.delete(entry.windows.keys().next().value!);
      entry.windows.set(key, row);
      entry.active.row = { ...row, state: entry.active.row.state };
    }
  }
  activity(owner: string): GlideThreadActivity {
    const entry = this.entries.get(owner);
    if (entry?.stopping) return { state: "stopping" };
    if (this.state === "stopping" || this.state === "unavailable") return { state: this.state };
    const row = entry?.active?.row;
    return row
      ? { state: row.state, appName: row.appName, windowTitle: row.windowTitle }
      : { state: entry ? "ready" : "stopped" };
  }
  snapshot(): GlideTraySnapshot {
    const rows: GlideTrayRow[] = [];
    for (const [owner, entry] of this.entries) {
      if (!entry.running) continue;
      const retained = [...entry.windows.values()];
      if (entry.active) {
        const row = entry.active.row;
        rows.push(
          row,
          ...retained
            .filter(
              (previous) =>
                previous.appName !== row.appName || previous.windowTitle !== row.windowTitle,
            )
            .slice(-1),
        );
      } else if (retained.length)
        rows.push(
          ...retained.map((row) => (entry.stopping ? { ...row, state: "stopping" as const } : row)),
        );
      else
        rows.push({
          owner,
          chat: entry.chat,
          provider: entry.provider,
          appName: "Computer use",
          windowTitle: "",
          state: entry.stopping ? "stopping" : "ready",
        });
    }
    return {
      state: this.state,
      rows: rows.slice(0, 64).map((row) => ({
        ...row,
        ...(this.state === "stopping" || this.state === "unavailable" ? { state: this.state } : {}),
      })),
    };
  }
}
