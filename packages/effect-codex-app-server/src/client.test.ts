import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";
import * as CodexError from "./errors.ts";
import { codexCommandUsesShell } from "./command.ts";
import * as Ref from "effect/Ref";
import * as CodexProtocol from "./protocol.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/codex-app-server-mock-peer.ts"),
);
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const encoder = new TextEncoder();
const encodeJsonl = (value: unknown) => encoder.encode(`${encodeUnknownJsonString(value)}\n`);
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

for (const loggerStage of ["raw", "decoded"] as const) {
  for (const shape of ["multiline", "multi-chunk"] as const) {
    it.effect(
      `fences the complete pulled ${shape} batch while ${loggerStage} logging is held`,
      () =>
        Effect.gen(function* () {
          const { stdio, input } = yield* makeInMemoryStdio();
          const loggerEntered = yield* Deferred.make<void>();
          const releaseLogger = yield* Deferred.make<void>();
          const processed = yield* Deferred.make<void>();
          let pendingIngress = 0;
          let incomplete = false;
          let receivedNotifications = 0;
          const first = encodeJsonl({
            method: "warning",
            params: { message: "synthetic earlier frame" },
          });
          const child = encodeJsonl({
            method: "turn/started",
            params: { threadId: "synthetic-later-child" },
          });
          // Queue before constructing the reader to make both chunks part of
          // one observed batch, not two timing-dependent independent pulls.
          yield* Queue.offerAll(
            input,
            shape === "multi-chunk" ? [first, child] : [Buffer.concat([first, child])],
          );
          const client = yield* CodexClient.make(stdio, {
            onIncomingDataReceived: () => {
              pendingIngress += 1;
            },
            onIncomingDataProcessed: (hasIncompleteFrame) => {
              pendingIngress -= 1;
              incomplete = hasIncompleteFrame;
              Deferred.doneUnsafe(processed, Effect.void);
            },
            onNotificationReceived: () => {
              receivedNotifications += 1;
            },
            logIncoming: true,
            logger: (event) =>
              event.stage === loggerStage
                ? Deferred.succeed(loggerEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseLogger)),
                  )
                : Effect.void,
          });
          yield* Effect.gen(function* () {
            yield* Deferred.await(loggerEntered);
            assert.equal(pendingIngress, 1);
            // Even when the later child line has not been decoded yet, the
            // whole observed batch already prevents a false native idle proof.
            assert.equal(pendingIngress > 0 || incomplete || receivedNotifications > 0, true);
            yield* Deferred.succeed(releaseLogger, undefined);
            const frames = yield* Stream.runCollect(client.raw.notifications.pipe(Stream.take(2)));
            assert.deepEqual(
              Array.from(frames, (frame) => frame.method),
              ["warning", "turn/started"],
            );
            // A distinct final callback is queued after routing, not a guess
            // based on the public notification queue becoming empty.
            yield* Deferred.await(processed);
            assert.equal(pendingIngress, 0);
            assert.equal(incomplete, false);
            assert.equal(receivedNotifications, 2);
          }).pipe(Effect.ensuring(Deferred.succeed(releaseLogger, undefined)));
        }).pipe(Effect.scoped),
    );
  }
}

it.effect(
  "reports a retained partial UTF-8 frame as unresolved ingress until its newline arrives",
  () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const firstProcessed = yield* Deferred.make<void>();
      const lastProcessed = yield* Deferred.make<void>();
      let incomplete = false;
      let processedCount = 0;
      const client = yield* CodexClient.make(stdio, {
        onIncomingDataProcessed: (hasIncompleteFrame) => {
          incomplete = hasIncompleteFrame;
          processedCount += 1;
          Deferred.doneUnsafe(processedCount === 1 ? firstProcessed : lastProcessed, Effect.void);
        },
        logIncoming: true,
        logger: () => Effect.void,
      });
      const prefix = encoder.encode('{"method":"future/child","params":{"name":"');
      yield* Queue.offer(input, Buffer.concat([prefix, new Uint8Array([0xe2])]));
      yield* Deferred.await(firstProcessed);
      assert.equal(incomplete, true);
      yield* Queue.offer(
        input,
        Buffer.concat([new Uint8Array([0x82, 0xac]), encoder.encode('"}}\n')]),
      );
      const frame = yield* Stream.runHead(client.raw.notifications);
      assert.equal(frame._tag, "Some");
      if (frame._tag === "Some") assert.deepEqual(frame.value.params, { name: "€" });
      yield* Deferred.await(lastProcessed);
      assert.equal(incomplete, false);
    }).pipe(Effect.scoped),
);

