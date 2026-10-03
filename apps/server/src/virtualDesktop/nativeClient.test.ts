import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import { processIdentity, swayRequest } from "./nativeClient.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  readFile: vi.fn(),
}));
vi.mock("node:net", async (original) => ({
  ...(await original<typeof import("node:net")>()),
  createConnection: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

describe("desktop worker process identity", () => {
  it.each(["ENOENT", "ESRCH"])("recognizes task disappearance at open/read (%s)", async (code) => {
    vi.mocked(fs.readFile).mockRejectedValueOnce(
      Object.assign(new Error("private details"), { code }),
    );
    expect(await processIdentity(123)).toBeNull();
  });
  it.each(["EACCES", "EIO"])(
    "does not interpret an inconclusive read as permission to kill (%s)",
    async (code) => {
      vi.mocked(fs.readFile).mockRejectedValueOnce(
        Object.assign(new Error("private details"), { code }),
      );
      await expect(processIdentity(123)).rejects.toThrow(
        "Desktop process ownership could not be verified.",
      );
    },
  );
});

describe("binary desktop IPC compatibility", () => {
  it("keeps binary Buffer mode and accepts fragmented UTF-8 frames", async () => {
    // This socket never connects to the host. Only its in-memory EventEmitter
    // surface is used, and writes are intercepted before reaching any native
    // transport. The fixture therefore runs on every OS without Sway, provider
    // credentials, a user socket, or a live desktop session.
    const socket = new net.Socket();
    vi.mocked(net.createConnection).mockReturnValueOnce(socket);
    const write = vi.spyOn(socket, "write").mockReturnValue(true);
    const setEncoding = vi.spyOn(socket, "setEncoding");
    const response = swayRequest("isolated-in-memory-socket", 4);

    socket.emit("connect");
    const requestFrame = write.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(requestFrame)).toBe(true);
    if (!Buffer.isBuffer(requestFrame)) throw new Error("Expected a binary request frame.");
    expect(requestFrame.subarray(0, 6).toString()).toBe("i3-ipc");
    expect(requestFrame.readUInt32LE(10)).toBe(4);

    const body = Buffer.from('{"ok":true,"text":"é"}', "utf8");
    const header = Buffer.alloc(14);
    header.write("i3-ipc");
    header.writeUInt32LE(body.length, 6);
    header.writeUInt32LE(4, 10);
    const frame = Buffer.concat([header, body]);
    socket.emit("data", frame.subarray(0, 8));
    socket.emit("data", frame.subarray(8, frame.length - 2));
    socket.emit("data", frame.subarray(frame.length - 2));

    await expect(response).resolves.toEqual({ ok: true, text: "é" });
    expect(setEncoding).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
  });
});
