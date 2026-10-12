import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@cafecode/contracts";
import type { Thread } from "../types";
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
const threadId = ThreadId.make("existing-thread");
const modelSelection = { instanceId, model: "gpt-6.1-sol" };
const existingThread: Pick<
  Thread,
  "id" | "environmentId" | "session" | "modelSelection" | "runtimeMode" | "archivedAt"
> = {
  id: threadId,
  environmentId,
  modelSelection,
  runtimeMode: "full-access",
  archivedAt: null,
  session: {
    provider,
    providerInstanceId: instanceId,
    status: "ready",
    orchestrationStatus: "ready",
    subagentRuntimeId: "exact-native-runtime",
    maxConcurrentSubagents: 6,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:01:00.000Z",
  },
};
const continuation = {
  threadId,
  modelSelection,
  runtimeMode: "full-access" as Thread["runtimeMode"],
  thread: existingThread,
};
const continuationOwner = {
  ...supported,
  providers: [
    {
      instanceId,
      driver: provider,
      runtimeCapabilities: { subagentConcurrency: false, subagentPolicyContinuation: true },
    },
  ],
};

describe("subagent limit send admission", () => {
  it("admits an exact already-materialized Codex policy only with the owning server's continuation guarantee", () => {
    expect(
      subagentConcurrencyAdmissionError({
        ...base,
        continuation,
        configuration: continuationOwner,
      }),
    ).toBeNull();
    expect(subagentConcurrencyAdmissionError({ ...base, configuration: continuationOwner })).toBe(
      UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE,
    );
    expect(
      subagentConcurrencyAdmissionError({
        ...base,
        continuation,
        configuration: {
          ...continuationOwner,
          providers: [
            { instanceId, driver: provider, runtimeCapabilities: { subagentConcurrency: false } },
          ],
        },
      }),
    ).toBe(UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE);
    expect(
      subagentConcurrencyAdmissionError({
        ...base,
        continuation,
        configuration: {
          ...continuationOwner,
          providers: [
            {
              instanceId,
              driver: provider,
              runtimeCapabilities: {
                subagentConcurrency: false,
                subagentPolicyContinuation: false,
              },
            },
          ],
        },
      }),
    ).toBe(UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE);
  });

  it("admits the unchanged live inherited account policy without declaring native CLI support", () => {
    const configuration = {
      ...continuationOwner,
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: { [instanceId]: { driver: provider, defaultMaxConcurrentSubagents: 6 } },
      },
    };
    expect(
      subagentConcurrencyAdmissionError({ ...base, limits: {}, continuation, configuration }),
    ).toBeNull();
    expect(
      subagentConcurrencyAdmissionError({
        ...base,
        limits: {},
        continuation,
        configuration: {
          ...configuration,
          settings: {
            ...configuration.settings,
            providerInstances: {
              [instanceId]: { driver: provider, defaultMaxConcurrentSubagents: 15 },
            },
          },
        },
      }),
    ).toBe(UNSUPPORTED_ACCOUNT_SUBAGENT_LIMIT_MESSAGE);
    expect(configuration.providers[0]?.runtimeCapabilities.subagentConcurrency).toBe(false);
  });

  it("refuses foreign, retired, changed, or unmaterialized continuation evidence", () => {
    const cases: (typeof continuation)[] = [
      { ...continuation, threadId: ThreadId.make("other-thread") },
      { ...continuation, modelSelection: { ...modelSelection, model: "different-model" } },
      { ...continuation, runtimeMode: "approval-required" },
      {
        ...continuation,
        thread: { ...existingThread, environmentId: EnvironmentId.make("foreign") },
      },
      { ...continuation, thread: { ...existingThread, archivedAt: "2026-10-11T01:00:00Z" } },
      { ...continuation, thread: { ...existingThread, session: null } },
      ...[
        { providerInstanceId: ProviderInstanceId.make("foreign") },
        { providerInstanceId: undefined },
        { provider: ProviderDriverKind.make("claudeAgent") },
        { subagentRuntimeId: null },
        { subagentRuntimeId: "" },
        { maxConcurrentSubagents: undefined },
        { maxConcurrentSubagents: null },
        { maxConcurrentSubagents: 15 },
        { status: "closed" as const },
        { status: "error" as const },
        { status: "connecting" as const },
        { orchestrationStatus: "stopped" as const },
      ].map((session) =>
        Object.assign({}, continuation, {
          thread: Object.assign({}, existingThread, {
            session: Object.assign({}, existingThread.session, session),
          }),
        }),
      ),
    ];
    for (const evidence of cases) {
      expect(
        subagentConcurrencyAdmissionError({
          ...base,
          continuation: evidence,
          configuration: continuationOwner,
        }),
      ).toBe(UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE);
    }
    expect(
      subagentConcurrencyAdmissionError({
        ...base,
        continuation,
        configuration: {
          ...continuationOwner,
          environment: { environmentId: EnvironmentId.make("foreign") },
        },
      }),
    ).toBe(UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE);
    expect(
      subagentConcurrencyAdmissionError({
        ...base,
        continuation,
        hasRecordedSessionOwner: false,
        configuration: continuationOwner,
      }),
    ).toBe(UNRECORDED_STEER_SUBAGENT_OWNER_MESSAGE);
  });
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
