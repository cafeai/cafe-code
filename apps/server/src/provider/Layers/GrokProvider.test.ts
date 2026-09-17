import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
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
  writeGrokTestShim,
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
      expect(snapshot.sandbox).toEqual({ status: "not-checked" });
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
  for (const splitWarning of [false, true]) {
    it.effect(
      `reports a socket sandbox refusal when the child exits immediately (split=${splitWarning})`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cafecode-grok-sandbox-" });
            const argvLog = NodePath.join(dir, "argv.jsonl");
            const warning =
              "warning: sandbox could not be applied: socket deny resolution failed: could not resolve runtime-socket deny path /private/secret-token.sock: endpoint is a symlink\n";
            const binaryPath = yield* Effect.promise(() =>
              writeGrokTestShim({
                directory: dir,
                source: `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("grok 1.0.34\\n");
} else {
  const warning = ${JSON.stringify(warning)};
  if (${JSON.stringify(splitWarning)}) {
    process.stderr.write(warning.slice(0, 37), () => {
      setTimeout(() => process.stderr.write(warning.slice(37), () => process.exit(1)), 10);
    });
  } else {
    process.stderr.write(warning, () => process.exit(1));
  }
}
`,
              }),
            );
            const logs: unknown[] = [];
            const logger = Logger.make(({ message }) => {
              logs.push(message);
            });
            const snapshot = yield* checkGrokProviderStatus(
              decodeGrokSettings({ binaryPath }),
            ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

            expect(snapshot.installed).toBe(true);
            expect(snapshot.version).toBe("1.0.34");
            expect(snapshot.status).toBe("error");
            // No authentication happened, so neither a login failure nor a
            // successful login may be inferred from this local refusal.
            expect(snapshot.auth.status).toBe("unknown");
            expect(snapshot.sandbox).toEqual({
              status: "unavailable",
              reason: "container-socket-symlink",
            });
            expect(snapshot.message).toContain("socket is a symbolic link");
            expect(snapshot.message).toContain("has not disabled sandbox protection");
            const diagnostics = JSON.stringify({ snapshot, logs });
            expect(diagnostics).toContain("container-socket-symlink");
            expect(diagnostics).not.toContain("secret-token");
            expect(diagnostics).not.toContain("/private/");
            expect(diagnostics).not.toContain(binaryPath);
            const attempts = (yield* fs.readFileString(argvLog))
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            // There must be exactly one protected ACP attempt. Never turn an
            // enforcement failure into an off/workspace retry or run inspect
            // (which can discover user content) after failed qualification.
            expect(attempts).toEqual([
              ["--version"],
              [
                "--no-auto-update",
                "--sandbox",
                "read-only",
                "--permission-mode",
                "default",
                "agent",
                "--no-leader",
                "stdio",
              ],
            ]);
          }),
        ),
    );
  }

  it.effect("reports generic enforcement failure without relaying stderr", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* makeFakeGrok({
          prefix: "cafecode-grok-sandbox-warning-",
          versionResponse: { stdout: "grok 1.0.34\n" },
          environment: { CAFE_CODE_ACP_SANDBOX_FAILURE_WARNING: "1" },
        });
        const snapshot = yield* checkGrokProviderStatus(decodeGrokSettings({ binaryPath }));
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unknown");
        expect(snapshot.sandbox).toEqual({
          status: "unavailable",
          reason: "sandbox-unavailable",
        });
        expect(snapshot.message).toContain("could not enforce its read-only sandbox");
        expect(snapshot.message).not.toContain("mock host");
        expect(snapshot.message).not.toContain("socket");
      }),
    ),
  );

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
        expect(snapshot.sandbox).toEqual({ status: "available" });
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

  for (const allowUnsandboxedProbe of [false, true]) {
    it.effect(
      `reports unusable auth even when unsandboxed qualification consent is ${allowUnsandboxedProbe}`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const binaryPath = yield* makeQualifiedFakeGrok({ noAuth: true });
            const snapshot = yield* checkGrokProviderStatus(
              decodeGrokSettings({ binaryPath, allowUnsandboxedProbe }),
              process.cwd(),
            );
            expect(snapshot.status).toBe("warning");
            expect(snapshot.auth.status).toBe("unauthenticated");
            expect(snapshot.sandbox).toEqual({ status: "not-checked" });
            expect(snapshot.message).toContain("grok login");
          }),
        ),
    );
  }

  it.effect(
    "qualifies Full access only with explicit consent and restores protection on revocation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cafecode-grok-probe-consent-" });
          const argvLog = NodePath.join(dir, "argv.jsonl");
          const requestLog = NodePath.join(dir, "requests.jsonl");
          const binaryPath = yield* Effect.promise(() =>
            writeGrokTestShim({
              directory: dir,
              source: `
const fs = require("node:fs");
const url = require("node:url");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
if (JSON.stringify(args) === JSON.stringify(["--version"])) {
  process.stdout.write("grok 1.0.34\\n");
} else if (JSON.stringify(args) === JSON.stringify(["--no-auto-update", "inspect", "--json"])) {
  process.stdout.write('{"skills":[]}\\n');
} else if (args[args.indexOf("--sandbox") + 1] === "read-only") {
  process.stderr.write("warning: sandbox could not be applied: mock host enforcement failure\\n", () => process.exit(1));
} else {
  process.env.CAFE_CODE_ACP_REQUEST_LOG_PATH = ${JSON.stringify(requestLog)};
  import(url.pathToFileURL(${JSON.stringify(mockAgentPath)}).href).catch(() => process.exit(12));
}
`,
            }),
          );

          // Bind the same synthetic executable once for the complete consent
          // lifecycle so revocation cannot accidentally reuse a ready snapshot
          // or trigger a second, unsandboxed attempt after protected failure.
          yield* provideGrokTestProcessSpawner(
            binaryPath,
            Effect.gen(function* () {
              const allowed = yield* checkGrokProviderStatusLive(
                decodeGrokSettings({ binaryPath, allowUnsandboxedProbe: true }),
              );
              expect(allowed.status).toBe("ready");
              expect(allowed.auth.status).toBe("authenticated");
              expect(allowed.sandbox).toEqual({ status: "not-checked" });
              expect(allowed.message).toBe(
                "Grok is ready for Full access without a sandbox. Protected access modes and Plan still require a working sandbox.",
              );

              for (const settings of [
                decodeGrokSettings({ binaryPath, allowUnsandboxedProbe: false }),
                decodeGrokSettings({ binaryPath }),
              ]) {
                const protectedResult = yield* checkGrokProviderStatusLive(settings);
                expect(protectedResult.status).toBe("error");
                expect(protectedResult.auth.status).toBe("unknown");
                expect(protectedResult.sandbox).toEqual({
                  status: "unavailable",
                  reason: "sandbox-unavailable",
                });
              }
            }),
          );

          const attempts = (yield* fs.readFileString(argvLog))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const acpArgs = (sandbox: string) => [
            "--no-auto-update",
            "--sandbox",
            sandbox,
            "--permission-mode",
            "default",
            "agent",
            "--no-leader",
            "stdio",
          ];
          expect(attempts).toEqual([
            ["--version"],
            acpArgs("off"),
            ["--no-auto-update", "inspect", "--json"],
            ["--version"],
            acpArgs("read-only"),
            ["--version"],
            acpArgs("read-only"),
          ]);
          const requests = (yield* fs.readFileString(requestLog))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(requests.map((request) => request.method)).toEqual([
            "process/argv",
            "initialize",
            "authenticate",
            "session/new",
            "x.ai/interject",
          ]);
          expect(
            requests.find((request) => request.method === "session/new")?.params.mcpServers,
          ).toEqual([]);
          // The capability request targets an impossible session and carries no
          // prompt text. No model prompt, provider command, or permission bypass
          // is authorized by the health-check opt-in.
          expect(requests.at(-1)?.params).toEqual({
            sessionId: "cafe-code-capability-probe-no-session",
            text: "",
            interjectionId: "cafe-code-capability-probe",
          });
        }),
      ),
  );
});
