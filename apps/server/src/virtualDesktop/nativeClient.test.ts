import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { processIdentity } from "./nativeClient.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  readFile: vi.fn(),
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
