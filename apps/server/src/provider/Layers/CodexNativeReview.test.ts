import { CodexReviewTarget } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { codexNativeReviewParams, decodeCodexNativeReviewResponse } from "./CodexNativeReview.ts";

const isReviewTarget = Schema.is(CodexReviewTarget);

const targets: CodexReviewTarget[] = [
  { type: "uncommittedChanges" },
  { type: "baseBranch", branch: "origin/main" },
  { type: "commit", sha: "a956835d020762cb2b570053af06f643a11c0ecc" },
  { type: "custom", instructions: "Review API compatibility.\nDo not edit files." },
];
describe("native Codex review protocol", () => {
  it.each(targets)(
    "preserves the exact structured $type target and fixes inline ownership",
    async (target) => {
      expect(await Effect.runPromise(codexNativeReviewParams("native-owned", target))).toEqual({
        threadId: "native-owned",
        delivery: "inline",
        target,
      });
    },
  );
  it.each([
    { type: "baseBranch", branch: "--upload-pack=evil" },
    { type: "baseBranch", branch: "main\nother" },
    { type: "baseBranch", branch: "x".repeat(513) },
    { type: "commit", sha: "HEAD; echo secret" },
    { type: "commit", sha: "abc123" },
    { type: "custom", instructions: "x".repeat(16_001) },
    { type: "custom", instructions: "" },
    { type: "detached" },
  ])("rejects malformed/hostile targets before native I/O", async (target) => {
    expect(isReviewTarget(target)).toBe(false);
    await expect(Effect.runPromise(codexNativeReviewParams("owned", target))).rejects.toThrow(
      "Invalid native review target",
    );
  });
  it("keeps acknowledged native lifecycle status without synthesizing completion", async () => {
    const response = {
      reviewThreadId: "owned",
      turn: { id: "review-turn", status: "inProgress", items: [], error: null },
    };
    expect(await Effect.runPromise(decodeCodexNativeReviewResponse("owned", response))).toEqual(
      response,
    );
  });
  it("rejects a detached or foreign thread response without adopting its cursor", async () => {
    await expect(
      Effect.runPromise(
        decodeCodexNativeReviewResponse("owned", {
          reviewThreadId: "foreign",
          turn: { id: "review-turn", status: "inProgress", items: [] },
        }),
      ),
    ).rejects.toThrow("different review thread");
  });
  it("rejects missing or malformed acknowledgements without claiming safe replay", async () => {
    await expect(Effect.runPromise(decodeCodexNativeReviewResponse("owned", {}))).rejects.toThrow(
      "do not resend automatically",
    );
  });
});
