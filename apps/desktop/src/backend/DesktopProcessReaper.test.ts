import { assert, describe, it } from "@effect/vitest";

import {
  matchesDesktopBackendProcess,
  matchesProviderRuntimeProcess,
  parseUnixProcessList,
} from "./DesktopProcessReaper.ts";

describe("DesktopProcessReaper", () => {
  it("parses ps output and classifies Cafe Code backend processes", () => {
    const backendEntryPath = "/repo/apps/server/dist/bin.mjs";
    const processes = parseUnixProcessList(`
      101     1 /Electron ${backendEntryPath} provider-daemon --bootstrap-fd 3
      102   101 /Electron ${backendEntryPath} provider-supervisor --bootstrap-fd 3
      103   200 /Electron ${backendEntryPath} --bootstrap-fd 3
      104   200 /Electron /other/apps/server/dist/bin.mjs provider-daemon --bootstrap-fd 3
    `);

    assert.equal(processes.length, 4);
    assert.deepEqual(
      processes
        .filter((processSnapshot) =>
          matchesProviderRuntimeProcess(processSnapshot, backendEntryPath),
        )
        .map((processSnapshot) => processSnapshot.pid),
      [101, 102],
    );
    assert.deepEqual(
      processes
        .filter((processSnapshot) =>
          matchesDesktopBackendProcess(processSnapshot, backendEntryPath),
        )
        .map((processSnapshot) => processSnapshot.pid),
      [103],
    );
  });
});
