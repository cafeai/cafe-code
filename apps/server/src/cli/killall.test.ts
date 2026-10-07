import { assert, describe, it } from "@effect/vitest";

import {
  classifyCafeKillallProcess,
  parsePosixProcessList,
  parseWindowsProcessList,
  selectCafeKillallTargets,
  type CafeKillallProcessSnapshot,
} from "./killall.ts";

const processSnapshot = (
  command: string,
  overrides: Partial<CafeKillallProcessSnapshot> = {},
): CafeKillallProcessSnapshot => ({
  pid: overrides.pid ?? 100,
  ppid: overrides.ppid ?? 1,
  command,
});

describe("killall process matching", () => {
  it("parses POSIX process rows", () => {
    const processes = parsePosixProcessList(`
        101     1 /usr/bin/node /repo/cafe-code/apps/server/dist/bin.mjs serve
        102   101 /Electron /repo/cafe-code/apps/server/dist/bin.mjs provider-daemon --bootstrap-fd 3
      `);

    assert.deepEqual(processes, [
      {
        pid: 101,
        ppid: 1,
        command: "/usr/bin/node /repo/cafe-code/apps/server/dist/bin.mjs serve",
      },
      {
        pid: 102,
        ppid: 101,
        command:
          "/Electron /repo/cafe-code/apps/server/dist/bin.mjs provider-daemon --bootstrap-fd 3",
      },
    ]);
  });

  it("parses Windows process rows from PowerShell JSON", () => {
    const processes = parseWindowsProcessList(
      JSON.stringify({
        ProcessId: 201,
        ParentProcessId: 1,
        Name: "node.exe",
        CommandLine:
          "node C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\@cafeai\\cafe-code\\dist\\bin.mjs serve",
      }),
    );

    assert.deepEqual(processes, [
      {
        pid: 201,
        ppid: 1,
        command:
          "node C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\@cafeai\\cafe-code\\dist\\bin.mjs serve",
      },
    ]);
  });

  it("classifies Cafe Code server, provider, desktop, and launcher processes", () => {
    assert.equal(
      classifyCafeKillallProcess(
        processSnapshot("/usr/bin/node /repo/cafe-code/apps/server/dist/bin.mjs serve"),
      ),
      "server",
    );
    assert.equal(
      classifyCafeKillallProcess(
        processSnapshot(
          "/Electron /Applications/Cafe Code.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs provider-daemon --bootstrap-fd 3",
        ),
      ),
      "provider-runtime",
    );
    assert.equal(
      classifyCafeKillallProcess(
        processSnapshot(
          "/repo/cafe-code/apps/desktop/node_modules/electron/dist/electron dist-electron/main.cjs",
        ),
      ),
      "desktop-client",
    );
    assert.equal(
      classifyCafeKillallProcess(
        processSnapshot("/usr/bin/node /repo/cafe-code/apps/desktop/scripts/start-electron.mjs"),
      ),
      "launcher",
    );
  });

  it("does not match unrelated commands that mention Cafe Code as an argument", () => {
    assert.equal(classifyCafeKillallProcess(processSnapshot("rg cafe-code")), null);
    assert.equal(
      classifyCafeKillallProcess(processSnapshot("node /tmp/script.js cafe-code")),
      null,
    );
    assert.equal(
      classifyCafeKillallProcess(processSnapshot("node /tmp/other/dist/bin.mjs serve")),
      null,
    );
  });

  it("excludes the current killall process and ancestors, then orders children first", () => {
    const processes: ReadonlyArray<CafeKillallProcessSnapshot> = [
      processSnapshot("/bin/zsh", { pid: 1, ppid: 0 }),
      processSnapshot("node /repo/cafe-code/apps/server/src/launcher.ts killall", {
        pid: 10,
        ppid: 1,
      }),
      processSnapshot("node /repo/cafe-code/apps/server/dist/bin.mjs killall", {
        pid: 11,
        ppid: 10,
      }),
      processSnapshot(
        "/repo/cafe-code/apps/desktop/node_modules/electron/dist/electron dist-electron/main.cjs",
        { pid: 20, ppid: 1 },
      ),
      processSnapshot("/Electron /repo/cafe-code/apps/server/dist/bin.mjs --bootstrap-fd 3", {
        pid: 21,
        ppid: 20,
      }),
      processSnapshot(
        "/Electron /repo/cafe-code/apps/server/dist/bin.mjs provider-daemon --bootstrap-fd 3",
        { pid: 22, ppid: 20 },
      ),
    ];

    const targets = selectCafeKillallTargets(processes, {
      currentPid: 11,
      currentParentPid: 10,
    });

    assert.deepEqual(
      targets.map((target) => [target.pid, target.role]),
      [
        [21, "server"],
        [22, "provider-runtime"],
        [20, "desktop-client"],
      ],
    );
  });
});
