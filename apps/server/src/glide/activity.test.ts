import { describe, expect, it } from "vitest";
import { GlideActivity } from "./activity.ts";
const start = (operation: number) => ({
  phase: "start" as const,
  operation,
  method: "get_app_state",
  appName: "Editor",
  app: "fixture.editor",
});
describe("computer-use activity ownership", () => {
  it("shows only running chat owners and never invents captures or input completion", () => {
    const activity = new GlideActivity();
    activity.grant("owner", "Chat", "Codex");
    activity.event("owner", start(1));
    expect(activity.snapshot().rows).toEqual([]);
    activity.running("owner", true);
    activity.event("owner", start(2));
    expect(activity.activity("owner")).toEqual({ state: "working", appName: "Editor" });
    expect(activity.snapshot().rows[0]).toMatchObject({
      owner: "owner",
      chat: "Chat",
      state: "working",
      windowTitle: "",
    });
    expect(activity.snapshot().rows[0]?.preview).toBeUndefined();
    activity.running("owner", false);
    expect(activity.snapshot().rows).toEqual([]);
  });
  it("ignores stale completion and retired-owner events across replacement", () => {
    const activity = new GlideActivity();
    activity.grant("old", "Chat", "Claude");
    activity.running("old", true);
    activity.event("old", start(1));
    activity.event("old", start(2));
    activity.event("old", { phase: "end", operation: 1 });
    expect(activity.activity("old").state).toBe("working");
    activity.revoke("old");
    activity.grant("new", "New chat", "Codex");
    activity.running("new", true);
    activity.event("old", start(3));
    expect(activity.snapshot().rows).toHaveLength(1);
    expect(activity.activity("new").state).toBe("ready");
  });
  it("keeps requested Stop distinct from joined retirement and bounds the live roster", () => {
    const activity = new GlideActivity();
    for (let i = 0; i < 32; i++) {
      activity.grant(String(i), "Chat", "Codex");
      activity.running(String(i), true);
      activity.event(String(i), start(i));
    }
    expect(() => activity.grant("overflow", "Chat", "Codex")).toThrow("full");
    expect(activity.snapshot().rows).toHaveLength(32);
    activity.transition("stopping");
    expect(activity.snapshot().rows.every((row) => row.state === "stopping")).toBe(true);
    activity.transition("unavailable");
    expect(activity.snapshot().rows.every((row) => row.state === "unavailable")).toBe(true);
    activity.transition("stopped");
    expect(activity.snapshot()).toEqual({ state: "stopped", rows: [] });
  });
});
