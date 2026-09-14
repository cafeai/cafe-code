import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_RUNTIME_PATH_MAX_BYTES,
  desktopIncarnationName,
  desktopInstanceDirectory,
  desktopRuntimeDirectory,
  isDesktopIncarnationName,
  isDesktopInstanceDirectory,
} from "./desktopRuntime.ts";

describe("compact private desktop runtime paths", () => {
  it("preserves all identifier bits and budgets every supported Linux UID", () => {
    const incarnation = "81e89e4f-675a-4638-b0e9-54fdb569ae95";
    const name = desktopIncarnationName(incarnation);
    expect(name).toBe("geieT2daRjiw6VT9tWmulQ");
    expect(Buffer.from(name, "base64url").toString("hex")).toBe(incarnation.replaceAll("-", ""));
    for (const uid of [0, 1000, 0xffff_fffe]) {
      const directory = desktopInstanceDirectory(
        "/arbitrarily/long/user/data/".repeat(100),
        uid,
        incarnation,
      );
      expect(Buffer.byteLength(directory)).toBeLessThanOrEqual(DESKTOP_RUNTIME_PATH_MAX_BYTES);
      expect(directory).toMatch(/^\/run\/user\/\d+\/cfd-[A-Za-z0-9_-]{8}\/[A-Za-z0-9_-]{22}$/);
      expect(
        isDesktopInstanceDirectory(
          directory,
          "/arbitrarily/long/user/data/".repeat(100),
          uid,
          incarnation,
        ),
      ).toBe(true);
    }
    expect(desktopRuntimeDirectory("one", 1000)).not.toBe(desktopRuntimeDirectory("two", 1000));
    expect(desktopIncarnationName("81e89e4f-675a-4638-b0e9-54fdb569ae94")).not.toBe(name);
  });
  it("rejects aliases, traversal, noncanonical padding bits and invalid identities", () => {
    const id = randomUUID(),
      directory = desktopInstanceDirectory("state", 1000, id);
    expect(isDesktopIncarnationName(desktopIncarnationName(id))).toBe(true);
    for (const value of [
      id,
      "../" + id,
      "A".repeat(21) + "B",
      "A".repeat(22) + "==",
      "A".repeat(21),
    ])
      expect(isDesktopIncarnationName(value)).toBe(false);
    for (const value of ["../" + id, id.toUpperCase(), "0".repeat(36)])
      expect(() => desktopIncarnationName(value)).toThrow();
    for (const uid of [-1, 1.5, Infinity, 0xffff_ffff])
      expect(() => desktopRuntimeDirectory("state", uid)).toThrow();
    for (const value of [
      directory + "/",
      directory + "/../escape",
      directory.replace("/cfd-", "/cafe-desktops-"),
    ])
      expect(isDesktopInstanceDirectory(value, "state", 1000, id)).toBe(false);
    expect(isDesktopInstanceDirectory(directory, "other state", 1000, id)).toBe(false);
    expect(isDesktopInstanceDirectory(directory, "state", 1001, id)).toBe(false);
    expect(isDesktopInstanceDirectory(directory, "state", 1000, "../bad")).toBe(false);
  });
  it.skipIf(process.platform !== "linux")(
    "binds a real Unix socket with the promised 50-byte application filename",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cfd-"));
      const directory = path.join(root, "x".repeat(56 - Buffer.byteLength(root) - 1));
      const socket = path.join(directory, "a".repeat(50));
      const server = createServer();
      try {
        await fs.mkdir(directory, { mode: 0o700 });
        expect(Buffer.byteLength(socket)).toBe(107);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socket, resolve);
        });
        expect((await fs.lstat(socket)).isSocket()).toBe(true);
      } finally {
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
