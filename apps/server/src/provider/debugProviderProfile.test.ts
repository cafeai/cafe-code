// @effect-diagnostics nodeBuiltinImport:off
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import * as NodePath from "node:path";
import { tmpdir } from "node:os";

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

import {
  applyDebugProviderSettingsDefaults,
  debugProviderHome,
  describeProviderDataProfiles,
  prepareDebugProviderHome,
  resolveProviderProfileAdmission,
} from "./debugProviderProfile.ts";

const profile = {
  dataProfile: "debug" as const,
  baseDir: NodePath.resolve("fixture-profile", ".debug"),
};
const instanceId = ProviderInstanceId.make("personal");
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

function admission(
  driver = "codex",
  config: unknown = {},
  environment: ReadonlyArray<{ name: string; value: string; sensitive: boolean }> = [],
) {
  return resolveProviderProfileAdmission({
    profile,
    instanceId,
    entry: { driver: ProviderDriverKind.make(driver), environment },
    config,
    enabled: true,
    baseEnvironment: {
      PATH: "fixture-bin",
      HOME: NodePath.resolve("production-home"),
      USERPROFILE: NodePath.resolve("production-home"),
      CODEX_HOME: NodePath.resolve("production-codex"),
      CODEX_SQLITE_HOME: NodePath.resolve("production-codex-sqlite"),
      CLAUDE_CONFIG_DIR: NodePath.resolve("production-claude"),
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "production-keychain",
      GROK_HOME: NodePath.resolve("production-grok"),
      OPENAI_API_KEY: "inherited-secret",
      ANTHROPIC_AUTH_TOKEN: "inherited-secret",
      XAI_API_KEY: "inherited-secret",
    },
  });
}

