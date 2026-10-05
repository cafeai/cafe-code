import { describe, expect, it } from "vitest";
import {
  readClaudeForkMessageIds,
  rememberClaudeForkMessage,
  remapClaudeForkMessageIds,
} from "./claudeForkMessageIds.ts";

const source = "79000000-0000-4000-8000-000000000001";
const target = "79000000-0000-4000-8000-000000000002";
const oldId = "79000000-0000-4000-8000-000000000003";
const newId = "79000000-0000-4000-8000-000000000004";

describe("private Claude fork message correspondence", () => {
  it("rejects malformed, oversized and unsafe UUID identities", () => {
    for (const value of [
      null,
      [],
      { x: { nativeId: "../private", turnId: oldId } },
      { ["x".repeat(1025)]: { nativeId: oldId, turnId: oldId } },
      Object.fromEntries(
        Array.from({ length: 4097 }, (_, index) => [index, { nativeId: oldId, turnId: oldId }]),
      ),
    ]) {
      expect(() => readClaudeForkMessageIds(value)).toThrow();
    }
  });
  it("bounds admission and keeps ambiguous reused Cafe identities unavailable to a replacement", () => {
    const ids = readClaudeForkMessageIds(undefined);
    for (let index = 0; index < 4097; index += 1)
      rememberClaudeForkMessage({
        ids,
        messageId: `m${index}`,
        nativeId: `79000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
        turnId: oldId,
        turnCount: 1,
      });
    expect(Object.keys(ids)).toHaveLength(4096);
    expect(ids.m0).toBeUndefined();
    rememberClaudeForkMessage({
      ids,
      messageId: "m1",
      nativeId: newId,
      turnId: newId,
      turnCount: 1,
    });
    expect(ids.m1).toEqual({ nativeId: source, turnId: oldId, turnCount: 1 });
  });
  it("retains only SDK-proven prefix lineage and namespaces copied message/turn identities", () => {
    const ids = readClaudeForkMessageIds({
      selected: { nativeId: oldId, turnId: oldId, turnCount: 1 },
      excluded: { nativeId: source, turnId: source, turnCount: 2 },
    });
    const entry = {
      type: "assistant",
      uuid: newId,
      sessionId: target,
      forkedFrom: { sessionId: source, messageUuid: oldId },
    };
    expect(
      remapClaudeForkMessageIds({
        ids,
        entries: [entry],
        sourceSessionId: source,
        targetSessionId: target,
        targetThreadId: "branch",
      }),
    ).toEqual({
      "copy:branch:selected": { nativeId: newId, turnId: `copy:branch:${oldId}`, turnCount: 1 },
    });
    for (const entries of [
      [entry, entry],
      [entry, { ...entry, forkedFrom: { sessionId: source, messageUuid: source } }],
      [{ ...entry, sessionId: source }],
      [{ ...entry, forkedFrom: { sessionId: target, messageUuid: oldId } }],
    ])
      expect(() =>
        remapClaudeForkMessageIds({
          ids,
          entries,
          sourceSessionId: source,
          targetSessionId: target,
        }),
      ).toThrow();
  });
});
