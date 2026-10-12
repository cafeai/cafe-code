import { expect, it } from "vitest";
import type { NativeControlActivity } from "@cafecode/contracts";
import { newerComputerActivity, computerActivityText } from "./useNativeControlActivity";
const state: NativeControlActivity = {
  version: 1,
  generation: "g",
  sequence: 3,
  episode: "e",
  threadId: null,
  provider: "codex",
  providerInstanceId: "account",
  phase: "controlling",
  inputPolicy: "background-only",
  inputRoute: "pid",
  usingSystemPointer: false,
  target: null,
  lastCaptureAt: null,
};
it("fences reordered IPC/query activity and accepts a new host generation", () => {
  expect(newerComputerActivity(state, { ...state, sequence: 2 })).toBe(false);
  expect(newerComputerActivity(state, { ...state, sequence: 3 })).toBe(false);
  expect(newerComputerActivity(state, { ...state, sequence: 4 })).toBe(true);
  expect(newerComputerActivity(state, { ...state, generation: "next", sequence: 0 })).toBe(true);
});
it("labels physical pointer use independently of foreground activation and capture", () => {
  expect(computerActivityText(state)).toBe("Controlling");
  expect(computerActivityText({ ...state, inputRoute: "hid", usingSystemPointer: true })).toBe(
    "Using the real mouse",
  );
  expect(computerActivityText({ ...state, phase: "capturing" })).toBe("Taking a screenshot");
  expect(computerActivityText({ ...state, phase: "stopping" })).toBe("Stopping…");
});
