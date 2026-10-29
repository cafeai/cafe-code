import type { GlideControlResult } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import {
  GLIDE_SETUP_POLL_WINDOW_MS,
  glideAccessibilityPaneKind,
  glideButtonDisabled,
  glideClickIntent,
  glidePermissionRequirements,
  glidePermissionsGranted,
  glideScreenRecordingPaneKind,
  glideSetupShouldPoll,
} from "./glideSetup";

const status = (patch: Partial<GlideControlResult> = {}): GlideControlResult => ({
  available: true,
  connected: false,
  enabled: false,
  fullAccess: true,
  busy: false,
  paused: false,
  accessibility: false,
  screenRecording: false,
  apps: [],
  runningApps: [],
  message: "",
  ...patch,
});

describe("Glide permission setup policy", () => {
  it.each([
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, true],
  ])("accessibility=%s screen=%s is complete only when both are granted", (a, s, granted) => {
    const value = status({ accessibility: a, screenRecording: s });
    expect(glidePermissionsGranted(value)).toBe(granted);
    expect(glidePermissionRequirements(value).map((row) => [row.id, row.granted])).toEqual([
      ["accessibility", a],
      ["screen-recording", s],
    ]);
  });

  it("opens setup for a missing permission but keeps enabled revocation and complete enablement direct", () => {
    expect(glideClickIntent({ error: false, enabled: false, status: status() })).toBe("setup");
    expect(
      glideClickIntent({ error: false, enabled: false, status: status({ accessibility: true }) }),
    ).toBe("setup");
    expect(glideClickIntent({ error: false, enabled: false, status: undefined })).toBe("setup");
    expect(glideClickIntent({ error: false, enabled: true, status: status() })).toBe("toggle");
    expect(
      glideClickIntent({
        error: false,
        enabled: false,
        status: status({ accessibility: true, screenRecording: true }),
      }),
    ).toBe("toggle");
    expect(glideClickIntent({ error: true, enabled: true, status: status() })).toBe("toggle");
    expect(glideClickIntent({ error: true, enabled: false, status: status() })).toBe("refresh");
  });

  it("disables enabling without the desktop helper or Full access, never revocation", () => {
    const base = {
      disabled: false,
      pending: false,
      canTarget: true,
      enabled: false,
      error: false,
      status: status(),
      runtimeMode: "full-access" as const,
    };
    expect(glideButtonDisabled(base)).toBe(false);
    expect(glideButtonDisabled({ ...base, runtimeMode: "approval-required" })).toBe(true);
    expect(glideButtonDisabled({ ...base, status: status({ available: false }) })).toBe(true);
    expect(glideButtonDisabled({ ...base, enabled: true, runtimeMode: "approval-required" })).toBe(
      false,
    );
    expect(glideButtonDisabled({ ...base, canTarget: false })).toBe(true);
    expect(glideButtonDisabled({ ...base, pending: true })).toBe(true);
  });

  it("labels Settings panes by host macOS version and keeps older names when unknown", () => {
    expect(glideAccessibilityPaneKind(undefined)).toBe("accessibility");
    expect(glideAccessibilityPaneKind(26)).toBe("accessibility");
    expect(glideAccessibilityPaneKind(27)).toBe("device-control");
    expect(glideScreenRecordingPaneKind(undefined)).toBe("screen");
    expect(glideScreenRecordingPaneKind(14)).toBe("screen");
    expect(glideScreenRecordingPaneKind(15)).toBe("screen-and-audio");
  });

  it("polls only while open, incomplete and inside the bounded window", () => {
    const base = { open: true, granted: false, startedAt: 1_000, now: 1_000 };
    expect(glideSetupShouldPoll(base)).toBe(true);
    expect(glideSetupShouldPoll({ ...base, open: false })).toBe(false);
    expect(glideSetupShouldPoll({ ...base, granted: true })).toBe(false);
    expect(glideSetupShouldPoll({ ...base, now: 1_000 + GLIDE_SETUP_POLL_WINDOW_MS })).toBe(false);
  });
});
