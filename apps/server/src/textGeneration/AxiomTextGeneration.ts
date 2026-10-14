import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import { type AxiomSettings, type ModelSelection } from "@cafecode/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@cafecode/shared/git";
import { extractJsonObject } from "@cafecode/shared/schemaJson";

import { TextGenerationError } from "@cafecode/contracts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
  buildThreadMetadataPrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import { applyAxiomSelection, makeAxiomRuntime } from "../provider/acp/AxiomAcpSupport.ts";

const AXIOM_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export const makeAxiomTextGeneration = Effect.fn("makeAxiomTextGeneration")(function* (
  axiomSettings: AxiomSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options: { readonly makeRuntime?: typeof makeAxiomRuntime } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runAxiomJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateThreadMetadata";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* (options.makeRuntime ?? makeAxiomRuntime)(
        axiomSettings,
        { cwd, frontend: "cli" },
        () => {},
        environment,
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      const overflow = yield* Ref.make(false);
      yield* Stream.runForEach(runtime.getEvents(), (event) => {
        if (event._tag === "EventStreamBarrier")
          return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
        if (event._tag !== "ContentDelta" || event.streamKind !== "assistant_text")
          return Effect.void;
        return Ref.get(outputRef).pipe(
          Effect.flatMap((current) =>
            current.length + event.text.length > 1024 * 1024
              ? Ref.set(overflow, true)
              : Ref.set(outputRef, current + event.text),
          ),
        );
      }).pipe(Effect.forkScoped);

      const promptResult = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        yield* applyAxiomSelection(runtime, modelSelection);
        // Axiom's None permission profile disables tools for metadata inference.
        // Never inherit a project's tool grants or let a helper alter files.
        yield* runtime.request("session/set_mode", {
          sessionId: started.sessionId,
          modeId: "none",
        });

        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(AXIOM_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Axiom ACP request timed out." }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause: EffectAcpErrors.AcpError | TextGenerationError) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Axiom ACP request failed.",
              }),
        ),
      );

      yield* runtime.finishPromptEvents;
      if (yield* Ref.get(overflow))
        return yield* new TextGenerationError({
          operation,
          detail: "Axiom metadata output exceeded its bounded size.",
        });
      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Axiom ACP request was cancelled."
              : "Axiom Agent returned empty output.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: () =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Axiom Agent returned invalid structured output.",
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: "Axiom ACP text generation failed.",
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("AxiomTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
      });

      const generated = yield* runAxiomJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("AxiomTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
      });

      const generated = yield* runAxiomJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("AxiomTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runAxiomJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("AxiomTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runAxiomJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  const generateThreadMetadata: TextGeneration.TextGeneration["Service"]["generateThreadMetadata"] =
    Effect.fn("AxiomTextGeneration.generateThreadMetadata")(function* (input) {
      const { prompt, outputSchema } = buildThreadMetadataPrompt(input);
      const generated = yield* runAxiomJson({
        operation: "generateThreadMetadata",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizeThreadTitle(generated.title),
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateThreadMetadata,
  } satisfies TextGeneration.TextGeneration["Service"];
});
