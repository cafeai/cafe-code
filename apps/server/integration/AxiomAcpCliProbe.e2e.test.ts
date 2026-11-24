// @effect-diagnostics nodeBuiltinImport:off
import { isAbsolute } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AxiomSettings } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeAxiomControl } from "../src/provider/acp/AxiomAcpSupport.ts";
import { AXIOM_CURRENT_INITIALIZE_RESPONSE } from "../src/provider/testUtils/axiomAcpContractFixture.ts";

const binaryPath = process.env.CAFE_AXIOMCLI_PATH;
if (!binaryPath || !isAbsolute(binaryPath))
  throw new Error(
    "Set CAFE_AXIOMCLI_PATH to the absolute native executable for this opt-in protocol-only test.",
  );

it.live(
  "qualifies native Axiom ACP and extension metadata without a conversation or inference",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-axiom-protocol-" });
      const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // The selected executable is opt-in; real provider credentials are not.
      // Replace the complete child environment, not just XDG paths: ambient API
      // keys would otherwise bypass the private native credential-store boundary.
      // The loopback origins also select a different native Keychain identity.
      const environment: NodeJS.ProcessEnv = {
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        AXIOM_BASE_URL: "https://127.0.0.1:1",
        AXIOM_AUTH_URL: "https://127.0.0.1:1",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.windir ? { windir: process.env.windir } : {}),
      };
      const isolatedSpawner = ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) {
          return Effect.die(new Error("The Axiom probe requires one exact native child."));
        }
        return nativeSpawner.spawn(
          ChildProcess.make(command.command, command.args, {
            ...command.options,
            env: environment,
            extendEnv: false,
          }),
        );
      });
      const { initialized, extension } = yield* makeAxiomControl(
        Schema.decodeSync(AxiomSettings)({ binaryPath }),
        root,
        environment,
        { keychainUi: process.platform === "darwin" ? "forbidden" : "interactive" },
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, isolatedSpawner));
      expect(initialized.protocolVersion).toBe(1);
      expect(initialized.agentInfo?.name).toBe("axiomcli");
      expect(extension.features.securityEvidence).toBe(4);
      expect(extension.features.attachments).toBe(2);
      expect(extension.features.desktopChat).toBe(1);
      expect(extension.features.desktopAgent).toBe(1);
      expect(extension.features.webConsent).toBe(1);
      // Current-version admission must observe the native advertisement, not
      // silently negotiate only the historical subset the synthetic peer used.
      const reviewed = AXIOM_CURRENT_INITIALIZE_RESPONSE.agentCapabilities._meta.axiom.features;
      expect(extension.features.activity).toBe(reviewed.activity);
      expect(extension.features.desktopMcp).toBe(reviewed.desktopMcp);
      expect(extension.features.commandInvocation).toBe(reviewed.commandInvocation);
      expect(extension.features.billing).toBe(reviewed.billing);
    }).pipe(Effect.timeout(15_000), Effect.provide(NodeServices.layer), Effect.scoped),
);
