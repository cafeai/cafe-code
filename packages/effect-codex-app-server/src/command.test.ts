import { assert, it, vi } from "vitest";
import { makeCodexCommand } from "./command.ts";

// Count the native resource that the public constructor may consume. No test
// path can reach the host filesystem, while removing the search bound would
// still perform every candidate probe and fail this independent cost assertion.
const candidateProbe = vi.hoisted(() =>
  vi.fn<(candidate: string) => { isFile: () => boolean }>(() => {
    throw new Error("Synthetic absent Windows executable");
  }),
);
vi.mock("node:fs", () => ({ statSync: candidateProbe }));

it.each(["darwin", "linux"] as const)(
  "leaves %s command arguments and options intact",
  (platform) => {
    const args = [
      'mcp_servers.fixture={command="node",args=["bridge with spaces.mjs"]}',
      "",
      "a&b",
    ];
    const options = {
      cwd: "/synthetic/workspace",
      env: { PATH: "/synthetic/bin" },
      detached: true,
    };
    const command = makeCodexCommand("codex.cmd", args, options, platform);
    assert.equal(command.command, "codex.cmd");
    assert.deepEqual(command.args, args);
    assert.equal(command.options.shell, false);
    assert.equal(command.options.cwd, options.cwd);
    assert.deepEqual(command.options.env, options.env);
    assert.equal(command.options.detached, true);
  },
);

it.each(["\u0000", "\r", "\n"])(
  "rejects Windows batch control characters without echoing input",
  (character) => {
    assert.throws(
      () => makeCodexCommand("codex.cmd", [`private${character}input`], {}, "win32"),
      TypeError,
      /^Invalid Windows Codex command argument\.$/u,
    );
  },
);

it("keeps explicit Windows native executables on literal argv", () => {
  const args = ['mcp_servers.fixture={command="node"}', "space & %PATH%", ""];
  const command = makeCodexCommand("C:\\Program Files\\codex.exe", args, {}, "win32");
  assert.equal(command.command, "C:\\Program Files\\codex.exe");
  assert.deepEqual(command.args, args);
  assert.equal(command.options.shell, false);
});

it("refuses an unresolved Windows command before shell admission", () => {
  // No current-directory or PATH candidate is admitted on any test host. The
  // shell operator is deliberately a separate argv token: a returned raw-shell
  // command would let it execute even when the provider itself was absent.
  // Refusing construction protects the production spawn boundary without
  // launching a shell, a provider, or even a synthetic side-effect command.
  assert.throws(
    () =>
      makeCodexCommand(
        "unavailable-cafe-fixture-codex",
        ["&", "synthetic-side-effect-must-not-run"],
        { env: { PATH: "", NoDefaultCurrentDirectoryInExePath: "1" } },
        "win32",
      ),
    TypeError,
    /^Unsupported or unavailable Windows Codex command\.$/u,
  );
});

it.each(["C:codex", "C:"])(
  "refuses drive-relative Windows command %j before probing a PATH replacement",
  (command) => {
    candidateProbe.mockClear();
    // Only the unrelated PATH executable exists in this inert filesystem. The
    // explicit C: spelling must not become a bare-name search that selects it.
    // A foreign host uses the same Windows path grammar without any native IO.
    candidateProbe.mockImplementation((candidate) => ({
      isFile: () => candidate === "C:\\tools\\codex.EXE",
    }));
    try {
      assert.throws(
        () =>
          makeCodexCommand(
            command,
            ["&", "synthetic-side-effect-must-not-run"],
            {
              cwd: "C:\\work",
              env: {
                PATH: "C:\\tools",
                PATHEXT: ".EXE",
                NoDefaultCurrentDirectoryInExePath: "1",
              },
            },
            "win32",
          ),
        TypeError,
        /^Unsupported or unavailable Windows Codex command\.$/u,
      );
      assert.equal(candidateProbe.mock.calls.length, 0);
    } finally {
      // Retire this test's successful-file observation even when the refusal
      // assertion fails, restoring the original all-absent fixture behavior.
      candidateProbe.mockReset();
    }
  },
);

it("bounds Windows PATH and PATHEXT candidate probes before refusing a missing command", () => {
  candidateProbe.mockClear();
  // These 820 short, distinct directories and the ordinary four extensions
  // require 4,100 candidates including exact-name probes. Their total string
  // size is well below the input limit, so this exercises the resource budget.
  const environment = {
    PATH: Array.from({ length: 820 }, (_, index) => `C:\\fixture${index}`).join(";"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    NoDefaultCurrentDirectoryInExePath: "1",
  };
  assert.throws(
    () => makeCodexCommand("missing-fixture-codex", [], { env: environment }, "win32"),
    TypeError,
    /^Unsupported or unavailable Windows Codex command\.$/u,
  );
  assert.isAtMost(candidateProbe.mock.calls.length, 4096);
});

it.each(["", "C:\\fixture\\codex.ps1"])(
  "refuses unsupported Windows command spelling %j without searching for a replacement",
  (command) => {
    candidateProbe.mockClear();
    assert.throws(
      () =>
        makeCodexCommand(
          command,
          ["&", "synthetic-side-effect-must-not-run"],
          { env: { PATH: "C:\\fixture", PATHEXT: ".EXE;.CMD" } },
          "win32",
        ),
      TypeError,
      /^Unsupported or unavailable Windows Codex command\.$/u,
    );
    assert.equal(candidateProbe.mock.calls.length, 0);
  },
);

it.each(["command", "PATH", "PATHEXT"] as const)(
  "refuses oversized Windows %s input without native filesystem probes",
  (name) => {
    candidateProbe.mockClear();
    assert.throws(
      () =>
        makeCodexCommand(
          name === "command" ? "x".repeat(32_768) : "missing-fixture-codex",
          [],
          {
            env: {
              PATH: "C:\\fixture",
              PATHEXT: ".EXE",
              NoDefaultCurrentDirectoryInExePath: "1",
              ...(name === "command"
                ? {}
                : {
                    [name]: name === "PATHEXT" ? `.${"x".repeat(32_767)}` : "x".repeat(32_768),
                  }),
            },
          },
          "win32",
        ),
      TypeError,
      /^Unsupported or unavailable Windows Codex command\.$/u,
    );
    assert.equal(candidateProbe.mock.calls.length, 0);
  },
);
