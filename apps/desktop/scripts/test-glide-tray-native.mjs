#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMacGlideHelper, writeGlideTrayPayload } from "./build-mac-glide-helper.mjs";

if (process.platform !== "darwin") throw new Error("Native tray qualification requires macOS.");
if (process.argv[2] === "--protocol") {
  const { createGlideTrayHost } = await import("../../server/src/glide/tray.ts");
  let failed = false;
  const host = createGlideTrayHost(
    process.argv[3],
    () => {
      throw new Error("Unexpected native event.");
    },
    () => {
      failed = true;
    },
  );
  try {
    await host.publish({
      state: "ready",
      rows: [
        {
          owner: "a40672aa-80b9-4bc3-bfc0-cbb03c17416d",
          chat: "Protocol fixture",
          provider: "Fixture",
          appName: "Owned fixture",
          windowTitle: "No desktop capture",
          state: "capturing",
        },
      ],
    });
    await host.publish({ state: "stopped", rows: [] });
  } finally {
    await host.close();
  }
  if (failed) throw new Error("Native tray protocol failed.");
  process.stdout.write("Native private-stdio ready/render/close passed.\n");
} else {
  const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const output = resolve(process.argv[2] ?? ".explorations/computer-use-implementation");
  const temporary = mkdtempSync(join(tmpdir(), "cafe-glide-tray-test-"));
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
      stdio: "inherit",
      shell: false,
      timeout: 60_000,
      ...options,
    });
    if (result.error || result.status !== 0) throw new Error("Native tray qualification failed.");
  };
  try {
    mkdirSync(output, { recursive: true });
    const privateHome = join(temporary, "home");
    mkdirSync(privateHome, { mode: 0o700 });
    const payload = join(temporary, "payload.swift");
    writeGlideTrayPayload(payload);
    const executable = join(temporary, "tray-fixture");
    run("xcrun", [
      "swiftc",
      "-parse-as-library",
      join(desktop, "native/mac-glide-tray.swift"),
      join(desktop, "native/mac-glide-tray-fixture.swift"),
      payload,
      "-o",
      executable,
    ]);
    run(executable, [output], {
      env: { ...process.env, HOME: privateHome, CFFIXED_USER_HOME: privateHome },
    });
    const helper = ensureMacGlideHelper();
    run(process.execPath, [fileURLToPath(import.meta.url), "--protocol", helper], {
      env: { ...process.env, HOME: privateHome, CFFIXED_USER_HOME: privateHome },
    });
    process.stdout.write(`Native tray qualification passed. Screenshots: ${output}\n`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
