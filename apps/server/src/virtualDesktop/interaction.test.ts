import { describe, expect, it, vi } from "vitest";
import { DesktopInteraction, compactWindows, type InteractionHost } from "./interaction.ts";
import { describeSwayTree } from "./swayState.ts";
import { desktopError } from "./nativeClient.ts";
import { decodeAct } from "./interactionSchema.ts";
import { launchOutcome } from "./launchOutcome.ts";

const signal = new AbortController().signal;
function fixture() {
  let observed: number | undefined;
  const state = {
    width: 1280,
    height: 800,
    controlEpoch: 1,
    humanControl: false,
    pixelHash: "first",
    observationGuards: true,
    actionValidation: true,
  };
  const window = {
    id: 12,
    type: "con",
    app_id: "dialog",
    name: "Dialog",
    visible: true,
    pid: 44,
    rect: { x: 100, y: 80, width: 400, height: 200 },
  };
  const request = vi.fn(
    async (
      body: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<Record<string, unknown>> => {
      if (signal.aborted) throw desktopError("operation_failed", "Cancelled.");
      if (body.method === "status") return { ...state };
      if (body.method === "observe") {
        const region = body.region as { width: number; height: number } | undefined;
        return {
          ...state,
          desktopWidth: state.width,
          desktopHeight: state.height,
          width: region?.width ?? state.width,
          height: region?.height ?? state.height,
          frame: 1,
          ...(body.sinceHash === state.pixelHash &&
          body.sinceEpoch === state.controlEpoch &&
          body.sinceWidth === state.width &&
          body.sinceHeight === state.height
            ? { unchanged: true }
            : { image: "cG5n" }),
        };
      }
      if (body.method === "act" && body.controlEpoch !== state.controlEpoch)
        throw desktopError("busy", "Control changed.");
      return { ok: true };
    },
  );
  const counts: Record<string, number> = {};
  const host: InteractionHost = {
    request,
    tree: vi.fn(async () => describeSwayTree(window)),
    publish: vi.fn(async (frame) => ({
      id: "24ff9ac9-1d98-4bb9-9d3f-1e868663a064",
      storage: "disabled",
      width: frame.width,
      height: frame.height,
      frame: 1,
      humanControl: false,
      capturedAt: "2026-09-13T00:00:00.000Z",
    })),
    check: (signal) => {
      if (signal.aborted) throw desktopError("operation_failed", "Cancelled.");
    },
    observed: (epoch) => {
      observed = epoch;
    },
    epoch: () => observed,
    count: (name, amount = 1) => {
      counts[name] = (counts[name] ?? 0) + amount;
    },
  };
  return { interaction: new DesktopInteraction(host), host, request, state, window, counts };
}

describe("desktop interactions", () => {
  it("omits identical pixels and retained writes, but force returns a fresh image", async () => {
    const { interaction, host, counts } = fixture();
    const first = await interaction.observe({}, signal);
    const next = await interaction.observe({ since: first.observationId }, signal);
    expect(next).toMatchObject({ unchanged: true, observationId: first.observationId });
    expect(next).not.toHaveProperty("image");
    expect(host.publish).toHaveBeenCalledTimes(1);
    const forced = await interaction.observe({ since: first.observationId, force: true }, signal);
    expect(forced.image).toBe("cG5n");
    expect(forced.observationId).not.toBe(first.observationId);
    expect(counts).toMatchObject({ captures: 3, screenshots: 2, unchangedCaptures: 1 });
  });
  it.each(["controlEpoch", "width", "height"] as const)(
    "never suppresses equal pixels after a %s change",
    async (field) => {
      const { interaction, state } = fixture();
      const first = await interaction.observe({}, signal);
      state[field]++;
      expect(await interaction.observe({ since: first.observationId }, signal)).toHaveProperty(
        "image",
      );
    },
  );
  it("maps cropped coordinates with retention disabled and rejects missing/stale/out-of-crop refs", async () => {
    const { interaction, request } = fixture();
    const first = await interaction.observe(
      { region: { x: 100, y: 80, width: 400, height: 200 } },
      signal,
    );
    await expect(interaction.act({ kind: "click", x: 10, y: 20 }, signal)).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      interaction.act({ kind: "click", x: 400, y: 20, observationId: first.observationId }, signal),
    ).rejects.toThrow();
    expect(
      await interaction.act(
        { kind: "drag", x: 10, y: 20, toX: 30, toY: 40, observationId: first.observationId },
        signal,
      ),
    ).toEqual({ ok: true });
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "act",
        x: 110,
        y: 100,
        toX: 130,
        toY: 120,
        observationGuard: { width: 1280, height: 800, controlEpoch: 1 },
      }),
      expect.any(AbortSignal),
    );
    const next = await interaction.observe({}, signal);
    expect(next).not.toHaveProperty("region");
    await expect(
      interaction.act({ kind: "click", x: 10, y: 20, observationId: first.observationId }, signal),
    ).rejects.toThrow();
  });
  it("rejects expired references and references from another binding", async () => {
    const { interaction } = fixture();
    const first = await interaction.observe({}, signal);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 301_000);
    try {
      await expect(interaction.observe({ since: first.observationId }, signal)).rejects.toThrow();
    } finally {
      clock.mockRestore();
    }
    await expect(
      fixture().interaction.observe({ since: first.observationId }, signal),
    ).rejects.toThrow();
  });
  it("guards a visible window and refuses hidden or unsupported crops", async () => {
    const { interaction, request, window, state } = fixture();
    const first = await interaction.observe({ windowId: 12 }, signal);
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        observationGuard: {
          width: 1280,
          height: 800,
          controlEpoch: 1,
          windowId: 12,
          rect: window.rect,
        },
      }),
      signal,
    );
    expect(first.region).toEqual(window.rect);
    window.visible = false;
    await expect(interaction.observe({ windowId: 12 }, signal)).rejects.toThrow();
    state.observationGuards = false;
    await expect(interaction.observe({ region: window.rect }, signal)).rejects.toThrow(
      "new desktop",
    );
  });
  it("validates all sequence fields and coordinates before any native input", async () => {
    const { interaction, request } = fixture();
    await interaction.observe({}, signal);
    request.mockClear();
    for (const actions of [
      [
        { kind: "click", x: 5, y: 5 },
        { kind: "click", x: 1600, y: 5 },
      ],
      [
        { kind: "click", x: 5, y: 5 },
        { kind: "key", keys: [] },
      ],
      [{ kind: "text", text: "é".repeat(3000) }],
    ])
      await expect(interaction.act({ actions }, signal)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    expect(() =>
      decodeAct({ kind: "click", x: 1, y: 1, actions: [{ kind: "text", text: "a" }] }),
    ).toThrow();
    expect(() =>
      decodeAct({ actions: Array.from({ length: 25 }, () => ({ kind: "text", text: "a" })) }),
    ).toThrow();
  });
  it("batches a dialog workflow with one final screenshot and no repeated worker status text", async () => {
    const { interaction, state, counts } = fixture();
    await interaction.observe({}, signal);
    state.pixelHash = "changed";
    const result = await interaction.act(
      {
        actions: [
          { kind: "key", keys: ["Control_L", "a"] },
          { kind: "text", text: "bamboo" },
          { kind: "key", keys: ["Return"] },
        ],
        observeAfter: "if_changed",
      },
      signal,
    );
    expect(result).toMatchObject({ ok: true, completed: 3, image: "cG5n" });
    expect(result).not.toHaveProperty("pixelHash");
    expect(result).not.toHaveProperty("pid");
    expect(counts).toMatchObject({ actions: 3, screenshots: 2, captures: 2 });
  });
  it("stops after an uncertain second step and does not replay or execute step three", async () => {
    const { interaction, request } = fixture();
    await interaction.observe({}, signal);
    const original = request.getMockImplementation()!;
    let steps = 0;
    request.mockImplementation(async (body, signal) => {
      if (body.method === "act" && ++steps === 2) throw new Error("private output");
      return original(body, signal);
    });
    const result = await interaction.act(
      {
        actions: [
          { kind: "text", text: "a" },
          { kind: "text", text: "b" },
          { kind: "text", text: "c" },
        ],
      },
      signal,
    );
    expect(result).toEqual({
      success: false,
      completed: 1,
      uncertainStep: 2,
      code: "operation_failed",
      observeBeforeRetry: true,
    });
    expect(steps).toBe(2);
    await expect(interaction.act({ kind: "text", text: "retry" }, signal)).rejects.toThrow();
  });
  it.each(["cancel", "takeover"])("stops later actions after %s", async (kind) => {
    const { interaction, request, state } = fixture();
    const controller = new AbortController();
    await interaction.observe({}, signal);
    const original = request.getMockImplementation()!;
    let steps = 0;
    request.mockImplementation(async (body, signal) => {
      const response = await original(body, signal);
      if (body.method === "act") {
        steps++;
        if (kind === "cancel") controller.abort();
        else state.controlEpoch++;
      }
      return response;
    });
    expect(
      await interaction.act(
        {
          actions: [
            { kind: "text", text: "a" },
            { kind: "text", text: "b" },
          ],
        },
        controller.signal,
      ),
    ).toMatchObject({ success: false, completed: 1 });
    expect(steps).toBe(1);
  });
  it("waits locally with no image or input retry when a screen remains unchanged", async () => {
    const { interaction, counts } = fixture();
    await interaction.observe({}, signal);
    const result = await interaction.act(
      {
        kind: "key",
        keys: ["Return"],
        waitFor: { type: "screen_change", timeoutMs: 100 },
        observeAfter: "if_changed",
      },
      signal,
    );
    expect(result).toMatchObject({ ok: true, wait: "timed_out", unchanged: true });
    expect(counts.actions).toBe(1);
    expect(counts.screenshots).toBe(1);
  });
  it("waits for a visible matching window without polling screenshot pixels", async () => {
    const { interaction, counts } = fixture();
    await interaction.observe({}, signal);
    expect(
      await interaction.act(
        {
          kind: "key",
          keys: ["Return"],
          waitFor: { type: "window", appId: "dialog", timeoutMs: 100 },
        },
        signal,
      ),
    ).toMatchObject({ ok: true, wait: "condition_met" });
    expect(counts.captures).toBe(1);
  });
  it("reports completed input separately when the final capture fails", async () => {
    const { interaction, request } = fixture();
    await interaction.observe({}, signal);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (body, signal) => {
      if (body.method === "observe") throw Error("capture failed");
      return original(body, signal);
    });
    expect(
      await interaction.act({ kind: "text", text: "a", observeAfter: "always" }, signal),
    ).toEqual({ ok: true, completed: 1, observationUnavailable: true, observeBeforeActing: true });
  });
  it("rejects sequences on older workers before the first input", async () => {
    const { interaction, state, request } = fixture();
    state.actionValidation = false;
    await interaction.observe({}, signal);
    await expect(
      interaction.act(
        {
          actions: [
            { kind: "text", text: "a" },
            { kind: "text", text: "b" },
          ],
        },
        signal,
      ),
    ).rejects.toThrow("new desktop");
    expect(request.mock.calls.filter(([body]) => body.method === "act")).toHaveLength(0);
  });
});

