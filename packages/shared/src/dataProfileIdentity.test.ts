import { describe, expect, it } from "vitest";
import { dataProfileIdentity } from "./dataProfileIdentity.ts";

describe("dataProfileIdentity", () => {
  it("binds both the exact profile and admitted effective root without exposing paths", () => {
    const root = "/private/synthetic/cafe";
    const identity = dataProfileIdentity("production", root);
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(dataProfileIdentity("production", root)).toBe(identity);
    expect(dataProfileIdentity("debug", root)).not.toBe(identity);
    expect(dataProfileIdentity("production", `${root}/.debug`)).not.toBe(identity);
    expect(identity).not.toContain(root);
    expect(dataProfileIdentity("debug", "/a\0b")).not.toBe(dataProfileIdentity("debug", "/a"));
  });
});
