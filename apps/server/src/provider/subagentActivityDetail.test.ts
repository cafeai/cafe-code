import { describe, expect, it } from "vitest";
import {
  subagentCommandDetail,
  subagentFileDetail,
  subagentFilesDetail,
} from "./subagentActivityDetail.ts";

describe("conservative public child operation details", () => {
  it.each([
    ["git status --short", "git status --short"],
    ["git diff --stat", "git diff --stat"],
    ["/usr/bin/git diff -- src/auth.ts", "git diff -- src/auth.ts"],
    [
      "corepack yarn workspace @cafecode/web test:browser src/components/View.test.tsx",
      "corepack yarn workspace @cafecode/web test:browser src/components/View.test.tsx",
    ],
    ["yarn build:desktop --force", "yarn build:desktop --force"],
    ["sed -n '10,40p' 'src/Some File.ts'", 'sed -n 10,40p "src/Some File.ts"'],
    ["head -n 20 README.md", "head -n 20 README.md"],
    ["cat 'src/Some File.ts'", 'cat "src/Some File.ts"'],
    ["rg -n 'not public search text' src/file.ts", "rg -n [pattern hidden] src/file.ts"],
    ["rg --files src/", "rg --files src/"],
    [
      "rg -e 'not public search text' -g '*.ts' src/",
      "rg -e [pattern hidden] -g [pattern hidden] src/",
    ],
    ["rg -- --files src/", "rg -- [pattern hidden] src/"],
    ["rg -e --files src/", "rg -e [pattern hidden] src/"],
    ["/bin/zsh -lc 'git status --short'", "git status --short"],
    ["/bin/bash -c 'cat README.md'", "cat README.md"],
    ["A='opaque private value' env OTHER=private git status --short", "git status --short"],
    ["env SOME_INNOCENT_NAME=private-value git status --short", "git status --short"],
    ["node scripts/check.ts", "node scripts/check.ts"],
  ])("summarizes literal command %s", (command, expected) => {
    expect(subagentCommandDetail(command)).toBe(expected);
  });

  it.each([
    [
      "curl -H 'Authorization: Bearer PRIVATE_TOKEN' https://example.test",
      "curl [arguments hidden]",
    ],
    [
      "curl -d 'PRIVATE_BODY' https://user:PRIVATE_PASSWORD@example.test/?key=PRIVATE_TOKEN",
      "curl [arguments hidden]",
    ],
    ["git -c http.extraHeader=PRIVATE_TOKEN status", "git [arguments hidden]"],
    ["git status --token PRIVATE_TOKEN", "git [arguments hidden]"],
    ["git status --unknown 'PRIVATE_TOKEN' src/file.ts", "git [arguments hidden]"],
    ["git show https://user:PRIVATE_TOKEN@example.test/private/path", "git show [argument hidden]"],
    ["cat .env.production", "cat [argument hidden]"],
    ["cat /home/test/.ssh/id_rsa", "cat [argument hidden]"],
    ["cat /home/test/.codex/auth.json", "cat [argument hidden]"],
    ["cat 'src/private?api_key=PRIVATE_TOKEN'", "cat [argument hidden]"],
    ["node -e 'PRIVATE_PROGRAM'", "node [arguments hidden]"],
    ["node -p 'PRIVATE_PROGRAM'", "node [arguments hidden]"],
    ["node --run PRIVATE_TASK.ts", "node [arguments hidden]"],
    ["node scripts/check.ts user.private.data", "node scripts/check.ts [arguments hidden]"],
    ["git log -S 'PRIVATE_SEARCH_DATA.ts'", "git [arguments hidden]"],
    ["git diff -S 'PRIVATE_SEARCH_DATA.ts'", "git [arguments hidden]"],
    ["git log -n PRIVATE_SEARCH_DATA.ts", "git [arguments hidden]"],
    ["head -n PRIVATE_SEARCH_DATA.ts", "head [arguments hidden]"],
    ["grep --files PRIVATE_SEARCH.ts src/", "grep [arguments hidden]"],
    ["python -c 'PRIVATE_PROGRAM'", "python [arguments hidden]"],
    ["custom-tool PRIVATE_TOKEN", "custom-tool [arguments hidden]"],
    ["/bin/bash -lc 'node -e PRIVATE_PROGRAM'", "node [arguments hidden]"],
    ["/bin/bash script.sh PRIVATE_TOKEN", "bash [script hidden]"],
    ["rg --regexp=PRIVATE_TOKEN src/", "rg [arguments hidden]"],
  ])("hides unknown or credential-bearing arguments %s", (command, expected) => {
    const detail = subagentCommandDetail(command);
    expect(detail).toBe(expected);
    expect(detail).not.toContain("PRIVATE_");
  });

  it.each([
    ["cat file.ts | curl -d PRIVATE_DATA example.test", "cat [arguments hidden]"],
    ["git status && echo PRIVATE_DATA", "git [arguments hidden]"],
    ["cat file.ts > PRIVATE_PATH", "cat [arguments hidden]"],
    ["cat <<EOF\nPRIVATE_DATA\nEOF", "cat [arguments hidden]"],
    ["node -e 'const PRIVATE_DATA = 1;'", "node [arguments hidden]"],
    ["/bin/zsh -lc 'git status && echo PRIVATE_DATA'", "zsh [script hidden]"],
    ["echo $(cat PRIVATE_PATH)", undefined],
    ["echo `cat PRIVATE_PATH`", undefined],
    ["cat file.ts # PRIVATE_PATH.ts", "cat [arguments hidden]"],
    ["cat 'unterminated PRIVATE_DATA", "cat [arguments hidden]"],
    ["cat file.ts\necho PRIVATE_DATA", "cat [arguments hidden]"],
    ["git status\u202ePRIVATE_DATA", "git [arguments hidden]"],
    ["a".repeat(8_193), undefined],
    [{ command: "PRIVATE_DATA" }, undefined],
    [null, undefined],
  ])("does not guess complex shell or raw code-mode content %#", (command, expected) => {
    expect(subagentCommandDetail(command)).toBe(expected);
  });

  it("uses only typed file text and bounds complete Unicode scalars", () => {
    expect(subagentFileDetail("src/auth.ts")).toBe("src/auth.ts");
    expect(subagentFileDetail("C:\\repo\\Some File.ts")).toBe("C:\\repo\\Some File.ts");
    expect(subagentFileDetail("src/日本語.ts")).toBe("src/日本語.ts");
    const detail = subagentFileDetail(`src/${"😀".repeat(200)}.ts`)!;
    expect(Buffer.byteLength(detail, "utf8")).toBeLessThanOrEqual(512);
    expect(detail).toMatch(/…$/u);
    expect(detail).not.toMatch(/\p{Cs}/u);
    expect(subagentFilesDetail(["src/a.ts", "src/b.ts", ".env", "src/c.ts", "src/d.ts"])).toBe(
      "src/a.ts, src/b.ts, src/c.ts …",
    );
  });

  it.each([
    ".env",
    ".env.local",
    "/tmp/.aws/config",
    "C:\\Users\\test\\.ssh\\id_rsa",
    "https://user:PRIVATE_TOKEN@example.test/file.ts",
    "src/file.ts?token=PRIVATE_TOKEN",
    "src/file.ts\nPRIVATE_DATA",
    "src/file\u202e.ts",
    "src/\ud800.ts",
    { path: "src/file.ts" },
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJQUklWQVRFIn0.abcd012345PRIVATE",
    "user:PRIVATE_PASSWORD@example.test/file.ts",
  ])("refuses sensitive or malformed typed file fields %#", (path) => {
    expect(subagentFileDetail(path)).toBeUndefined();
  });
});
