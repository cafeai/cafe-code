import { describe, expect, it } from "vitest";
import {
  createVisualizationPane,
  createVisualizationViewportEpochs,
} from "./visualizationViewportEpochs";

describe("viewport execution epochs", () => {
  it("mints frozen distinct pane identities even for the same chat", () => {
    const first = createVisualizationPane(),
      second = createVisualizationPane();
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys(first)).toEqual([]);
  });
  it("retains terminal admission across repeated visible mounts and presentation changes", () => {
    const epochs = createVisualizationViewportEpochs();
    expect(epochs.observe("call", true)).toBe(true);
    epochs.terminal("call");
    for (let count = 0; count < 50; count += 1) expect(epochs.observe("call", true)).toBe(false);
    expect(epochs.size()).toBe(1);
  });
  it("renews only after an actual observed offscreen transition", () => {
    const epochs = createVisualizationViewportEpochs();
    epochs.observe("call", true);
    epochs.terminal("call");
    expect(epochs.observe("call", false)).toBe(false);
    expect(epochs.observe("call", true)).toBe(true);
    epochs.terminal("call");
    expect(epochs.allowed("call")).toBe(false);
  });
  it("explicit restart changes only the exact call", () => {
    const epochs = createVisualizationViewportEpochs();
    for (const key of ["root", "child"]) {
      epochs.observe(key, true);
      epochs.terminal(key);
    }
    expect(epochs.restart("root")).toBe(true);
    expect(epochs.allowed("root")).toBe(true);
    expect(epochs.allowed("child")).toBe(false);
  });
  it("nearby preparation refusal cannot renew on the first visible observation", () => {
    const epochs = createVisualizationViewportEpochs();
    epochs.observe("near", false);
    epochs.terminal("near");
    expect(epochs.observe("near", true)).toBe(false);
  });
  it("latches authority loss before the first viewport observation", () => {
    const epochs = createVisualizationViewportEpochs();
    epochs.terminal("pending");
    expect(epochs.observe("pending", true)).toBe(false);
    expect(epochs.observe("pending", false)).toBe(false);
    expect(epochs.observe("pending", true)).toBe(true);
  });
  it("refuses overflow without evicting old terminal history", () => {
    const epochs = createVisualizationViewportEpochs(2);
    epochs.observe("old", true);
    epochs.terminal("old");
    epochs.observe("other", true);
    expect(epochs.observe("new", true)).toBe(false);
    expect(epochs.observe("old", true)).toBe(false);
    expect(epochs.size()).toBe(2);
    expect(epochs.restart("new")).toBe(false);
  });
  it("closed exact pane can release its ledger without changing another pane", () => {
    const first = createVisualizationViewportEpochs(),
      second = createVisualizationViewportEpochs();
    first.observe("same", true);
    second.observe("same", true);
    second.terminal("same");
    first.clear();
    expect(first.size()).toBe(0);
    expect(second.observe("same", true)).toBe(false);
  });
  it("retains only bounded exact layout scalars without changing terminal admission", () => {
    const epochs = createVisualizationViewportEpochs(1);
    epochs.observe("call", true);
    epochs.terminal("call");
    const received = { height: 620, constrained: false, privateObject: { source: "not retained" } };
    expect(epochs.rememberLayout("call", received)).toBe(true);
    received.height = 2000;
    expect(epochs.layout("call")).toEqual({ height: 620, constrained: false });
    expect(Object.isFrozen(epochs.layout("call"))).toBe(true);
    expect(epochs.observe("call", true)).toBe(false);
    expect(epochs.rememberLayout("unrecorded", { height: 620, constrained: false })).toBe(false);
    for (const height of [NaN, Infinity, 79, 2001, 620.5])
      expect(epochs.rememberLayout("call", { height, constrained: false })).toBe(false);
    expect(epochs.size()).toBe(1);
    expect(epochs.layout("call")).toEqual({ height: 620, constrained: false });
    epochs.clear();
    expect(epochs.layout("call")).toBeUndefined();
  });
});
