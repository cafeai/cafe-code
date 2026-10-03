import { EnvironmentId } from "@cafecode/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supportsStandaloneChats } from "./standaloneChats";

const fixtures = vi.hoisted(() => ({
  primary: null as unknown,
  saved: new Map<string, unknown>(),
}));
vi.mock("../environments/primary", () => ({
  readPrimaryEnvironmentDescriptor: () => fixtures.primary,
}));
vi.mock("../environments/runtime/catalog", () => ({
  getSavedEnvironmentRuntimeState: (id: string) => fixtures.saved.get(id),
}));

describe("standalone capability ownership", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  beforeEach(() => {
    fixtures.primary = null;
    fixtures.saved.clear();
  });
  it("fails closed for missing or old descriptors", () => {
    expect(supportsStandaloneChats(local)).toBe(false);
    fixtures.primary = { environmentId: local, capabilities: {} };
    expect(supportsStandaloneChats(local)).toBe(false);
  });
  it("never borrows a primary or sibling environment's capability", () => {
    fixtures.primary = { environmentId: local, capabilities: { standaloneChats: true } };
    expect(supportsStandaloneChats(local)).toBe(true);
    expect(supportsStandaloneChats(remote)).toBe(false);
    fixtures.saved.set(remote, {
      descriptor: { environmentId: local, capabilities: { standaloneChats: true } },
    });
    expect(supportsStandaloneChats(remote)).toBe(false);
    fixtures.saved.set(remote, {
      descriptor: { environmentId: remote, capabilities: { standaloneChats: true } },
    });
    expect(supportsStandaloneChats(remote)).toBe(true);
  });
});
