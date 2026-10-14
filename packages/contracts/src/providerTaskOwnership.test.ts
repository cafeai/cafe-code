import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { ProviderTaskOwner } from "./providerTaskOwnership.ts";
import { ProviderEvent } from "./provider.ts";
import { ProviderRuntimeEvent } from "./providerRuntime.ts";

const native = {
  id: "event",
  kind: "notification",
  provider: "codex",
  threadId: "chat",
  createdAt: "2026-10-14T00:00:00.000Z",
  method: "item/started",
  subagentRuntimeId: "00000000-0000-4000-8000-000000000001",
  payload: { item: { type: "contextCompaction", threadId: "receiver-not-source" } },
};
const runtime = {
  eventId: "event",
  provider: "codex",
  threadId: "chat",
  turnId: "turn",
  createdAt: "2026-10-14T00:00:00.000Z",
  subagentRuntimeId: native.subagentRuntimeId,
};

describe("optional provider task source ownership", () => {
  it("retains exact bounded identity without normalization and refuses unsupported records", () => {
    const decode = Schema.decodeUnknownSync(ProviderTaskOwner);
    for (const owner of [
      { type: "root" },
      { type: "child", id: "child" },
      { type: "child", id: " child  id " },
      { type: "child", id: "x".repeat(512) },
    ]) {
      expect(decode(owner)).toEqual(owner);
    }
    for (const owner of [
      null,
      [],
      {},
      { type: "other", id: "child" },
      { type: "child" },
      { type: "child", id: "" },
      { type: "child", id: "x".repeat(513) },
      { type: "child", id: "child\u0000" },
      { type: "child", id: "child\u202e" },
      { type: "child", id: 17 },
    ])
      expect(() => decode(owner)).toThrow();
  });

  it("roundtrips owner outside native data and preserves legacy omission", () => {
    const decode = Schema.decodeUnknownSync(ProviderEvent);
    const json = Schema.fromJsonString(ProviderEvent);
    const encodeJson = Schema.encodeSync(json);
    const decodeJson = Schema.decodeUnknownSync(json);
    for (const owner of [undefined, { type: "root" }, { type: "child", id: "exact-child" }]) {
      const value = { ...native, ...(owner ? { taskOwner: owner } : {}) };
      expect(decode(value)).toEqual(value);
      expect(JSON.parse(encodeJson(decode(value)))).toEqual(value);
      expect(decodeJson(JSON.stringify(value))).toEqual(value);
      expect(decodeJson(encodeJson(decode(value)))).toEqual(value);
    }
    expect(decode(native)).not.toHaveProperty("taskOwner");
    expect(() => decode({ ...native, taskOwner: { type: "child", id: "" } })).toThrow();
  });

  it("roundtrips ownership on every ordinary tool and native task lifecycle edge", () => {
    const decode = Schema.decodeUnknownSync(ProviderRuntimeEvent);
    const json = Schema.fromJsonString(ProviderRuntimeEvent);
    const encodeJson = Schema.encodeSync(json);
    const decodeJson = Schema.decodeUnknownSync(json);
    const edges = [
      { type: "item.started", itemId: "item", payload: { itemType: "context_compaction" } },
      { type: "item.updated", itemId: "item", payload: { itemType: "context_compaction" } },
      {
        type: "item.completed",
        itemId: "item",
        payload: { itemType: "context_compaction", status: "completed" },
      },
      { type: "task.started", payload: { taskId: "task", taskType: "local_bash" } },
      { type: "task.progress", payload: { taskId: "task", description: "Working" } },
      { type: "task.completed", payload: { taskId: "task", status: "completed" } },
    ];
    for (const edge of edges)
      for (const owner of [undefined, { type: "root" }, { type: "child", id: "exact-child" }]) {
        const value = {
          ...runtime,
          ...edge,
          payload: { ...edge.payload, ...(owner ? { taskOwner: owner } : {}) },
        };
        expect(decode(value)).toEqual(value);
        expect(JSON.parse(encodeJson(decode(value)))).toEqual(value);
        expect(decodeJson(JSON.stringify(value))).toEqual(value);
        expect(decodeJson(encodeJson(decode(value)))).toEqual(value);
        if (!owner) expect(decode(value).payload).not.toHaveProperty("taskOwner");
        expect(() =>
          decode({
            ...value,
            payload: { ...value.payload, taskOwner: { type: "child", id: "bad\n" } },
          }),
        ).toThrow();
      }
  });
});
