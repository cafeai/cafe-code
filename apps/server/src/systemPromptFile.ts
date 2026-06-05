import { ServerSystemPromptFileError } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

function isNotFoundError(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

function toSystemPromptFileError(operation: string, error: PlatformError.PlatformError) {
  return new ServerSystemPromptFileError({
    message: `Unable to ${operation} system prompt file.`,
    cause: error,
  });
}

export function composeSystemPromptProviderInput(input: {
  readonly systemPrompt: string;
  readonly userMessage: string | undefined;
}): string | undefined {
  const systemPrompt = input.systemPrompt.trim();
  if (systemPrompt.length === 0) {
    return input.userMessage;
  }

  const userMessage = input.userMessage?.trim();
  const userRequest = userMessage && userMessage.length > 0 ? userMessage : "";
  return `System prompt:\n${systemPrompt}\n\nUser request:\n${userRequest}`;
}

export const readSystemPromptFileForInjection = Effect.fn(function* (systemPromptPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(systemPromptPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return undefined;
  }

  const contents = yield* fs
    .readFileString(systemPromptPath)
    .pipe(
      Effect.catch((error) =>
        isNotFoundError(error)
          ? Effect.succeed("")
          : Effect.fail(toSystemPromptFileError("read", error)),
      ),
    );
  const trimmed = contents.trim();
  return trimmed.length > 0 ? trimmed : undefined;
});

export const ensureSystemPromptFile = Effect.fn(function* (systemPromptPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs
    .makeDirectory(path.dirname(systemPromptPath), { recursive: true })
    .pipe(Effect.mapError((error) => toSystemPromptFileError("create", error)));

  const exists = yield* fs.exists(systemPromptPath).pipe(Effect.orElseSucceed(() => false));
  if (exists) {
    return;
  }

  yield* fs
    .writeFileString(systemPromptPath, "")
    .pipe(Effect.mapError((error) => toSystemPromptFileError("create", error)));
});
