// @effect-diagnostics nodeBuiltinImport:off
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AxiomSettings,
  ProviderInstanceId,
  type UsageAccountingSnapshot,
} from "@cafecode/contracts";
import { AuxiliaryUsage } from "../usageStats/Services/AuxiliaryUsage.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeAxiomRuntime } from "../provider/acp/AxiomAcpSupport.ts";
import { makeAxiomTextGeneration } from "./AxiomTextGeneration.ts";

const fixturePath = fileURLToPath(
  new URL("../provider/testUtils/axiomMockPeer.ts", import.meta.url),
);
it.effect(
  "drains scoped native helper output with the no-tools profile and returns typed metadata",
  () =>
    Effect.gen(function* () {
      const accounting: UsageAccountingSnapshot[] = [];
      const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const makeRuntime: typeof makeAxiomRuntime = (
        settings,
        options,
        identity,
        environment,
        accountKey,
      ) =>
        makeAxiomRuntime(settings, options, identity, environment, accountKey).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              nativeSpawner.spawn(
                ChildProcess.make(
                  process.execPath,
                  [fixturePath, options.frontend ?? "desktop-chat"],
                  {
                    shell: false,
                    extendEnv: false,
                    env: {
                      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
                      ...(process.env.windir ? { windir: process.env.windir } : {}),
                    },
                  },
                ),
              ),
            ),
          ),
        );
      const helpers = yield* makeAxiomTextGeneration(
        Schema.decodeSync(AxiomSettings)({}),
        {},
        { makeRuntime },
      ).pipe(
        Effect.provideService(AuxiliaryUsage, {
          installSink: () => Effect.void,
          record: (provider, snapshot) =>
            Effect.sync(() => {
              expect(provider).toBe("axiom");
              accounting.push(snapshot);
            }),
        }),
      );
      const modelSelection = {
        instanceId: ProviderInstanceId.make("axiom-fixture"),
        model: "test-model",
        options: [{ id: "thinkingLevel", value: "high" }],
      };
      expect(
        yield* helpers.generateThreadMetadata({
          cwd: process.cwd(),
          message: "Fixture task",
          modelSelection,
        }),
      ).toEqual({ title: "Fixture title", branch: "fixture-branch" });
      expect(
        yield* helpers.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feat/fixture",
          stagedSummary: "Fixture",
          stagedPatch: "Fixture diff",
          modelSelection,
        }),
      ).toEqual({ subject: "feat(fixture): add example", body: "Fixture body" });
      expect(accounting).toHaveLength(2);
      expect(accounting[0]?.models[0]?.reportedCostMicrousd).toBe("123456");
      expect(accounting[0]?.scopeId).not.toBe(accounting[1]?.scopeId);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
