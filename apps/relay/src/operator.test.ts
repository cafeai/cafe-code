// @effect-diagnostics nodeBuiltinImport:off
// POSIX private-file fixture. Fence admission before IO and join each original
// operation before removing its private root, including a late acquisition.
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { configureNetwork } from "./operator.ts";
import { readNodeConfig, readPrivateFile } from "./config.ts";
import { verifyNetwork } from "@cafecode/relay/descriptor";
import { canonicalBytes } from "@cafecode/relay/protocol";
import { epochNow } from "@cafecode/relay/lifetime";
import { randomOpaque } from "@cafecode/relay/bytes";

it.skipIf(process.platform === "win32")(
  "extends a private recipe without replacing identities or silently moving/removing nodes",
  async (test) => {
    let directory: string | undefined,
      retired = false;
    const jobs = new Set<Promise<unknown>>();
    const own = async <T>(action: () => Promise<T>): Promise<T> => {
      if (retired) throw new Error("fixture-retired");
      const job = action();
      jobs.add(job);
      try {
        const value = await job;
        if (retired) throw new Error("fixture-retired");
        return value;
      } finally {
        jobs.delete(job);
      }
    };
    test.signal.addEventListener(
      "abort",
      () => {
        retired = true;
      },
      { once: true },
    );
    test.onTestFinished(async () => {
      retired = true;
      await Promise.allSettled(jobs);
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    });
    await own(async () => {
      directory = await fs.mkdtemp(join(tmpdir(), "cafe-relay-operator-"));
    });
    directory = await own(() => fs.realpath(directory!));
    await own(() => fs.chmod(directory!, 0o700));
    const recipe = join(directory, "recipe.json"),
      output = join(directory, "operator");
    const nodes = Array.from({ length: 3 }, (_, index) => ({
      publicUrl: `wss://relay-${index}.example:8443/v1/relay`,
      wireGuardAddress: `10.200.0.${11 + index}`,
    }));
    const write = (members: typeof nodes) =>
      own(() =>
        fs.writeFile(
          recipe,
          canonicalBytes({
            version: 1,
            viewerOrigin: "https://trusted-viewer.example",
            nodes: members,
          }),
          { mode: 0o600 },
        ),
      );
    await write(nodes.slice(0, 1));
    await own(() => configureNetwork(output, recipe));
    const first = await own(() => readNodeConfig(join(output, "node-0.json")));
    const forwardedIpKeys = [randomOpaque(), randomOpaque()];
    await own(() =>
      fs.writeFile(join(output, "node-0.json"), canonicalBytes({ ...first, forwardedIpKeys }), {
        mode: 0o600,
      }),
    );
    await write(nodes);
    await own(() => configureNetwork(output, recipe));
    const current = await own(() => readNodeConfig(join(output, "node-0.json")));
    expect(current.privateIdentity).toBe(first.privateIdentity);
    expect(current.grants).toEqual(first.grants);
    expect(current.rootPublicKey).toBe(first.rootPublicKey);
    expect(current.forwardedIpKeys).toEqual(forwardedIpKeys);
    expect(current.descriptor.revision).toBe(2);
    expect(current.descriptor.nodes.length).toBe(3);
    const networkBytes = await own(() => readPrivateFile(join(output, "network.json"), 8192));
    await own(() =>
      verifyNetwork(networkBytes, {
        rootPublicKey: first.rootPublicKey,
        now: epochNow(),
        minimumRevision: 2,
      }),
    );
    const keyStat = await own(() => fs.lstat(join(output, "operator-root.key")));
    expect(keyStat.mode & 0o777).toBe(0o600);
    expect(keyStat.nlink).toBe(1);
    await write([nodes[1]!, nodes[0]!, nodes[2]!]);
    await expect(own(() => configureNetwork(output, recipe))).rejects.toThrow();
    await write(nodes.slice(0, 1));
    await expect(own(() => configureNetwork(output, recipe))).rejects.toThrow();
    expect((await own(() => readNodeConfig(join(output, "node-0.json")))).descriptor.revision).toBe(
      2,
    );
    await write(nodes);
    await own(() => fs.unlink(join(output, "node-0.key")));
    await expect(own(() => configureNetwork(output, recipe))).rejects.toThrow();
    await expect(own(() => fs.lstat(join(output, "node-0.key")))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
