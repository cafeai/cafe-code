// These synthetic fixtures qualify native no-follow/inode/private-mode checks
// using only filesystem-minted temporary directories and exact owned cleanup.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs/promises";
// Host-native paths must retain the same namespace semantics as the helper.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path";
// Native fixture roots are selected solely beneath the host temporary directory.
import { tmpdir } from "node:os";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi, type TestContext } from "vitest";
import {
  PROVIDER_DAEMON_RETIRE_PATH,
  ProviderDaemonMarker,
  ProviderDaemonRetirementRequest,
  ProviderDaemonRetirementResponse,
  type ProviderDaemonHealth,
} from "@cafecode/contracts";
import type { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import {
  observeProviderDaemonProcess,
  providerDaemonRetirementRequest,
  retireProviderDaemonForStartup,
} from "./DesktopProviderDaemonRetirement.ts";

const token = "synthetic-bootstrap-root-token-0000000000000000000000";
const oldBuild = "a".repeat(64);
const profileId = "b".repeat(64);
const marker: ProviderDaemonMarker = {
  version: 2,
  mode: "provider-daemon",
  dataProfile: "debug",
  dataProfileId: profileId,
  protocolVersion: 1,
  pid: 12345,
  ppid: 1,
  transport: "ipc",
  httpBaseUrl: "http://provider-daemon.local",
  socketPath: "/synthetic/daemon.sock",
  credentialPath: "/synthetic/credential",
  credentialEncrypted: false,
  createdAt: "2026-10-29T01:00:00.000Z",
  updatedAt: "2026-10-29T01:00:01.000Z",
  appVersion: "0.2.6",
  runtimeBuildId: oldBuild,
};
const health: ProviderDaemonHealth = {
  ok: true,
  mode: "provider-daemon",
  dataProfile: "debug",
  dataProfileId: profileId,
  pid: marker.pid,
  ppid: 1,
  version: marker.appVersion,
  protocolVersion: 1,
  runtimeBuildId: oldBuild,
  transport: "ipc",
  retirementProtocol: 1,
  // The actual process opening time comes from authenticated health rather
  // than a marker timestamp or the replacement build's current time.
  startedAt: "2026-10-29T01:00:00.123Z",
  activeSessionCount: 0,
  configuredInstanceCount: 0,
  eventCursor: 0,
};
const encodeMarker = Schema.encodeSync(Schema.fromJsonString(ProviderDaemonMarker));
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(ProviderDaemonRetirementRequest));
const encodeResponse = Schema.encodeSync(Schema.fromJsonString(ProviderDaemonRetirementResponse));

