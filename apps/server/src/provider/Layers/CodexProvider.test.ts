import { CodexSettings } from "@cafecode/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { describe, expect, it } from "vitest";

import {
  CODEX_MODEL_LIST_MAX_MODELS,
  CODEX_MODEL_LIST_MAX_PAGES,
  checkCodexCliProviderStatus,
  checkCodexProviderStatus,
  fallbackCodexModelsFromSettings,
  finalizeCodexModelListRefresh,
  makeCodexHealthProbeCommand,
  makeCodexModelListCommand,
  makePendingCodexProvider,
  requestAllCodexModelsWithClient,
  readCodexUsageIdentity,
  type CodexAppServerProviderSnapshot,
} from "./CodexProvider.ts";
import { terminateProbeChild } from "../providerSnapshot.ts";

const decodeProviderJsonString = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeProviderJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

describe("private reset account identity", () => {
  const identity = (accountId: string | undefined, tokenRevision: number) => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: "same-user", revision: tokenRevision })).toString("base64url")}.signature`;
    return Effect.runPromise(
      readCodexUsageIdentity(decodeCodexSettings({ homePath: "/mock-codex-home" }), {}).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () =>
              Effect.succeed(
                JSON.stringify({
                  auth_mode: "chatgpt",
                  tokens: { access_token: token, account_id: accountId },
                }),
              ),
          }),
        ),
        Effect.provide(Path.layer),
      ),
    );
  };

  it("keeps a known user/workspace stable across token refresh but distinguishes workspaces", async () => {
    expect(await identity("personal", 1)).toEqual(await identity("personal", 2));
    expect(await identity("personal", 1)).not.toEqual(await identity("work", 1));
  });

  it("invalidates a rotated credential when the workspace identity is unavailable", async () => {
    expect(await identity(undefined, 1)).not.toEqual(await identity(undefined, 2));
  });
});

const makeModel = (slug: string): CodexSchema.V2ModelListResponse__Model => ({
  defaultReasoningEffort: "medium",
  description: `${slug} description`,
  displayName: slug,
  hidden: false,
  id: slug,
  isDefault: false,
  model: slug,
  supportedReasoningEfforts: [
    {
      description: "Medium",
      reasoningEffort: "medium",
    },
  ],
});

const makeModelListClient = (
  request: (
    payload: CodexSchema.V2ModelListParams,
  ) => Effect.Effect<CodexSchema.V2ModelListResponse, never>,
): CodexClient.CodexAppServerClientShape =>
  ({
    request: ((method: string, payload: CodexSchema.V2ModelListParams) => {
      expect(method).toBe("model/list");
      return request(payload);
    }) as CodexClient.CodexAppServerClientShape["request"],
  }) as CodexClient.CodexAppServerClientShape;

describe("Codex account-scoped fallback catalogue", () => {
  const retired = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"];
  const settings = decodeCodexSettings({});
  const chatGptAuth = { status: "authenticated", type: "chatgpt" };

  it("omits only retired built-ins after conclusive ChatGPT authentication", () => {
    const baseline = fallbackCodexModelsFromSettings(settings);
    expect(baseline.filter((row) => retired.includes(row.slug)).map((row) => row.slug)).toEqual(
      retired,
    );
    expect(fallbackCodexModelsFromSettings(settings, chatGptAuth)).toEqual(
      baseline.filter((row) => !retired.includes(row.slug)),
    );
    expect(fallbackCodexModelsFromSettings(settings, chatGptAuth)[0]?.slug).toBe("gpt-6-astra");
  });

  it.each([
    undefined,
    null,
    { status: "unknown", type: "chatgpt" },
    { status: "unauthenticated", type: "chatgpt" },
    { status: "authenticated", type: "apiKey" },
    { status: "authenticated", type: "amazonBedrock" },
    { status: "authenticated" },
    { type: "chatgpt" },
    { status: "authenticated", type: "CHATGPT" },
    [{ status: "authenticated", type: "chatgpt" }],
  ])("keeps API and inconclusive authentication fallback unchanged (%j)", (auth) => {
    expect(fallbackCodexModelsFromSettings(settings, auth)).toEqual(
      fallbackCodexModelsFromSettings(settings),
    );
  });

  it("does not invoke getters or borrow inherited/revoked-proxy authentication", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({ type: "chatgpt" }, "status", {
      get: () => {
        getterCalls += 1;
        return "authenticated";
      },
    });
    const inherited: unknown = Object.create(chatGptAuth);
    const revoked = Proxy.revocable(chatGptAuth, {});
    revoked.revoke();
    const trapped = new Proxy(chatGptAuth, {
      getOwnPropertyDescriptor: () => {
        throw new Error("Synthetic descriptor refusal");
      },
    });
    for (const auth of [accessor, inherited, revoked.proxy, trapped]) {
      expect(fallbackCodexModelsFromSettings(settings, auth)).toEqual(
        fallbackCodexModelsFromSettings(settings),
      );
    }
    expect(getterCalls).toBe(0);
  });

  it("retains explicit retired custom rows with their own original controls and ordering", () => {
    const configured = decodeCodexSettings({
      customModels: ["gpt-5.3-codex-spark", "gpt-5.5", "gpt-5.4-mini", "gpt-5.4"],
    });
    const baseline = fallbackCodexModelsFromSettings(settings);
    const models = fallbackCodexModelsFromSettings(configured, chatGptAuth);
    expect(models.slice(-4).map((row) => row.slug)).toEqual(configured.customModels);
    for (const slug of retired) {
      const original = baseline.find((row) => row.slug === slug);
      expect(original).toBeDefined();
      expect(models.filter((row) => row.slug === slug)).toEqual([{ ...original, isCustom: true }]);
    }
    const spark = models.find((row) => row.slug === "gpt-5.3-codex-spark");
    expect(spark?.capabilities?.optionDescriptors).toMatchObject([
      { id: "reasoningEffort", currentValue: "high" },
    ]);
    expect(spark?.capabilities?.optionDescriptors).toHaveLength(1);
    expect(configured.customModels).toEqual([
      "gpt-5.3-codex-spark",
      "gpt-5.5",
      "gpt-5.4-mini",
      "gpt-5.4",
    ]);
    // Native custom supplementation retains the existing unknown-control
    // policy; the new static filter cannot replace any authoritative row.
    const native = [{ slug: "native", name: "Native", isCustom: false, capabilities: null }];
    expect(finalizeCodexModelListRefresh(native, ["gpt-5.5"])?.[1]).toEqual({
      slug: "gpt-5.5",
      name: "gpt-5.5",
      isCustom: true,
      capabilities: null,
    });
  });

  it.each([
    { login: "Logged in using ChatGPT", auth: chatGptAuth, filtered: true },
    {
      login: "Logged in using an API key - synthetic",
      auth: { status: "authenticated", type: "apiKey" },
      filtered: false,
    },
    {
      login: "Logged in using access token",
      auth: { status: "authenticated", type: "accessToken" },
      filtered: false,
    },
    {
      login: "Unrecognized synthetic successful login",
      auth: { status: "unknown" },
      filtered: false,
    },
  ])(
    "labels actual lightweight CLI status as fallback for $login",
    async ({ login, auth, filtered }) => {
      const commands: ReadonlyArray<string>[] = [];
      let fileReads = 0;
      const spawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
        commands.push(command.args);
        expect(command.command).toBe("synthetic-codex");
        expect(command.options.env).toEqual({ CAFE_TEST_ONLY: "catalogue" });
        const stdout =
          command.args.length === 1 && command.args[0] === "--version"
            ? "codex-cli 0.162.1"
            : command.args.length === 2 &&
                command.args[0] === "login" &&
                command.args[1] === "status"
              ? login
              : undefined;
        if (stdout === undefined) return Effect.die("Unexpected provider command");
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(stdout)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      });
      const snapshot = await Effect.runPromise(
        checkCodexCliProviderStatus(
          decodeCodexSettings({ binaryPath: "synthetic-codex", homePath: "" }),
          { CAFE_TEST_ONLY: "catalogue" },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(
            FileSystem.FileSystem,
            FileSystem.makeNoop({
              readFileString: () => {
                fileReads += 1;
                return Effect.die("No fixture or inherited authentication home is available");
              },
            }),
          ),
          Effect.provide(Path.layer),
        ),
      );
      expect(commands).toEqual([["--version"], ["login", "status"]]);
      expect(fileReads).toBe(0);
      expect(snapshot.auth).toMatchObject(auth);
      expect(snapshot.codexModelCatalogSource).toBe("fallback");
      expect(snapshot).not.toHaveProperty("versionAdvisory");
      expect(snapshot.models).toEqual(fallbackCodexModelsFromSettings(settings, auth));
      expect(snapshot.models.some((row) => retired.includes(row.slug))).toBe(!filtered);
      expect(snapshot.probePhases?.map(({ phase, outcome }) => ({ phase, outcome }))).toEqual([
        { phase: "version", outcome: "success" },
        { phase: "login-status", outcome: "success" },
        { phase: "account-usage", outcome: "skipped" },
      ]);
    },
  );

  it("marks pending and disabled static drafts fallback without borrowing future authentication", async () => {
    for (const enabled of [true, false]) {
      const snapshot = await Effect.runPromise(
        makePendingCodexProvider(decodeCodexSettings({ enabled })),
      );
      expect(snapshot.codexModelCatalogSource).toBe("fallback");
      expect(snapshot.models).toEqual(fallbackCodexModelsFromSettings(settings));
      expect(snapshot.auth).toEqual({ status: "unknown" });
      expect(snapshot).not.toHaveProperty("versionAdvisory");
    }
  });
});

describe("Codex catalogue producer provenance", () => {
  const models = [{ slug: "gpt-5.5", name: "Native GPT-5.5", isCustom: false, capabilities: null }];
  const makeSnapshot = (): CodexAppServerProviderSnapshot => ({
    account: {
      account: { type: "chatgpt", email: "synthetic@example.invalid", planType: "plus" },
      requiresOpenaiAuth: true,
    },
    version: "0.162.1",
    models,
    skills: [],
  });
  const status = (snapshot: CodexAppServerProviderSnapshot) =>
    Effect.runPromise(
      checkCodexProviderStatus(decodeCodexSettings({}), () => Effect.succeed(snapshot), {}).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Injected snapshot must not launch a process")),
        ),
      ),
    );

  it.each(["native", "fallback"] as const)(
    "carries explicit own %s provenance without filtering native rows",
    async (source) => {
      const snapshot = await status({ ...makeSnapshot(), codexModelCatalogSource: source });
      expect(snapshot.codexModelCatalogSource).toBe(source);
      expect(snapshot.models).toEqual(models);
      expect(snapshot).not.toHaveProperty("versionAdvisory");
    },
  );

  it("keeps missing, inherited, accessor and malformed provenance unknown", async () => {
    let getterCalls = 0;
    const inherited = makeSnapshot();
    Object.setPrototypeOf(inherited, { codexModelCatalogSource: "native" });
    const accessor = Object.defineProperty(makeSnapshot(), "codexModelCatalogSource", {
      get: () => {
        getterCalls += 1;
        return "native";
      },
    });
    const malformed = Object.defineProperty(makeSnapshot(), "codexModelCatalogSource", {
      value: "provider-defined-native",
    });
    for (const native of [makeSnapshot(), inherited, accessor, malformed]) {
      const snapshot = await status(native);
      expect(snapshot).not.toHaveProperty("codexModelCatalogSource");
      expect(snapshot.models).toEqual(models);
    }
    expect(getterCalls).toBe(0);
  });

  it("marks full-status disabled custom-only fallback without executing its probe", async () => {
    let probes = 0;
    const snapshot = await Effect.runPromise(
      checkCodexProviderStatus(
        decodeCodexSettings({ enabled: false, customModels: ["gpt-5.5"] }),
        () => {
          probes += 1;
          return Effect.succeed(makeSnapshot());
        },
        {},
      ).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Disabled status must not launch a process")),
        ),
      ),
    );
    expect(probes).toBe(0);
    expect(snapshot.codexModelCatalogSource).toBe("fallback");
    expect(snapshot.models).toEqual([
      { slug: "gpt-5.5", name: "gpt-5.5", isCustom: true, capabilities: null },
    ]);
  });

  it.each([
    { label: "ChatGPT native", type: "chatgpt", requiresAuth: true, empty: false, failed: false },
    { label: "API native", type: "apiKey", requiresAuth: true, empty: false, failed: false },
    { label: "unknown native", type: "unknown", requiresAuth: false, empty: false, failed: false },
    { label: "native empty", type: "chatgpt", requiresAuth: true, empty: true, failed: false },
    {
      label: "unauthenticated early return",
      type: "unknown",
      requiresAuth: true,
      empty: false,
      failed: false,
    },
    {
      label: "failed model discovery",
      type: "chatgpt",
      requiresAuth: true,
      empty: false,
      failed: true,
    },
  ])(
    "labels $label only after the real typed native model/list exchange",
    async ({ type, requiresAuth, empty, failed }) => {
      const methods: string[] = [];
      const commands: ReadonlyArray<string>[] = [];
      const account =
        type === "chatgpt"
          ? { type: "chatgpt", email: "synthetic@example.invalid", planType: "plus" }
          : type === "apiKey"
            ? { type: "apiKey" }
            : null;
      const earlyReturn = account === null && requiresAuth;
      const snapshot = await Effect.runPromise(
        Effect.gen(function* () {
          // Exercise the production full probe and JSONL codec, not a callback
          // invocation as proof. The peer owns only these finite metadata replies;
          // no native provider, profile, filesystem, HTTP or paid turn is involved.
          const output = yield* Queue.unbounded<Uint8Array>();
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          const decodeRequest = Schema.decodeUnknownSync(
            Schema.Struct({
              id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
              method: Schema.String,
              params: Schema.optionalKey(Schema.Unknown),
            }),
          );
          let pending = "";
          const spawner = ChildProcessSpawner.make((command) => {
            if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
            expect(command.command).toBe("synthetic-codex");
            commands.push(command.args);
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.never,
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.forEach((chunk: Uint8Array) =>
                  Effect.gen(function* () {
                    pending += decoder.decode(chunk, { stream: true });
                    const lines = pending.split("\n");
                    pending = lines.pop() ?? "";
                    for (const line of lines) {
                      const request = decodeRequest(decodeProviderJsonString(line));
                      methods.push(request.method);
                      if (request.id === undefined) {
                        expect(request.method).toBe("initialized");
                        continue;
                      }
                      let result: unknown;
                      switch (request.method) {
                        case "initialize":
                          result = {
                            userAgent: "synthetic/0.162.1",
                            codexHome: process.cwd(),
                            platformFamily: "synthetic",
                            platformOs: "synthetic",
                          };
                          break;
                        case "account/read":
                          expect(request.params).toEqual({});
                          result = { account, requiresOpenaiAuth: requiresAuth };
                          break;
                        case "account/rateLimits/read":
                          result = { rateLimits: {} };
                          break;
                        case "skills/list":
                          expect(request.params).toEqual({ cwds: [process.cwd()] });
                          result = { data: [] };
                          break;
                        case "model/list":
                          expect(request.params).toEqual({ limit: 100 });
                          result = { data: empty ? [] : [makeModel("gpt-5.5")] };
                          break;
                        default:
                          return yield* Effect.die("Unexpected metadata or paid request");
                      }
                      yield* Queue.offer(
                        output,
                        encoder.encode(
                          `${encodeProviderJsonString({
                            id: request.id,
                            ...(failed && request.method === "model/list"
                              ? {
                                  error: {
                                    code: -32603,
                                    message: "Synthetic model discovery refused",
                                  },
                                }
                              : { result }),
                          })}\n`,
                        ),
                      );
                    }
                  }),
                ),
                stdout: Stream.fromQueue(output),
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            );
          });
          return yield* checkCodexProviderStatus(
            decodeCodexSettings({
              binaryPath: "synthetic-codex",
              homePath: "",
              customModels: ["custom-model"],
            }),
            undefined,
            { CAFE_TEST_ONLY: "native-catalogue" },
          ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        }).pipe(Effect.scoped),
      );
      expect(commands).toEqual([["app-server"]]);
      expect(methods.slice(0, 3)).toEqual(["initialize", "initialized", "account/read"]);
      expect(methods.slice(3).sort()).toEqual(
        earlyReturn
          ? []
          : [...(account ? ["account/rateLimits/read"] : []), "model/list", "skills/list"].sort(),
      );
      expect(snapshot.codexModelCatalogSource).toBe(earlyReturn || failed ? "fallback" : "native");
      expect(snapshot.models.map((row) => row.slug)).toEqual(
        earlyReturn || failed || empty ? ["custom-model"] : ["gpt-5.5", "custom-model"],
      );
      expect(snapshot.models.find((row) => row.slug === "custom-model")?.isCustom).toBe(true);
      if (!earlyReturn && !failed && !empty) {
        expect(snapshot.models[0]).toMatchObject({
          slug: "gpt-5.5",
          name: "GPT-5.5",
          isCustom: false,
        });
        const options = snapshot.models[0]?.capabilities?.optionDescriptors;
        expect(options?.find((entry) => entry.id === "reasoningEffort")).toMatchObject({
          currentValue: "medium",
          options: [{ id: "medium", isDefault: true }],
        });
        const tier = options?.find((entry) => entry.id === "serviceTier");
        expect(tier).toMatchObject({ options: [{ id: "default", label: "Standard" }] });
        expect(tier).not.toHaveProperty("currentValue");
      }
      if (earlyReturn || failed) expect(snapshot.status).toBe("error");
      else expect(snapshot.status).toBe("ready");
      // Only the diagnostic full catalogue can be known empty. The model-only
      // producer's existing empty-as-inconclusive rule remains unchanged.
      expect(finalizeCodexModelListRefresh([], ["custom-model"])).toBeUndefined();
    },
  );
});

describe("Codex CLI health probe command", () => {
  // These inert command spellings exercise the real factory on each CI host.
  // The package's separate injected-platform matrix covers all three policies
  // locally; neither test resolves a provider or inherits a real auth home.
  it.each([
    { binaryPath: "C:\\Program Files\\Cafe & Codex\\codex.exe", windowsShell: false },
    { binaryPath: "C:\\Program Files\\Cafe & Codex\\CODEX.COM", windowsShell: false },
    { binaryPath: "C:\\Program Files\\Cafe & Codex\\codex.cmd", windowsShell: true },
    { binaryPath: "C:\\Program Files\\Cafe & Codex\\codex.bat", windowsShell: true },
    { binaryPath: "codex", windowsShell: true },
    { binaryPath: "/test-only/codex", windowsShell: true },
  ])("preserves probe ownership and argv for $binaryPath", ({ binaryPath, windowsShell }) => {
    const environment = { CAFE_TEST_ONLY: "literal & | %fixture%", CODEX_HOME: "overridden" };
    const homePath = "isolated-codex-home";
    const args = ["", "two words", 'embedded"quote', "a&b|c", "%CAFE_TEST_ONLY%"];
    const health = makeCodexHealthProbeCommand(
      decodeCodexSettings({ binaryPath, homePath }),
      args,
      environment,
    );
    const models = makeCodexModelListCommand({
      binaryPath,
      homePath,
      cwd: "backend-owned-cwd",
      environment,
    });

    for (const command of [health, models]) {
      expect(command.command).toBe(binaryPath);
      expect(command.options.shell).toBe(process.platform === "win32" && windowsShell);
      expect(command.options.env).toEqual({ ...environment, CODEX_HOME: homePath });
      expect(command.options.detached).toBe(process.platform !== "win32");
      expect(command.options.killSignal).toBe("SIGKILL");
    }
    expect(health.args).toEqual(args);
    expect(models.args).toEqual(["app-server"]);
    expect(models.options.cwd).toBe("backend-owned-cwd");
  });

  it("isolates POSIX descendants and gives scope cleanup a SIGKILL backstop", () => {
    const command = makeCodexHealthProbeCommand(
      decodeCodexSettings({
        binaryPath: "/opt/codex/bin/codex",
        homePath: "/private/codex-home",
      }),
      ["--version"],
      { PATH: "/usr/bin" },
    );

    expect(command.command).toBe("/opt/codex/bin/codex");
    expect(command.args).toEqual(["--version"]);
    expect(command.options.detached).toBe(process.platform !== "win32");
    expect(command.options.killSignal).toBe("SIGKILL");
    expect(command.options.env).toMatchObject({
      PATH: "/usr/bin",
      CODEX_HOME: "/private/codex-home",
    });
  });

  it("uses the same isolated child-tree ownership for picker model/list", () => {
    const command = makeCodexModelListCommand({
      binaryPath: "/opt/codex/bin/codex",
      homePath: "/private/codex-home",
      cwd: "/private/cafe-state",
      environment: { PATH: "/usr/bin" },
    });

    expect(command.command).toBe("/opt/codex/bin/codex");
    expect(command.args).toEqual(["app-server"]);
    expect(command.options.cwd).toBe("/private/cafe-state");
    expect(command.options.detached).toBe(process.platform !== "win32");
    expect(command.options.killSignal).toBe("SIGKILL");
    expect(command.options.env).toMatchObject({
      PATH: "/usr/bin",
      CODEX_HOME: "/private/codex-home",
    });
  });

  it("waits for graceful exit before escalating a stubborn probe to SIGKILL", async () => {
    const signals: string[] = [];
    const child = {
      isRunning: Effect.succeed(true),
      kill: (options?: ChildProcess.KillOptions) => {
        signals.push(options?.killSignal ?? "SIGTERM");
        return options?.killSignal === "SIGTERM" ? Effect.never : Effect.void;
      },
    };

    const timedOut = await Effect.runPromise(
      Effect.never.pipe(
        Effect.ensuring(terminateProbeChild(child, Duration.millis(5))),
        Effect.timeoutOption(Duration.millis(5)),
      ),
    );

    expect(timedOut._tag).toBe("None");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

describe("Codex picker model/list refresh", () => {
  it("maps caller-specific Daybreak support and removes retired aliases without lending access to custom models", async () => {
    const client = makeModelListClient(() =>
      Effect.succeed({
        data: [
          {
            ...makeModel("blue"),
            availableAccessPrograms: { cyber: ["standard", "daybreakBlue"] },
          },
          {
            ...makeModel("red"),
            availableAccessPrograms: { cyber: ["standard", "daybreakBlue", "daybreakRed"] },
          },
          { ...makeModel("ordinary"), availableAccessPrograms: { cyber: ["standard"] } },
          makeModel("legacy"),
          makeModel("gpt-daybreak-blue-latest"),
          makeModel("gpt-daybreak-red-latest"),
        ],
      }),
    );
    const discovered = await Effect.runPromise(requestAllCodexModelsWithClient(client));
    const models = finalizeCodexModelListRefresh(discovered, [
      "custom",
      "gpt-daybreak-blue-latest",
    ]);
    expect(models?.map((model) => model.slug)).toEqual([
      "blue",
      "red",
      "ordinary",
      "legacy",
      "custom",
    ]);
    const options = (slug: string) =>
      models
        ?.find((model) => model.slug === slug)
        ?.capabilities?.optionDescriptors?.find((entry) => entry.id === "cyberAccessProgram");
    expect(options("blue")).toMatchObject({
      currentValue: "standard",
      options: [
        { id: "standard", label: "Off" },
        { id: "daybreakBlue", label: "Blue" },
      ],
    });
    expect(options("red")).toMatchObject({
      currentValue: "standard",
      options: [
        { id: "standard", label: "Off" },
        { id: "daybreakBlue", label: "Blue" },
        { id: "daybreakRed", label: "Red" },
      ],
    });
    expect(options("ordinary")).toBeUndefined();
    expect(options("legacy")).toBeUndefined();
    expect(options("custom")).toBeUndefined();
    expect(
      fallbackCodexModelsFromSettings(
        decodeCodexSettings({
          customModels: ["gpt-daybreak-blue-latest", "gpt-daybreak-red-latest"],
        }),
      ).some((model) => model.slug.includes("daybreak")),
    ).toBe(false);
  });
  it("lists Astra first during cold-start fallback and de-duplicates custom entries", () => {
    const models = fallbackCodexModelsFromSettings(
      decodeCodexSettings({ customModels: ["gpt-6-astra"] }),
    );
    expect(models[0]).toMatchObject({
      slug: "gpt-6-astra",
      name: "GPT-6-Astra",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          { id: "reasoningEffort", currentValue: "low" },
          { id: "fastMode", type: "boolean" },
        ],
      },
    });
    expect(models.filter((model) => model.slug === "gpt-6-astra")).toHaveLength(1);
  });

  it.each([
    ["gpt-6.1-sol", "GPT-6.1-Sol", ["low", "medium", "high", "xhigh", "max", "ultra"], "low"],
    ["gpt-6-sol", "GPT-6-Sol", ["low", "medium", "high", "xhigh", "max", "ultra"], "medium"],
    ["gpt-6-luna", "GPT-6-Luna", ["low", "medium", "high", "xhigh", "max"], "medium"],
  ] as const)(
    "provides %s fallback controls without replacing a live catalogue",
    (slug, name, efforts, defaultEffort) => {
      const fallback = fallbackCodexModelsFromSettings(
        decodeCodexSettings({ customModels: [slug] }),
      );
      expect(fallback.filter((model) => model.slug === slug)).toHaveLength(1);
      const row = fallback.find((model) => model.slug === slug);
      expect(row).toMatchObject({ slug, name, isCustom: false });
      const reasoning = row?.capabilities?.optionDescriptors?.find(
        (option) => option.id === "reasoningEffort",
      );
      expect(
        reasoning?.type === "select" ? reasoning.options.map((option) => option.id) : undefined,
      ).toEqual(efforts);
      expect(reasoning?.currentValue).toBe(defaultEffort);
      expect(row?.capabilities?.optionDescriptors).toContainEqual({
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
      });

      const live = { slug, name: "Account model", isCustom: false, capabilities: null };
      expect(finalizeCodexModelListRefresh([live], [slug])).toEqual([live]);
      const other = { ...live, slug: "other" };
      expect(finalizeCodexModelListRefresh([other], [])).toEqual([other]);
      expect(finalizeCodexModelListRefresh([other], [slug])?.[1]).toEqual({
        ...row,
        isCustom: true,
      });
    },
  );

  it("keeps live Sol 6.1 defaults and narrower backend controls authoritative", async () => {
    const efforts = ["low", "medium", "high", "xhigh", "max"];
    const client = makeModelListClient(() =>
      Effect.succeed({
        data: [
          {
            ...makeModel("gpt-6.1-sol"),
            displayName: "GPT-6.1-Sol",
            inputModalities: ["text", "image"],
            supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
              reasoningEffort,
              description: reasoningEffort,
            })),
            serviceTiers: [],
            additionalSpeedTiers: [],
          },
        ],
      }),
    );

    const discovered = await Effect.runPromise(requestAllCodexModelsWithClient(client));
    const models = finalizeCodexModelListRefresh(discovered, ["gpt-6.1-sol"]);
    expect(models).toEqual(discovered);
    expect(models).toHaveLength(1);
    expect(models?.[0]).toMatchObject({
      slug: "gpt-6.1-sol",
      name: "GPT-6.1-Sol",
      isCustom: false,
      capabilities: {
        inputModalities: ["text", "image"],
        optionDescriptors: [
          {
            id: "reasoningEffort",
            currentValue: "medium",
            options: efforts.map((id) => (id === "medium" ? { id, isDefault: true } : { id })),
          },
          { id: "serviceTier", type: "select", options: [{ id: "default" }] },
        ],
      },
    });
    expect(models?.[0]?.capabilities?.optionDescriptors).toHaveLength(2);
  });

  it("reads bounded cursor pages in provider order", async () => {
    const payloads: CodexSchema.V2ModelListParams[] = [];
    const client = makeModelListClient((payload) =>
      Effect.sync(() => {
        payloads.push(payload);
        return payload.cursor === undefined
          ? { data: [makeModel("gpt-new")], nextCursor: "page-2" }
          : { data: [makeModel("gpt-latest")], nextCursor: null };
      }),
    );

    const models = await Effect.runPromise(requestAllCodexModelsWithClient(client));
    expect(models.map((model) => model.slug)).toEqual(["gpt-new", "gpt-latest"]);
    expect(payloads).toEqual([{ limit: 100 }, { limit: 100, cursor: "page-2" }]);
  });

  it("preserves observed input restrictions and the known legacy Spark restriction", async () => {
    const client = makeModelListClient(() =>
      Effect.succeed({
        data: [
          { ...makeModel("text-only"), inputModalities: ["text"] },
          { ...makeModel("audio-only"), inputModalities: ["audio"] },
          { ...makeModel("multimodal"), inputModalities: ["text", "image", "audio"] },
          makeModel("gpt-5.3-codex-spark"),
          makeModel("legacy-model"),
        ],
      }),
    );
    const models = await Effect.runPromise(requestAllCodexModelsWithClient(client));
    expect(models.map((model) => model.capabilities?.inputModalities)).toEqual([
      ["text"],
      [],
      ["text", "image"],
      ["text"],
      ["text", "image"],
    ]);
  });

  it("discovers visible Astra with its live defaults and modern Fast tier", async () => {
    // Astra's account catalogue now defaults to Medium, while the embedded
    // pre-rollout fallback defaults to Low. Exercise the full discovery path
    // so a custom fallback cannot override the live row or remove Ultra/Fast.
    const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
    const client = makeModelListClient(() =>
      Effect.succeed({
        data: [
          {
            ...makeModel("gpt-6-astra"),
            displayName: "GPT-6-Astra",
            supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
              reasoningEffort,
              description: reasoningEffort,
            })),
            serviceTiers: [{ id: "priority", name: "Fast", description: "Priority processing" }],
          },
        ],
      }),
    );

    const discovered = await Effect.runPromise(requestAllCodexModelsWithClient(client));
    const models = finalizeCodexModelListRefresh(discovered, ["gpt-6-astra"]);
    expect(models).toHaveLength(1);
    expect(models?.[0]).toMatchObject({
      slug: "gpt-6-astra",
      name: "GPT-6-Astra",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            currentValue: "medium",
            options: efforts.map((id) => (id === "medium" ? { id, isDefault: true } : { id })),
          },
          { id: "serviceTier", type: "select", options: [{ id: "default" }, { id: "priority" }] },
        ],
      },
    });
  });

  it("keeps legacy Fast support without mistaking another service tier for Fast", async () => {
    const client = makeModelListClient(() =>
      Effect.succeed({
        data: [
          { ...makeModel("legacy-model"), additionalSpeedTiers: ["fast"] },
          { ...makeModel("mixed-model"), serviceTiers: [], additionalSpeedTiers: ["fast"] },
          {
            ...makeModel("flex-model"),
            serviceTiers: [{ id: "flex", name: "Flex", description: "Flexible processing" }],
          },
          makeModel("standard-model"),
        ],
      }),
    );

    const models = await Effect.runPromise(requestAllCodexModelsWithClient(client));
    expect(
      models.map((model) =>
        model.capabilities?.optionDescriptors?.find((option) => option.id === "serviceTier"),
      ),
    ).toMatchObject([
      { options: [{ id: "default" }, { id: "priority" }] },
      { options: [{ id: "default" }] },
      { options: [{ id: "default" }, { id: "flex" }] },
      { options: [{ id: "default" }] },
    ]);
  });

  it("bounds and sanitizes advertised tiers without selecting any paid default or borrowing custom model tiers", async () => {
    const rows = await Effect.runPromise(
      requestAllCodexModelsWithClient(
        makeModelListClient(() =>
          Effect.succeed({
            data: [
              {
                ...makeModel("live-tier-model"),
                serviceTiers: [
                  {
                    id: "ultrafast",
                    name: "Ultra fast",
                    description: "ignored native description",
                  },
                  { id: "ultrafast", name: "Duplicate", description: "ignored" },
                  { id: "default", name: "Paid fake standard", description: "ignored" },
                  { id: "bad id", name: "Fake", description: "ignored" },
                  { id: "secret", name: "bad\u202ename", description: "ignored" },
                  ...Array.from({ length: 40 }, (_, index) => ({
                    id: `tier-${index}`,
                    name: `Tier ${index}`,
                    description: "ignored",
                  })),
                ],
              },
            ],
          }),
        ),
      ),
    );
    const tier = rows[0]?.capabilities?.optionDescriptors?.find(
      (entry) => entry.id === "serviceTier",
    );
    expect(tier).not.toHaveProperty("currentValue");
    expect(tier?.type).toBe("select");
    if (tier?.type !== "select") throw new Error("Missing advertised tiers");
    expect(tier.options[0]).toEqual({ id: "default", label: "Standard" });
    expect(tier.options.filter((option) => option.id === "ultrafast")).toEqual([
      { id: "ultrafast", label: "Ultra fast" },
    ]);
    expect(tier.options.length).toBeLessThanOrEqual(33);
    expect(
      tier.options.some(
        (option) => option.isDefault || option.id === "secret" || option.id === "bad id",
      ),
    ).toBe(false);
    const all = finalizeCodexModelListRefresh(rows, ["custom-unknown-model"]);
    expect(
      all
        ?.find((entry) => entry.slug === "custom-unknown-model")
        ?.capabilities?.optionDescriptors?.some((entry) => entry.id === "serviceTier"),
    ).toBe(false);
  });

  it("fails closed on repeated cursors and bounded page/model overflow", async () => {
    let repeatedCalls = 0;
    const repeatedCursorExit = await Effect.runPromise(
      requestAllCodexModelsWithClient(
        makeModelListClient(() =>
          Effect.sync(() => ({
            data: [makeModel(`gpt-repeated-${(repeatedCalls += 1)}`)],
            nextCursor: "same-cursor",
          })),
        ),
      ).pipe(Effect.exit),
    );
    expect(repeatedCursorExit._tag).toBe("Failure");
    expect(repeatedCalls).toBe(2);

    let pageCalls = 0;
    const pageBoundExit = await Effect.runPromise(
      requestAllCodexModelsWithClient(
        makeModelListClient(() =>
          Effect.sync(() => ({
            data: [makeModel(`gpt-page-${(pageCalls += 1)}`)],
            nextCursor: `cursor-${pageCalls}`,
          })),
        ),
      ).pipe(Effect.exit),
    );
    expect(pageBoundExit._tag).toBe("Failure");
    expect(pageCalls).toBe(CODEX_MODEL_LIST_MAX_PAGES);

    let modelCalls = 0;
    const modelBoundExit = await Effect.runPromise(
      requestAllCodexModelsWithClient(
        makeModelListClient(() =>
          Effect.sync(() => {
            modelCalls += 1;
            return {
              data: Array.from({ length: CODEX_MODEL_LIST_MAX_MODELS + 1 }, (_, index) =>
                makeModel(index === 0 ? "gpt-daybreak-blue-latest" : `gpt-overflow-${index}`),
              ),
              nextCursor: null,
            };
          }),
        ),
      ).pipe(Effect.exit),
    );
    expect(modelBoundExit._tag).toBe("Failure");
    expect(modelCalls).toBe(1);
  });

  it("keeps an empty upstream catalogue inconclusive even with custom models", () => {
    expect(finalizeCodexModelListRefresh([], ["custom-model"])).toBeUndefined();

    const upstream = [
      {
        slug: "gpt-provider",
        name: "GPT Provider",
        isCustom: false,
        capabilities: null,
      },
    ] as const;
    expect(
      finalizeCodexModelListRefresh(upstream, ["custom-model"])?.map((model) => model.slug),
    ).toEqual(["gpt-provider", "custom-model"]);
  });

  it("does not resurrect omitted GPT-5.5 from the cold fallback or erase an explicit custom selection", () => {
    const upstream = [
      {
        slug: "gpt-6.1-sol",
        name: "Account Sol",
        isCustom: false,
        capabilities: null,
      },
    ];
    // A conclusive native catalogue replaces the generic startup fallback.
    // The official October 14 retirement excludes API-key sessions, so keep
    // explicit user-entered IDs rather than applying a wall-clock/global ban.
    expect(finalizeCodexModelListRefresh(upstream, [])).toEqual(upstream);
    expect(finalizeCodexModelListRefresh(upstream, ["gpt-5.5"])).toEqual([
      ...upstream,
      { slug: "gpt-5.5", name: "gpt-5.5", isCustom: true, capabilities: null },
    ]);
    const api = [{ slug: "gpt-5.5", name: "Account GPT-5.5", isCustom: false, capabilities: null }];
    expect(finalizeCodexModelListRefresh(api, [])).toEqual(api);
  });

  it("uses exact bundled controls for custom Astra absent from the live catalog", () => {
    const upstream = [
      {
        slug: "gpt-provider",
        name: "GPT Provider",
        isCustom: false,
        capabilities: null,
      },
    ] as const;

    const models = finalizeCodexModelListRefresh(upstream, ["gpt-6-astra"]);
    const astra = models?.find((model) => model.slug === "gpt-6-astra");
    expect(astra).toMatchObject({
      slug: "gpt-6-astra",
      name: "GPT-6-Astra",
      isCustom: true,
    });
    expect(astra?.capabilities?.optionDescriptors).toEqual([
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low", isDefault: true },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra High" },
          { id: "max", label: "Max" },
          { id: "ultra", label: "Ultra" },
        ],
        currentValue: "low",
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
      },
    ]);
  });

  it("does not replace an Astra model advertised by app-server", () => {
    const upstreamAstra = {
      slug: "gpt-6-astra",
      name: "Server Astra",
      isCustom: false,
      capabilities: null,
    } as const;

    expect(finalizeCodexModelListRefresh([upstreamAstra], ["gpt-6-astra"])).toEqual([
      upstreamAstra,
    ]);
  });
});
