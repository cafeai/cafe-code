import { expect } from "vitest";
import { DesktopInteraction, type InteractionHost } from "../src/virtualDesktop/interaction.ts";
import { fixtureRegion } from "./desktopFrameFixture.ts";
import { desktopError } from "../src/virtualDesktop/nativeClient.ts";

/** Credential-free native qualification, called only by the explicit E2E.
 * All input targets its synthetic private window; no host app is controlled. */
export async function qualifyDesktopInteractions(options: {
  call: InteractionHost["request"];
  tree: InteractionHost["tree"];
}) {
  const signal = new AbortController().signal;
  const counters: Record<string, number> = {};
  let epoch: number | undefined;
  const interaction = new DesktopInteraction({
    request: async (body, signal) => {
      const result = await options.call(body, signal);
      if (result.error)
        throw desktopError("operation_failed", "Native qualification operation failed.");
      return result;
    },
    tree: options.tree,
    publish: async () => undefined, // Runtime references also work without retention.
    check: (signal) => {
      if (signal.aborted) throw desktopError("operation_failed", "Cancelled.");
    },
    epoch: () => epoch,
    observed: (next) => {
      epoch = next;
    },
    count: (name, amount = 1) => {
      counters[name] = (counters[name] ?? 0) + amount;
    },
  });
  const full = await interaction.observe({}, signal);
  const unchanged = await interaction.observe({ since: full.observationId }, signal);
  expect(unchanged).toMatchObject({ unchanged: true, observationId: full.observationId });
  expect(unchanged).not.toHaveProperty("image");
  const cropped = await interaction.observe(
    { region: { x: 100, y: 80, width: 400, height: 200 } },
    signal,
  );
  expect(cropped).toMatchObject({ width: 400, height: 200 });
  expect(fixtureRegion(String(cropped.image), 0, 0, 400, 200)).toEqual(
    fixtureRegion(String(full.image), 100, 80, 400, 200),
  );
  expect(
    await interaction.act(
      { kind: "click", x: 100, y: 100, observationId: cropped.observationId },
      signal,
    ),
  ).toMatchObject({ ok: true });
  const window = (await options.tree(signal)).windows.find((window) => window.visible === true)!;
  expect(window).toBeDefined();
  await interaction.observe({ windowId: window.id }, signal);
  const stale = await options.call(
    {
      method: "act",
      kind: "click",
      x: 200,
      y: 220,
      controlEpoch: epoch,
      observationGuard: {
        width: 1280,
        height: 800,
        controlEpoch: epoch,
        windowId: window.id,
        rect: { x: window.x + 1, y: window.y, width: window.width, height: window.height },
      },
    },
    signal,
  );
  expect(stale).toMatchObject({ error: "observation_required" });
  expect(
    await options.call(
      {
        method: "validate_actions",
        controlEpoch: epoch,
        actions: [
          { kind: "click", x: 200, y: 220 },
          { kind: "key", keys: ["Definitely_Not_An_XKB_Key"] },
        ],
      },
      signal,
    ),
  ).toMatchObject({ error: "invalid_key" });
  await interaction.observe({}, signal);
  const before = counters.screenshots;
  const combined = await interaction.act(
    {
      actions: [
        { kind: "click", x: 200, y: 220 },
        { kind: "text", text: "batch" },
        { kind: "key", keys: ["Return"] },
      ],
      observeAfter: "always",
    },
    signal,
  );
  expect(combined).toMatchObject({ ok: true, completed: 3 });
  expect(typeof combined.image).toBe("string");
  expect(counters.screenshots! - before!).toBe(1);
  expect(combined).not.toHaveProperty("pixelHash");
  const launch = await options.call(
    { method: "launch", command: "/bin/sh", args: ["-c", "exit 7"], controlEpoch: epoch },
    signal,
  );
  expect(launch.launchId).toBeTypeOf("number");
  // A later request lets the worker reap its exact direct child. Polling only
  // this bounded numeric status never reads arbitrary process command lines.
  let status: Record<string, unknown> = {};
  for (let i = 0; i < 20; i++) {
    status = await options.call({ method: "launch_status", launchId: launch.launchId }, signal);
    if (status.state === "exited") break;
  }
  expect(status).toMatchObject({ state: "exited", exitCode: 7 });
}
