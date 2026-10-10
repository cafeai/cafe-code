import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  subagentConcurrencyAdmissionError,
  UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE,
  UNSUPPORTED_ACCOUNT_SUBAGENT_LIMIT_MESSAGE,
  UNRECORDED_STEER_SUBAGENT_OWNER_MESSAGE,
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

  it("requires capability for live inherited account limits even after Reset", () => {
    for (const instance of [{ driver: provider, defaultMaxConcurrentSubagents: 15 }]) {
      const configuration = {
        ...supported,
        providers: [{ instanceId, driver: provider }],
        settings: { ...DEFAULT_SERVER_SETTINGS, providerInstances: { [instanceId]: instance } },
      };
      for (const limits of [undefined, {}, { claude: 8 }]) {
        expect(subagentConcurrencyAdmissionError({ ...base, limits, configuration })).toBe(
          UNSUPPORTED_ACCOUNT_SUBAGENT_LIMIT_MESSAGE,
        );
        expect(
          subagentConcurrencyAdmissionError({
            ...base,
            limits,
            configuration: { ...configuration, providers: supported.providers },
          }),
        ).toBeNull();
      }
      // An explicit chat override still reports its own correction surface.
      expect(subagentConcurrencyAdmissionError({ ...base, configuration })).toBe(
        UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE,
      );
      const cleared = {
        ...configuration,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: { [instanceId]: { driver: provider } },
        },
      };
      expect(
        subagentConcurrencyAdmissionError({ ...base, limits: {}, configuration: cleared }),
      ).toBeNull();
      expect(
        subagentConcurrencyAdmissionError({
          ...base,
          limits: {},
          configuration: {
            ...configuration,
            environment: { environmentId: EnvironmentId.make("foreign") },
          },
        }),
      ).toBeNull();
    }
  });

  it("preserves existing legacy runtime-config admission semantics", () => {
    const configuration = {
      ...supported,
      providers: [{ instanceId, driver: provider }],
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: provider, config: { maxConcurrentSubagents: 5 } },
        },
      },
    };
    expect(subagentConcurrencyAdmissionError({ ...base, limits: {}, configuration })).toBeNull();
  });
  it("never borrows selected account support for a numeric steer with an unrecorded session owner", () => {
    expect(
      subagentConcurrencyAdmissionError({
        ...base,
        configuration: supported,
        hasRecordedSessionOwner: false,
      }),
    ).toBe(UNRECORDED_STEER_SUBAGENT_OWNER_MESSAGE);
    const inherited = {
      ...supported,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: provider, defaultMaxConcurrentSubagents: 15 },
        },
      },
    };
    expect(
      subagentConcurrencyAdmissionError({
        ...base,
        limits: {},
        configuration: inherited,
        hasRecordedSessionOwner: false,
      }),
    ).toBe(UNRECORDED_STEER_SUBAGENT_OWNER_MESSAGE);
    expect(
      subagentConcurrencyAdmissionError({
        ...base,
        limits: {},
        configuration: supported,
        hasRecordedSessionOwner: false,
      }),
    ).toBeNull();
    const legacy = {
      ...supported,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [instanceId]: { driver: provider, config: { maxConcurrentSubagents: 5 } },
        },
      },
    };
    expect(
      subagentConcurrencyAdmissionError({
        ...base,
        limits: {},
        configuration: legacy,
        hasRecordedSessionOwner: false,
      }),
    ).toBeNull();
    // Numeric intent uses the actual session driver; a foreign-driver saved
    // map never becomes its execution policy merely because the picker moved.
    expect(
      subagentConcurrencyAdmissionError({
        ...base,
        provider: ProviderDriverKind.make("claudeAgent"),
        configuration: inherited,
        hasRecordedSessionOwner: false,
      }),
    ).toBeNull();
    expect(
      subagentConcurrencyAdmissionError({
        ...base,
        provider: ProviderDriverKind.make("claudeAgent"),
        limits: { claude: 8 },
        configuration: inherited,
        hasRecordedSessionOwner: false,
      }),
    ).toBe(UNRECORDED_STEER_SUBAGENT_OWNER_MESSAGE);
  });
});
