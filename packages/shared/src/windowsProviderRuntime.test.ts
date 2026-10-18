// @effect-diagnostics nodeBuiltinImport:off
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ProviderDaemonHealth, ProviderDaemonMarker } from "@cafecode/contracts";
import type { WindowsOwnershipSession, WindowsProcessIdentity } from "./windowsProcessOwnership.ts";
import {
  createWindowsProviderRuntime,
  spawnWindowsProviderRuntimeChild,
  WindowsProviderRuntimeError,
  type WindowsProviderRuntimeOptions,
  type WindowsRuntimeStartupProgress,
} from "./windowsProviderRuntime.ts";
import {
  encodeBackendMigrationProgress,
  makeProviderDaemonStartupProgressTracker,
} from "./backendStartupProgress.ts";
import { dataProfileIdentity } from "./dataProfileIdentity.ts";

const ownershipId = "be5b2b29-72ef-4d31-9571-50856776e18b";
const identity: WindowsProcessIdentity = { pid: 101, creationTime100ns: "134032074530123456" };
const secondIdentity: WindowsProcessIdentity = {
  pid: 101,
  creationTime100ns: "134042074530123456",
};
const token = "synthetic-private-token-not-a-real-account-token";
const credential = Buffer.from(token).toString("base64");
const socketPath = "\\\\.\\pipe\\cafe-runtime-test";
const withSupervisor = (health: ProviderDaemonHealth): ProviderDaemonHealth => ({
  ...health,
  upstreamSupervisor: {
    configured: true,
    reachable: true,
    mode: "provider-supervisor",
    pid: 333,
    windowsOwnershipId: "ae5b2b29-72ef-4d31-9571-50856776e18b",
    windowsProcessIdentity: { pid: 333, creationTime100ns: "134000000000000333" },
  },
});
const marker = (overrides: Partial<ProviderDaemonMarker> = {}): ProviderDaemonMarker => ({
  version: 2,
  mode: "provider-daemon",
  pid: identity.pid,
  ppid: 42,
  protocolVersion: 1,
  transport: "ipc",
  httpBaseUrl: "http://provider-daemon.local",
  socketPath,
  credentialPath: `C:\\fixture\\provider-daemon-token.bin.${ownershipId}`,
  credentialEncrypted: false,
  appVersion: "1.0.0",
  runtimeBuildId: "build-one",
  createdAt: "2026-09-27T00:00:00.000Z",
  updatedAt: "2026-09-27T00:00:00.000Z",
  windowsProcessIdentity: identity,
  windowsOwnershipId: ownershipId,
  windowsOwnershipState: "committed",
  ...overrides,
});

function fixture(initial: ProviderDaemonMarker | null = marker()) {
  let record = initial;
  let revision = initial ? "revision-one" : null;
  let storedCredential: string | undefined = initial ? credential : undefined;
  let clock = 0;
  let counter = 0;
  let childExited = false;
  let unavailable = false;
  let captureUnknown = false;
  let observationUnknown = false;
  let terminationUnknown = false;
  let readError = false;
  let leaseError = false;
  let publishFailureAt = 0;
  let retireFailure = false;
  let response: ProviderDaemonHealth | undefined;
  const processes = new Map<number, WindowsProcessIdentity>([
    [identity.pid, identity],
    [process.pid, { pid: process.pid, creationTime100ns: "134000000000000000" }],
  ]);
  const compare = (expected: WindowsProcessIdentity) => {
    if (observationUnknown) return { status: "unknown" as const };
    const actual = processes.get(expected.pid);
    return {
      status: !actual
        ? ("exited" as const)
        : actual.creationTime100ns === expected.creationTime100ns
          ? ("same-process" as const)
          : ("different-process" as const),
    };
  };
  const health = (): ProviderDaemonHealth => {
    if (response) return response;
    if (!record || unavailable) throw new Error("PRIVATE endpoint output");
    const processIdentity = processes.get(record.pid);
    if (
      !processIdentity ||
      (record.windowsProcessIdentity &&
        processIdentity.creationTime100ns !== record.windowsProcessIdentity.creationTime100ns)
    ) {
      throw new Error("PRIVATE endpoint unavailable");
    }
    return {
      ok: true,
      mode: record.mode ?? "provider-daemon",
      ...(record.dataProfile === undefined ? {} : { dataProfile: record.dataProfile }),
      ...(record.dataProfileId === undefined ? {} : { dataProfileId: record.dataProfileId }),
      pid: record.pid,
      ppid: 42,
      protocolVersion: 1,
      version: "1.0.0",
      runtimeBuildId: "build-one",
      startedAt: "2026-09-27T00:00:00.000Z",
      activeSessionCount: 0,
      configuredInstanceCount: 0,
      eventCursor: 0,
      transport: "ipc",
      windowsProcessIdentity: processIdentity,
      ...(record.windowsOwnershipId === undefined
        ? {}
        : { windowsOwnershipId: record.windowsOwnershipId }),
    };
  };
  const session: WindowsOwnershipSession = {
    read: vi.fn(async () => {
      if (readError) throw new Error("PRIVATE C:\\profile\\marker");
      return {
        markerJson: record ? JSON.stringify(record) : null,
        revision,
        ...(storedCredential === undefined ? {} : { credentialBase64: storedCredential }),
      };
    }),
    publish: vi.fn(async (input) => {
      if (input.expectedRevision !== revision) throw new Error("ownership changed");
      record = JSON.parse(input.markerJson) as ProviderDaemonMarker;
      revision = `revision-${++counter}`;
      if (input.credentialBase64 !== undefined) storedCredential = input.credentialBase64;
      if (counter === publishFailureAt) throw new Error("PRIVATE committed reply lost");
      return revision;
    }),
    retire: vi.fn(async (expectedRevision) => {
      if (expectedRevision !== revision) throw new Error("ownership changed");
      record = null;
      revision = null;
      storedCredential = undefined;
      if (retireFailure) throw new Error("PRIVATE retired reply lost");
    }),
    capture: vi.fn(async (pid) => {
      if (captureUnknown) return { status: "unknown" as const };
      const actual = processes.get(pid);
      return actual
        ? { status: "present" as const, identity: actual }
        : { status: "exited" as const };
    }),
    observe: vi.fn(async (expected) => compare(expected)),
    terminate: vi.fn(async (expected) => {
      if (terminationUnknown) return { status: "unknown" as const };
      const observed = compare(expected);
      if (observed.status === "same-process") {
        processes.delete(expected.pid);
        return { status: "exited" as const };
      }
      return { status: observed.status };
    }),
    close: vi.fn(async () => {}),
  };
  const closeStartupProgress = vi.fn();
  const spawn = vi.fn<WindowsProviderRuntimeOptions["spawn"]>(async () => {
    processes.set(201, { pid: 201, creationTime100ns: "134050000000000000" });
    return { pid: 201, hasExited: () => childExited, closeStartupProgress };
  });
  const options: WindowsProviderRuntimeOptions = {
    role: "provider-daemon",
    markerPath: "C:\\fixture\\provider-daemon.json",
    legacyCredentialPath: "C:\\fixture\\provider-daemon-token.bin",
    socketPath,
    appVersion: "1.0.0",
    protocolVersion: 1,
    runtimeBuildId: "build-one",
    bootstrap: { cafeCodeHome: "C:\\fixture" },
    encodeCredential: async (value) => ({
      base64: Buffer.from(value).toString("base64"),
      encrypted: false,
    }),
    decodeCredential: async (value) => Buffer.from(value, "base64").toString(),
    spawn,
    openSession: vi.fn(async () => session),
    fetchHealth: vi.fn(async () => health()),
    issueLease: vi.fn(async () => {
      if (leaseError) throw new Error("PRIVATE lease output");
      return {
        leaseId: "synthetic-lease-identifier",
        token: `${token}-lease`,
        capabilities: ["health", "events", "rpc", "lease"] as const,
        issuedAt: "2026-09-27T00:00:00.000Z",
      };
    }),
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    readinessTimeoutMs: 5,
  };
  return {
    options,
    session,
    spawn,
    closeStartupProgress,
    processes,
    runtime: createWindowsProviderRuntime(options),
    get record() {
      return record;
    },
    get revision() {
      return revision;
    },
    get elapsedMs() {
      return clock;
    },
    advanceClock(milliseconds: number) {
      clock += milliseconds;
    },
    setRecord(next: ProviderDaemonMarker | null) {
      record = next;
      revision = next ? `external-${++counter}` : null;
    },
    setCredential(value?: string) {
      storedCredential = value;
    },
    setUnavailable(value: boolean) {
      unavailable = value;
    },
    setResponse(value?: ProviderDaemonHealth) {
      response = value;
    },
    setChildExited(value: boolean) {
      childExited = value;
    },
    setCaptureUnknown(value: boolean) {
      captureUnknown = value;
    },
    setObservationUnknown(value: boolean) {
      observationUnknown = value;
    },
    setTerminationUnknown(value: boolean) {
      terminationUnknown = value;
    },
    setReadError(value: boolean) {
      readError = value;
    },
    setLeaseError(value: boolean) {
      leaseError = value;
    },
    setPublishFailureAt(value: number) {
      publishFailureAt = value;
    },
    setRetireFailure(value: boolean) {
      retireFailure = value;
    },
    health,
  };
}

