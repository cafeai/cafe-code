// @effect-diagnostics nodeBuiltinImport:off
import { fileURLToPath } from "node:url";

import { ProviderInstanceId } from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { GeminiDriver } from "./GeminiDriver.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "cafecode-gemini-driver-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));
const fixture = fileURLToPath(new URL("../testUtils/geminiAcpFixture.cjs", import.meta.url));

it.live("reports the native Gemini catalogue and rejects an IDE launcher before ACP", () =>
  Effect.gen(function* () {
    const native = yield* ChildProcessSpawner.ChildProcessSpawner;
    let ide = false;
    let startedAcp = 0;
    const spawner = ChildProcessSpawner.make((command) => {
      if (command._tag !== "StandardCommand" || command.command !== process.execPath) {
        return native.spawn(command);
      }
      if (command.args[0] === "acp") startedAcp++;
      const args =
        ide && command.args[0] === "--version"
          ? ["-e", 'console.log("1.107.0\\n3ab42ef\\narm64")']
          : [fixture, ...command.args];
      return native.spawn(ChildProcess.make(command.command, args, command.options));
    });
    const instance = yield* GeminiDriver.create({
      instanceId: ProviderInstanceId.make("test-antigravity"),
      displayName: undefined,
      enabled: true,
      environment: [],
      processEnvironment: {},
      config: { ...GeminiDriver.defaultConfig(), binaryPath: process.execPath },
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    const ready = yield* instance.snapshot.refresh;
    assert.equal(ready.version, "1.5.11");
    assert.equal(ready.auth.status, "authenticated");
    assert.deepEqual(
      ready.models.map((model) => model.slug),
      ["gemini-4-neon"],
    );
    assert.equal(startedAcp, 1);

    ide = true;
    const unavailable = yield* instance.snapshot.refresh;
    assert.equal(unavailable.status, "error");
    assert.deepEqual(unavailable.models, []);
    assert.equal(startedAcp, 1);
  }).pipe(Effect.provide(configLayer)),
);
