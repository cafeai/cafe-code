import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  subagentConcurrencyAdmissionError,
  UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE,
} from "./subagentConcurrencyAdmission";

const environmentId = EnvironmentId.make("owner");
const instanceId = ProviderInstanceId.make("selected-account");
const provider = ProviderDriverKind.make("codex");
const base = { environmentId, instanceId, provider, limits: { codex: 6 } };
const supported = {
  environment: { environmentId },
  providers: [{ instanceId, driver: provider, runtimeCapabilities: { subagentConcurrency: true } }],
};

describe("subagent limit send admission", () => {
  it.each([undefined, {}, { claude: 8 }])(
    "allows nonnumeric selected-driver policy %j",
    (limits) => {
      expect(
        subagentConcurrencyAdmissionError({ ...base, limits, configuration: null }),
      ).toBeNull();
    },
  );

  it("requires support from the exact selected account and environment", () => {
    expect(subagentConcurrencyAdmissionError({ ...base, configuration: supported })).toBeNull();
    for (const configuration of [
      null,
      { ...supported, environment: { environmentId: EnvironmentId.make("other-server") } },
      {
        ...supported,
        providers: [
          { ...supported.providers[0]!, instanceId: ProviderInstanceId.make("other-account") },
        ],
      },
      {
        ...supported,
        providers: [{ ...supported.providers[0]!, driver: ProviderDriverKind.make("claudeAgent") }],
      },
      { ...supported, providers: [{ instanceId, driver: provider }] },
      {
        ...supported,
        providers: [
          { instanceId, driver: provider, runtimeCapabilities: { subagentConcurrency: false } },
        ],
      },
    ]) {
      expect(subagentConcurrencyAdmissionError({ ...base, configuration })).toBe(
        UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE,
      );
    }
  });

  it("uses Claude's saved driver key without borrowing Codex support", () => {
    const claude = {
      ...base,
      provider: ProviderDriverKind.make("claudeAgent"),
      limits: { claude: 4 },
    };
    expect(subagentConcurrencyAdmissionError({ ...claude, configuration: supported })).toBe(
      UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE,
    );
    expect(
      subagentConcurrencyAdmissionError({
        ...claude,
        configuration: {
          ...supported,
          providers: [
            {
              instanceId,
              driver: claude.provider,
              runtimeCapabilities: { subagentConcurrency: true },
            },
          ],
        },
      }),
    ).toBeNull();
  });
});