const profileRoot = "C:\\fixture\\.debug";
const profileId = dataProfileIdentity("debug", profileRoot);
const profileSocketPath = `\\\\.\\pipe\\cafecode-provider-daemon-${createHash("sha256").update(profileRoot).digest("hex").slice(0, 24)}`;
const profileMarker = (overrides: Partial<ProviderDaemonMarker> = {}) =>
  marker({
    dataProfile: "debug",
    dataProfileId: profileId,
    socketPath: profileSocketPath,
    credentialPath: `${profileRoot}\\userdata\\provider-daemon-token.bin.${ownershipId}`,
    ...overrides,
  });
function profileOptions(f: ReturnType<typeof fixture>): WindowsProviderRuntimeOptions {
  return {
    ...f.options,
    dataProfile: "debug",
    dataProfileId: profileId,
    markerPath: `${profileRoot}\\userdata\\provider-daemon.json`,
    legacyCredentialPath: `${profileRoot}\\userdata\\provider-daemon-token.bin`,
    socketPath: profileSocketPath,
    bootstrap: {
      cafeCodeHome: profileRoot,
      configuredCafeCodeHome: "C:\\fixture",
      dataProfile: "debug",
    },
  };
}

describe("Windows runtime exact data-profile admission", () => {
  it.each(["marker", "credential", "pipe", "configured-root"] as const)(
    "refuses a profiled %s namespace inconsistent with the admitted effective root",
    (phase) => {
      const f = fixture(profileMarker());
      const options = profileOptions(f);
      const foreign = {
        ...options,
        ...(phase === "marker" ? { markerPath: "C:\\foreign\\provider-daemon.json" } : {}),
        ...(phase === "credential" ? { legacyCredentialPath: "C:\\foreign\\token" } : {}),
        ...(phase === "pipe" ? { socketPath: "\\\\.\\pipe\\foreign" } : {}),
        ...(phase === "configured-root"
          ? { bootstrap: { ...options.bootstrap, configuredCafeCodeHome: "C:\\foreign" } }
          : {}),
      };
      expect(() => createWindowsProviderRuntime(foreign)).toThrow("profile-mismatch");
      expect(f.options.openSession).not.toHaveBeenCalled();
      expect(f.spawn).not.toHaveBeenCalled();
      expect(f.session.publish).not.toHaveBeenCalled();
    },
  );
  it.each([
    { field: "markerPath", value: "\\\\?\\C:\\fixture\\.debug\\userdata\\provider-daemon.json" },
    { field: "markerPath", value: "\\\\server\\share\\provider-daemon.json" },
    { field: "markerPath", value: "C:/fixture/.debug/userdata/provider-daemon.json" },
    {
      field: "markerPath",
      value: "C:\\fixture\\.debug\\userdata\\..\\userdata\\provider-daemon.json",
    },
    { field: "markerPath", value: "C:\\fixture\\.debug\\userdata.\\provider-daemon.json" },
    {
      field: "legacyCredentialPath",
      value: "C:\\fixture\\.debug\\userdata\\provider-daemon-token.bin:stream",
    },
    {
      field: "legacyCredentialPath",
      value: "C:\\fixture\\.debug\\userdata\\..\\userdata\\provider-daemon-token.bin",
    },
  ] as const)("refuses unsafe $field spelling before native helper access", ({ field, value }) => {
    const f = fixture(profileMarker());
    expect(() => createWindowsProviderRuntime({ ...profileOptions(f), [field]: value })).toThrow(
      "profile-mismatch",
    );
    expect(f.options.openSession).not.toHaveBeenCalled();
    expect(f.options.fetchHealth).not.toHaveBeenCalled();
    expect(f.session.read).not.toHaveBeenCalled();
    expect(f.session.publish).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it.each([
    "missing-id",
    "missing-profile",
    "foreign-id",
    "foreign-bootstrap",
    "foreign-home",
    "missing-parent",
  ] as const)("refuses %s opening policy before native guard or credential work", (phase) => {
    const f = fixture(profileMarker());
    const options = profileOptions(f);
    const changed = {
      ...options,
      ...(phase === "missing-id" ? { dataProfileId: undefined } : {}),
      ...(phase === "missing-profile" ? { dataProfile: undefined } : {}),
      ...(phase === "foreign-id"
        ? { dataProfileId: dataProfileIdentity("production", profileRoot) }
        : {}),
      bootstrap: {
        ...options.bootstrap,
        ...(phase === "foreign-bootstrap" ? { dataProfile: "production" as const } : {}),
        ...(phase === "foreign-home" ? { cafeCodeHome: "C:\\another" } : {}),
        ...(phase === "missing-parent" ? { configuredCafeCodeHome: undefined } : {}),
      },
    };
    expect(() => createWindowsProviderRuntime(changed)).toThrow("profile-mismatch");
    expect(f.options.openSession).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.session.publish).not.toHaveBeenCalled();
    expect(f.options.fetchHealth).not.toHaveBeenCalled();
  });

  it.each([
    { credentialPath: undefined },
    { credentialPath: "C:\\foreign\\provider-daemon-token.bin" },
    { credentialPath: `${profileRoot}\\userdata\\secrets\\provider-supervisor-token` },
    { credentialPath: `${profileRoot}\\userdata\\provider-daemon-token.bin:stream` },
    { socketPath: "\\\\.\\pipe\\cafecode-provider-supervisor-foreign" },
    { transport: "tcp" as const, httpBaseUrl: "http://127.0.0.1:3773" },
  ])(
    "preserves a profile-labeled record outside its role's credential/pipe namespace",
    async (override) => {
      const initial = profileMarker(override);
      const f = fixture(initial);
      const decode = vi.fn(f.options.decodeCredential);
      const runtime = createWindowsProviderRuntime({
        ...profileOptions(f),
        decodeCredential: decode,
      });
      await expect(runtime.ensure()).rejects.toMatchObject({ reason: "profile-mismatch" });
      await expect(runtime.stop()).rejects.toMatchObject({ reason: "profile-mismatch" });
      await expect(runtime.recover()).rejects.toMatchObject({ reason: "profile-mismatch" });
      expect(decode).not.toHaveBeenCalled();
      expect(f.options.fetchHealth).not.toHaveBeenCalled();
      expect(f.options.issueLease).not.toHaveBeenCalled();
      expect(f.session.capture).not.toHaveBeenCalled();
      expect(f.session.observe).not.toHaveBeenCalled();
      expect(f.session.terminate).not.toHaveBeenCalled();
      expect(f.session.publish).not.toHaveBeenCalled();
      expect(f.session.retire).not.toHaveBeenCalled();
      expect(f.spawn).not.toHaveBeenCalled();
      expect(f.record).toEqual(initial);
    },
  );

  it.each(["legacy", "profile-only", "id-only", "foreign-profile", "foreign-root"] as const)(
    "preserves a %s record before decryption, endpoint contact or native identity mutation",
    async (phase) => {
      const receipt =
        phase === "legacy"
          ? {}
          : phase === "profile-only"
            ? { dataProfile: "debug" as const }
            : phase === "id-only"
              ? { dataProfileId: profileId }
              : phase === "foreign-profile"
                ? { dataProfile: "production" as const, dataProfileId: profileId }
                : {
                    dataProfile: "debug" as const,
                    dataProfileId: dataProfileIdentity("debug", "C:\\foreign"),
                  };
      const initial = marker(receipt);
      const f = fixture(initial);
      const decode = vi.fn(f.options.decodeCredential);
      const runtime = createWindowsProviderRuntime({
        ...profileOptions(f),
        decodeCredential: decode,
      });
      await expect(runtime.ensure()).rejects.toMatchObject({ reason: "profile-mismatch" });
      await expect(runtime.stop()).rejects.toMatchObject({ reason: "profile-mismatch" });
      await expect(runtime.recover()).rejects.toMatchObject({ reason: "profile-mismatch" });
      expect(decode).not.toHaveBeenCalled();
      expect(f.options.fetchHealth).not.toHaveBeenCalled();
      expect(f.options.issueLease).not.toHaveBeenCalled();
      expect(f.session.capture).not.toHaveBeenCalled();
      expect(f.session.observe).not.toHaveBeenCalled();
      expect(f.session.terminate).not.toHaveBeenCalled();
      expect(f.session.publish).not.toHaveBeenCalled();
      expect(f.session.retire).not.toHaveBeenCalled();
      expect(f.spawn).not.toHaveBeenCalled();
      expect(f.record).toEqual(initial);
    },
  );

  it.each(["committed", "prepared", "legacy-native-identity"] as const)(
    "requires native profile proof before %s admission can publish or lease",
    async (phase) => {
      let initial = profileMarker(
        phase === "prepared" ? { windowsOwnershipState: "prepared" } : {},
      );
      if (phase === "legacy-native-identity") {
        const {
          windowsOwnershipId: _id,
          windowsOwnershipState: _state,
          windowsProcessIdentity: _identity,
          ...legacy
        } = initial;
        initial = {
          ...legacy,
          credentialPath: `${profileRoot}\\userdata\\provider-daemon-token.bin`,
        };
      }
      const f = fixture(initial);
      const runtime = createWindowsProviderRuntime(profileOptions(f));
      f.setResponse({
        ...f.health(),
        dataProfile: "production",
        dataProfileId: dataProfileIdentity("production", "C:\\foreign"),
      });
      await expect(runtime.ensure()).rejects.toMatchObject({ reason: "profile-mismatch" });
      expect(f.options.fetchHealth).toHaveBeenCalledTimes(1);
      expect(f.options.issueLease).not.toHaveBeenCalled();
      expect(f.session.publish).not.toHaveBeenCalled();
      expect(f.session.retire).not.toHaveBeenCalled();
      expect(f.session.terminate).not.toHaveBeenCalled();
      expect(f.spawn).not.toHaveBeenCalled();
      expect(f.record).toEqual(initial);
    },
  );

  it("does not substitute missing native profile proof from a matching saved marker", async () => {
    const f = fixture(profileMarker());
    const { dataProfile: _profile, dataProfileId: _id, ...legacyHealth } = f.health();
    f.setResponse(legacyHealth);
    await expect(createWindowsProviderRuntime(profileOptions(f)).ensure()).rejects.toMatchObject({
      reason: "profile-mismatch",
    });
    expect(f.session.publish).not.toHaveBeenCalled();
    expect(f.options.issueLease).not.toHaveBeenCalled();
    expect(f.session.terminate).not.toHaveBeenCalled();
  });

  it("preserves a foreign authenticated responder even after the recorded native owner exited", async () => {
    const f = fixture(profileMarker());
    const health = f.health();
    f.processes.delete(identity.pid);
    f.setResponse({ ...health, dataProfileId: dataProfileIdentity("debug", "C:\\foreign") });
    await expect(createWindowsProviderRuntime(profileOptions(f)).ensure()).rejects.toMatchObject({
      reason: "profile-mismatch",
    });
    expect(f.session.retire).not.toHaveBeenCalled();
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.record).toEqual(profileMarker());
  });

  it("does not let a cached FILETIME/generation authorize a later foreign-profile record", async () => {
    const f = fixture(profileMarker());
    const runtime = createWindowsProviderRuntime(profileOptions(f));
    const accepted = await runtime.ensure();
    const foreign = profileMarker({ dataProfileId: dataProfileIdentity("debug", "C:\\foreign") });
    f.setRecord(foreign);
    await expect(runtime.stop(accepted.ownershipId)).rejects.toMatchObject({
      reason: "profile-mismatch",
    });
    await expect(runtime.recover(accepted.ownershipId)).rejects.toMatchObject({
      reason: "profile-mismatch",
    });
    expect((await runtime.observe()).status).toBe("unknown");
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.session.retire).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.record).toEqual(foreign);
  });

  it("preserves legacy callers without letting omitted expectation adopt a labeled profile", async () => {
    const legacy = fixture();
    await expect(legacy.runtime.ensure()).resolves.toMatchObject({ adopted: true });
    const labeled = fixture(profileMarker());
    await expect(labeled.runtime.ensure()).rejects.toMatchObject({ reason: "profile-mismatch" });
    expect(labeled.options.fetchHealth).not.toHaveBeenCalled();
    expect(labeled.session.publish).not.toHaveBeenCalled();
    expect(labeled.session.terminate).not.toHaveBeenCalled();
  });

  it("carries the immutable opening profile through each fresh reservation and private bootstrap", async () => {
    const f = fixture(null);
    const options = profileOptions(f);
    const runtime = createWindowsProviderRuntime(options);
    Object.assign(options, {
      dataProfile: "production",
      dataProfileId: dataProfileIdentity("production", "C:\\another"),
      markerPath: "C:\\another\\userdata\\provider-daemon.json",
      legacyCredentialPath: "C:\\another\\userdata\\provider-daemon-token.bin",
      socketPath: "\\\\.\\pipe\\foreign",
    });
    Object.assign(options.bootstrap, { cafeCodeHome: "C:\\another", dataProfile: "production" });
    const result = await runtime.ensure();
    expect(result.marker.dataProfile).toBe("debug");
    expect(result.marker.dataProfileId).toBe(profileId);
    expect(result.marker.windowsProcessIdentity).toEqual(f.processes.get(201));
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.options.openSession).toHaveBeenCalledWith({
      markerPath: `${profileRoot}\\userdata\\provider-daemon.json`,
      legacyCredentialPath: `${profileRoot}\\userdata\\provider-daemon-token.bin`,
      role: "provider-daemon",
    });
    expect(f.spawn.mock.calls[0]?.[0]).toMatchObject({
      dataProfile: "debug",
      configuredCafeCodeHome: "C:\\fixture",
      cafeCodeHome: profileRoot,
    });
    for (const [publication] of vi.mocked(f.session.publish).mock.calls) {
      expect(JSON.parse(publication.markerJson)).toMatchObject({
        dataProfile: "debug",
        dataProfileId: profileId,
      });
    }
    await runtime.stop(result.ownershipId);
    expect(f.session.terminate).toHaveBeenCalledWith(
      f.processes.get(201) ?? result.marker.windowsProcessIdentity,
    );
  });
});

