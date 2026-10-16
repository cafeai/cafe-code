import { assert, describe, it } from "@effect/vitest";
import { encodeClaudeProjectDirectoryName } from "./ClaudeAdapter.ts";
describe("Claude project directory encoding", () => {
  it("matches upstream punctuation replacement and bounded long-path hashing", () => {
    assert.equal(
      encodeClaudeProjectDirectoryName(String.raw`C:\Users\mike\work.dir`),
      "C--Users-mike-work-dir",
    );
    assert.equal(encodeClaudeProjectDirectoryName("a".repeat(201)), `${"a".repeat(200)}-rkvsv5`);
  });
});
