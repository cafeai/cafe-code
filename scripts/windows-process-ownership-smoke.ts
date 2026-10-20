import * as DateTime from "effect/DateTime";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
/**
 * Explicit, isolated native Windows qualification. Never run from default unit
 * discovery: this exercises Win32 handles and helper death using only children
 * and temporary ownership files created by this invocation. It needs no Cafe
 * profile, provider binary, account credentials, or inference calls.
 */
import assert from "node:assert/strict";
// This boundary retains exact native child handles and close/signal ownership.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir, release } from "node:os";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";
import { PassThrough, Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  captureWindowsProcessIdentity,
  observeWindowsProcess,
  openWindowsOwnershipSession,
  terminateWindowsProcess,
  windowsOwnershipCredentialPath,
  WindowsOwnershipError,
  type WindowsOwnershipDependencies,
  type WindowsOwnershipSession,
  type WindowsProcessIdentity,
} from "@cafecode/shared/windowsProcessOwnership";

const FIXTURE_SWITCH = "--ownership-fixture-child";
const TEST_TOKEN = "synthetic-native-ownership-token-000000000000000000";
// This native wait owns an external child/stream lifetime; a virtual
// Effect clock must not replace its existing deadline or cleanup.
// @effect-diagnostics-next-line globalTimers:off
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readPowerShellEnvironment(): Promise<{ version: string; languageMode: string }> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (systemRoot === undefined || !/^[A-Za-z]:\\/.test(systemRoot) || systemRoot.includes("\0")) {
    throw new Error("Trusted Windows system directory unavailable.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$PSVersionTable.PSVersion.ToString(); $ExecutionContext.SessionState.LanguageMode.ToString()",
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { SystemRoot: systemRoot, WINDIR: systemRoot },
      },
    );
    let output = "";
    // This native wait owns an external child/stream lifetime; a virtual
    // Effect clock must not replace its existing deadline or cleanup.
    // @effect-diagnostics-next-line globalTimers:off
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("PowerShell environment probe timed out."));
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 1_024) {
        child.kill();
        reject(new Error("PowerShell environment probe exceeded its limit."));
      }
    });
    child.stderr.on("data", () => {});
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("PowerShell environment probe unavailable."));
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      const [version, languageMode] = output.trim().split(/\r?\n/);
      if (
        code !== 0 ||
        version === undefined ||
        !/^\d+(?:\.\d+){1,3}$/.test(version) ||
        languageMode === undefined ||
        !/^(FullLanguage|ConstrainedLanguage|RestrictedLanguage|NoLanguage)$/.test(languageMode)
      ) {
        reject(new Error("PowerShell environment probe returned invalid metadata."));
      } else resolve({ version, languageMode });
    });
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = DateTime.toEpochMillis(DateTime.nowUnsafe()) + 10_000;
  while (
    child.exitCode === null &&
    child.signalCode === null &&
    DateTime.toEpochMillis(DateTime.nowUnsafe()) < deadline
  ) {
    await sleep(25);
  }
  assert.ok(child.exitCode !== null || child.signalCode !== null, "fixture child must exit");
}

async function startFixture(): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), FIXTURE_SWITCH], {
    windowsHide: true,
    shell: false,
    stdio: "pipe",
    // Native fixture bootstrap receives no inherited provider credentials or
    // selected Node hooks. Its lifetime is controlled by this private stdin.
    env: {
      SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
      WINDIR: process.env.WINDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
  });
  child.stderr.on("data", () => {});
  child.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    // This native wait owns an external child/stream lifetime; a virtual
    // Effect clock must not replace its existing deadline or cleanup.
    // @effect-diagnostics-next-line globalTimers:off
    const timeout = setTimeout(
      () => reject(new Error("Native fixture did not become ready.")),
      10_000,
    );
    child.stdout.once("data", (chunk: Buffer) => {
      clearTimeout(timeout);
      if (chunk.toString("utf8").trim() === "ready") resolve();
      else reject(new Error("Native fixture sent an invalid ready response."));
    });
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Native fixture could not start."));
    });
  });
  return child;
}

/**
 * Lose one real helper mutation response after the actual operation completed.
 * This is a test transport fault, not a production mutation hook: the native
 * helper remains the sole lock holder and file mutator. A fresh helper must
 * recover by reading committed bytes, never by replaying the lost request.
 */