describe("Debug provider profile admission", () => {
  it("describes owner-only manual setup targets without provider construction, credentials or native IO", () => {
    const profiles = describeProviderDataProfiles(profile, {
      [instanceId]: {
        driver: ProviderDriverKind.make("codex"),
        enabled: false,
        environment: [{ name: "OPENAI_API_KEY", value: "private-fixture-secret", sensitive: true }],
      },
      [ProviderInstanceId.make("shared")]: {
        driver: ProviderDriverKind.make("axiom"),
        enabled: true,
        debugStateSharing: true,
      },
      [ProviderInstanceId.make("unknown")]: {
        driver: ProviderDriverKind.make("future_driver"),
        enabled: true,
      },
      [ProviderInstanceId.make("invalid")]: {
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        config: "invalid",
      },
    });
    expect(profiles?.[instanceId]).toEqual({
      scope: "unconfigured",
      nativeHome: debugProviderHome(profile, "codex", instanceId),
    });
    expect(profiles?.[ProviderInstanceId.make("shared")]).toEqual({ scope: "shared" });
    expect(profiles?.[ProviderInstanceId.make("unknown")]).toEqual({ scope: "unconfigured" });
    expect(profiles?.[ProviderInstanceId.make("invalid")]).toEqual({ scope: "unconfigured" });
    expect(JSON.stringify(profiles)).not.toContain("private-fixture-secret");
    expect(
      describeProviderDataProfiles({ ...profile, dataProfile: "production" }, {}),
    ).toBeUndefined();
  });
  it("disables every fresh built-in without changing Production defaults", () => {
    const settings = decodeSettings(applyDebugProviderSettingsDefaults({}));
    expect(Object.values(settings.providers).every((value) => !value.enabled)).toBe(true);
    expect(
      Object.values(settings.providerInstances).every((value) => value.enabled === false),
    ).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.providers.codex.enabled).toBe(true);
    expect(
      DEFAULT_SERVER_SETTINGS.providerInstances[ProviderInstanceId.make("axiom")]?.enabled,
    ).toBe(true);
  });

  it("preserves deliberate choices through sparse settings reloads", () => {
    const settings = decodeSettings(
      applyDebugProviderSettingsDefaults({
        providers: { codex: { enabled: true } },
        providerInstances: {
          personal: { driver: "codex", enabled: true },
          external: { driver: "future_driver", enabled: true, debugStateSharing: true },
          disabled: { driver: "grok", enabled: false, config: { enabled: true } },
        },
      }),
    );
    expect(settings.providers.codex.enabled).toBe(true);
    expect(settings.providers.claudeAgent.enabled).toBe(false);
    expect(settings.providerInstances[ProviderInstanceId.make("personal")]?.enabled).toBe(true);
    expect(settings.providerInstances[ProviderInstanceId.make("external")]?.debugStateSharing).toBe(
      true,
    );
    expect(settings.providerInstances[ProviderInstanceId.make("disabled")]?.enabled).toBe(false);
  });

  for (const driver of ["codex", "claudeAgent", "grok"]) {
    it(`pins ${driver} helpers and native launches to one private account`, () => {
      const result = admission(driver);
      expect(result.kind).toBe("admitted");
      if (result.kind !== "admitted") throw new Error("Expected private admission");
      const home = debugProviderHome(profile, driver, instanceId);
      expect(result.nativeHome).toBe(home);
      expect(result.config).toMatchObject({ homePath: home });
      expect(result.processEnvironment).toMatchObject({
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: home,
        CODEX_SQLITE_HOME: home,
        CLAUDE_CONFIG_DIR: NodePath.join(home, ".claude"),
        GROK_HOME: home,
        PATH: "fixture-bin",
      });
      expect(result.processEnvironment.OPENAI_API_KEY).toBeUndefined();
      expect(result.processEnvironment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(result.processEnvironment.XAI_API_KEY).toBeUndefined();
      expect(result.processEnvironment.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
    });
  }

  it("does not silently replace explicit external homes, shadow history or Claude settings flags", () => {
    expect(admission("codex", { homePath: "~/.codex" }).kind).toBe("refused");
    expect(admission("codex", { shadowHomePath: "~/.codex-other" }).kind).toBe("refused");
    expect(admission("claudeAgent", { launchArgs: "--settings outside.json" }).kind).toBe(
      "refused",
    );
    expect(
      admission("grok", {}, [{ name: "grok_home", value: "outside", sensitive: false }]).kind,
    ).toBe("refused");
    expect(
      admission("codex", {}, [{ name: "CODEX_AUTH_JSON", value: "outside.json", sensitive: true }])
        .kind,
    ).toBe("refused");
  });

  it("allows deliberately configured credentials without inheriting the terminal account", () => {
    const result = admission("claudeAgent", {}, [
      { name: "ANTHROPIC_API_KEY", value: "explicit-fixture-key", sensitive: true },
    ]);
    expect(result.kind).toBe("admitted");
    if (result.kind !== "admitted") throw new Error("Expected private admission");
    expect(result.processEnvironment.ANTHROPIC_API_KEY).toBe("explicit-fixture-key");
    expect(result.processEnvironment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("keeps removal tombstones through a real native Node child with extendEnv enabled", async () => {
    const fixtureKey = "CODEX_DEBUG_PROFILE_FIXTURE_TOKEN";
    const previous = process.env[fixtureKey];
    process.env[fixtureKey] = "synthetic-fixture-only";
    try {
      const result = resolveProviderProfileAdmission({
        profile,
        instanceId,
        entry: { driver: ProviderDriverKind.make("codex") },
        config: {},
        enabled: true,
        baseEnvironment: { [fixtureKey]: "synthetic-fixture-only" },
      });
      if (result.kind !== "admitted") throw new Error("Expected private admission");
      expect(Object.hasOwn(result.processEnvironment, fixtureKey)).toBe(true);
      expect(result.processEnvironment[fixtureKey]).toBeUndefined();
      const received = await Effect.runPromise(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawner.spawn(
            ChildProcess.make(
              process.execPath,
              ["-e", `process.stdout.write(String(process.env.${fixtureKey} === undefined))`],
              {
                env: result.processEnvironment,
                extendEnv: true,
                stdin: "ignore",
                stderr: "ignore",
              },
            ),
          );
          const stdout = yield* collectUint8StreamText({ stream: child.stdout, maxBytes: 16 });
          const exit = yield* child.exitCode;
          expect(Number(exit)).toBe(0);
          return stdout;
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      );
      expect(received.truncated).toBe(false);
      expect(received.text).toBe("true");
    } finally {
      if (previous === undefined) delete process.env[fixtureKey];
      else process.env[fixtureKey] = previous;
    }
  });

  it("requires explicit sharing for unsupported native homes and keeps disabling authoritative", () => {
    for (const driver of ["axiom", "opencode", "future_driver"]) {
      expect(admission(driver).kind).toBe("refused");
      const input = {
        profile,
        instanceId,
        entry: { driver: ProviderDriverKind.make(driver), debugStateSharing: true },
        config: {},
        enabled: true,
        baseEnvironment: { HOME: "deliberately-shared" },
      };
      expect(resolveProviderProfileAdmission(input)).toMatchObject({
        kind: "admitted",
        processEnvironment: { HOME: "deliberately-shared" },
      });
      expect(resolveProviderProfileAdmission({ ...input, enabled: false }).kind).toBe("refused");
    }
  });

  it("leaves Production native home and auth behavior unchanged", () => {
    const config = { homePath: "~/.codex", shadowHomePath: "~/.codex-account" };
    const environment = { HOME: "existing-home", OPENAI_API_KEY: "existing-key" };
    const result = resolveProviderProfileAdmission({
      profile: { ...profile, dataProfile: "production" },
      instanceId,
      entry: { driver: ProviderDriverKind.make("codex") },
      config,
      enabled: false,
      baseEnvironment: environment,
    });
    expect(result).toEqual({ kind: "admitted", config, processEnvironment: environment });
  });

  it("does not alias case-distinct account ids on Windows", () => {
    expect(debugProviderHome(profile, "codex", ProviderInstanceId.make("Personal"))).not.toBe(
      debugProviderHome(profile, "codex", ProviderInstanceId.make("personal")),
    );
  });

  it("creates only a private synthetic home and refuses directory aliases without modifying their target", async () => {
    const temporary = await mkdtemp(NodePath.join(tmpdir(), "cafe-debug-provider-profile-"));
    const outside = await mkdtemp(NodePath.join(tmpdir(), "cafe-debug-provider-outside-"));
    try {
      const localProfile = { dataProfile: "debug" as const, baseDir: temporary };
      const home = debugProviderHome(localProfile, "codex", instanceId);
      await prepareDebugProviderHome(localProfile, home);
      await writeFile(NodePath.join(outside, "sentinel"), "unchanged", { mode: 0o600 });
      await link(NodePath.join(outside, "sentinel"), NodePath.join(home, "auth.json"));
      await expect(prepareDebugProviderHome(localProfile, home)).rejects.toThrow(
        "native account state contains an unsafe alias",
      );
      expect(await readFile(NodePath.join(outside, "sentinel"), "utf8")).toBe("unchanged");
      await rm(NodePath.join(home, "auth.json"));
      await rm(NodePath.join(temporary, "provider-homes"), { recursive: true });
      await symlink(
        outside,
        NodePath.join(temporary, "provider-homes"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await expect(prepareDebugProviderHome(localProfile, home)).rejects.toThrow(
        "unsafe directory alias",
      );
      expect(await readFile(NodePath.join(outside, "sentinel"), "utf8")).toBe("unchanged");
      await expect(
        prepareDebugProviderHome(localProfile, NodePath.join(outside, "outside")),
      ).rejects.toThrow("escaped its data profile");
    } finally {
      await rm(temporary, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
