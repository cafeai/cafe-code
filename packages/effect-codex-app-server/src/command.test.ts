import { assert, it } from "vitest";
import { makeCodexCommand } from "./command.ts";

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
