import {
  ThreadId as BarrelThreadId,
  ProviderDriverKind as BarrelDriver,
  ProviderInstanceId as BarrelInstance,
} from "@cafecode/contracts";
import { ThreadId } from "@cafecode/contracts/baseSchemas";
import { ProviderDriverKind, ProviderInstanceId } from "@cafecode/contracts/providerInstance";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

describe("contracts direct import bindings", () => {
  it("retains the existing ID and routing schema objects rather than recreating brands", () => {
    expect(ThreadId).toBe(BarrelThreadId);
    expect(ProviderDriverKind).toBe(BarrelDriver);
    expect(ProviderInstanceId).toBe(BarrelInstance);
    expect(ThreadId.make("thread-direct-import")).toBe(BarrelThreadId.make("thread-direct-import"));
    expect(Schema.decodeUnknownSync(ProviderInstanceId)("  codex_work  ")).toBe("codex_work");
    expect(() => Schema.decodeUnknownSync(ProviderDriverKind)("../codex")).toThrow();
  });
});
