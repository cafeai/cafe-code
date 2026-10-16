import {
  DEFAULT_UNIFIED_SETTINGS,
  ProviderInstanceId,
  ThreadId,
  type ProviderSkillsInput,
  type ServerProvider,
} from "@cafecode/contracts";
import { expect, it } from "vitest";
import { providerSkillsScopeRevision } from "./providerSkillsScope";
const input: ProviderSkillsInput = {
  instanceId: ProviderInstanceId.make("personal"),
  context: { kind: "thread", threadId: ThreadId.make("chat") },
};
it("invalidates only workspace/account configuration, not periodic provider metadata", () => {
  const snapshot: ServerProvider = {
    instanceId: input.instanceId,
    driver: "codex" as ServerProvider["driver"],
    enabled: true,
    installed: true,
    version: "0.160.0",
    status: "ready",
    auth: { status: "authenticated", email: "old@example.test" },
    checkedAt: "2026-10-05T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const scope = {
    cwd: "/saved/worktree",
    instanceId: input.instanceId,
    settings: DEFAULT_UNIFIED_SETTINGS,
    snapshot,
  };
  const before = providerSkillsScopeRevision(scope);
  expect(
    providerSkillsScopeRevision({
      ...scope,
      snapshot: {
        ...snapshot,
        checkedAt: "2026-10-05T00:00:05.000Z",
        models: [{ slug: "new", name: "New", isCustom: false, capabilities: {} }],
        message: "Periodic probe completed",
      },
    }),
  ).toBe(before);
  expect(providerSkillsScopeRevision({ ...scope, cwd: "/moved/worktree" })).not.toBe(before);
  expect(
    providerSkillsScopeRevision({
      ...scope,
      snapshot: { ...snapshot, auth: { status: "authenticated", email: "new@example.test" } },
    }),
  ).not.toBe(before);
  expect(
    providerSkillsScopeRevision({
      ...scope,
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: {
          [input.instanceId]: { driver: snapshot.driver, config: { homePath: "/changed/home" } },
        },
      },
    }),
  ).not.toBe(before);
  const sensitiveSettings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [input.instanceId]: {
        driver: snapshot.driver,
        config: { homePath: "/private/provider/home", credential: "private-config-canary" },
        environment: [{ name: "API_KEY", value: "private-environment-canary", sensitive: true }],
      },
    },
  };
  const opaque = providerSkillsScopeRevision({ ...scope, settings: sensitiveSettings });
  expect(opaque).not.toContain("private-config-canary");
  expect(opaque).not.toContain("private-environment-canary");
  expect(opaque).not.toContain("/private/provider/home");
  expect(
    providerSkillsScopeRevision({
      ...scope,
      settings: sensitiveSettings,
      snapshot: { ...snapshot, checkedAt: "2026-10-05T00:00:10.000Z" },
    }),
  ).toBe(opaque);
});
