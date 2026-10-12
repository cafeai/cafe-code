import { describe, expect, it } from "vitest";
import {
  VisualizationAppContextPresenter,
  type VisualizationAppContext,
} from "./visualizationAppContext.ts";

const context: VisualizationAppContext = {
  theme: "light",
  locale: "en",
  reducedMotion: false,
  scale: 1,
  displayMode: "inline",
  containerDimensions: { width: 400, height: 200 },
};
describe("native Apps context presentation", () => {
  it("enriches only the exact observed initialization response with native context", () => {
    const presenter = new VisualizationAppContextPresenter(context);
    presenter.observeOutgoing({ jsonrpc: "2.0", method: "ui/initialize", id: 7 });
    const wrong = { jsonrpc: "2.0", id: 8, result: { hostContext: { theme: "untrusted" } } };
    expect(presenter.receive(wrong)).toBe(wrong);
    const result = presenter.receive({
      jsonrpc: "2.0",
      id: 7,
      result: { capabilities: {}, hostContext: { source: "private" } },
    });
    expect(result).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {
        capabilities: {},
        hostContext: {
          ...context,
          availableDisplayModes: ["inline", "fullscreen"],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("does not notify before initialization or replay a second initialization", () => {
    const presenter = new VisualizationAppContextPresenter(context);
    expect(presenter.update({ ...context, theme: "dark" })).toBeNull();
    presenter.observeOutgoing({ jsonrpc: "2.0", method: "ui/initialize", id: "first" });
    presenter.observeOutgoing({ jsonrpc: "2.0", method: "ui/initialize", id: "second" });
    const second = { jsonrpc: "2.0", id: "second", result: {} };
    expect(presenter.receive(second)).toBe(second);
    const error = { jsonrpc: "2.0", id: "first", error: { code: -1 } };
    expect(presenter.receive(error)).toBe(error);
    expect(presenter.update(context)).toBeNull();
    presenter.receive({ jsonrpc: "2.0", id: "first", result: {} });
    const changed = { ...context, displayMode: "fullscreen" as const, locale: "ja" as const };
    expect(presenter.update(changed)).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: changed,
    });
    expect(presenter.update(changed)).toBeNull();
    expect(presenter.receive(second)).toBe(second);
  });
  it("does not observe malformed or unbounded initialization identities", () => {
    for (const id of [null, {}, [], NaN, Infinity, 1.5]) {
      const presenter = new VisualizationAppContextPresenter(context);
      presenter.observeOutgoing({ jsonrpc: "2.0", method: "ui/initialize", id });
      const value = { jsonrpc: "2.0", id, result: {} };
      expect(presenter.receive(value)).toBe(value);
      expect(presenter.update({ ...context, theme: "dark" })).toBeNull();
    }
  });
  it("advertises no expanded mode from a private data-only poster preview", () => {
    const presenter = new VisualizationAppContextPresenter(context, true);
    presenter.observeOutgoing({ jsonrpc: "2.0", method: "ui/initialize", id: 1 });
    expect(
      presenter.receive({ jsonrpc: "2.0", id: 1, result: { hostCapabilities: { sandbox: {} } } }),
    ).toMatchObject({
      result: {
        hostCapabilities: { sandbox: {} },
        hostContext: { availableDisplayModes: ["inline"] },
      },
    });
  });
});
