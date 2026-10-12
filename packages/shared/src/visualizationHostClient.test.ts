import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VISUALIZATION_HOST_FILE } from "@cafecode/contracts/visualizationHost";
import { readVisualizationHost, requestVisualizationHost } from "./visualizationHostClient.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cafe-visualization-client-"));
  directories.push(directory);
  const value = {
    version: 1 as const,
    generation: randomUUID(),
    token: "a".repeat(64),
    url: "http://127.0.0.1:1234/visualizations",
  };
  const path = join(directory, VISUALIZATION_HOST_FILE);
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return { directory, path, value };
}
describe("private visualization host discovery", () => {
  it("reads only the admitted private exact file", async () => {
    const f = await fixture();
    expect(await readVisualizationHost(f.directory)).toEqual(f.value);
    await writeFile(f.path, JSON.stringify({ ...f.value, source: "private" }));
    expect(await readVisualizationHost(f.directory)).toBeNull();
    await writeFile(f.path, "x".repeat(1025));
    expect(await readVisualizationHost(f.directory)).toBeNull();
  });
  it("refuses invalid loopback ports and does not expose malformed bytes", async () => {
    const f = await fixture();
    await writeFile(
      f.path,
      JSON.stringify({ ...f.value, url: "http://127.0.0.1:99999/visualizations" }),
    );
    expect(await readVisualizationHost(f.directory)).toBeNull();
    await writeFile(f.path, "{private credential");
    expect(await readVisualizationHost(f.directory)).toBeNull();
    await expect(
      requestVisualizationHost({ ...f.value, url: "https://example.invalid/secret" }, "revoke", {}),
    ).rejects.toThrow("Visualization host is unavailable.");
  });
  it.skipIf(process.platform === "win32")(
    "refuses public permissions and symlink aliases",
    async () => {
      const f = await fixture();
      await chmod(f.path, 0o644);
      expect(await readVisualizationHost(f.directory)).toBeNull();
      await rm(f.path);
      const target = join(f.directory, "target");
      await writeFile(target, JSON.stringify(f.value), { mode: 0o600 });
      await symlink(target, f.path);
      expect(await readVisualizationHost(f.directory)).toBeNull();
    },
  );
});
