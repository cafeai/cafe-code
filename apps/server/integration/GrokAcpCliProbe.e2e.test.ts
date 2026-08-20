import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  GrokPermissionMode,
  GrokSandboxProfile,
  makeGrokAcpRuntime,
  readGrokAcpSessionModelMetadata,
} from "../src/provider/acp/GrokAcpSupport.ts";

const runRealGrok = process.env.CAFE_CODE_GROK_E2E === "1";
const traceRealGrok = process.env.CAFE_CODE_GROK_E2E_TRACE === "1";

it.layer(NodeServices.layer)("real Grok ACP qualification", (it) => {
  it.effect.skipIf(!runRealGrok)(
    "initializes, authenticates, creates a read-only session, and completes a prompt",
    () =>
      Effect.gen(function* () {
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const output = yield* Ref.make("");
        const runtime = yield* makeGrokAcpRuntime({
          grokSettings: { binaryPath: process.env.CAFE_CODE_GROK_BINARY_PATH ?? "grok" },
          childProcessSpawner,
          cwd: process.cwd(),
          environment: process.env,
          sandboxProfile: GrokSandboxProfile.ReadOnly,
          permissionMode: GrokPermissionMode.Ask,
          reasoningEffort: "low",
          clientInfo: { name: "cafe-code-grok-e2e", version: "0.0.0" },
          ...(traceRealGrok
            ? {
                // The ACP package redacts payloads before invoking this hook;
                // opt-in traces contain only direction, stage, method/tag,
                // identifier class, and byte/count metadata.
                protocolLogging: {
                  logIncoming: true,
                  logOutgoing: true,
                  logger: (event) =>
                    Effect.sync(() => {
                      process.stderr.write(`${JSON.stringify(event)}\n`);
                    }),
                },
              }
            : {}),
        });
        yield* runtime.handleRequestPermission(() =>
          Effect.succeed({ outcome: { outcome: "cancelled" } }),
        );
        yield* runtime.handleSessionUpdate((notification) => {
          const update = notification.update;
          if (update.sessionUpdate !== "agent_message_chunk") return Effect.void;
          const content = update.content;
          return content.type === "text"
            ? Ref.update(output, (current) => current + content.text)
            : Effect.void;
        });
        const startedOption = yield* runtime.start().pipe(Effect.timeoutOption("30 seconds"));
        if (Option.isNone(startedOption)) {
          return yield* Effect.fail(
            new Error("Grok ACP canary timed out during initialize/authenticate/session setup."),
          );
        }
        expect(startedOption.value.initializeResult.protocolVersion).toBe(1);
        const modelMetadata = readGrokAcpSessionModelMetadata(
          startedOption.value.sessionSetupResult,
        );
        expect(modelMetadata.totalContextTokens).toBeGreaterThan(0);
        expect(modelMetadata.reasoningEfforts.some((effort) => effort.value === "low")).toBe(true);
        const resultOption = yield* runtime
          .prompt({
            prompt: [{ type: "text", text: "Reply with exactly OK. Do not use tools." }],
          })
          .pipe(Effect.timeoutOption("90 seconds"));
        if (Option.isNone(resultOption)) {
          return yield* Effect.fail(
            new Error("Grok ACP canary timed out waiting for prompt completion."),
          );
        }
        expect(resultOption.value.stopReason).not.toBe("cancelled");
        expect((yield* Ref.get(output)).trim().length).toBeGreaterThan(0);
      }).pipe(Effect.scoped, TestClock.withLive),
    140_000,
  );
});