it.effect("accounts native notification receipt before decoded logging or raw queue handoff", () =>
  Effect.gen(function* () {
    const { stdio, input } = yield* makeInMemoryStdio();
    const loggerEntered = yield* Deferred.make<void>();
    const releaseLogger = yield* Deferred.make<void>();
    let received = 0;
    const client = yield* CodexClient.make(stdio, {
      onNotificationReceived: () => {
        received += 1;
      },
      logIncoming: true,
      logger: (event) =>
        event.stage === "decoded"
          ? Deferred.succeed(loggerEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseLogger)),
            )
          : Effect.void,
    });
    yield* Effect.gen(function* () {
      yield* Queue.offer(
        input,
        encodeJsonl({ method: "turn/started", params: { threadId: "synthetic-child" } }),
      );
      yield* Deferred.await(loggerEntered);
      // The reader is held before incomingNotifications publication. Cafe's
      // native ingress count must already deny retirement in this interval.
      assert.equal(received, 1);
      yield* Deferred.succeed(releaseLogger, undefined);
      const frame = yield* Stream.runHead(client.raw.notifications);
      assert.equal(frame._tag, "Some");
      if (frame._tag === "Some") assert.equal(frame.value.method, "turn/started");
      assert.equal(received, 1);
    }).pipe(Effect.ensuring(Deferred.succeed(releaseLogger, undefined)));
  }).pipe(Effect.scoped),
);

const literalCommandArgs = [
  "space in argument",
  'literal"quote',
  "literal&pipe|",
  "%CAFE_ARG%",
  "!CAFE_ARG!",
  "$(literal);`literal`",
  "trailing\\",
  'backslash-before-quote\\"',
  "",
];
const commandPolicies = [
  { command: "C:\\Program Files\\Codex\\codex.exe", windowsShell: false },
  { command: "C:\\tools & fixtures\\CODEX.EXE", windowsShell: false },
  { command: "codex.com", windowsShell: false },
  { command: "CODEX.COM", windowsShell: false },
  { command: "C:\\tools & fixtures\\codex.cmd", windowsShell: true },
  { command: "codex.BAT", windowsShell: true },
  { command: "codex.exe.cmd", windowsShell: true },
  { command: "C:\\codex.exe\\codex", windowsShell: true },
  { command: "codex", windowsShell: true },
  { command: "/usr/local/bin/codex", windowsShell: true },
  { command: "/tmp/native executable & fixture.exe", windowsShell: false },
] as const;

interface NativeFixtureRemoval {
  readonly remove: (root: string, options: { readonly recursive: true }) => Promise<void>;
  readonly wait: (milliseconds: number) => Promise<void>;
}

const removeWindowsNativePeerFixture = async (
  root: string,
  operations: NativeFixtureRemoval = { remove: rm, wait: delay },
) => {
  // Effect observes the child's Node `exit` event. Its inner scope already
  // retires the process, but Windows may still hold the copied executable's
  // image handle when the outer fixture scope starts removing its directory.
  // Retry only this owned directory, never the test or the child launch. The
  // five linear waits total 1.5 seconds; exhaustion retains the actual error.
  for (let retry = 0; ; retry += 1) {
    try {
      await operations.remove(root, { recursive: true });
      return;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (retry === 5 || (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY")) {
        throw error;
      }
      await operations.wait((retry + 1) * 100);
    }
  }
};

const makeNativePeerTemporaryRoot = (
  fs: FileSystem.FileSystem,
  platform: NodeJS.Platform = process.platform,
  remove: (root: string) => Promise<void> = removeWindowsNativePeerFixture,
) =>
  platform === "win32"
    ? Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: "cafe-codex-launch-" }),
        // The release closure captures only the directory minted by this
        // acquisition, not an environment path or a caller-selected parent.
        // A rejected cleanup remains a finalizer defect and fails the test.
        (root) => Effect.promise(() => remove(root)),
      )
    : fs.makeTempDirectoryScoped({ prefix: "cafe-codex-launch-" });