function faultTransport(sourceFault?: { readonly anchor: string; readonly replacement: string }) {
  let helper: ChildProcessWithoutNullStreams | undefined;
  let dropResponse = false;
  const dependency: WindowsOwnershipDependencies = {
    spawn: (executable, args, options) => {
      helper = spawn(executable, [...args], { ...options, stdio: "pipe" });
      if (sourceFault !== undefined) {
        const originalInput = helper.stdin;
        let firstInput = true;
        // Test-only instrumentation of the repository-owned source frame. No
        // environment hook or mutation option exists in the production helper.
        // The fault occurs inside the very helper holding the real native guard.
        const instrumentedInput = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            if (!firstInput) {
              callback(null, chunk);
              return;
            }
            firstInput = false;
            const source = Buffer.from(chunk.toString("utf8").trim(), "base64").toString("utf8");
            const first = source.indexOf(sourceFault.anchor);
            if (first < 0 || first !== source.lastIndexOf(sourceFault.anchor)) {
              callback(new Error("Native fault fixture source anchor must occur exactly once."));
              return;
            }
            const instrumented = source.replace(sourceFault.anchor, sourceFault.replacement);
            callback(null, `${Buffer.from(instrumented, "utf8").toString("base64")}\n`);
          },
        });
        instrumentedInput.pipe(originalInput);
        originalInput.on("error", (error) => instrumentedInput.destroy(error));
        instrumentedInput.on("close", () => originalInput.destroy());
        Object.defineProperty(helper, "stdin", { value: instrumentedInput });
      }
      const original = helper.stdout;
      const forwarded = new PassThrough();
      original.on("data", (chunk: Buffer) => {
        if (dropResponse) {
          // The test owns this disposable helper, never the daemon/fixture PID.
          // Its death releases the same guard that protected this mutation.
          helper?.kill();
        } else forwarded.write(chunk);
      });
      original.on("end", () => forwarded.end());
      Object.defineProperty(helper, "stdout", { value: forwarded });
      return helper;
    },
  };
  return {
    dependency,
    loseNextResponse: () => {
      dropResponse = true;
    },
    killHelper: async () => {
      assert.ok(helper, "expected an owned helper child");
      helper.kill();
      await waitForExit(helper);
    },
  };
}

