import { describe, expect, it } from "vitest";

import { parseFallbackArgs } from "./provider-update-fallback.ts";

describe("provider update fallback", () => {
  it("preserves paths with spaces without building a command string", () => {
    expect(
      parseFallbackArgs([
        "--project-dir",
        "/work/my project",
        "--claude",
        "/bin/claude",
        "--codex",
        "/bin/codex",
      ]),
    ).toEqual({
      mode: "recovery",
      projectDirectory: "/work/my project",
      claudePath: "/bin/claude",
      codexPath: "/bin/codex",
      logPath: null,
    });
  });

  it("parses a recovered-update notice without putting an error message in argv", () => {
    expect(
      parseFallbackArgs([
        "--project-dir",
        "/work/project",
        "--claude",
        "/bin/claude",
        "--codex",
        "/bin/codex",
        "--mode",
        "update-failed",
        "--log",
        "/state/update.log",
      ]),
    ).toMatchObject({ mode: "update-failed", logPath: "/state/update.log" });
  });

  it("parses a shutdown-failure notice that cannot launch a duplicate app", () => {
    expect(
      parseFallbackArgs([
        "--project-dir",
        "/work/project",
        "--claude",
        "/bin/claude",
        "--codex",
        "/bin/codex",
        "--mode",
        "shutdown-failed",
        "--log",
        "/state/update.log",
      ]),
    ).toMatchObject({ mode: "shutdown-failed", logPath: "/state/update.log" });
  });

  it("fails closed when recovery state is incomplete", () => {
    expect(() => parseFallbackArgs(["--project-dir", "/work"])).toThrow("incomplete");
  });
});