it.each(["EBUSY", "EPERM", "ENOTEMPTY"])(
  "removes the exact Windows native fixture root after transient %s handle release",
  async (code) => {
    const root = "filesystem-minted-fixture-root";
    const targets: Array<{ root: string; options: { readonly recursive: true } }> = [];
    const waits: Array<number> = [];
    await removeWindowsNativePeerFixture(root, {
      remove: async (target, options) => {
        targets.push({ root: target, options });
        if (targets.length < 3) throw Object.assign(new Error("Synthetic image lock"), { code });
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
    assert.deepEqual(
      targets,
      Array.from({ length: 3 }, () => ({ root, options: { recursive: true } })),
    );
    assert.deepEqual(waits, [100, 200]);
  },
);

it.each(["EACCES", "ENOENT", "EIO", "EMFILE", "ENFILE", undefined])(
  "does not retry unrelated Windows native fixture cleanup error %s",
  async (code) => {
    const failure = Object.assign(new Error("Synthetic non-transient cleanup failure"), { code });
    let attempts = 0;
    let waits = 0;
    let caught: unknown;
    try {
      await removeWindowsNativePeerFixture("filesystem-minted-fixture-root", {
        remove: async () => {
          attempts += 1;
          throw failure;
        },
        wait: async () => {
          waits += 1;
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.strictEqual(caught, failure);
    assert.equal(attempts, 1);
    assert.equal(waits, 0);
  },
);

it("fails Windows native fixture cleanup after its bounded handle-release budget", async () => {
  const failure = Object.assign(new Error("Synthetic persistent image lock"), { code: "EBUSY" });
  let attempts = 0;
  const waits: Array<number> = [];
  let caught: unknown;
  try {
    await removeWindowsNativePeerFixture("filesystem-minted-fixture-root", {
      remove: async () => {
        attempts += 1;
        throw failure;
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.strictEqual(caught, failure);
  assert.equal(attempts, 6);
  assert.deepEqual(waits, [100, 200, 300, 400, 500]);
});

it.effect("retires the inner native process scope before Windows fixture-root cleanup", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    const root = "filesystem-minted-fixture-root";
    const fs = FileSystem.makeNoop({
      makeTempDirectory: (options) =>
        Effect.sync(() => {
          assert.deepEqual(options, { prefix: "cafe-codex-launch-" });
          events.push("directory acquired");
          return root;
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        assert.equal(
          yield* makeNativePeerTemporaryRoot(fs, "win32", (target) =>
            removeWindowsNativePeerFixture(target, {
              remove: async (removedRoot, options) => {
                assert.equal(removedRoot, root);
                assert.deepEqual(options, { recursive: true });
                assert.deepEqual(events, ["directory acquired", "child retired"]);
                events.push("directory removed");
              },
              wait: async () => assert.fail("Successful cleanup must not wait"),
            }),
          ),
          root,
        );
        yield* Effect.scoped(
          Effect.addFinalizer(() => Effect.sync(() => events.push("child retired"))),
        );
        assert.deepEqual(events, ["directory acquired", "child retired"]);
      }),
    );
    assert.deepEqual(events, ["directory acquired", "child retired", "directory removed"]);
  }),
);

it.effect("keeps rejected Windows fixture-root cleanup visible as a finalizer failure", () =>
  Effect.gen(function* () {
    const failure = Object.assign(new Error("Synthetic persistent image lock"), { code: "EBUSY" });
    const fs = FileSystem.makeNoop({
      makeTempDirectory: () => Effect.succeed("filesystem-minted-fixture-root"),
    });
    const result = yield* Effect.scoped(
      makeNativePeerTemporaryRoot(fs, "win32", async () => {
        throw failure;
      }),
    ).pipe(Effect.exit);
    assert.equal(Exit.isFailure(result), true);
    if (Exit.isFailure(result)) assert.strictEqual(Cause.squash(result.cause), failure);
  }),
);

it.effect.each(["darwin", "linux"] as const)(
  "preserves single-pass scoped native fixture cleanup on %s",
  (platform) =>
    Effect.gen(function* () {
      const root = "filesystem-minted-fixture-root";
      let removed = false;
      const fs = FileSystem.makeNoop({
        makeTempDirectoryScoped: (options) => {
          assert.deepEqual(options, { prefix: "cafe-codex-launch-" });
          return Effect.acquireRelease(Effect.succeed(root), () =>
            Effect.sync(() => {
              removed = true;
            }),
          );
        },
      });
      assert.equal(
        yield* Effect.scoped(
          makeNativePeerTemporaryRoot(fs, platform, async () =>
            assert.fail("POSIX must retain the FileSystem scoped finalizer"),
          ),
        ),
        root,
      );
      assert.equal(removed, true);
    }),
);

const makeNativePeerFixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const temporaryRoot = yield* makeNativePeerTemporaryRoot(fs);
    // macOS resolves /var temporary paths through /private/var in cwd;
    // use one canonical usable spelling for all fixture paths and homes.
    const fixtureRoot = yield* fs.realPath(temporaryRoot);
    const binaryDir = path.join(fixtureRoot, "native executable & fixtures");
    yield* fs.makeDirectory(binaryDir);
    const executable = path.join(binaryDir, "mock codex.EXE");
    const peer = path.join(fixtureRoot, "mock peer.ts");
    // A copy guarantees a spaced native executable path on every runner,
    // without Windows symlink privileges or any installed-provider lookup.
    yield* fs.copyFile(process.execPath, executable);
    if (process.platform !== "win32") {
      yield* fs.chmod(executable, 0o700);
    }
    yield* fs.copyFile(yield* mockPeerPath, peer);
    const homeDrive = process.platform === "win32" ? path.parse(fixtureRoot).root.slice(0, 2) : "";
    const fixtureEnv: Record<string, string> = {
      HOME: fixtureRoot,
      USERPROFILE: fixtureRoot,
      HOMEDRIVE: homeDrive,
      HOMEPATH: fixtureRoot.slice(homeDrive.length),
      APPDATA: fixtureRoot,
      LOCALAPPDATA: fixtureRoot,
      CODEX_HOME: fixtureRoot,
      CODEX_SQLITE_HOME: fixtureRoot,
      PATH: binaryDir,
      TEMP: fixtureRoot,
      TMP: fixtureRoot,
      TMPDIR: fixtureRoot,
      NODE_OPTIONS: "",
      NODE_PATH: "",
      NODE_EXTRA_CA_CERTS: "",
      // Node restores parent coverage settings when this key is absent;
      // an explicit empty value prevents files outside the fixture root.
      NODE_V8_COVERAGE: "",
      USERNAME: "cafe-fixture",
      USERDOMAIN: "cafe-fixture",
      LOGONSERVER: "cafe-fixture",
      CAFE_ARG: "must-never-expand",
      CAFE_CODE_MOCK_PEER_ROOT: fixtureRoot,
      CAFE_CODE_MOCK_PEER_PATH: binaryDir,
    };
    // libuv restores certain absent Windows variables from the parent.
    // Override every home/profile/PATH/temp value above, retaining only
    // the real system directories required for native Windows startup.
    // Required-variable list: Node v24.13.1 deps/uv/src/win/process.c.
    for (const [key, value] of Object.entries(process.env)) {
      if (value && ["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE"].includes(key.toUpperCase())) {
        fixtureEnv[key.toUpperCase()] = value;
      }
    }
    return { fixtureRoot, executable, peer, fixtureEnv };
  });

it.layer(NodeServices.layer)("effect-codex-app-server client", (it) => {
  const makeHandle = () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const { fixtureRoot, executable, peer, fixtureEnv } = yield* makeNativePeerFixture();
      const command = ChildProcess.make(executable, [peer], {
        cwd: fixtureRoot,
        env: fixtureEnv,
        extendEnv: false,
        shell: false,
      });
      return yield* spawner.spawn(command);
    });

  it.effect("keeps typed account reads and both notification streams usable for new plans", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const client = yield* CodexClient.make(stdio);
      const accountRead = yield* client.request("account/read", {}).pipe(Effect.forkScoped);
      const request = decodeJson(yield* Queue.take(output)) as { id: number };
      yield* Queue.offer(
        input,
        encodeJsonl({
          id: request.id,
          result: {
            account: { type: "chatgpt", email: null, planType: "future_plan" },
            requiresOpenaiAuth: true,
          },
        }),
      );
      assert.deepEqual(yield* Fiber.join(accountRead), {
        account: { type: "chatgpt", email: null, planType: "unknown" },
        requiresOpenaiAuth: true,
      });

      const quotaRead = yield* client
        .request("account/rateLimits/read", undefined)
        .pipe(Effect.forkScoped);
      const quotaRequest = decodeJson(yield* Queue.take(output)) as { id: number };
      yield* Queue.offer(
        input,
        encodeJsonl({
          id: quotaRequest.id,
          result: {
            rateLimits: { planType: "future_plan" },
            rateLimitsByLimitId: {
              extra: { planType: "future_plan", primary: { usedPercent: 0 } },
            },
          },
        }),
      );
      assert.deepEqual(yield* Fiber.join(quotaRead), {
        rateLimits: { planType: "unknown" },
        rateLimitsByLimitId: { extra: { planType: "unknown", primary: { usedPercent: 0 } } },
      });

      const typed = yield* Deferred.make<unknown>();
      yield* client.handleServerNotification("account/rateLimits/updated", (payload) =>
        Deferred.succeed(typed, payload),
      );
      const raw = yield* client.raw.notifications.pipe(Stream.runHead, Effect.forkScoped);
      const params = { rateLimits: { planType: "future_plan", primary: { usedPercent: 12 } } };
      yield* Queue.offer(
        input,
        encodeJsonl({ method: "account/rateLimits/updated", params, emittedAtMs: 123 }),
      );
      const expected = { rateLimits: { planType: "unknown", primary: { usedPercent: 12 } } };
      assert.deepEqual(yield* Deferred.await(typed), expected);
      assert.deepEqual(Option.getOrThrow(yield* Fiber.join(raw)), {
        method: "account/rateLimits/updated",
        params: expected,
        emittedAtMs: 123,
      });
    }),
  );

  it.effect("preserves optional Codex 0.154 usage-read capabilities on the typed wire", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const client = yield* CodexClient.make(stdio);

      // The upstream request now has an optional object, while its exported
      // JSON schema wraps that object in NullableGetAccountRateLimitsParams.
      // Exercise the generated typed client so neither omission nor the new
      // flags can accidentally be erased by method/schema resolution.
      const legacyRead = yield* client
        .request("account/rateLimits/read", undefined)
        .pipe(Effect.forkScoped);
      assert.deepEqual(decodeJson(yield* Queue.take(output)), {
        id: 1,
        method: "account/rateLimits/read",
      });
      yield* Queue.offer(input, encodeJsonl({ id: 1, result: { rateLimits: {} } }));
      assert.deepEqual(yield* Fiber.join(legacyRead), { rateLimits: {} });

      const capabilities = {
        excludeResetCreditDetails: true,
        supportsLunaReserve: false,
      };
      const usageRead = yield* client
        .request("account/rateLimits/read", capabilities)
        .pipe(Effect.forkScoped);
      assert.deepEqual(decodeJson(yield* Queue.take(output)), {
        id: 2,
        method: "account/rateLimits/read",
        params: capabilities,
      });
      const result = {
        ordinaryUsageAllowed: false,
        rateLimits: { normalModelSlug: "gpt-5.6-luna" },
        rateLimitsByLimitId: {
          "luna-reserve": { normalModelSlug: "gpt-5.6-luna" },
        },
      };
      yield* Queue.offer(input, encodeJsonl({ id: 2, result }));
      assert.deepEqual(yield* Fiber.join(usageRead), result);
    }),
  );

  it.effect("round-trips Codex 0.155 stored-attachment RPCs without starting a turn", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const client = yield* CodexClient.make(stdio);
      const identity = {
        threadId: "thread-1",
        attachmentType: "document",
        identityKey: "document-1",
      };
      const payload = { title: "Stored document", nested: [null, true, 1] };
      const attachment = {
        attachmentType: identity.attachmentType,
        identityKey: identity.identityKey,
        id: "attachment-1",
        payload,
        createdAt: 1_789_700_000,
      };

      // Use the generated method map, not raw JSON-RPC, so a missing request or
      // response schema fails here before a provider update reaches users.
      const add = yield* client
        .request("thread/attachment/add", { ...identity, payload })
        .pipe(Effect.forkScoped);
      assert.deepEqual(decodeJson(yield* Queue.take(output)), {
        id: 1,
        method: "thread/attachment/add",
        params: { ...identity, payload },
      });
      const addResult = { outcome: "existing" as const, attachment };
      yield* Queue.offer(input, encodeJsonl({ id: 1, result: addResult }));
      assert.deepEqual(yield* Fiber.join(add), addResult);

      const listParams = { threadId: identity.threadId, cursor: "page-2", limit: 20 };
      const list = yield* client
        .request("thread/attachment/list", listParams)
        .pipe(Effect.forkScoped);
      assert.deepEqual(decodeJson(yield* Queue.take(output)), {
        id: 2,
        method: "thread/attachment/list",
        params: listParams,
      });
      const listResult = { data: [attachment], nextCursor: null };
      yield* Queue.offer(input, encodeJsonl({ id: 2, result: listResult }));
      assert.deepEqual(yield* Fiber.join(list), listResult);

      const remove = yield* client
        .request("thread/attachment/remove", identity)
        .pipe(Effect.forkScoped);
      assert.deepEqual(decodeJson(yield* Queue.take(output)), {
        id: 3,
        method: "thread/attachment/remove",
        params: identity,
      });
      yield* Queue.offer(input, encodeJsonl({ id: 3, result: {} }));
      assert.deepEqual(yield* Fiber.join(remove), {});
    }),
  );

  it.effect("initializes, handles typed server requests, and reads account and skills data", () =>
    Effect.gen(function* () {
      const userInputRequests = yield* Ref.make<Array<unknown>>([]);
      const nativeRequestIds = yield* Ref.make<Array<string | number>>([]);
      const messageDeltas = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      // Layer construction can fail before the normal request-region ensuring
      // is installed. Attach this manual scope to the test immediately; its
      // later normal close is idempotent, and test teardown remains a backstop.
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const clientLayer = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const result = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;

        yield* client.handleServerRequest("item/tool/requestUserInput", (payload, context) =>
          Ref.update(userInputRequests, (current) => [...current, payload]).pipe(
            Effect.andThen(
              Ref.update(nativeRequestIds, (current) => [...current, context!.requestId]),
            ),
            Effect.as({
              answers: {
                approved: {
                  answers: ["yes"],
                },
              },
            }),
          ),
        );

        yield* client.handleServerNotification("item/agentMessage/delta", () =>
          Effect.fail(CodexError.CodexAppServerRequestError.internalError("test handler failed")),
        );
        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Ref.update(messageDeltas, (current) => [...current, payload]),
        );

        const initialized = yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
        assert.equal(initialized.userAgent, "mock-codex-app-server");

        yield* client.notify("initialized", undefined);

        const account = yield* client.request("account/read", {});
        assert.equal(account.requiresOpenaiAuth, false);
        assert.deepEqual(account.account, {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        });

        const skills = yield* client.request("skills/list", {
          cwds: [process.cwd()],
        });
        assert.equal(skills.data.length, 1);
        assert.equal(skills.data[0]?.cwd, process.cwd());

        return {
          account,
          skills,
        };
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(result.skills.data[0]?.skills.length, 0);
      assert.deepEqual(yield* Ref.get(nativeRequestIds), [10_000]);
      assert.deepEqual(yield* Ref.get(userInputRequests), [
        {
          isBlocking: true,
          itemId: "item-approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "approved",
              header: "Approve",
              question: "Continue with the mock skills request?",
              options: [
                {
                  label: "yes",
                  description: "Approve the request",
                },
              ],
            },
          ],
        },
      ]);
      assert.deepEqual(yield* Ref.get(messageDeltas), [
        {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      ]);
    }),
  );

  it.effect.each(
    (["win32", "darwin", "linux"] as const).flatMap((platform) =>
      commandPolicies.map((policy) => ({ ...policy, platform })),
    ),
  )("selects $platform shell policy for $command", ({ command, platform, windowsShell }) =>
    Effect.sync(() => {
      assert.equal(codexCommandUsesShell(command, platform), platform === "win32" && windowsShell);
    }),
  );

  it.effect.each(commandPolicies)(
    "applies the host command policy at the client spawn boundary for $command",
    ({ command, windowsShell }) =>
      Effect.gen(function* () {
        const commands: Array<ChildProcess.Command> = [];
        // These paths are policy examples, never installed providers. Stop at
        // the exact spawn boundary before anything could resolve or execute.
        const spawner = ChildProcessSpawner.make((observed) => {
          commands.push(observed);
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "Intentional command-policy fixture stop",
            }),
          );
        });
        const cwd = (yield* Path.Path).join(import.meta.dirname, "..");
        const result = yield* CodexClient.layerCommand({
          command,
          args: literalCommandArgs,
          cwd,
        }).pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          Layer.build,
          Effect.exit,
        );
        assert.equal(Exit.isFailure(result), true);
        assert.equal(commands.length, 1);
        const observed = commands[0];
        if (observed?._tag !== "StandardCommand") {
          return assert.fail("Expected one standard command");
        }
        assert.equal(observed.command, command);
        assert.deepEqual(observed.args, literalCommandArgs);
        assert.equal(observed.options.cwd, cwd);
        assert.equal(observed.options.shell, process.platform === "win32" && windowsShell);
      }),
  );

  it.effect.each([
    { name: "initializes a command-backed app-server client", echo: false, failDuringBuild: false },
    { name: "preserves native executable arguments literally", echo: true, failDuringBuild: false },
    {
      name: "closes the native fixture when client layer construction fails",
      echo: true,
      failDuringBuild: true,
    },
  ])(
    "$name",
    ({ echo, failDuringBuild }) =>
      Effect.gen(function* () {
        const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { fixtureRoot, executable, peer, fixtureEnv } = yield* makeNativePeerFixture();
        const args = [peer, ...(echo ? ["--echo-argv", ...literalCommandArgs] : [])];
        const handles: Array<ChildProcessSpawner.ChildProcessHandle> = [];
        const isolatedSpawner = ChildProcessSpawner.make((observed) => {
          // Only this copied executable and this peer may run. Preserve the
          // production command/argv/cwd/shell while removing ambient secrets
          // and Node hooks from the synthetic subprocess's environment.
          assert.equal(observed._tag, "StandardCommand");
          if (observed._tag !== "StandardCommand") {
            return Effect.die("Unexpected command fixture pipeline");
          }
          assert.equal(observed.command, executable);
          assert.deepEqual(observed.args, args);
          assert.equal(observed.options.cwd, fixtureRoot);
          assert.equal(observed.options.shell, false);
          return realSpawner
            .spawn(
              ChildProcess.make(observed.command, observed.args, {
                ...observed.options,
                env: fixtureEnv,
                extendEnv: false,
              }),
            )
            .pipe(
              Effect.tap((handle) => Effect.sync(() => handles.push(handle))),
              Effect.map((handle) =>
                failDuringBuild
                  ? new Proxy(handle, {
                      get(target, property, receiver) {
                        // Fail after the real child is acquired but while
                        // layerCommand is still constructing its stdio. This
                        // catches setup leaks that a later assertion failure
                        // inside an already-built client would not exercise.
                        if (property === "stdout") {
                          throw new Error("Intentional fixture stdio construction failure");
                        }
                        return Reflect.get(target, property, receiver);
                      },
                    })
                  : handle,
              ),
            );
        });
        // Register the child in an inner scope before building the client, so
        // failed layer initialization also retires it. The outer scope keeps
        // its copied executable and peer until child cleanup has completed.
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const context = yield* CodexClient.layerCommand({
              command: executable,
              args,
              cwd: fixtureRoot,
            }).pipe(
              Layer.provide(
                Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, isolatedSpawner),
              ),
              Layer.build,
            );
            const initialized = yield* Effect.gen(function* () {
              const client = yield* CodexClient.CodexAppServerClient;
              return yield* client.request("initialize", {
                clientInfo: {
                  name: "effect-codex-app-server-test",
                  title: "Effect Codex App Server Test",
                  version: "0.0.0",
                },
                capabilities: { experimentalApi: true, optOutNotificationMethods: null },
              });
            }).pipe(Effect.provide(context));
            return initialized;
          }),
        ).pipe(Effect.exit);
        assert.equal(handles.length, 1);
        for (const handle of handles) {
          assert.equal(yield* handle.isRunning, false);
        }
        if (failDuringBuild) {
          if (Exit.isSuccess(result)) {
            return assert.fail("Expected fixture stdio construction to fail");
          }
          assert.match(
            Cause.pretty(result.cause),
            /Intentional fixture stdio construction failure/,
          );
          return;
        }
        if (Exit.isFailure(result)) {
          return assert.fail("Native mock app-server initialization failed");
        }
        assert.equal(result.value.codexHome, fixtureRoot);
        assert.equal(
          result.value.userAgent,
          echo
            ? JSON.stringify({
                argv: literalCommandArgs,
                environment: {
                  home: true,
                  userProfile: true,
                  homeDriveAndPath: true,
                  appData: true,
                  localAppData: true,
                  codexHome: true,
                  codexSqliteHome: true,
                  temp: true,
                  path: true,
                  nodeHooksAbsent: true,
                  syntheticUser: true,
                  providerCredentialsAbsent: true,
                },
              })
            : "mock-codex-app-server",
        );
      }),
    // Copy/spawn on a loaded Windows runner can exceed the ordinary budget;
    // in-memory policy cases keep their default, as do macOS/Linux fixtures.
    process.platform === "win32" ? 20_000 : undefined,
  );

  it.effect("keeps dispatching notifications after a handler defect", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const protocolEvents = yield* Ref.make<Array<CodexProtocol.CodexAppServerProtocolLogEvent>>(
        [],
      );
      const received = yield* Ref.make<Array<unknown>>([]);
      const receivedBoth = yield* Deferred.make<ReadonlyArray<unknown>>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const client = yield* CodexClient.make(stdio, {
            logger: (event) => Ref.update(protocolEvents, (current) => [...current, event]),
          });

          yield* client.handleServerNotification("item/agentMessage/delta", () =>
            Effect.die(new Error("defective notification handler")),
          );
          yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
            Ref.update(received, (current) => [...current, payload]).pipe(
              Effect.flatMap(() => Ref.get(received)),
              Effect.tap((current) =>
                current.length >= 2 ? Deferred.succeed(receivedBoth, current) : Effect.void,
              ),
              Effect.asVoid,
            ),
          );

          yield* Queue.offer(
            input,
            encodeJsonl({
              method: "item/agentMessage/delta",
              params: {
                delta: "first",
                itemId: "item-1",
                threadId: "thread-1",
                turnId: "turn-1",
              },
            }),
          );
          yield* Queue.offer(
            input,
            encodeJsonl({
              method: "item/agentMessage/delta",
              params: {
                delta: "second",
                itemId: "item-2",
                threadId: "thread-1",
                turnId: "turn-1",
              },
            }),
          );

          assert.deepEqual(yield* Deferred.await(receivedBoth), [
            {
              delta: "first",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
            {
              delta: "second",
              itemId: "item-2",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          ]);
        }),
      );

      const diagnosticEvents = (yield* Ref.get(protocolEvents)).filter(
        (event) => event.stage === "decode_failed",
      );
      assert.equal(diagnosticEvents.length, 2);
      assert.deepEqual(
        diagnosticEvents.map((event) =>
          typeof event.payload === "object" && event.payload !== null
            ? (event.payload as Record<string, unknown>)["method"]
            : undefined,
        ),
        ["item/agentMessage/delta", "item/agentMessage/delta"],
      );
    }),
  );

  it.effect("forwards a redacted terminal protocol diagnostic to the client observer", () =>
    Effect.gen(function* () {
      const privateWireSentinel = "private-wire-sentinel-that-must-not-leak";
      const observed = yield* Deferred.make<{
        readonly tag: CodexError.CodexAppServerError["_tag"];
        readonly maxBytes: number | null;
      }>();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { stdio, input } = yield* makeInMemoryStdio();
          yield* CodexClient.make(stdio, {
            maxIncomingLineBytes: 32,
            onTermination: (error) =>
              Deferred.succeed(observed, {
                tag: error._tag,
                maxBytes:
                  error._tag === "CodexAppServerIncomingMessageTooLargeError"
                    ? error.maxBytes
                    : null,
              }).pipe(Effect.asVoid),
          });

          // Exercise the client boundary rather than the protocol constructor
          // directly: this proves the public option is forwarded to the
          // protocol reader. The callback records only the allowlisted error
          // discriminator and configured byte limit, never provider wire data.
          yield* Queue.offer(input, encoder.encode('{"id":1,"result":"'));
          yield* Queue.offer(input, encoder.encode(privateWireSentinel));

          const diagnostic = yield* Deferred.await(observed);
          assert.deepEqual(diagnostic, {
            tag: "CodexAppServerIncomingMessageTooLargeError",
            maxBytes: 32,
          });
          assert.equal(JSON.stringify(diagnostic).includes(privateWireSentinel), false);
        }),
      );
    }),
  );
});
