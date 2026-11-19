import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { SessionConfigOption } from "effect-acp/schema";
import { applyGeminiAcpSelection, buildGeminiAcpModels } from "./GeminiAcpSupport.ts";

type Configs = ReadonlyArray<SessionConfigOption>;
const neon = "gemini-4-neon";
const carbon = "gemini-4-carbon";
const hydrogen = "gemini-4-hydrogen";

function modelSelector(active: string, advertised: ReadonlyArray<string>): SessionConfigOption {
  return {
    id: "provider-model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: active,
    options: [
      {
        group: "gemini-family",
        name: "Gemini",
        options: advertised.map((value) => ({ value, name: value })),
      },
    ],
  };
}

function effortSelector(id: string, currentValue: string, efforts: ReadonlyArray<string>) {
  return {
    id,
    name: "Thinking level",
    category: "thought_level",
    type: "select",
    currentValue,
    options: efforts.map((value) => ({ value, name: value === "native.extra" ? "Extra" : value })),
  } satisfies SessionConfigOption;
}

function fixture(initial: Configs, respond: (id: string, value: string | boolean) => Configs) {
  const calls: Array<readonly [string, string | boolean]> = [];
  let configOptions = initial;
  return {
    calls,
    runtime: {
      getConfigOptions: Effect.sync(() => configOptions),
      setConfigOption: (id: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push([id, value]);
          configOptions = respond(id, value);
          return { configOptions };
        }),
    },
  };
}

describe("Antigravity ACP model catalogue and selection", () => {
  it("catalogues only account-advertised models and preserves negotiated values", () => {
    const models = buildGeminiAcpModels(
      [
        modelSelector(neon, [neon, hydrogen, "future-native-model"]),
        effortSelector("thinking_level", "native.extra", ["low", "native.extra"]),
      ],
      { image: true },
    );

    expect(models.map(({ slug }) => slug)).toEqual([neon, hydrogen, "future-native-model"]);
    expect(models[0]?.capabilities).toEqual({
      inputModalities: ["text", "image"],
      optionDescriptors: [
        {
          id: "reasoningEffort",
          type: "select",
          label: "Thinking level",
          options: [
            { id: "low", label: "low" },
            { id: "native.extra", label: "Extra" },
          ],
          currentValue: "native.extra",
        },
      ],
    });
    expect(models[1]?.capabilities?.optionDescriptors?.[0]).toEqual({
      id: "reasoningEffort",
      type: "select",
      label: "Thinking",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra" },
      ],
    });
    expect(models[2]?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("does not restore undocumented image or reasoning support over an explicit native restriction", () => {
    const [model] = buildGeminiAcpModels(
      [modelSelector(neon, [neon]), effortSelector("thinking_level", "", [])],
      { image: false },
    );
    expect(model?.capabilities).toEqual({
      inputModalities: ["text"],
      optionDescriptors: [],
    });
  });

  it.effect("sets the newly advertised effort after the model acknowledges a switch", () =>
    Effect.gen(function* () {
      const { calls, runtime } = fixture(
        [modelSelector(neon, [neon, carbon]), effortSelector("neon-thinking", "high", ["high"])],
        (id) => [
          modelSelector(carbon, [neon, carbon]),
          effortSelector("carbon-thinking", id === "provider-model" ? "medium" : "low", [
            "low",
            "medium",
          ]),
        ],
      );
      const selected = yield* applyGeminiAcpSelection(runtime, {
        model: carbon,
        options: [{ id: "reasoningEffort", value: "low" }],
      });
      expect(calls).toEqual([
        ["provider-model", carbon],
        ["carbon-thinking", "low"],
      ]);
      expect(selected).toEqual({ model: carbon, reasoningEffort: "low" });
    }),
  );

  it.effect(
    "refuses an effort from the previous model after the new model changes the choices",
    () =>
      Effect.gen(function* () {
        const { calls, runtime } = fixture(
          [
            modelSelector(neon, [neon, carbon]),
            effortSelector("thinking_level", "xhigh", ["xhigh"]),
          ],
          () => [
            modelSelector(carbon, [neon, carbon]),
            effortSelector("thinking_level", "medium", ["low", "medium", "high"]),
          ],
        );
        const result = yield* Effect.result(
          applyGeminiAcpSelection(runtime, {
            model: carbon,
            options: [{ id: "reasoningEffort", value: "xhigh" }],
          }),
        );
        expect(result._tag).toBe("Failure");
        expect(calls).toEqual([["provider-model", carbon]]);
      }),
  );

  it.effect("refuses the unconfirmed model without sending the effort even when offered", () =>
    Effect.gen(function* () {
      const initial = [
        modelSelector(neon, [neon, carbon]),
        effortSelector("thinking_level", "high", ["low", "high"]),
      ];
      const { calls, runtime } = fixture(initial, () => initial);
      const result = yield* Effect.result(
        applyGeminiAcpSelection(runtime, {
          model: carbon,
          options: [{ id: "reasoningEffort", value: "low" }],
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(calls).toEqual([["provider-model", carbon]]);
    }),
  );

  it.effect("refuses an unacknowledged effort", () =>
    Effect.gen(function* () {
      const initial = [
        modelSelector(neon, [neon]),
        effortSelector("thinking_level", "high", ["low", "high"]),
      ];
      const { calls, runtime } = fixture(initial, () => initial);
      const result = yield* Effect.result(
        applyGeminiAcpSelection(runtime, {
          model: neon,
          options: [{ id: "reasoningEffort", value: "low" }],
        }),
      );
      expect(result._tag).toBe("Failure");
      expect(calls).toEqual([["thinking_level", "low"]]);
    }),
  );

  it.effect("refuses a config ID alias that the ACP runtime would normalize", () =>
    Effect.gen(function* () {
      const initial = [
        modelSelector(neon, [neon, carbon]),
        effortSelector(" provider-model ", "high", ["high"]),
      ];
      const { calls, runtime } = fixture(initial, () => initial);
      const error = yield* applyGeminiAcpSelection(runtime, { model: carbon }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "GeminiAcpSelectionError",
        issue: "The requested model is not advertised by this Antigravity session.",
      });
      expect(calls).toEqual([]);
      expect(buildGeminiAcpModels(initial)).toEqual([]);
    }),
  );

  it.effect("inherits the actual native effort when an otherwise known model is selected", () =>
    Effect.gen(function* () {
      const { calls, runtime } = fixture([modelSelector(neon, [neon, carbon])], () => [
        modelSelector(carbon, [neon, carbon]),
        effortSelector("thinking_level", "native.default", ["native.default"]),
      ]);
      expect(yield* applyGeminiAcpSelection(runtime, { model: carbon })).toEqual({
        model: carbon,
        reasoningEffort: "native.default",
      });
      expect(calls).toEqual([["provider-model", carbon]]);
    }),
  );
});
