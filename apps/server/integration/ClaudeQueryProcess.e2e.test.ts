// @effect-diagnostics nodeBuiltinImport:off
/** Opt-in native process fixture. No Claude executable, auth, profile or model request. */
import { describe, expect, it } from "vitest";
import { makeClaudeQueryProcessObserver } from "../src/provider/claudeQueryProcess.ts";

describe("Claude query public spawn hook with an isolated Node child", () => {
  it("observes exact native exit after stdin EOF while preserving literal argv", async () => {
    const observer = makeClaudeQueryProcessObserver(undefined);
    // Explicitly exclude credentials, provider homes, PATH and user Node hooks.
    const env: NodeJS.ProcessEnv =
      process.platform === "win32"
        ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
        : {};
    const argument = "literal argument $(not-a-command) with spaces";
    const child = observer.spawnClaudeCodeProcess({
      command: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify(process.argv[1])+'\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))",
        argument,
      ],
      env,
      signal: AbortSignal.timeout(10_000),
    });
    try {
      let output = "";
      child.stdout.setEncoding("utf8");
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Synthetic child exited before readiness.")));
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
          if (output.includes("\n")) resolve();
        });
      });
      expect(JSON.parse(output.trim())).toBe(argument);
      let exited = false;
      void observer.waitForExit().then(() => {
        exited = true;
      });
      await Promise.resolve();
      expect(exited).toBe(false);
      child.stdin.end();
      await observer.waitForExit();
      expect(child.exitCode).toBe(0);
      expect(exited).toBe(true);
    } finally {
      if (child.exitCode === null && !child.signalCode) {
        child.kill("SIGKILL");
        await observer.waitForExit();
      }
    }
  }, 15_000);
});
