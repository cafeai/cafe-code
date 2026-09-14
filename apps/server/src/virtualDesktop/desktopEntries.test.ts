import { describe, expect, it } from "vitest";
import { parseDesktopExec } from "./desktopEntries.ts";
const context = { name: "A browser", file: "/fixture/app.desktop", icon: "browser" };
describe("desktop application argument parsing", () => {
  it("expands field codes without interpreting shell substitutions", () => {
    expect(
      parseDesktopExec(
        '"/an app/browser" --name %c %i %U "$(touch file)" "`whoami`" 100%%',
        context,
      ),
    ).toEqual([
      "/an app/browser",
      "--name",
      "A browser",
      "--icon",
      "browser",
      "$(touch file)",
      "`whoami`",
      "100%",
    ]);
  });
  it("keeps empty and escaped arguments and rejects ambiguous field codes", () => {
    expect(parseDesktopExec('app "" "a\\\"b" %k', context)).toEqual([
      "app",
      "",
      'a"b',
      context.file,
    ]);
    expect(() => parseDesktopExec('app "unterminated', context)).toThrow();
    expect(() => parseDesktopExec("app --file=%u", context)).toThrow();
    expect(() => parseDesktopExec("app %v", context)).toThrow();
  });
});
