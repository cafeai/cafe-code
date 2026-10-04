import type { ProviderSkillsResult } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import type { ProviderInstance } from "./ProviderDriver.ts";

/** Bind one metadata result to the exact instance object, not merely its reused
 * public id. A settings/account replacement retires the old discovery result. */
export const discoverBoundProviderSkills = (
  resolveInstance: Effect.Effect<Pick<ProviderInstance, "enabled" | "discoverSkills"> | undefined>,
  cwd: string,
): Effect.Effect<ProviderSkillsResult> =>
  Effect.gen(function* () {
    const instance = yield* resolveInstance;
    if (!instance?.enabled || !instance.discoverSkills)
      return { status: "disabled" as const, skills: [] };
    const result = yield* instance.discoverSkills(cwd);
    return (yield* resolveInstance) === instance
      ? result
      : { status: "unavailable" as const, skills: [] };
  });
