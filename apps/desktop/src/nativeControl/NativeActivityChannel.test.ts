import { expect, it, vi } from "vitest";
import { connect } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeActivityChannel, decodeNativeActivity } from "./NativeActivityChannel.ts";

const target = {
  scope: "window",
  pid: 1,
  windowId: 2,
  app: "Fixture",
  title: "Fixture",
  visible: true,
  bounds: { x: -50, y: 0, width: 200, height: 100 },
};
it("bounds metadata and discards native input/results", () => {
  expect(
    decodeNativeActivity({
      kind: "capturing",
      target: { ...target, title: "a".repeat(1000), text: "secret", image: "bytes" },
      text: "secret",
    }).target,
  ).toEqual({ ...target, title: "a".repeat(160) });
  expect(() => decodeNativeActivity({ kind: "controlling", target })).toThrow();
  expect(() =>
    decodeNativeActivity({
      kind: "capturing",
      target: { ...target, bounds: { ...target.bounds, x: Infinity } },
    }),
  ).toThrow();
});
it("keeps connected-tab scope with its proven native window identity", () => {
  expect(
    decodeNativeActivity({ kind: "captured", target: { ...target, scope: "browser" } }),
  ).toEqual({ kind: "captured", target: { ...target, scope: "browser" } });
  expect(() =>
    decodeNativeActivity({
      kind: "capturing",
      target: {
        ...target,
        scope: "browser",
        windowId: undefined,
      },
    }),
  ).toThrow();
});
it("acknowledges capture only after visible status and refuses foreign credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "cafe-activity-fixture-"));
  const shown = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const receive = vi.fn(async () => {
    entered.resolve();
    await shown.promise;
  });
  const channel = new NativeActivityChannel(join(root, "activity.sock"), receive);
  await channel.listen();
  const request = (token: string) =>
    new Promise<string>((resolve, reject) => {
      const socket = connect(channel.path);
      let reply = "";
      socket.on("data", (b) => {
        reply += b;
      });
      socket.on("error", reject);
      socket.on("end", () => resolve(reply));
      socket.on("connect", () =>
        socket.write(JSON.stringify({ token, kind: "capturing", target }) + "\n"),
      );
    });
  try {
    expect(await request("0".repeat(64))).toBe("refused\n");
    expect(receive).not.toHaveBeenCalled();
    let acknowledged = false;
    const valid = request(channel.token).then((value) => {
      acknowledged = true;
      return value;
    });
    await entered.promise;
    expect(acknowledged).toBe(false);
    shown.resolve();
    expect(JSON.parse(await valid)).toEqual({ ok: true, exclude_windows: [] });
    expect(receive).toHaveBeenCalledOnce();
  } finally {
    shown.resolve();
    await channel.close();
    await rm(root, { recursive: true, force: true });
  }
});