describe("provider daemon startup retirement policy", () => {
  it("binds one nonce to the coherent old IPC runtime and its actual opening time", () => {
    const request = providerDaemonRetirementRequest(marker, health);
    expect(request).toEqual({
      protocolVersion: 1,
      pid: marker.pid,
      startedAt: health.startedAt,
      runtimeBuildId: oldBuild,
      dataProfile: "debug",
      dataProfileId: profileId,
      nonce: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(request?.startedAt).not.toBe(marker.createdAt);
    expect(providerDaemonRetirementRequest(marker, health)?.nonce).not.toBe(request?.nonce);
  });

  const mismatches: ReadonlyArray<{
    name: string;
    markerPatch?: Partial<ProviderDaemonMarker>;
    healthPatch?: Partial<ProviderDaemonHealth>;
  }> = [
    { name: "legacy marker", markerPatch: { version: 1 } },
    { name: "foreign marker role", markerPatch: { mode: "provider-supervisor" } },
    { name: "foreign health role", healthPatch: { mode: "provider-supervisor" } },
    { name: "marker TCP transport", markerPatch: { transport: "tcp" } },
    { name: "health TCP transport", healthPatch: { transport: "tcp" } },
    { name: "stale process", healthPatch: { pid: marker.pid + 1 } },
    { name: "marker protocol", markerPatch: { protocolVersion: 2 } },
    { name: "health protocol", healthPatch: { protocolVersion: 2 } },
    { name: "different old version", healthPatch: { version: "0.2.5" } },
    { name: "different old build", healthPatch: { runtimeBuildId: "c".repeat(64) } },
    {
      name: "malformed old build",
      markerPatch: { runtimeBuildId: "old" },
      healthPatch: { runtimeBuildId: "old" },
    },
    { name: "foreign profile", healthPatch: { dataProfile: "production" } },
    { name: "foreign profile root", healthPatch: { dataProfileId: "c".repeat(64) } },
    {
      name: "configured upstream supervisor",
      healthPatch: { upstreamSupervisor: { configured: true, reachable: false } },
    },
    {
      name: "separate supervisor process",
      healthPatch: {
        supervisorProcess: {
          status: "adopted",
          pid: 23456,
          httpBaseUrl: "http://provider-supervisor.local",
          transport: "ipc",
          markerPath: "/synthetic/supervisor",
          appVersion: "0.2.6",
          protocolVersion: 1,
          adoptedExistingProcess: true,
          durationMs: 0,
        },
      },
    },
  ];
  it.each(mismatches)("refuses $name without minting a request", ({ markerPatch, healthPatch }) => {
    expect(
      providerDaemonRetirementRequest({ ...marker, ...markerPatch }, { ...health, ...healthPatch }),
    ).toBeUndefined();
  });

  it("does not backfill missing legacy capability, profile, build or transport fields", () => {
    const { retirementProtocol: _retirement, ...legacyHealth } = health;
    const { dataProfile: _markerProfile, ...legacyMarker } = marker;
    const { dataProfileId: _healthProfileId, ...unboundHealth } = health;
    const { runtimeBuildId: _markerBuild, ...unknownBuildMarker } = marker;
    const { transport: _markerTransport, ...unknownTransportMarker } = marker;
    const { transport: _healthTransport, ...unknownTransportHealth } = health;
    expect(providerDaemonRetirementRequest(marker, legacyHealth)).toBeUndefined();
    expect(providerDaemonRetirementRequest(legacyMarker, health)).toBeUndefined();
    expect(providerDaemonRetirementRequest(marker, unboundHealth)).toBeUndefined();
    expect(providerDaemonRetirementRequest(unknownBuildMarker, health)).toBeUndefined();
    expect(providerDaemonRetirementRequest(unknownTransportMarker, health)).toBeUndefined();
    expect(providerDaemonRetirementRequest(marker, unknownTransportHealth)).toBeUndefined();
  });
});

describe("strict signal-zero process observation", () => {
  it("admits only successful signal-zero observation or exact ESRCH absence", () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      expect(observeProviderDaemonProcess(marker.pid)).toBe("present");
      expect(kill).toHaveBeenCalledExactlyOnceWith(marker.pid, 0);
      kill.mockImplementationOnce(() => {
        throw Object.assign(new Error("synthetic absence"), { code: "ESRCH" });
      });
      expect(observeProviderDaemonProcess(marker.pid)).toBe("exited");
      expect(kill).toHaveBeenLastCalledWith(marker.pid, 0);
      for (const error of [
        Object.assign(new Error("private denial"), { code: "EPERM" }),
        new Error("private native failure"),
        null,
      ]) {
        kill.mockImplementationOnce(() => {
          throw error;
        });
        expect(observeProviderDaemonProcess(marker.pid)).toBe("unknown");
        expect(kill).toHaveBeenLastCalledWith(marker.pid, 0);
      }
    } finally {
      kill.mockRestore();
    }
  });

  it("never calls process.kill for an invalid PID", () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      for (const pid of [0, -1, 1.5, NaN, Infinity, 2 ** 31, Number.MAX_SAFE_INTEGER + 1])
        expect(observeProviderDaemonProcess(pid)).toBe("unknown");
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});

async function nativeFixture(context: TestContext, encrypted = false) {
  let retired = false;
  let root: string | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const guards = new Set<Awaited<ReturnType<typeof retireProviderDaemonForStartup>>>();
  const controller = new AbortController();
  const assertActive = () => {
    if (retired || context.signal.aborted) throw new Error("Synthetic retirement fixture retired.");
  };
  const own = <A>(start: () => Promise<A>): Promise<A> => {
    assertActive();
    const operation = start();
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  };
  const retire = () => {
    retired = true;
    controller.abort();
  };
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    retire();
    cleanupPromise = (async () => {
      try {
        while (pending.size) await Promise.allSettled([...pending]);
        const closed = await Promise.allSettled([...guards].map((guard) => guard.close()));
        for (const result of closed) if (result.status === "rejected") throw result.reason;
        if (root !== undefined) await fs.rm(root, { recursive: true, force: true });
      } finally {
        context.signal.removeEventListener("abort", retire);
      }
    })();
    return cleanupPromise;
  };
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(cleanup);
  if (context.signal.aborted) retire();
  const directory = await own(async () => {
    const created = await fs.mkdtemp(path.join(tmpdir(), "cafe-retirement-fixture-"));
    root = created;
    return created;
  });
  await own(() => fs.chmod(directory, 0o700));
  const ipcDirectory = path.join(directory, "ipc");
  await own(() => fs.mkdir(ipcDirectory, { mode: 0o700 }));
  const markerPath = path.join(directory, "provider-daemon.json");
  const credentialPath = path.join(directory, "credential");
  const socketPath = path.join(ipcDirectory, "daemon.sock");
  const actualMarker = { ...marker, credentialPath, socketPath, credentialEncrypted: encrypted };
  const markerSource = encodeMarker(actualMarker);
  const credentialBytes = encrypted ? Buffer.from([1, 2, 3, 4]) : Buffer.from(token);
  await own(() => fs.writeFile(markerPath, markerSource, { flag: "wx", mode: 0o600 }));
  await own(() => fs.writeFile(credentialPath, credentialBytes, { flag: "wx", mode: 0o600 }));
  const request = providerDaemonRetirementRequest(actualMarker, health);
  if (!request) throw new Error("Synthetic coherent retirement request was unavailable.");
  const endpoint = {
    transport: "ipc" as const,
    socketPath,
    httpBaseUrl: marker.httpBaseUrl,
    token,
  };
  const decryptCredential = vi.fn(async (_bytes: Uint8Array) => token);
  const input = {
    endpoint,
    marker: actualMarker,
    request,
    markerPath,
    credentialPath,
    socketPath,
    signal: controller.signal,
    decryptCredential,
  };
  const requestJson = vi.fn<typeof requestProviderDaemonJson>(async () => ({
    statusCode: 200,
    body: encodeResponse({ accepted: true, ...request }),
  }));
  const observeProcess = vi.fn<typeof observeProviderDaemonProcess>(() => "exited");
  const dependencies = { requestJson, observeProcess };
  return {
    directory,
    ipcDirectory,
    markerPath,
    credentialPath,
    socketPath,
    markerSource,
    credentialBytes,
    request,
    input,
    dependencies,
    controller,
    own,
    cleanup,
    run: (changes: Partial<typeof input> = {}) =>
      own(async () => {
        const guard = await retireProviderDaemonForStartup({ ...input, ...changes }, dependencies);
        // A timeout can retire the fixture after native guard acquisition but
        // before this continuation. Always retain and join that exact owner.
        guards.add(guard);
        assertActive();
        return guard;
      }),
  };
}
type NativeFixture = Awaited<ReturnType<typeof nativeFixture>>;
async function withNativeFixture(
  context: TestContext,
  body: (fixture: NativeFixture) => Promise<void>,
  encrypted = false,
) {
  const fixture = await nativeFixture(context, encrypted);
  let bodyFailed = false;
  try {
    await body(fixture);
  } catch (error) {
    bodyFailed = true;
    throw error;
  } finally {
    if (bodyFailed) await fixture.cleanup().catch(() => {});
    else await fixture.cleanup();
  }
}

