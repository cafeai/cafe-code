import { describe, expect, it } from "vitest";
import { GlideActivity } from "./activity.ts";
import type { GlideObservation } from "./protocol.ts";

const observation: GlideObservation = {
  app: "/Editor.app",
  text: "AXTextField",
  screenshot: { url: "data:image/png;base64,AA==" },
  revision: 1,
  pid: 1,
  windowId: 7,
  windowTitle: "Notes",
  processBirth: "100:20",
  bounds: { x: 0, y: 0, width: 100, height: 100 },
  screenshotWidth: 100,
  screenshotHeight: 100,
  capturedAt: "2026-10-21T12:00:00.000Z",
  screenshotPreview: "data:image/jpeg;base64,AA==",
};
const start = (operation: number, screenshot = true) => ({
  phase: "start" as const,
  operation,
  method: "get_app_state",
  appName: "Editor",
  app: "/Editor.app",
  screenshot,
});
describe("computer use activity ownership", () => {
  it("hides a persistent grant until its chat runs and drops its previews when the turn finishes", () => {
    const activity = new GlideActivity();
    activity.grant("owner", "Chat", "Codex");
    activity.event("owner", start(1));
    expect(activity.snapshot().rows).toEqual([]);
    activity.running("owner", true);
    activity.event("owner", start(2));
    activity.event("owner", { phase: "observation", operation: 2, observation });
    expect(activity.snapshot().rows[0]?.preview).toBe(observation.screenshotPreview);
    activity.running("owner", false);
    expect(activity.snapshot().rows).toEqual([]);
    activity.running("owner", true);
    expect(activity.snapshot().rows).toHaveLength(1);
    expect(activity.snapshot().rows[0]?.preview).toBeUndefined();
  });
  it("requires confirmed global stopping before presenting every saved grant as off", () => {
    const activity = new GlideActivity();
    expect(activity.snapshot()).toEqual({ state: "ready", rows: [] });
    activity.grant("owner", "Chat", "Codex");
    activity.revoke("owner");
    expect(activity.snapshot()).toEqual({ state: "ready", rows: [] });
    activity.transition("stopping");
    activity.transition("stopped");
    expect(activity.snapshot()).toEqual({ state: "stopped", rows: [] });
  });
  it("separates permission, text reading and successful screenshots and retires exact owners", () => {
    const activity = new GlideActivity();
    activity.grant("owner", "Notes chat", "Claude");
    activity.running("owner", true);
    expect(activity.snapshot().rows[0]?.state).toBe("ready");
    expect(activity.snapshot().rows[0]?.preview).toBeUndefined();
    activity.event("owner", start(1, false));
    expect(activity.activity("owner").state).toBe("reading");
    activity.event("owner", {
      phase: "observation",
      operation: 1,
      observation: { ...observation, screenshot: null },
    });
    expect(activity.snapshot().rows.every((row) => row.preview === undefined)).toBe(true);
    activity.event("owner", start(2));
    activity.event("owner", { phase: "end", operation: 1 });
    expect(activity.activity("owner").state).toBe("capturing");
    activity.event("owner", { phase: "observation", operation: 2, observation });
    activity.event("owner", { phase: "end", operation: 2 });
    expect(activity.snapshot().rows[0]).toMatchObject({
      state: "ready",
      preview: observation.screenshotPreview,
      capturedAt: observation.capturedAt,
    });
    activity.event("owner", start(3, false));
    activity.event("owner", {
      phase: "observation",
      operation: 3,
      observation: { ...observation, processBirth: "101:20", screenshot: null },
    });
    activity.event("owner", { phase: "end", operation: 3 });
    expect(activity.snapshot().rows.at(-1)?.preview).toBeUndefined();
    activity.revoke("owner");
    activity.grant("replacement", "Other chat", "Codex");
    activity.running("replacement", true);
    activity.event("owner", { phase: "observation", operation: 2, observation });
    expect(activity.snapshot().rows).toHaveLength(1);
    expect(activity.snapshot().rows[0]?.preview).toBeUndefined();
  });
  it("bounds retained images and preserves every live owner's current operation", () => {
    const activity = new GlideActivity();
    for (let owner = 0; owner < 32; owner++) {
      activity.grant(String(owner), "Chat", "Codex");
      activity.running(String(owner), true);
      for (let windowId = 0; windowId < 10; windowId++) {
        activity.event(String(owner), start(windowId));
        activity.event(String(owner), {
          phase: "observation",
          operation: windowId,
          observation: { ...observation, windowId, windowTitle: `Window ${windowId}` },
        });
        activity.event(String(owner), { phase: "end", operation: windowId });
      }
      activity.event(String(owner), start(100));
    }
    expect(activity.snapshot().rows).toHaveLength(64);
    expect(activity.snapshot().rows.filter((row) => row.state === "capturing")).toHaveLength(32);
    activity.transition("unavailable");
    expect(activity.snapshot().rows.every((row) => row.state === "unavailable")).toBe(true);
    activity.transition("stopped");
    expect(activity.snapshot()).toEqual({ state: "stopped", rows: [] });
  });
});