describe("Windows provider runtime ownership lifecycle", () => {
  it("releases the guard during an exact fresh migration and re-admits only its unchanged prepared revision", async () => {
    const f = fixture(null);
    let held = false;
    let progress!: WindowsRuntimeStartupProgress;
    const phases = vi.fn();
    const fetchHealth = vi.fn(async () => {
      expect(held).toBe(false);
      if (f.elapsedMs === 0) throw new Error("synthetic migration not ready");
      return f.health();
    });
    const open = vi.fn(async () => {
      expect(held).toBe(false);
      held = true;
      return {
        ...f.session,
        close: async () => {
          await f.session.close();
          held = false;
        },
      };
    });
    const runtime = createWindowsProviderRuntime({
      ...f.options,
      openSession: open,
      onStartupProgress: phases,
      spawn: async (bootstrap, input) => {
        expect(held).toBe(true);
        expect(bootstrap.startupProgressFd).toBe(4);
        progress = input!;
        progress.tracker.push(
          Buffer.from(encodeBackendMigrationProgress({ phase: "start", migrationId: 92 })),
          progress.elapsedMs(),
        );
        return f.spawn(bootstrap, input);
      },
      fetchHealth,
      sleep: async () => {
        expect(held).toBe(false);
        // Exceed the unchanged native helper's 120-second session bound. The
        // migration wait must not retain that helper or its interprocess guard.
        f.advanceClock(240_000);
        progress.tracker.push(
          Buffer.from(encodeBackendMigrationProgress({ phase: "complete", migrationId: 92 })),
          progress.elapsedMs(),
        );
      },
    });
    expect((await runtime.ensure()).marker.windowsOwnershipState).toBe("committed");
    expect(open).toHaveBeenCalledTimes(2);
    expect(f.session.close).toHaveBeenCalledTimes(2);
    expect(f.session.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedRevision: "revision-2" }),
    );
    expect(phases.mock.calls.map(([phase]) => phase)).toEqual([
      { phase: "starting" },
      { phase: "migrating", migrationId: 92 },
      { phase: "starting" },
      { phase: "ready" },
    ]);
    expect(f.closeStartupProgress).toHaveBeenCalledTimes(1);
    expect(f.session.terminate).not.toHaveBeenCalled();
  });

  it("preserves a replacement record when the prepared revision changes outside the guard", async () => {
    const f = fixture(null);
    const runtime = createWindowsProviderRuntime({
      ...f.options,
      fetchHealth: async () => {
        const health = f.health();
        f.setRecord(marker());
        return health;
      },
    });
    await expect(runtime.ensure()).rejects.toMatchObject({ reason: "ownership-changed" });
    expect(f.record).toEqual(marker());
    expect(f.session.publish).toHaveBeenCalledTimes(2);
    expect(f.session.retire).not.toHaveBeenCalled();
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.options.issueLease).not.toHaveBeenCalled();
    expect(f.processes.has(201)).toBe(true);
    expect(f.closeStartupProgress).toHaveBeenCalledTimes(1);
  });

  it("preserves the exact prepared child when native re-admission is inconclusive", async () => {
    const f = fixture(null);
    const runtime = createWindowsProviderRuntime({
      ...f.options,
      fetchHealth: async () => {
        f.setObservationUnknown(true);
        return f.health();
      },
    });
    await expect(runtime.ensure()).rejects.toMatchObject({ reason: "child-admission-uncertain" });
    expect(f.record?.windowsOwnershipState).toBe("prepared");
    expect(f.record?.pid).toBe(201);
    expect(f.processes.has(201)).toBe(true);
    expect(f.session.publish).toHaveBeenCalledTimes(2);
    expect(f.session.retire).not.toHaveBeenCalled();
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.closeStartupProgress).toHaveBeenCalledTimes(1);
  });

  it("does not wait or acquire another guard after an unconfirmed helper close", async () => {
    const f = fixture(null);
    vi.mocked(f.session.close).mockRejectedValueOnce(new Error("synthetic lost close reply"));
    await expect(f.runtime.ensure()).rejects.toMatchObject({ reason: "ownership-unavailable" });
    expect(f.options.openSession).toHaveBeenCalledTimes(1);
    expect(f.options.fetchHealth).not.toHaveBeenCalled();
    expect(f.record?.windowsOwnershipState).toBe("prepared");
    expect(f.processes.has(201)).toBe(true);
    expect(f.closeStartupProgress).toHaveBeenCalledTimes(1);
  });

  it("keeps migration timeout nonrenewable and preserves the child and prepared credential record", async () => {
    const f = fixture(null);
    let progress!: WindowsRuntimeStartupProgress;
    f.setUnavailable(true);
    const runtime = createWindowsProviderRuntime({
      ...f.options,
      spawn: async (bootstrap, input) => {
        progress = input!;
        progress.tracker.push(
          Buffer.from(encodeBackendMigrationProgress({ phase: "start", migrationId: 92 })),
          0,
        );
        return f.spawn(bootstrap, input);
      },
      sleep: async () => {
        const absoluteDeadline = progress.tracker.deadlineMs;
        f.advanceClock(absoluteDeadline - 1);
        progress.tracker.push(
          Buffer.from(encodeBackendMigrationProgress({ phase: "start", migrationId: 93 })),
          progress.elapsedMs(),
        );
        expect(progress.tracker.deadlineMs).toBe(absoluteDeadline);
        f.advanceClock(1);
      },
    });
    await expect(runtime.ensure()).rejects.toMatchObject({ reason: "prepared-attempt-uncertain" });
    expect(f.options.openSession).toHaveBeenCalledTimes(1);
    expect(f.record?.windowsOwnershipState).toBe("prepared");
    expect(f.record?.pid).toBe(201);
    expect(f.processes.has(201)).toBe(true);
    expect(f.session.publish).toHaveBeenCalledTimes(2);
    expect(f.session.retire).not.toHaveBeenCalled();
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.closeStartupProgress).toHaveBeenCalledTimes(1);
  });

  it("adopts a matching authenticated process and obtains a scoped lease", async () => {
    const f = fixture();
    const result = await f.runtime.ensure();
    expect(result.adopted).toBe(true);
    expect(result.endpoint.token).toBe(`${token}-lease`);
    expect(await f.runtime.observe()).toEqual({ status: "same-process", ownershipId });
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.session.terminate).not.toHaveBeenCalled();
  });

  it("retires a proven reused PID without signalling its unrelated occupant", async () => {
    const f = fixture();
    f.processes.set(identity.pid, secondIdentity);
    const result = await f.runtime.ensure();
    expect(result.adopted).toBe(false);
    expect(result.marker.pid).toBe(201);
    expect(f.processes.get(identity.pid)).toEqual(secondIdentity);
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.session.retire).toHaveBeenCalledTimes(1);
  });

  it("confirmed process exit allows a fresh bound generation", async () => {
    const f = fixture();
    f.processes.delete(identity.pid);
    const result = await f.runtime.ensure();
    expect(result.marker.windowsOwnershipState).toBe("committed");
    expect(result.marker.windowsProcessIdentity).toEqual(f.processes.get(201));
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.session.terminate).not.toHaveBeenCalled();
  });

  it.each(["credential", "health", "lease", "identity", "read"] as const)(
    "preserves ownership after inconclusive %s observation",
    async (phase) => {
      const f = fixture();
      if (phase === "credential") f.setCredential();
      if (phase === "health") f.setUnavailable(true);
      if (phase === "lease") f.setLeaseError(true);
      if (phase === "identity") f.setObservationUnknown(true);
      if (phase === "read") f.setReadError(true);
      await expect(f.runtime.ensure()).rejects.toBeInstanceOf(WindowsProviderRuntimeError);
      expect(f.record).toEqual(marker());
      expect(f.spawn).not.toHaveBeenCalled();
      expect(f.session.retire).not.toHaveBeenCalled();
      expect(f.session.terminate).not.toHaveBeenCalled();
    },
  );

  it("rejects authenticated contradictory endpoint evidence during stale retirement", async () => {
    const f = fixture();
    const health = f.health();
    f.processes.set(identity.pid, secondIdentity);
    f.setResponse(health);
    await expect(f.runtime.ensure()).rejects.toMatchObject({ reason: "endpoint-conflict" });
    expect(f.session.retire).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("does not grant ownership when a new-generation endpoint omits its OS identity", async () => {
    const f = fixture();
    const { windowsProcessIdentity: _identity, ...health } = f.health();
    f.setResponse(health);
    await expect(f.runtime.ensure()).rejects.toMatchObject({ reason: "endpoint-conflict" });
    expect(f.session.terminate).not.toHaveBeenCalled();
  });

  it("migrates an authenticated legacy owner by exact OS identity without changing credentials", async () => {
    const {
      windowsOwnershipId: _id,
      windowsOwnershipState: _state,
      windowsProcessIdentity: _identity,
      ...legacy
    } = marker();
    const f = fixture(legacy);
    const result = await f.runtime.ensure();
    expect(result.marker.windowsProcessIdentity).toEqual(identity);
    expect(result.marker.windowsOwnershipId).toBeUndefined();
    expect(result.ownershipId).toBe(f.revision);
    expect(result.marker.credentialPath).toBe(legacy.credentialPath);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.session.publish).toHaveBeenCalledWith(
      expect.not.objectContaining({ credentialBase64: expect.anything() }),
    );
  });

  it("does not infer a legacy owner from timestamps or a currently live PID", async () => {
    const {
      windowsOwnershipId: _id,
      windowsOwnershipState: _state,
      windowsProcessIdentity: _identity,
      ...legacy
    } = marker({ createdAt: "2020-01-01T00:00:00.000Z" });
    const f = fixture(legacy);
    f.setUnavailable(true);
    await expect(f.runtime.ensure()).rejects.toMatchObject({ reason: "legacy-identity-unknown" });
    expect(f.session.publish).not.toHaveBeenCalled();
    expect(f.session.retire).not.toHaveBeenCalled();
  });

  it("preflights native identity support before creating any attempt or child", async () => {
    const f = fixture(null);
    f.setCaptureUnknown(true);
    await expect(f.runtime.ensure()).rejects.toMatchObject({ reason: "ownership-unavailable" });
    expect(f.session.publish).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("retains an uncertain prepared attempt instead of repeatedly spawning", async () => {
    const f = fixture(null);
    f.setUnavailable(true);
    await expect(f.runtime.ensure()).rejects.toMatchObject({
      reason: "prepared-attempt-uncertain",
    });
    expect(f.record?.windowsOwnershipState).toBe("prepared");
    await expect(f.runtime.ensure()).rejects.toMatchObject({
      reason: "prepared-attempt-uncertain",
    });
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.session.terminate).not.toHaveBeenCalled();
  });

  it("a lost prepared publication reply does not spawn or blindly replay the mutation", async () => {
    const f = fixture(null);
    f.setPublishFailureAt(1);
    await expect(f.runtime.ensure()).rejects.toMatchObject({ reason: "mutation-uncertain" });
    expect(f.record?.pid).toBe(0);
    expect(f.spawn).not.toHaveBeenCalled();
    await expect(f.runtime.ensure()).rejects.toMatchObject({
      reason: "prepared-attempt-uncertain",
    });
    expect(f.session.publish).toHaveBeenCalledTimes(1);
  });

  it("recovers a pid-zero attempt only from matching authenticated generation and OS identity", async () => {
    const { windowsProcessIdentity: _identity, ...prepared } = marker({
      pid: 0,
      windowsOwnershipState: "prepared",
    });
    const f = fixture(prepared);
    f.setResponse({
      ok: true,
      mode: "provider-daemon",
      pid: identity.pid,
      ppid: 42,
      protocolVersion: 1,
      version: "1.0.0",
      runtimeBuildId: "build-one",
      startedAt: "2026-09-27T00:00:00.000Z",
      activeSessionCount: 0,
      configuredInstanceCount: 0,
      eventCursor: 0,
      windowsOwnershipId: ownershipId,
      windowsProcessIdentity: identity,
    });
    const result = await f.runtime.ensure();
    expect(result.marker.windowsOwnershipState).toBe("committed");
    expect(result.marker.pid).toBe(identity.pid);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.session.capture).not.toHaveBeenCalledWith(0);
  });

  it("a lost committed reply re-observes the durable owner without another spawn", async () => {
    const f = fixture(null);
    f.setPublishFailureAt(3);
    await expect(f.runtime.ensure()).rejects.toMatchObject({ reason: "mutation-uncertain" });
    expect(f.record?.windowsOwnershipState).toBe("committed");
    expect((await f.runtime.ensure()).adopted).toBe(true);
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("preserves a prepared identity when an authenticated endpoint contradicts its birth time", async () => {
    const f = fixture(marker({ windowsOwnershipState: "prepared" }));
    f.setResponse({ ...f.health(), windowsProcessIdentity: secondIdentity });
    f.setObservationUnknown(true);
    await expect(f.runtime.ensure()).rejects.toMatchObject({ reason: "endpoint-conflict" });
    expect(f.session.publish).not.toHaveBeenCalled();
    expect(f.session.retire).not.toHaveBeenCalled();
  });

  it("a failed lease retains the admitted generation for later safe adoption", async () => {
    const f = fixture(null);
    f.setLeaseError(true);
    await expect(f.runtime.ensure()).rejects.toMatchObject({ reason: "lease-unavailable" });
    expect(f.record?.windowsOwnershipState).toBe("committed");
    f.setLeaseError(false);
    await f.runtime.ensure();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.session.terminate).not.toHaveBeenCalled();
  });

  it("retires a failed actual child only after its direct-child exit event", async () => {
    const f = fixture(null);
    f.setChildExited(true);
    f.setUnavailable(true);
    await expect(f.runtime.ensure()).rejects.toMatchObject({ reason: "child-admission-uncertain" });
    expect(f.record).toBeNull();
    expect(f.session.terminate).not.toHaveBeenCalled();
  });

  it("rejects bootstrap-generation mismatch without terminating any process", async () => {
    const f = fixture(null);
    const other = fixture().health();
    f.setResponse(other);
    await expect(f.runtime.ensure()).rejects.toMatchObject({ reason: "child-admission-uncertain" });
    expect(f.record?.windowsOwnershipState).toBe("prepared");
    expect(f.session.terminate).not.toHaveBeenCalled();
  });

  it("stop never signals a PID reused after successful adoption", async () => {
    const f = fixture();
    const result = await f.runtime.ensure();
    f.processes.set(identity.pid, secondIdentity);
    await f.runtime.stop(result.ownershipId);
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.processes.get(identity.pid)).toEqual(secondIdentity);
  });

  it("termination refusal preserves the owner and prevents a competing recovery child", async () => {
    const f = fixture();
    const result = await f.runtime.ensure();
    f.setTerminationUnknown(true);
    await expect(f.runtime.recover(result.ownershipId)).rejects.toMatchObject({
      reason: "termination-uncertain",
    });
    expect(f.record).not.toBeNull();
    expect(f.session.retire).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("replaces an authenticated incompatible build through verified-handle termination", async () => {
    const f = fixture(marker({ appVersion: "older-version" }));
    const accepted = await f.runtime.ensure();
    expect(f.session.terminate).toHaveBeenCalledExactlyOnceWith(identity);
    expect(accepted.marker.pid).toBe(201);
    expect(accepted.marker.appVersion).toBe("1.0.0");
  });

  it("refuses a PID reused between the last observation and same-handle termination", async () => {
    const f = fixture();
    await f.runtime.ensure();
    vi.mocked(f.session.terminate).mockImplementationOnce(async () => {
      f.processes.set(identity.pid, secondIdentity);
      return { status: "different-process" };
    });
    await f.runtime.stop(ownershipId);
    expect(f.processes.get(identity.pid)).toEqual(secondIdentity);
    expect(f.record).toBeNull();
  });

  it("a replaced marker fences a stale watchdog before any mutation", async () => {
    const f = fixture();
    const result = await f.runtime.ensure();
    f.setRecord(marker({ windowsOwnershipId: "ee5b2b29-72ef-4d31-9571-50856776e18b" }));
    await expect(f.runtime.recover(result.ownershipId)).rejects.toMatchObject({
      reason: "ownership-changed",
    });
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.session.retire).not.toHaveBeenCalled();
  });

  it("a stale recovery returns an already accepted newer owner without replacing it", async () => {
    const f = fixture();
    const old = await f.runtime.ensure();
    f.setRecord(marker({ windowsOwnershipId: "ee5b2b29-72ef-4d31-9571-50856776e18b" }));
    const fresh = await f.runtime.ensure();
    const recovered = await f.runtime.recover(old.ownershipId);
    expect(recovered.ownershipId).toBe(fresh.ownershipId);
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("a lost retirement reply never falls through into spawning", async () => {
    const f = fixture();
    f.processes.delete(identity.pid);
    f.setRetireFailure(true);
    await expect(f.runtime.ensure()).rejects.toMatchObject({ reason: "mutation-uncertain" });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("re-observes a supervisor after a lost retirement reply without repeating the stop", async () => {
    const f = fixture(marker({ mode: "provider-supervisor" }));
    const runtime = createWindowsProviderRuntime({ ...f.options, role: "provider-supervisor" });
    await runtime.ensure();
    f.setRetireFailure(true);
    await expect(runtime.stop(ownershipId, identity)).rejects.toMatchObject({
      reason: "mutation-uncertain",
    });
    expect(f.record).toBeNull();
    await runtime.stop(ownershipId, identity);
    expect(runtime.current()).toBeNull();
    expect(f.session.terminate).toHaveBeenCalledTimes(1);
    expect(f.session.retire).toHaveBeenCalledTimes(1);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("an absent already-retired owner never signals a recycled PID", async () => {
    const f = fixture(null);
    f.processes.set(identity.pid, secondIdentity);
    await f.runtime.stop(ownershipId, identity);
    expect(f.processes.get(identity.pid)).toEqual(secondIdentity);
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.session.retire).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(["same-process", "unknown"] as const)(
    "an absent ownership record preserves a %s process",
    async (status) => {
      const f = fixture(null);
      f.setObservationUnknown(status === "unknown");
      await expect(f.runtime.stop(ownershipId, identity)).rejects.toMatchObject({
        reason: "identity-unknown",
      });
      expect(f.session.terminate).not.toHaveBeenCalled();
      expect(f.session.retire).not.toHaveBeenCalled();
    },
  );

  it("an owner appearing during retirement re-observation fences the stale stop", async () => {
    const f = fixture(null);
    const replacement = marker({ windowsOwnershipId: "ce5b2b29-72ef-4d31-9571-50856776e18b" });
    vi.mocked(f.session.observe).mockImplementationOnce(async () => {
      f.setRecord(replacement);
      return { status: "exited" };
    });
    await expect(f.runtime.stop(ownershipId, identity)).rejects.toMatchObject({
      reason: "ownership-changed",
    });
    expect(f.record).toEqual(replacement);
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.session.retire).not.toHaveBeenCalled();
  });

  it("an absent marker without a trusted expected birth identity remains inconclusive", async () => {
    const f = fixture(null);
    f.processes.delete(identity.pid);
    await expect(f.runtime.stop(ownershipId)).rejects.toMatchObject({
      reason: "ownership-changed",
    });
    expect(f.session.observe).not.toHaveBeenCalled();
    expect(f.session.retire).not.toHaveBeenCalled();
  });

  it("preserves separately configured supervisor ownership instead of killing a cached PID", async () => {
    const f = fixture();
    f.setResponse({
      ...f.health(),
      upstreamSupervisor: { configured: true, reachable: true, pid: 333 },
    });
    await f.runtime.ensure();
    await expect(f.runtime.stop()).rejects.toMatchObject({ reason: "upstream-ownership-unknown" });
    expect(f.session.terminate).not.toHaveBeenCalled();
  });

  it("releases the daemon guard before stopping its independently bound supervisor", async () => {
    const f = fixture();
    f.setResponse(withSupervisor(f.health()));
    const stopSupervisor = vi.fn(async () => {
      expect(f.session.close).toHaveBeenCalledTimes(2); // adoption plus first stop transaction
      expect(f.session.terminate).not.toHaveBeenCalled();
    });
    const runtime = createWindowsProviderRuntime({ ...f.options, stopSupervisor });
    await runtime.ensure();
    await runtime.stop(ownershipId);
    expect(stopSupervisor).toHaveBeenCalledExactlyOnceWith({
      ownershipId: "ae5b2b29-72ef-4d31-9571-50856776e18b",
      identity: { pid: 333, creationTime100ns: "134000000000000333" },
    });
    expect(f.session.close).toHaveBeenCalledTimes(3);
    expect(f.session.terminate).toHaveBeenCalledExactlyOnceWith(identity);
  });

  it("refuses a changed daemon revision after the separate supervisor transaction", async () => {
    const f = fixture();
    f.setResponse(withSupervisor(f.health()));
    const stopSupervisor = vi.fn(async () => {
      f.setRecord(marker({ updatedAt: "2026-09-27T01:00:00.000Z" }));
    });
    const runtime = createWindowsProviderRuntime({ ...f.options, stopSupervisor });
    await runtime.ensure();
    await expect(runtime.stop(ownershipId)).rejects.toMatchObject({ reason: "ownership-changed" });
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.session.retire).not.toHaveBeenCalled();
  });

  it("preserves a newly reported supervisor after reacquiring an unchanged daemon marker", async () => {
    const f = fixture();
    const health = withSupervisor(f.health());
    f.setResponse(health);
    const stopSupervisor = vi.fn(async () => {
      f.setResponse({
        ...health,
        upstreamSupervisor: {
          ...health.upstreamSupervisor!,
          windowsOwnershipId: "ce5b2b29-72ef-4d31-9571-50856776e18b",
        },
      });
    });
    const runtime = createWindowsProviderRuntime({ ...f.options, stopSupervisor });
    await runtime.ensure();
    await expect(runtime.stop(ownershipId)).rejects.toMatchObject({ reason: "endpoint-conflict" });
    expect(f.session.terminate).not.toHaveBeenCalled();
    expect(f.session.retire).not.toHaveBeenCalled();
  });

  it("allows expected upstream disappearance during an incompatible-runtime replacement", async () => {
    const f = fixture(marker({ appVersion: "older-version" }));
    let stopped = false;
    const runtime = createWindowsProviderRuntime({
      ...f.options,
      fetchHealth: async () =>
        f.record?.pid === identity.pid
          ? stopped
            ? { ...f.health(), upstreamSupervisor: { configured: true, reachable: false } }
            : withSupervisor(f.health())
          : f.health(),
      stopSupervisor: async () => {
        stopped = true;
      },
    });
    const accepted = await runtime.ensure();
    expect(accepted.marker.pid).toBe(201);
    expect(f.session.terminate).toHaveBeenCalledExactlyOnceWith(identity);
  });

  it("a superseded supervisor or uncertain guard release preserves the daemon", async () => {
    const f = fixture();
    f.setResponse(withSupervisor(f.health()));
    const stopSupervisor = vi.fn(async () => {
      throw new Error("supervisor generation changed");
    });
    const runtime = createWindowsProviderRuntime({ ...f.options, stopSupervisor });
    await runtime.ensure();
    await expect(runtime.stop(ownershipId)).rejects.toMatchObject({
      reason: "upstream-ownership-unknown",
    });
    expect(f.session.terminate).not.toHaveBeenCalled();
    vi.mocked(f.session.close).mockRejectedValueOnce(new Error("exit observation lost"));
    await expect(runtime.stop(ownershipId)).rejects.toMatchObject({
      reason: "upstream-ownership-unknown",
    });
    expect(stopSupervisor).toHaveBeenCalledTimes(1);
  });

  it("closes guards and exposes no native errors or private material", async () => {
    const f = fixture();
    f.setReadError(true);
    try {
      await f.runtime.ensure();
      throw new Error("test must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WindowsProviderRuntimeError);
      expect(String(error)).not.toMatch(/PRIVATE|profile|synthetic-private/);
    }
    expect(f.session.close).toHaveBeenCalledTimes(1);
  });
});

function directChildFixture() {
  const bootstrapPipe = new PassThrough();
  const progressPipe = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: 201,
    stdio: [null, null, null, bootstrapPipe, progressPipe],
    unref: vi.fn(),
    kill: vi.fn(),
  });
  const spawnChild = vi.fn(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcess;
  }) as unknown as typeof nodeSpawn;
  return { child, bootstrapPipe, progressPipe, spawnChild };
}

describe("Windows direct child startup progress boundary", () => {
  const launchOptions = {
    executable: "C:\\fixture\\native-node.exe",
    entrypoint: "C:\\fixture\\daemon.js",
    cwd: "C:\\fixture",
    env: {},
    bootstrap: {
      cafeCodeHome: "C:\\fixture",
      mode: "provider-daemon" as const,
      transport: "ipc" as const,
      socketPath,
      token,
      startupProgressFd: 4 as const,
    },
  };

  it("drains fd 4 after rejection, ignores detached output and closes only the progress handle", async () => {
    const f = directChildFixture();
    const report = vi.fn();
    const tracker = makeProviderDaemonStartupProgressTracker(30_000, report);
    tracker.start();
    const child = await spawnWindowsProviderRuntimeChild({
      ...launchOptions,
      spawnChild: f.spawnChild,
      startupProgress: { tracker, elapsedMs: () => 0 },
    });
    expect(f.spawnChild).toHaveBeenCalledWith(
      launchOptions.executable,
      [launchOptions.entrypoint, "provider-daemon", "--bootstrap-fd", "3"],
      expect.objectContaining({
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      }),
    );
    f.progressPipe.write(
      Buffer.from(encodeBackendMigrationProgress({ phase: "start", migrationId: 92 })),
    );
    expect(report).toHaveBeenLastCalledWith({ phase: "migrating", migrationId: 92 });
    f.progressPipe.write(Buffer.from("SECRET invalid arbitrary child output\n"));
    f.progressPipe.write(Buffer.alloc(128 * 1_024, 65));
    expect(f.progressPipe.readableLength).toBe(0);
    expect(tracker.deadlineMs).toBe(30_000);
    expect(JSON.stringify(report.mock.calls)).not.toMatch(/SECRET|arbitrary/);
    child.closeStartupProgress?.();
    child.closeStartupProgress?.();
    expect(f.progressPipe.destroyed).toBe(true);
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(child.hasExited()).toBe(false);
  });

  it("always drains an unobserved progress pipe and closes it on exact child exit", async () => {
    const f = directChildFixture();
    const child = await spawnWindowsProviderRuntimeChild({
      ...launchOptions,
      spawnChild: f.spawnChild,
    });
    f.progressPipe.write(Buffer.alloc(128 * 1_024, 65));
    expect(f.progressPipe.readableLength).toBe(0);
    f.child.emit("exit", 0);
    expect(child.hasExited()).toBe(true);
    expect(f.progressPipe.destroyed).toBe(true);
    expect(f.child.kill).not.toHaveBeenCalled();
  });

  it("revokes an active migration allowance after a progress pipe I/O error", async () => {
    const f = directChildFixture();
    const report = vi.fn();
    const tracker = makeProviderDaemonStartupProgressTracker(30_000, report);
    const child = await spawnWindowsProviderRuntimeChild({
      ...launchOptions,
      spawnChild: f.spawnChild,
      startupProgress: { tracker, elapsedMs: () => 0 },
    });
    f.progressPipe.write(
      Buffer.from(encodeBackendMigrationProgress({ phase: "start", migrationId: 92 })),
    );
    expect(tracker.deadlineMs).toBe(3_600_000);
    f.progressPipe.emit("error", new Error("PRIVATE synthetic error"));
    expect(tracker.deadlineMs).toBe(30_000);
    expect(report).toHaveBeenLastCalledWith({ phase: "starting" });
    expect(JSON.stringify(report.mock.calls)).not.toContain("PRIVATE");
    child.closeStartupProgress?.();
    expect(f.child.kill).not.toHaveBeenCalled();
  });
});