it("keeps compact window IDs/geometry while omitting container diagnostics", () => {
  const tree = describeSwayTree({
    id: 1,
    type: "con",
    app_id: "fixture",
    pid: 42,
    name: "Window",
    rect: { x: 0, y: 0, width: 400, height: 300 },
  });
  const compact = compactWindows(tree);
  expect(compact.windows[0]).toMatchObject({ id: 1, width: 400, height: 300, parentId: null });
  expect(compact).not.toHaveProperty("containers");
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(tree).length / 2);
});
it("distinguishes launcher evidence without treating wrappers or forking as app success/failure", () => {
  expect(launchOutcome({}, true, [{ id: 1 }])).toMatchObject({
    opened: false,
    outcome: "terminal_opened",
  });
  expect(launchOutcome({}, false, [{ id: 1 }])).toMatchObject({
    opened: true,
    outcome: "window_appeared",
  });
  expect(launchOutcome({ state: "exited", signal: 6 }, false, [])).toMatchObject({
    opened: false,
    outcome: "launcher_exited",
    signal: 6,
  });
  expect(launchOutcome({ state: "running" }, false, [])).toMatchObject({
    outcome: "running_without_window",
  });
  expect(launchOutcome({}, false, [])).toMatchObject({ outcome: "unverified" });
});
