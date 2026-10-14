// @effect-diagnostics nodeBuiltinImport:off
import { isAbsolute } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AxiomSettings } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeAxiomControl } from "../src/provider/acp/AxiomAcpSupport.ts";

const binaryPath = process.env.CAFE_AXIOMCLI_PATH;
if (!binaryPath || !isAbsolute(binaryPath))
  throw new Error(
    "Set CAFE_AXIOMCLI_PATH to the absolute native executable for this opt-in protocol-only test.",
  );

it.live(
  "qualifies native Axiom ACP and extension metadata without a conversation or inference",
  () =>
    Effect.gen(function* () {
      const { initialized, extension } = yield* makeAxiomControl(
        Schema.decodeSync(AxiomSettings)({ binaryPath }),
        process.cwd(),
      );
      expect(initialized.protocolVersion).toBe(1);
      expect(initialized.agentInfo?.name).toBe("axiomcli");
      expect(extension.features.securityEvidence).toBe(4);
      expect(extension.features.attachments).toBe(2);
      expect(extension.features.desktopChat).toBe(1);
      expect(extension.features.desktopAgent).toBe(1);
      expect(extension.features.webConsent).toBe(1);
    }).pipe(Effect.timeout(15_000), Effect.provide(NodeServices.layer), Effect.scoped),
);
