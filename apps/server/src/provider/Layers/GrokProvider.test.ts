import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@cafecode/contracts";

import {
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus as checkGrokProviderStatusLive,
  grokSlashCommandsFromAcp,
  parseGrokInspectSkills,
} from "./GrokProvider.ts";
import {
  provideGrokTestProcessSpawner,
  writeGrokAcpMockShim,
} from "../testUtils/grokProcessFixture.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const makeFakeGrok = Effect.fn(function* (input: {
  readonly prefix: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly versionResponse?: {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exitCode?: number;
  };
  readonly inspectResponse?: {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exitCode?: number;
  };
  readonly runAgent?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: input.prefix });
  return yield* Effect.promise(() =>
    writeGrokAcpMockShim({
      directory: dir,
      mockAgentPath,
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.versionResponse ? { versionResponse: input.versionResponse } : {}),
      ...(input.inspectResponse ? { inspectResponse: input.inspectResponse } : {}),
      ...(input.runAgent === undefined ? {} : { runAgent: input.runAgent }),
    }),
  );
});

const makeQualifiedFakeGrok = Effect.fn(function* (input?: {
  readonly noAuth?: boolean;
  readonly disableInterject?: boolean;
  readonly exposeBilling?: boolean;
}) {
  return yield* makeFakeGrok({
    prefix: "cafecode-grok-qualified-",
    environment: {
      CAFE_CODE_ACP_EMIT_AVAILABLE_COMMANDS: "1",
      ...(input?.noAuth ? { CAFE_CODE_ACP_NO_AUTH: "1" } : {}),
      ...(input?.disableInterject ? { CAFE_CODE_ACP_DISABLE_INTERJECT: "1" } : {}),
      ...(input?.exposeBilling ? { CAFE_CODE_ACP_EXPOSE_BILLING: "1" } : {}),
    },
    versionResponse: { stdout: "grok 1.0.4\n" },
    inspectResponse: {
      stdout: `${JSON.stringify({
        skills: [
          {
            name: "repository-review",
            description: "Review repository changes",
            source: { type: "user", path: "/tmp/grok/skills/repository-review/SKILL.md" },
            userInvocable: true,
          },
        ],
      })}\n`,
    },
  });
});

const checkGrokProviderStatus = (
  settings: GrokSettings,
  cwd: string = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
) =>
  provideGrokTestProcessSpawner(
    settings.binaryPath || "grok",
    checkGrokProviderStatusLive(settings, cwd, environment),
  );

describe("buildInitialGrokProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Grok");
      expect(snapshot.displayName).toBe("Grok Build");
      expect(snapshot.runtimeCapabilities?.liveSteer).toBe("unsupported");
    }),
  );
});

it("decodes Grok skills and filters commands owned by Cafe controls", () => {
  expect(
    grokSlashCommandsFromAcp([
      { name: "/compact", description: "Compact context" },
      { name: "model", description: "Switch model" },
      { name: "review", input: { hint: "focus" } },
    ]),
  ).toEqual([
    { name: "compact", description: "Compact context" },
    { name: "review", input: { hint: "focus" } },
  ]);
  expect(
    parseGrokInspectSkills(
      JSON.stringify({
        skills: [
          {
            name: "project-review",
            description: "Review this project",
            source: { path: "/workspace/project/.grok/skills/project-review/SKILL.md" },
            userInvocable: true,
          },
          {
            name: "internal-only",
            source: { path: "/tmp/internal/SKILL.md" },
            userInvocable: false,
          },
        ],
      }),
      "/workspace/project",
    ),
  ).toEqual([
    {
      name: "project-review",
      description: "Review this project",
      shortDescription: "Review this project",
      path: "/workspace/project/.grok/skills/project-review/SKILL.md",
      scope: "project",
      enabled: true,
      displayName: "project-review",
    },
  ]);
});

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken grok install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const grokPath = yield* makeFakeGrok({
            prefix: "cafecode-grok-version-",
            versionResponse: { stderr: `${secretStderr}\n`, exitCode: 2 },
            runAgent: false,
          });

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const grokPath = yield* makeFakeGrok({
            prefix: "cafecode-grok-success-",
            versionResponse: { stdout: "grok 1.0.4\n" },
            runAgent: false,
          });

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );

  it.effect("reports an authenticated compatible ACP catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* makeQualifiedFakeGrok();
        const snapshot = yield* checkGrokProviderStatus(
          decodeGrokSettings({ binaryPath }),
          process.cwd(),
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.version).toBe("1.0.4");
        expect(snapshot.models.map((model) => model.slug)).toContain("grok-build");
        const grokBuild = snapshot.models.find((model) => model.slug === "grok-build");
        expect(grokBuild?.capabilities?.optionDescriptors).toEqual([
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            currentValue: "high",
            options: [
              { id: "xhigh", label: "Extra High" },
              { id: "high", label: "High", isDefault: true },
              { id: "medium", label: "Medium" },
              { id: "low", label: "Low" },
            ],
          },
        ]);
        expect(snapshot.runtimeCapabilities?.liveSteer).toBe("supported");
        expect(snapshot.slashCommands).toEqual([
          { name: "compact", description: "Compact conversation context" },
          {
            name: "review",
            description: "Review the current changes",
            input: { hint: "optional focus" },
          },
        ]);
        expect(snapshot.skills.map((skill) => skill.name)).toEqual(["repository-review"]);
      }),
    ),
  );

  it.effect("uses Grok's billing extension when the installed ACP surface exposes it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* makeQualifiedFakeGrok({ exposeBilling: true });
        const snapshot = yield* checkGrokProviderStatus(
          decodeGrokSettings({ binaryPath }),
          process.cwd(),
        );

        expect(snapshot.accountRateLimits).toEqual({
          rateLimits: {
            limitId: "grok",
            limitName: "Grok usage",
            primary: {
              usedPercent: 1,
              windowDurationMins: 10_080,
              resetsAt: Math.floor(Date.parse("2026-08-21T08:49:34.446428+00:00") / 1_000),
            },
          },
          rateLimitsByLimitId: {
            grok: {
              limitId: "grok",
              limitName: "Grok usage",
              primary: {
                usedPercent: 1,
                windowDurationMins: 10_080,
                resetsAt: Math.floor(Date.parse("2026-08-21T08:49:34.446428+00:00") / 1_000),
              },
            },
          },
          checkedAt: snapshot.checkedAt,
        });
        expect(JSON.stringify(snapshot.accountRateLimits)).not.toContain("prepaidBalance");
      }),
    ),
  );

  it.effect("does not advertise live steer when the xAI extension is absent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* makeQualifiedFakeGrok({ disableInterject: true });
        const snapshot = yield* checkGrokProviderStatus(
          decodeGrokSettings({ binaryPath }),
          process.cwd(),
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.runtimeCapabilities?.liveSteer).toBe("unsupported");
      }),
    ),
  );

  it.effect("reports advertised-but-unusable auth without exposing provider payloads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* makeQualifiedFakeGrok({ noAuth: true });
        const snapshot = yield* checkGrokProviderStatus(
          decodeGrokSettings({ binaryPath }),
          process.cwd(),
        );
        expect(snapshot.status).toBe("warning");
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.message).toContain("grok login");
      }),
    ),
  );
});
