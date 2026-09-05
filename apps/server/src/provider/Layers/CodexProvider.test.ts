import { CodexSettings } from "@cafecode/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess } from "effect/unstable/process";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { describe, expect, it } from "vitest";

import {
  CODEX_MODEL_LIST_MAX_MODELS,
  CODEX_MODEL_LIST_MAX_PAGES,
  fallbackCodexModelsFromSettings,
  finalizeCodexModelListRefresh,
  makeCodexHealthProbeCommand,
  makeCodexModelListCommand,
  requestAllCodexModelsWithClient,
} from "./CodexProvider.ts";
import { terminateProbeChild } from "../providerSnapshot.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

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

describe("Codex CLI health probe command", () => {
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
          { id: "fastMode", type: "boolean" },
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
        model.capabilities?.optionDescriptors?.some((option) => option.id === "fastMode"),
      ),
    ).toEqual([true, true, false, false]);
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
                makeModel(`gpt-overflow-${index}`),
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
