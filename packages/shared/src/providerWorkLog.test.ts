import { describe, expect, it } from "vitest";
import { isExcludedWorkLogOperation, readWorkLogOperationIdentity } from "./providerWorkLog.ts";

describe("shared work-log operation identity", () => {
  it("joins native task echoes only through their explicit display correlation", () => {
    for (const kind of ["task.started", "task.progress", "task.completed"]) {
      expect(
        readWorkLogOperationIdentity({
          kind,
          payload: {
            taskId: "separate-task",
            workLogToolCallId: "\u3000command-id\ufeff",
          },
        }),
      ).toEqual({ kind: "tool", id: "command-id" });
      expect(
        isExcludedWorkLogOperation({ kind, payload: { workLogToolCallId: "command-id" } }, [
          { kind: "tool", id: "command-id" },
        ]),
      ).toBe(true);
      for (const workLogToolCallId of [
        undefined,
        null,
        42,
        " ",
        "bad\u0000id",
        "bad\u202eid",
        "x".repeat(4_097),
      ]) {
        expect(
          readWorkLogOperationIdentity({
            kind,
            payload: {
              taskId: "command-id",
              itemId: "command-id",
              data: { toolCallId: "command-id" },
              workLogToolCallId,
            },
          }),
        ).toBeUndefined();
      }
      const payload = Object.defineProperty({}, "workLogToolCallId", {
        get: () => {
          throw new Error("must not read");
        },
      });
      expect(readWorkLogOperationIdentity({ kind, payload })).toBeUndefined();
      expect(
        readWorkLogOperationIdentity({
          kind,
          payload: Object.create({ workLogToolCallId: "command-id" }),
        }),
      ).toBeUndefined();
    }
  });
  it("uses explicit ACP identity before native item identity and trims both consistently", () => {
    for (const kind of ["tool.started", "tool.updated", "tool.completed"]) {
      expect(
        readWorkLogOperationIdentity({
          kind,
          payload: { itemId: "native", data: { toolCallId: "\u00a0 explicit \u2029" } },
        }),
      ).toEqual({ kind: "tool", id: "explicit" });
      for (const toolCallId of [undefined, null, 42, " \t "]) {
        expect(
          readWorkLogOperationIdentity({
            kind,
            payload: { itemId: "\u3000native\ufeff", data: { toolCallId } },
          }),
        ).toEqual({ kind: "tool", id: "native" });
      }
    }
  });

  it("keeps tools and public summaries separate and ignores other activity kinds", () => {
    const exclusions = [{ kind: "tool" as const, id: "same-id" }];
    expect(
      isExcludedWorkLogOperation(
        { kind: "tool.updated", payload: { itemId: "same-id" } },
        exclusions,
      ),
    ).toBe(true);
    expect(
      isExcludedWorkLogOperation(
        { kind: "reasoning.summary", payload: { itemId: "same-id" } },
        exclusions,
      ),
    ).toBe(false);
    expect(
      readWorkLogOperationIdentity({ kind: "runtime.warning", payload: { itemId: "same-id" } }),
    ).toBeUndefined();
  });

  it("rejects malformed identities without borrowing a fallback or invoking accessors", () => {
    for (const toolCallId of ["bad\u0000id", "bad\u202eid", "x".repeat(4_097)]) {
      expect(
        readWorkLogOperationIdentity({
          kind: "tool.updated",
          payload: { itemId: "valid-fallback", data: { toolCallId } },
        }),
      ).toBeUndefined();
    }
    const data = Object.defineProperty({}, "toolCallId", {
      get: () => {
        throw new Error("must not read");
      },
    });
    expect(
      readWorkLogOperationIdentity({ kind: "tool.updated", payload: { itemId: "native", data } }),
    ).toEqual({ kind: "tool", id: "native" });
    expect(
      readWorkLogOperationIdentity({
        kind: "tool.updated",
        payload: Object.create({ itemId: "inherited" }),
      }),
    ).toBeUndefined();
  });
});