// The POSIX manager uses uid/mode/no-follow admission. Windows retains its
// separate generation/FILETIME native-handle suite and never calls this helper.
describe.skipIf(process.platform === "win32")("private POSIX startup retirement", () => {
  it("sends one exact root-authenticated request, then rechecks files and socket before spawn", async (context) => {
    await withNativeFixture(context, async (f) => {
      const retired = await f.run();
      expect(f.dependencies.requestJson).toHaveBeenCalledExactlyOnceWith(
        f.input.endpoint,
        PROVIDER_DAEMON_RETIRE_PATH,
        expect.objectContaining({
          method: "POST",
          body: encodeRequest(f.request),
          timeoutMs: 5_000,
          maxResponseBytes: 2_048,
          signal: expect.any(AbortSignal),
        }),
      );
      expect(f.input.endpoint.token).toBe(token);
      expect(f.request.nonce).toMatch(/^[a-f0-9]{64}$/u);
      expect(f.input.decryptCredential).not.toHaveBeenCalled();
      expect(f.dependencies.observeProcess).toHaveBeenCalledWith(marker.pid);
      await f.own(() => retired.verifyBeforeSpawn());
      expect(f.dependencies.requestJson).toHaveBeenCalledTimes(1);
      expect(await f.own(() => fs.readFile(f.markerPath, "utf8"))).toBe(f.markerSource);
      expect(await f.own(() => fs.readFile(f.credentialPath))).toEqual(f.credentialBytes);
      await f.own(() => retired.close());
      await f.own(() => retired.close());
      await expect(f.own(() => retired.verifyBeforeSpawn())).rejects.toThrow(
        "could not be safely stopped",
      );
      expect(f.dependencies.requestJson).toHaveBeenCalledTimes(1);
    });
  });

  it("decrypts only the exact held credential bytes before requesting retirement", async (context) => {
    await withNativeFixture(
      context,
      async (f) => {
        await f.run();
        expect(f.input.decryptCredential).toHaveBeenCalledExactlyOnceWith(f.credentialBytes);
        expect(f.dependencies.requestJson).toHaveBeenCalledTimes(1);
      },
      true,
    );
  });

  it("refuses a credential mismatch before any control request or process observation", async (context) => {
    await withNativeFixture(context, async (f) => {
      await expect(
        f.run({
          endpoint: { ...f.input.endpoint, token: "foreign-bootstrap-token-000000000000000000" },
        }),
      ).rejects.toThrow("could not be safely stopped");
      expect(f.dependencies.requestJson).not.toHaveBeenCalled();
      expect(f.dependencies.observeProcess).not.toHaveBeenCalled();
      expect(await f.own(() => fs.readFile(f.credentialPath))).toEqual(f.credentialBytes);
    });
  });

  it.for(["wrong-nonce", "non-200", "lost-ack", "malformed"] as const)(
    "preserves recovery files and never repeats a %s control outcome",
    async (outcome, context) => {
      await withNativeFixture(context, async (f) => {
        f.dependencies.requestJson.mockImplementationOnce(async () => {
          if (outcome === "lost-ack")
            throw new Error("PRIVATE lost native control acknowledgement");
          return {
            statusCode: outcome === "non-200" ? 409 : 200,
            body:
              outcome === "wrong-nonce"
                ? encodeResponse({
                    accepted: true,
                    ...f.request,
                    nonce: (f.request.nonce[0] === "a" ? "b" : "a") + f.request.nonce.slice(1),
                  })
                : "PRIVATE malformed response",
          };
        });
        await expect(f.run()).rejects.toThrow("could not be safely stopped");
        expect(f.dependencies.requestJson).toHaveBeenCalledTimes(1);
        expect(f.dependencies.observeProcess).not.toHaveBeenCalled();
        expect(await f.own(() => fs.readFile(f.markerPath, "utf8"))).toBe(f.markerSource);
        expect(await f.own(() => fs.readFile(f.credentialPath))).toEqual(f.credentialBytes);
      });
    },
  );

  it.for([
    "marker-content",
    "marker-inode",
    "credential-content",
    "credential-inode",
    "socket",
    "socket-directory",
  ] as const)("refuses changed %s evidence at the final spawn fence", async (changed, context) => {
    await withNativeFixture(context, async (f) => {
      const retired = await f.run();
      if (changed === "marker-content")
        await f.own(() =>
          fs.writeFile(
            f.markerPath,
            encodeMarker({ ...f.input.marker, updatedAt: "2026-10-29T02:00:00.000Z" }),
          ),
        );
      else if (changed === "credential-content")
        await f.own(() => fs.writeFile(f.credentialPath, "changed synthetic credential"));
      else if (changed === "marker-inode" || changed === "credential-inode") {
        const target = changed === "marker-inode" ? f.markerPath : f.credentialPath;
        const replacement = path.join(f.directory, "replacement");
        const bytes = changed === "marker-inode" ? f.markerSource : f.credentialBytes;
        await f.own(() => fs.writeFile(replacement, bytes, { flag: "wx", mode: 0o600 }));
        await f.own(() => fs.rename(replacement, target));
      } else if (changed === "socket")
        await f.own(() =>
          fs.writeFile(f.socketPath, "synthetic conflicting socket entry", {
            flag: "wx",
            mode: 0o600,
          }),
        );
      else {
        await f.own(() => fs.rename(f.ipcDirectory, path.join(f.directory, "retired-ipc")));
        await f.own(() => fs.mkdir(f.ipcDirectory, { mode: 0o700 }));
      }
      await expect(f.own(() => retired.verifyBeforeSpawn())).rejects.toThrow(
        "could not be safely stopped",
      );
      expect(f.dependencies.requestJson).toHaveBeenCalledTimes(1);
      expect((await f.own(() => fs.stat(f.markerPath))).isFile()).toBe(true);
      expect((await f.own(() => fs.stat(f.credentialPath))).isFile()).toBe(true);
    });
  });

  it.for(["unknown", "present"] as const)(
    "preserves the owner when %s observation is cancelled",
    async (observation, context) => {
      await withNativeFixture(context, async (f) => {
        f.dependencies.observeProcess.mockImplementation(() => {
          f.controller.abort();
          return observation;
        });
        await expect(f.run()).rejects.toThrow("could not be safely stopped");
        expect(f.dependencies.requestJson).toHaveBeenCalledTimes(1);
        expect(await f.own(() => fs.readFile(f.markerPath, "utf8"))).toBe(f.markerSource);
        expect(await f.own(() => fs.readFile(f.credentialPath))).toEqual(f.credentialBytes);
      });
    },
  );

  it("refuses an already cancelled attempt before control IO", async (context) => {
    await withNativeFixture(context, async (f) => {
      f.controller.abort();
      await expect(f.run()).rejects.toThrow("could not be safely stopped");
      expect(f.dependencies.requestJson).not.toHaveBeenCalled();
      expect(f.dependencies.observeProcess).not.toHaveBeenCalled();
      expect(await f.own(() => fs.readFile(f.markerPath, "utf8"))).toBe(f.markerSource);
      expect(await f.own(() => fs.readFile(f.credentialPath))).toEqual(f.credentialBytes);
    });
  });
});
