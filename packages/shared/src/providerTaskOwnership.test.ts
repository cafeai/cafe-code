import { describe, expect, it } from "vitest";
import {
  providerTaskOwnerAvatarSeed,
  readProviderTaskOwnerPayload,
} from "./providerTaskOwnership.ts";

const runtimeId = "00000000-0000-4000-8000-000000000001";
const session = { subagentRuntimeId: runtimeId, orchestrationStatus: "ready" as const };
const child = { type: "child" as const, id: "exact-child" };

describe("finite provider task owner presentation", () => {
  it("reconstructs only finite received fields while preserving exact child seeds", () => {
    expect(
      readProviderTaskOwnerPayload({ taskOwner: { ...child, privateExtra: "not-public" } }),
    ).toEqual(child);
    expect(
      readProviderTaskOwnerPayload({
        taskOwner: { type: "root", id: "not-an-actor", privateExtra: "not-public" },
      }),
    ).toEqual({ type: "root" });
    expect(
      readProviderTaskOwnerPayload({ taskOwner: { type: "child", id: " child  id " } }),
    ).toEqual({ type: "child", id: " child  id " });
    for (const taskOwner of [
      undefined,
      null,
      [],
      {},
      { type: "other", id: "child" },
      { type: "child", id: "" },
      { type: "child", id: "x".repeat(513) },
      { type: "child", id: "bad\u0000" },
      { type: "child", id: "bad\u202e" },
      {
        type: "child",
        id: {
          toString: () => {
            throw Error("never coerce");
          },
        },
      },
    ])
      expect(readProviderTaskOwnerPayload({ taskOwner })).toBeUndefined();
    expect(
      readProviderTaskOwnerPayload({ taskOwner: { type: "child", id: "x".repeat(512) } }),
    ).toEqual({ type: "child", id: "x".repeat(512) });
  });

  it("never reads inherited fields or executes payload/owner accessors", () => {
    let calls = 0;
    const getter = () => {
      calls++;
      throw Error("never invoke");
    };
    const values = [
      Object.create({ taskOwner: child }),
      Object.defineProperty({}, "taskOwner", { get: getter }),
      { taskOwner: Object.create(child) },
      { taskOwner: Object.defineProperty({ id: "exact-child" }, "type", { get: getter }) },
      { taskOwner: Object.defineProperty({ type: "child" }, "id", { get: getter }) },
      { taskOwner: Object.assign([], child) },
    ];
    for (const value of values) expect(readProviderTaskOwnerPayload(value)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("requires the exact valid current generation, never controls or receiver targets", () => {
    const payload = { taskOwner: child, nativeWorkRuntimeId: runtimeId };
    expect(providerTaskOwnerAvatarSeed(payload, session)).toBe(child.id);
    for (const candidate of [
      null,
      { ...session, subagentRuntimeId: "00000000-0000-4000-8000-000000000002" },
      { ...session, orchestrationStatus: "stopped" as const },
      { ...session, orchestrationStatus: "error" as const },
      { ...session, subagentRuntimeId: undefined },
    ])
      expect(providerTaskOwnerAvatarSeed(payload, candidate)).toBeUndefined();
    for (const value of [
      { taskOwner: child },
      { ...payload, nativeWorkRuntimeId: "invalid" },
      { nativeWorkRuntimeId: runtimeId, data: { taskOwner: child, receiverThreadIds: [child.id] } },
      { taskOwner: { type: "root" }, nativeWorkRuntimeId: runtimeId },
      { taskOwner: child, individualTaskControl: { runtimeId } },
      Object.create(payload),
      Object.defineProperty({ taskOwner: child }, "nativeWorkRuntimeId", {
        get: () => {
          throw Error("no getter");
        },
      }),
    ])
      expect(providerTaskOwnerAvatarSeed(value, session)).toBeUndefined();
    expect(
      providerTaskOwnerAvatarSeed(
        { ...payload, nativeWorkRuntimeId: "invalid" },
        { ...session, subagentRuntimeId: "invalid" },
      ),
    ).toBeUndefined();
  });
});
