import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { discoverBoundProviderSkills } from "./providerSkillsDiscovery.ts";

describe("provider skill discovery generation fence", () => {
  it("uses only the resolved instance and discards its result after account replacement", async () => {
    const calls: string[] = [];
    const replacement = { enabled: true };
    let current: Pick<ProviderInstance, "enabled" | "discoverSkills"> = {
      enabled: true,
      discoverSkills: (cwd: string) =>
        Effect.sync(() => {
          calls.push(cwd);
          current = replacement;
          return {
            status: "available" as const,
            skills: [{ name: "old-private-account", enabled: true }],
          };
        }),
    };
    const result = await Effect.runPromise(
      discoverBoundProviderSkills(
        Effect.sync(() => current),
        "server-authorized-cwd",
      ),
    );
    expect(calls).toEqual(["server-authorized-cwd"]);
    expect(result).toEqual({ status: "unavailable", skills: [] });
  });
  it("never launches discovery for missing, disabled or incapable instances", async () => {
    let calls = 0;
    for (const instance of [
      undefined,
      { enabled: true },
      {
        enabled: false,
        discoverSkills: () =>
          Effect.sync(() => {
            calls += 1;
            return { status: "empty" as const, skills: [] };
          }),
      },
    ]) {
      expect(
        await Effect.runPromise(
          discoverBoundProviderSkills(Effect.succeed(instance), "authorized"),
        ),
      ).toEqual({ status: "disabled", skills: [] });
    }
    expect(calls).toBe(0);
  });
  it("preserves an admitted same-instance result without publishing it into global snapshots", async () => {
    const result = { status: "available" as const, skills: [{ name: "safe", enabled: true }] };
    const instance = {
      enabled: true,
      discoverSkills: () => Effect.succeed(result),
    };
    expect(
      await Effect.runPromise(discoverBoundProviderSkills(Effect.succeed(instance), "authorized")),
    ).toBe(result);
  });
});