export async function runWindowsProcessOwnershipSmoke(): Promise<void> {
  if (process.platform !== "win32")
    throw new Error("Native ownership qualification requires Windows.");
  const root = await mkdtemp(join(tmpdir(), "cafecode-windows-ownership-"));
  let child: ChildProcessWithoutNullStreams | undefined;
  let identity: WindowsProcessIdentity | undefined;
  let junctionFixture: string | undefined;
  const sessions = new Set<WindowsOwnershipSession>();
  const results: Record<string, boolean> = {};
  const timing: Record<string, number> = {};
  const open = async (
    role: "daemon" | "supervisor",
    dependencies?: WindowsOwnershipDependencies,
  ) => {
    const markerPath = join(root, role, "state", `provider-${role}.json`);
    const legacyCredentialPath =
      role === "daemon"
        ? join(dirname(markerPath), "provider-daemon-token.bin")
        : join(root, role, "secrets", "provider-supervisor-token");
    await mkdir(dirname(markerPath), { recursive: true });
    await mkdir(dirname(legacyCredentialPath), { recursive: true });
    const session = await openWindowsOwnershipSession(
      { markerPath, legacyCredentialPath, role },
      dependencies,
    );
    sessions.add(session);
    return { session, markerPath, legacyCredentialPath };
  };
  const close = async (session: WindowsOwnershipSession) => {
    await session.close().catch(() => {});
    sessions.delete(session);
  };
  try {
    const powershell = await readPowerShellEnvironment();
    Effect.runSync(
      Console.info(
        JSON.stringify({
          phase: "native-environment",
          powershell,
          node: process.version,
          windowsBuild: release(),
          runnerImageVersion: process.env.ImageVersion ?? null,
        }),
      ),
    );
    child = await startFixture();
    assert.ok(child.pid);
    let started = performance.now();
    const captured = await captureWindowsProcessIdentity(child.pid, {
      onStartupPhase: (phase) =>
        Effect.runSync(
          Console.info(
            JSON.stringify({
              phase: "native-helper-startup",
              helperPhase: phase,
              durationMs: Math.round(performance.now() - started),
            }),
          ),
        ),
    });
    timing.coldCaptureMs = Math.round(performance.now() - started);
    // Fixed native outcomes diagnose setup/policy failures without printing the
    // helper's raw stdout/stderr, target command line, PID or filesystem paths.
    Effect.runSync(
      Console.info(
        JSON.stringify({
          phase: "native-capture",
          status: captured.status,
          ...(captured.status === "present" || captured.reason === undefined
            ? {}
            : { reason: captured.reason }),
          durationMs: timing.coldCaptureMs,
        }),
      ),
    );
    assert.equal(
      captured.status,
      "present",
      "native helper must capture the disposable child's FILETIME",
    );
    if (captured.status !== "present") throw new Error("Disposable child identity unavailable.");
    identity = captured.identity;
    assert.equal(typeof identity.creationTime100ns, "string");
    results.capture = true;
    const owner = await open("daemon");
    await assert.rejects(
      openWindowsOwnershipSession({
        markerPath: `${dirname(owner.markerPath)}/../state\\provider-daemon.json`,
        legacyCredentialPath: owner.legacyCredentialPath,
        role: "daemon",
      }),
      (error: unknown) => error instanceof WindowsOwnershipError && error.reason === "unsafe-path",
    );
    results.slashTraversalRejected = true;
    // Junction creation needs no Developer Mode or administrator symlink
    // privilege. Keep both the link and its empty target inside this invocation's
    // disposable root; native validation must reject before creating a guard.
    const junctionTarget = join(root, "junction-target");
    await mkdir(junctionTarget);
    const junctionPath = join(root, "junction-alias");
    await symlink(junctionTarget, junctionPath, "junction");
    junctionFixture = junctionPath;
    await assert.rejects(
      openWindowsOwnershipSession({
        markerPath: join(junctionPath, "provider-daemon.json"),
        legacyCredentialPath: join(junctionPath, "provider-daemon-token.bin"),
        role: "daemon",
      }),
      (error: unknown) =>
        error instanceof WindowsOwnershipError && error.reason === "unsafe-directory-reparse",
    );
    assert.deepEqual(await readdir(junctionTarget), []);
    // Remove only the directory entry, never recursively traverse the junction.
    await unlink(junctionPath);
    junctionFixture = undefined;
    results.junctionAncestorRejectedBeforeMutation = true;
    started = performance.now();
    assert.equal((await owner.session.observe(identity)).status, "same-process");
    timing.hotObserveMs = Math.round(performance.now() - started);
    const wrongIdentity = {
      ...identity,
      creationTime100ns: (BigInt(identity.creationTime100ns) + 1n).toString(),
    };
    assert.equal((await owner.session.observe(wrongIdentity)).status, "different-process");
    assert.equal((await owner.session.terminate(wrongIdentity)).status, "different-process");
    assert.equal((await owner.session.observe(identity)).status, "same-process");
    results.wrongIdentityNeverTerminates = true;

    await assert.rejects(
      open("daemon"),
      (error: unknown) => error instanceof WindowsOwnershipError && error.reason === "lock-busy",
    );
    results.concurrentGuardExclusion = true;
    // Node realpath expands an existing 8.3 TEMP alias when one is present. The
    // canonical/case variant must contend on the same native guard; it must not
    // create a second ownership authority under another spelling of one folder.
    const canonicalOwnerDirectory = await realpath(dirname(owner.markerPath));
    await assert.rejects(
      openWindowsOwnershipSession({
        markerPath: join(canonicalOwnerDirectory.toUpperCase(), "provider-daemon.json"),
        legacyCredentialPath: join(
          canonicalOwnerDirectory.toUpperCase(),
          "provider-daemon-token.bin",
        ),
        role: "daemon",
      }),
      (error: unknown) => error instanceof WindowsOwnershipError && error.reason === "lock-busy",
    );
    results.canonicalCaseAliasGuardExclusion = true;
    const ownershipId = randomUUID();
    const credentialPath = windowsOwnershipCredentialPath(owner.legacyCredentialPath, ownershipId);
    const unrelatedCredential = windowsOwnershipCredentialPath(
      owner.legacyCredentialPath,
      randomUUID(),
    );
    await writeFile(unrelatedCredential, "unrelated synthetic generation");
    const prepared = {
      version: 2,
      mode: "provider-daemon",
      protocolVersion: 1,
      pid: identity.pid,
      httpBaseUrl: "http://provider-daemon.local",
      transport: "ipc",
      socketPath: `\\\\.\\pipe\\cafecode-ownership-fixture-${ownershipId}`,
      credentialPath,
      credentialEncrypted: false,
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      appVersion: "0.0.0-native-test",
      windowsOwnershipId: ownershipId,
      windowsProcessIdentity: identity,
      windowsOwnershipState: "prepared",
    };
    assert.deepEqual(await owner.session.read(), { markerJson: null, revision: null });
    const preparedRevision = await owner.session.publish({
      expectedRevision: null,
      markerJson: JSON.stringify(prepared),
      credentialBase64: Buffer.from(TEST_TOKEN).toString("base64"),
    });
    const committed = { ...prepared, windowsOwnershipState: "committed" };
    const committedRevision = await owner.session.publish({
      expectedRevision: preparedRevision,
      markerJson: JSON.stringify(committed),
    });
    assert.notEqual(committedRevision, preparedRevision);
    await assert.rejects(
      owner.session.retire(preparedRevision),
      (error: unknown) =>
        error instanceof WindowsOwnershipError && error.reason === "ownership-changed",
    );
    await assert.rejects(
      owner.session.publish({
        expectedRevision: preparedRevision,
        markerJson: JSON.stringify(prepared),
      }),
      (error: unknown) =>
        error instanceof WindowsOwnershipError && error.reason === "ownership-changed",
    );
    assert.equal((await owner.session.read()).revision, committedRevision);
    results.staleRevisionPreservesNewGeneration = true;
    await close(owner.session);

    const crash = faultTransport();
    const crashOwner = await open("daemon", crash.dependency);
    await crash.killHelper();
    await assert.rejects(crashOwner.session.read());
    await close(crashOwner.session);
    const afterCrash = await open("daemon");
    assert.equal((await afterCrash.session.read()).revision, committedRevision);
    await close(afterCrash.session);
    results.helperDeathReleasesGuard = true;

    const lostReply = faultTransport();
    const uncertainOwner = await open("daemon", lostReply.dependency);
    lostReply.loseNextResponse();
    const republished = { ...committed, updatedAt: "2026-09-27T00:00:01.000Z" };
    await assert.rejects(
      uncertainOwner.session.publish({
        expectedRevision: committedRevision,
        markerJson: JSON.stringify(republished),
      }),
    );
    await close(uncertainOwner.session);
    const recovered = await open("daemon");
    const recoveredSnapshot = await recovered.session.read();
    assert.ok(recoveredSnapshot.revision);
    assert.notEqual(recoveredSnapshot.revision, committedRevision);
    assert.deepEqual(JSON.parse(recoveredSnapshot.markerJson!), republished);
    assert.equal(
      Buffer.from(recoveredSnapshot.credentialBase64!, "base64").toString("utf8"),
      TEST_TOKEN,
    );
    results.lostMutationReplyRecoveredByObservation = true;
    await recovered.session.retire(recoveredSnapshot.revision);
    assert.deepEqual(await recovered.session.read(), { markerJson: null, revision: null });
    await assert.rejects(readFile(credentialPath), { code: "ENOENT" });
    assert.equal(await readFile(unrelatedCredential, "utf8"), "unrelated synthetic generation");
    results.exactGenerationCleanup = true;
    await close(recovered.session);

    const newRecord = () => {
      const windowsOwnershipId = randomUUID();
      return {
        ...prepared,
        windowsOwnershipId,
        credentialPath: windowsOwnershipCredentialPath(
          owner.legacyCredentialPath,
          windowsOwnershipId,
        ),
      };
    };
    const publishRecord = (
      session: WindowsOwnershipSession,
      record: ReturnType<typeof newRecord>,
    ) =>
      session.publish({
        expectedRevision: null,
        markerJson: JSON.stringify(record),
        credentialBase64: Buffer.from(TEST_TOKEN).toString("base64"),
      });

    // A lost initial prepared-publication ACK must be recovered by observing
    // its exact durable bytes, not by publishing another generation over it.
    const preparedLostReply = faultTransport();
    const preparedUncertain = await open("daemon", preparedLostReply.dependency);
    const uncertainPreparedRecord = newRecord();
    preparedLostReply.loseNextResponse();
    await assert.rejects(publishRecord(preparedUncertain.session, uncertainPreparedRecord));
    await close(preparedUncertain.session);
    const preparedReobserved = await open("daemon");
    const preparedSnapshot = await preparedReobserved.session.read();
    assert.ok(preparedSnapshot.revision);
    assert.deepEqual(JSON.parse(preparedSnapshot.markerJson!), uncertainPreparedRecord);
    await assert.rejects(
      publishRecord(preparedReobserved.session, newRecord()),
      (error: unknown) =>
        error instanceof WindowsOwnershipError && error.reason === "ownership-changed",
    );
    await preparedReobserved.session.retire(preparedSnapshot.revision);
    await close(preparedReobserved.session);
    results.lostPreparedPublicationReplyReobserved = true;

    // Kill at the native boundary after the credential became durable but
    // before any marker publication. Preserve the orphan as evidence; a later
    // generation uses its own credential and never adopts/replays the old one.
    const credentialBoundary = "if (existing == null) WriteAtomic(credentialPath,bytes);";
    const credentialCrash = faultTransport({
      anchor: credentialBoundary,
      replacement: `${credentialBoundary} Environment.Exit(73);`,
    });
    const credentialUncertain = await open("daemon", credentialCrash.dependency);
    const credentialOnlyRecord = newRecord();
    await assert.rejects(publishRecord(credentialUncertain.session, credentialOnlyRecord));
    await close(credentialUncertain.session);
    const afterCredentialCrash = await open("daemon");
    assert.deepEqual(await afterCredentialCrash.session.read(), {
      markerJson: null,
      revision: null,
    });
    assert.equal(await readFile(credentialOnlyRecord.credentialPath, "utf8"), TEST_TOKEN);
    const postCredentialRecord = newRecord();
    const postCredentialRevision = await publishRecord(
      afterCredentialCrash.session,
      postCredentialRecord,
    );
    await afterCredentialCrash.session.retire(postCredentialRevision);
    assert.equal(await readFile(credentialOnlyRecord.credentialPath, "utf8"), TEST_TOKEN);
    await close(afterCredentialCrash.session);
    results.credentialBeforeMarkerCrashReobserved = true;

    // A lost retirement ACK can mean that both deletes completed. Re-observe
    // absence; an old revision must not retire a subsequently admitted owner.
    const retireLostReply = faultTransport();
    const retireUncertain = await open("daemon", retireLostReply.dependency);
    const retiredRecord = newRecord();
    const retiredRevision = await publishRecord(retireUncertain.session, retiredRecord);
    retireLostReply.loseNextResponse();
    await assert.rejects(retireUncertain.session.retire(retiredRevision));
    await close(retireUncertain.session);
    const retirementReobserved = await open("daemon");
    assert.deepEqual(await retirementReobserved.session.read(), {
      markerJson: null,
      revision: null,
    });
    await assert.rejects(readFile(retiredRecord.credentialPath), { code: "ENOENT" });
    const replacementRecord = newRecord();
    const replacementRevision = await publishRecord(
      retirementReobserved.session,
      replacementRecord,
    );
    await assert.rejects(
      retirementReobserved.session.retire(retiredRevision),
      (error: unknown) =>
        error instanceof WindowsOwnershipError && error.reason === "ownership-changed",
    );
    assert.equal((await retirementReobserved.session.read()).revision, replacementRevision);
    assert.equal(await readFile(replacementRecord.credentialPath, "utf8"), TEST_TOKEN);
    await retirementReobserved.session.retire(replacementRevision);
    await close(retirementReobserved.session);
    results.lostRetirementReplyDoesNotDeleteNewGeneration = true;

    // Kill inside retirement after marker removal but before credential removal.
    // Its stale credential remains untouched; a new owner's marker/token must
    // survive every stale-revision cleanup attempt after the guard is reacquired.
    const retirementBoundary = 'if (!DeleteFile(Marker)) Fail("mutation-unconfirmed");';
    const retirementCrash = faultTransport({
      anchor: retirementBoundary,
      replacement: `${retirementBoundary} Environment.Exit(73);`,
    });
    const partialRetirement = await open("daemon", retirementCrash.dependency);
    const partialRetiredRecord = newRecord();
    const partialRetiredRevision = await publishRecord(
      partialRetirement.session,
      partialRetiredRecord,
    );
    await assert.rejects(partialRetirement.session.retire(partialRetiredRevision));
    await close(partialRetirement.session);
    const afterRetirementCrash = await open("daemon");
    assert.deepEqual(await afterRetirementCrash.session.read(), {
      markerJson: null,
      revision: null,
    });
    assert.equal(await readFile(partialRetiredRecord.credentialPath, "utf8"), TEST_TOKEN);
    const postRetirementRecord = newRecord();
    const postRetirementRevision = await publishRecord(
      afterRetirementCrash.session,
      postRetirementRecord,
    );
    await assert.rejects(
      afterRetirementCrash.session.retire(partialRetiredRevision),
      (error: unknown) =>
        error instanceof WindowsOwnershipError && error.reason === "ownership-changed",
    );
    assert.equal((await afterRetirementCrash.session.read()).revision, postRetirementRevision);
    assert.equal(await readFile(postRetirementRecord.credentialPath, "utf8"), TEST_TOKEN);
    await afterRetirementCrash.session.retire(postRetirementRevision);
    assert.equal(await readFile(partialRetiredRecord.credentialPath, "utf8"), TEST_TOKEN);
    await close(afterRetirementCrash.session);
    results.markerBeforeCredentialRetirementCrashReobserved = true;

    // Supervisors deliberately keep marker and credentials in different pinned
    // directories. Exercise the same native transaction authority for that role.
    const supervisor = await open("supervisor");
    const supervisorId = randomUUID();
    const supervisorMarker = {
      ...committed,
      mode: "provider-supervisor",
      windowsOwnershipId: supervisorId,
      credentialPath: windowsOwnershipCredentialPath(supervisor.legacyCredentialPath, supervisorId),
    };
    const supervisorRevision = await supervisor.session.publish({
      expectedRevision: null,
      markerJson: JSON.stringify(supervisorMarker),
      credentialBase64: Buffer.from(TEST_TOKEN).toString("base64"),
    });
    await supervisor.session.retire(supervisorRevision);
    assert.deepEqual(await supervisor.session.read(), { markerJson: null, revision: null });
    await close(supervisor.session);
    results.supervisorSeparateCredentialDirectory = true;

    assert.equal((await terminateWindowsProcess(identity)).status, "exited");
    await waitForExit(child);
    const afterExit = await observeWindowsProcess(identity);
    assert.ok(afterExit.status === "exited" || afterExit.status === "different-process");
    results.sameHandleTerminationConfirmed = true;
    const helperSource = await readFile(
      new URL("../packages/shared/src/windowsProcessOwnershipScript.ts", import.meta.url),
    );
    const lockfile = await readFile(new URL("../yarn.lock", import.meta.url));
    Effect.runSync(
      Console.info(
        JSON.stringify({
          ok: true,
          platform: process.platform,
          windowsBuild: release(),
          architecture: process.arch,
          node: process.version,
          powershell,
          runnerImageVersion: process.env.ImageVersion ?? null,
          helperSourceSha256: createHash("sha256").update(helperSource).digest("hex"),
          lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
          checks: results,
          timingMs: timing,
        }),
      ),
    );
  } finally {
    for (const session of sessions) await close(session);
    if (junctionFixture !== undefined) await unlink(junctionFixture);
    if (identity !== undefined && child?.exitCode === null && child.signalCode === null)
      await terminateWindowsProcess(identity);
    // The fixture's stdin EOF is a cooperative exit, not a raw PID signal.
    child?.stdin.end();
    if (child !== undefined) await waitForExit(child);
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  }
}

if (import.meta.main) {
  if (process.argv[2] === FIXTURE_SWITCH) {
    process.stdout.write("ready\n");
    process.stdin.resume();
    process.stdin.once("end", () => process.exit(0));
    // Independent backstop if the parent loses its streams during a test crash.
    // This native wait owns an external child/stream lifetime; a virtual
    // Effect clock must not replace its existing deadline or cleanup.
    // @effect-diagnostics-next-line globalTimers:off
    setTimeout(() => process.exit(0), 180_000);
  } else {
    await runWindowsProcessOwnershipSmoke();
  }
}
