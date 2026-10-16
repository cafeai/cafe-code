// @effect-diagnostics nodeBuiltinImport:off
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  AxiomSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@cafecode/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { makeAxiomControl, makeAxiomRuntime } from "../acp/AxiomAcpSupport.ts";
import { AXIOM_LOGIN_ERRORS } from "../axiomAccount.ts";
import { makeAxiomAdapter, selectAxiomPermissionOption } from "./AxiomAdapter.ts";

const fixturePath = fileURLToPath(new URL("../testUtils/axiomMockPeer.ts", import.meta.url));
const layer = ServerConfig.layerTest(process.cwd(), { prefix: "cafe-axiom-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const threadId = ThreadId.make("axiom-test-thread");
const instanceId = ProviderInstanceId.make("axiom-test-account");

const loginFixture = (scenario: string, browserFailure = false, withSession = false) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const config = yield* ServerConfig;
    const opened: string[] = [];
    const refreshed = yield* Deferred.make<void>();
    const peerSpawner = (scenario: string) =>
      ChildProcessSpawner.make(() =>
        spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [fixturePath, "desktop-chat", config.baseDir, scenario],
            {
              shell: false,
              extendEnv: false,
              env: {
                ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
                ...(process.env.windir ? { windir: process.env.windir } : {}),
              },
            },
          ),
        ),
      );
    const adapter = yield* makeAxiomAdapter(Schema.decodeSync(AxiomSettings)({}), {
      instanceId,
      makeControl: (...args) =>
        makeAxiomControl(...args).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peerSpawner(scenario)),
        ),
      makeRuntime: (...args) =>
        makeAxiomRuntime(...args).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, peerSpawner("normal")),
        ),
      openLoginUrl: (url) =>
        browserFailure
          ? Effect.fail(new Error("fixture browser failure"))
          : Effect.sync(() => {
              opened.push(url);
            }),
      onAccountChanged: Deferred.succeed(refreshed, undefined).pipe(Effect.asVoid),
    });
    if (withSession)
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("axiom"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        interactionMode: "default",
        modelSelection: { instanceId, model: "test-model" },
      });
    return {
      adapter,
      opened,
      refreshed,
      methods: () =>
        JSON.parse(readFileSync(join(config.baseDir, "login-methods.json"), "utf8")) as string[],
    };
  });

describe("Axiom native sign-in", () => {
  it.effect("refreshes an already valid account while retaining its open Cafe session", () =>
    Effect.gen(function* () {
      const fixture = yield* loginFixture("login-valid", false, true);
      expect(yield* fixture.adapter.login!()).toBe("authenticated");
      expect(yield* fixture.adapter.hasSession(threadId)).toBe(true);
      expect(fixture.methods()).toEqual(["initialize", "_axiom/account/status"]);
      expect(fixture.opened).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("still refuses an account-changing login while a Cafe session is open", () =>
    Effect.gen(function* () {
      const fixture = yield* loginFixture("login-signed-out", false, true);
      expect(yield* fixture.adapter.login!().pipe(Effect.flip)).toMatchObject({
        issue: AXIOM_LOGIN_ERRORS.busy,
      });
      expect(yield* fixture.adapter.hasSession(threadId)).toBe(true);
      expect(fixture.methods()).toEqual(["initialize", "_axiom/account/status"]);
      expect(fixture.opened).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("refreshes an already signed-in account without creating a second login", () =>
    Effect.gen(function* () {
      const fixture = yield* loginFixture("login-valid");
      expect(yield* fixture.adapter.login!()).toBe("authenticated");
      yield* Deferred.await(fixture.refreshed);
      expect(fixture.opened).toEqual([]);
      expect(fixture.methods()).toEqual(["initialize", "_axiom/account/status"]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("opens the private checked URL when desktop-chat delegates browser launch", () =>
    Effect.gen(function* () {
      const fixture = yield* loginFixture("login-signed-out");
      expect(yield* fixture.adapter.login!()).toBe("started");
      yield* Deferred.await(fixture.refreshed);
      expect(fixture.opened).toEqual([
        "https://auth.axiom.stream/native/authorize?authorization_id=fixture&state=fixture-private-authorization-state",
      ]);
      expect(fixture.methods()).toEqual([
        "initialize",
        "_axiom/account/status",
        "_axiom/account/native_login_start",
        "_axiom/account/native_login_complete",
      ]);
      expect(yield* fixture.adapter.listSessions()).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("does not create a login when the account check is unavailable", () =>
    Effect.gen(function* () {
      const fixture = yield* loginFixture("login-unavailable");
      const outcome = yield* fixture.adapter.login!().pipe(Effect.flip);
      expect(outcome).toMatchObject({ issue: AXIOM_LOGIN_ERRORS.account });
      expect(fixture.methods()).toEqual(["initialize", "_axiom/account/status"]);
      expect(fixture.opened).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("cancels an untrusted native URL without opening it or completing login", () =>
    Effect.gen(function* () {
      const fixture = yield* loginFixture("login-invalid-url");
      expect(yield* fixture.adapter.login!().pipe(Effect.flip)).toMatchObject({
        issue: AXIOM_LOGIN_ERRORS.url,
      });
      expect(fixture.opened).toEqual([]);
      expect(fixture.methods()).toEqual([
        "initialize",
        "_axiom/account/status",
        "_axiom/account/native_login_start",
        "_axiom/account/native_login_cancel",
      ]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("cancels the native capability when the host browser cannot open", () =>
    Effect.gen(function* () {
      const fixture = yield* loginFixture("login-signed-out", true);
      expect(yield* fixture.adapter.login!().pipe(Effect.flip)).toMatchObject({
        issue: AXIOM_LOGIN_ERRORS.browser,
      });
      expect(fixture.methods()).toEqual([
        "initialize",
        "_axiom/account/status",
        "_axiom/account/native_login_start",
        "_axiom/account/native_login_cancel",
      ]);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});

const setupWith = (
  configuration: {
    scenario?: string;
    interactionMode?: "plan" | "default";
    runtimeMode?: "approval-required" | "full-access";
  } = {},
) =>
  Effect.gen(function* () {
    const nativeSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const config = yield* ServerConfig;
    const makeRuntime: typeof makeAxiomRuntime = (
      settings,
      options,
      identity,
      environment,
      accountKey,
    ) =>
      makeAxiomRuntime(settings, options, identity, environment, accountKey).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            nativeSpawner.spawn(
              ChildProcess.make(
                process.execPath,
                [
                  fixturePath,
                  options.frontend ?? "desktop-chat",
                  config.baseDir,
                  configuration.scenario ?? "normal",
                ],
                {
                  shell: false,
                  extendEnv: false,
                  env: {
                    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
                    ...(process.env.windir ? { windir: process.env.windir } : {}),
                  },
                },
              ),
            ),
          ),
        ),
      );
    const adapter = yield* makeAxiomAdapter(Schema.decodeSync(AxiomSettings)({}), {
      instanceId,
      makeRuntime,
    });
    const events: ProviderRuntimeEvent[] = [];
    const complete = yield* Deferred.make<void>();
    const approval = yield* Deferred.make<ProviderRuntimeEvent>();
    const question = yield* Deferred.make<ProviderRuntimeEvent>();
    const active = yield* Deferred.make<void>();
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => events.push(event)).pipe(
        Effect.andThen(
          event.type === "turn.completed"
            ? Deferred.succeed(complete, undefined)
            : event.type === "request.opened"
              ? Deferred.succeed(approval, event)
              : event.type === "user-input.requested"
                ? Deferred.succeed(question, event)
                : event.type === "content.delta"
                  ? Deferred.succeed(active, undefined)
                  : Effect.void,
        ),
      ),
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    const session = yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("axiom"),
      cwd: process.cwd(),
      runtimeMode: configuration.runtimeMode ?? "approval-required",
      interactionMode: configuration.interactionMode ?? "default",
      modelSelection: {
        instanceId,
        model: "test-model",
        options: [{ id: "thinkingLevel", value: "high" }],
      },
    });
    const readReport = Effect.gen(function* () {
      const current = (yield* adapter.listSessions())[0]!;
      return (yield* adapter.readSecurity!({
        instanceId,
        threadId,
        runtimeId: current.subagentRuntimeId!,
        modelId: current.model!,
        configurationKey: current.commandCatalogConfigurationKey!,
      })).report;
    });
    return { adapter, session, events, complete, approval, question, active, readReport };
  });
const setup = setupWith();

describe("Axiom scoped ACP adapter", () => {
  it.effect(
    "recovers native settlements with omitted cursors and retains their stable identity on resume",
    () =>
      Effect.gen(function* () {
        const { adapter, session, events } = yield* setupWith({ scenario: "recover-billing" });
        const first = events.find((event) => event.type === "thread.usage-accounting.updated");
        if (first?.type !== "thread.usage-accounting.updated")
          return yield* Effect.die("Missing recovered native cost");
        expect(first.createdAt).toBe(new Date(1791849601000).toISOString());
        expect(first.payload.models[0]?.reportedCostMicrousd).toBe("99");
        yield* adapter.readThread(threadId);
        expect(
          events.filter((event) => event.type === "thread.usage-accounting.updated"),
        ).toHaveLength(1);
        yield* adapter.stopSession(threadId);
        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("axiom"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: session.resumeCursor,
          modelSelection: { instanceId, model: "test-model" },
        });
        const recovered = events.filter(
          (event) => event.type === "thread.usage-accounting.updated",
        );
        expect(recovered).toHaveLength(2);
        expect(recovered[1]?.payload).toEqual(first.payload);
      }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect(
    "manages native MCP with exact idle ownership and binds prompts to reviewed revisions",
    () =>
      Effect.gen(function* () {
        const { adapter, session, events, complete } = yield* setup;
        const input = {
          instanceId,
          threadId,
          runtimeId: session.subagentRuntimeId!,
          modelId: session.model!,
          configurationKey: session.commandCatalogConfigurationKey!,
        };
        const initial = yield* adapter.manageMcp!({ ...input, action: { kind: "list" } });
        expect(initial.state?.revision).toBe(0);
        const saved = yield* adapter.manageMcp!({
          ...input,
          expectedRevision: 0,
          action: {
            kind: "save",
            server: {
              name: "fixture",
              command: process.execPath,
              args: [],
              enabled: true,
              env: { PRIVATE_FIXTURE: "secret-value" },
            },
          },
        });
        expect(saved.state?.revision).toBe(1);
        expect(JSON.stringify(saved)).not.toContain("secret-value");
        expect(JSON.stringify(saved)).not.toContain("private-native-credential");
        expect(
          (yield* adapter.manageMcp!({
            ...input,
            expectedRevision: 0,
            action: { kind: "delete", name: "fixture" },
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        const tested = yield* adapter.manageMcp!({
          ...input,
          expectedRevision: 1,
          action: { kind: "test", name: "fixture" },
        });
        const selected = yield* adapter.manageMcp!({
          ...input,
          expectedRevision: tested.state!.revision,
          action: { kind: "select", tools: [tested.state!.servers[0]!.tools[0]!.name] },
        });
        expect(
          (yield* adapter
            .sendTurn({ threadId, input: "configuration fixture", axiomMcpRevision: 2 })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* adapter
            .sendTurn({ threadId, input: "configuration fixture" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* adapter.sendTurn({
          threadId,
          input: "configuration fixture",
          axiomMcpRevision: selected.state!.revision,
        });
        yield* Deferred.await(complete);
        const delta = events.find((event) => event.type === "content.delta");
        expect(
          delta?.type === "content.delta" ? JSON.parse(delta.payload.delta).mcpRevision : null,
        ).toBe(3);
        expect(
          (yield* adapter.manageMcp!({
            ...input,
            runtimeId: "foreign-runtime" as typeof input.runtimeId,
            action: { kind: "list" },
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect(
    "sends explicit message web consent and only steers with the active turn's setting",
    () =>
      Effect.gen(function* () {
        const { adapter, events, active, complete } = yield* setup;
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "hold configuration fixture",
          axiomWebEnabled: true,
        });
        yield* Deferred.await(active);
        const delta = events.find((event) => event.type === "content.delta");
        if (delta?.type !== "content.delta")
          return yield* Effect.die("Missing native consent observation");
        expect(JSON.parse(delta.payload.delta)).toMatchObject({
          webEnabled: true,
          agentRevision: 1,
        });
        const changed = yield* adapter
          .steerTurn({
            threadId,
            expectedTurnId: turn.turnId,
            input: "Changed consent",
            axiomWebEnabled: false,
          })
          .pipe(Effect.result);
        expect(changed._tag).toBe("Failure");
        const steered = yield* adapter.steerTurn({
          threadId,
          expectedTurnId: turn.turnId,
          input: "Keep current consent",
          axiomWebEnabled: true,
        });
        expect(steered.turnId).toBe(turn.turnId);
        yield* adapter.interruptTurn(threadId, turn.turnId);
        yield* Deferred.await(complete);
        const nextContent = yield* Deferred.make<ProviderRuntimeEvent>();
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          event.type === "content.delta" ? Deferred.succeed(nextContent, event) : Effect.void,
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        const next = yield* adapter.sendTurn({ threadId, input: "hold configuration fixture" });
        const nextDelta = yield* Deferred.await(nextContent);
        if (nextDelta.type !== "content.delta")
          return yield* Effect.die("Missing next native consent observation");
        expect(JSON.parse(nextDelta.payload.delta)).toMatchObject({
          webEnabled: false,
          agentRevision: 1,
        });
        yield* adapter.interruptTurn(threadId, next.turnId);
      }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect(
    "binds a desktop Agent to Cafe's project and retains its revision on unchanged turns",
    () =>
      Effect.gen(function* () {
        const { adapter, session, events, complete } = yield* setup;
        yield* adapter.sendTurn({ threadId, input: "configuration fixture" });
        yield* Deferred.await(complete);
        const delta = events.find((event) => event.type === "content.delta");
        if (delta?.type !== "content.delta")
          return yield* Effect.die("Missing configuration observation");
        expect(
          events.filter((event) => event.type === "thread.usage-accounting.updated"),
        ).toHaveLength(1);
        const billing = events.find((event) => event.type === "thread.usage-accounting.updated");
        expect(
          billing?.type === "thread.usage-accounting.updated" ? billing.payload.models[0] : null,
        ).toMatchObject({ inputTokens: 100, outputTokens: 30, reportedCostMicrousd: "123456" });
        expect(JSON.parse(delta.payload.delta)).toMatchObject({
          frontend: "desktop-chat",
          agent: {
            enabled: true,
            permission: "approve_commands",
            workingDirectory: (session.resumeCursor as { nativeCwd: string }).nativeCwd,
            revision: 1,
          },
          agentRevision: 1,
          webEnabled: false,
        });
        expect((yield* adapter.listSessions())[0]?.resumeCursor).toMatchObject({
          agentRevision: 1,
        });
      }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("disables native Agent tools in plan mode and binds full access explicitly", () =>
    Effect.gen(function* () {
      const { adapter, events, complete } = yield* setupWith({
        interactionMode: "plan",
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "configuration fixture" });
      yield* Deferred.await(complete);
      const delta = events.find((event) => event.type === "content.delta");
      if (delta?.type !== "content.delta")
        return yield* Effect.die("Missing configuration observation");
      expect(JSON.parse(delta.payload.delta)).toMatchObject({
        agent: { enabled: false, permission: "full_access", revision: 1 },
        webEnabled: false,
      });
      expect(
        (yield* adapter
          .sendTurn({ threadId, input: " ", interactionMode: "default" })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* adapter.listSessions())[0]?.resumeCursor).toMatchObject({ agentRevision: 1 });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "hold configuration fixture",
        interactionMode: "default",
      });
      const current = (yield* adapter.listSessions())[0]!;
      expect(current.resumeCursor).toMatchObject({ agentRevision: 2 });
      yield* adapter.interruptTurn(threadId, turn.turnId);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("carries the approved Agent revision into exact-turn steering with full access", () =>
    Effect.gen(function* () {
      const { adapter, events, complete, active } = yield* setupWith({
        runtimeMode: "full-access",
      });
      const started = yield* adapter.sendTurn({ threadId, input: "hold configuration fixture" });
      yield* Deferred.await(active);
      const delta = events.find((event) => event.type === "content.delta");
      if (delta?.type !== "content.delta")
        return yield* Effect.die("Missing configuration observation");
      expect(JSON.parse(delta.payload.delta)).toMatchObject({
        agent: { enabled: true, permission: "full_access", revision: 1 },
      });
      const steered = yield* adapter.steerTurn({
        threadId,
        expectedTurnId: started.turnId,
        input: "Use the scoped fixture",
        attachments: [],
      });
      expect(steered.turnId).toBe(started.turnId);
      yield* adapter.interruptTurn(threadId, started.turnId);
      yield* Deferred.await(complete);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("rejects invalid bootstrap and a configuration receipt for another workspace", () =>
    Effect.gen(function* () {
      for (const scenario of [
        "invalid-bootstrap",
        "wrong-workspace",
        "wrong-revision",
        "wrong-thread",
        "wrong-permission",
      ])
        expect((yield* setupWith({ scenario }).pipe(Effect.result))._tag).toBe("Failure");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect(
    "refuses changed native Agent configuration before admitting another prompt or resume",
    () =>
      Effect.gen(function* () {
        const { adapter, events, complete } = yield* setup;
        yield* adapter.sendTurn({ threadId, input: "change agent configuration" });
        yield* Deferred.await(complete);
        const old = (yield* adapter.listSessions())[0]!;
        expect(
          (yield* adapter.sendTurn({ threadId, input: "normal prompt" }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(events.filter((event) => event.type === "turn.started")).toHaveLength(1);
        yield* adapter.stopSession(threadId);
        expect(
          (yield* adapter
            .startSession({
              threadId,
              cwd: process.cwd(),
              runtimeMode: "approval-required",
              resumeCursor: old.resumeCursor,
              modelSelection: { instanceId, model: "test-model" },
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* adapter.listSessions()).toHaveLength(0);
      }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("admits a turn promptly and verifies only native authenticated completion", () =>
    Effect.gen(function* () {
      const { adapter, session, events, complete, readReport } = yield* setup;
      expect(session.resumeCursor).toMatchObject({
        schemaVersion: 2,
        frontend: "desktop-chat",
        agentRevision: 1,
        accountKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const turn = yield* adapter.sendTurn({ threadId, input: "normal prompt" });
      expect(turn.turnId).toBeTruthy();
      yield* Deferred.await(complete);
      expect((yield* adapter.listSessions())[0]?.securityReport).toBeUndefined();
      expect((yield* readReport)?.reply.state).toBe("verified");
      const history = yield* adapter.readThread(threadId);
      expect(history.turns).toEqual([
        {
          id: turn.turnId,
          items: [{ id: "assistant-1", type: "agentMessage", text: "Fixture reply" }],
        },
      ]);
      expect(
        events.some(
          (event) => event.type === "content.delta" && event.payload.delta === "Fixture reply",
        ),
      ).toBe(true);
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("fixture-account");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("accepts native authentication after an earlier completed accounting snapshot", () =>
    Effect.gen(function* () {
      const { adapter, events, complete, readReport } = yield* setup;
      yield* adapter.sendTurn({ threadId, input: "accounting before verification" });
      yield* Deferred.await(complete);
      expect((yield* readReport)?.reply.state).toBe("verified");
      expect(
        events.filter((event) => event.type === "thread.usage-accounting.updated"),
      ).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("keeps native web identities and queries through sparse progress and completion", () =>
    Effect.gen(function* () {
      const { adapter, events, complete } = yield* setup;
      yield* adapter.sendTurn({ threadId, input: "native web tools" });
      yield* Deferred.await(complete);
      for (const [name, title, detail] of [
        ["web_search", "Searched the web", "fixture web query"],
        ["fetch_url", "Opened web page", "https://example.com/fixture"],
      ]) {
        const matching = events.filter(
          (event) =>
            (event.type === "item.updated" || event.type === "item.completed") &&
            event.itemId?.endsWith(`:${name}`),
        );
        expect(matching).toHaveLength(3);
        for (const event of matching)
          expect(event.payload).toMatchObject({
            title,
            detail,
            itemType: "web_search",
            data: { nativeToolName: name },
          });
      }
      const fileSearch = events.find(
        (event) => event.type === "item.updated" && event.itemId?.endsWith(":search_text"),
      );
      expect(fileSearch?.payload).toMatchObject({ title: "Searched files" });
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("applies a concrete default thinking mode when a model selection has no choice", () =>
    Effect.gen(function* () {
      const { adapter, events, complete } = yield* setup;
      yield* adapter.sendTurn({
        threadId,
        input: "configuration fixture",
        modelSelection: { instanceId, model: "test-model" },
      });
      yield* Deferred.await(complete);
      const reply = events
        .filter((event) => event.type === "content.delta")
        .map((event) => event.payload.delta)
        .join("");
      expect(JSON.parse(reply).thinking).toBe("medium");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("never promotes unauthenticated completion to a verified reply", () =>
    Effect.gen(function* () {
      const { adapter, complete, readReport } = yield* setup;
      yield* adapter.sendTurn({ threadId, input: "unverified prompt" });
      yield* Deferred.await(complete);
      expect((yield* readReport)?.reply.state).toBe("incomplete");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("routes the exact offered approval id and clears pending ownership", () =>
    Effect.gen(function* () {
      const { adapter, approval, complete, readReport } = yield* setup;
      yield* adapter.sendTurn({ threadId, input: "approval prompt" });
      const request = yield* Deferred.await(approval);
      expect(request.type).toBe("request.opened");
      if (request.type !== "request.opened" || !request.requestId)
        return yield* Effect.die("Missing exact approval identity");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(request.requestId),
        "acceptForSession",
      );
      yield* Deferred.await(complete);
      expect((yield* readReport)?.reply.state).toBe("verified");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("stops a long prompt exactly once and keeps partial reply incomplete", () =>
    Effect.gen(function* () {
      const { adapter, complete, events, active, readReport } = yield* setup;
      const started = yield* adapter.sendTurn({ threadId, input: "hold prompt" });
      yield* Deferred.await(active);
      yield* adapter.interruptTurn(threadId, started.turnId);
      yield* Deferred.await(complete);
      expect((yield* readReport)?.reply.state).toBe("incomplete");
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      yield* adapter.stopSession(threadId);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("rejects wrong-account resume without silently creating a new conversation", () =>
    Effect.gen(function* () {
      const { adapter, session } = yield* setup;
      yield* adapter.stopSession(threadId);
      const result = yield* adapter
        .startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          resumeCursor: { ...(session.resumeCursor as object), accountKey: "b".repeat(64) },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("handles cancellation before native prompt admission without leaving work active", () =>
    Effect.gen(function* () {
      const { adapter, complete, events, readReport } = yield* setup;
      const started = yield* adapter.sendTurn({ threadId, input: "hold prompt" });
      yield* adapter.interruptTurn(threadId, started.turnId);
      yield* Deferred.await(complete);
      expect((yield* readReport)?.reply.state).toBe("incomplete");
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("validates multi-choice answers and resolves only the pending native question", () =>
    Effect.gen(function* () {
      const { adapter, question, complete, readReport } = yield* setup;
      yield* adapter.sendTurn({ threadId, input: "question prompt" });
      const request = yield* Deferred.await(question);
      if (!request.requestId) return yield* Effect.die("Missing exact question identity");
      const requestId = ApprovalRequestId.make(request.requestId);
      expect(
        (yield* adapter
          .respondToUserInput(threadId, requestId, { choices: ["unoffered"] })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* adapter.respondToUserInput(threadId, requestId, { choices: ["first"] });
      yield* Deferred.await(complete);
      expect((yield* readReport)?.reply.state).toBe("verified");
      expect(
        (yield* adapter
          .respondToUserInput(threadId, requestId, { choices: ["first"] })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("continues after two UUID-bound choice answers and accepts the next prompt", () =>
    Effect.gen(function* () {
      const { adapter, question, complete, events } = yield* setup;
      const first = yield* adapter.sendTurn({ threadId, input: "string question prompt" });
      const request = yield* Deferred.await(question);
      if (!request.requestId) return yield* Effect.die("Missing exact question identity");
      const requestId = ApprovalRequestId.make(request.requestId);
      expect(request.payload).toMatchObject({ questions: [{ id: "build" }, { id: "scope" }] });
      expect(
        (yield* adapter
          .respondToUserInput(threadId, requestId, {
            build: "local build",
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(events.filter((event) => event.type === "user-input.resolved")).toHaveLength(0);
      yield* adapter.respondToUserInput(threadId, requestId, {
        build: "local build",
        scope: "npm only",
      });
      yield* Deferred.await(complete);
      expect(events.filter((event) => event.type === "turn.completed")).toMatchObject([
        { turnId: first.turnId, payload: { state: "completed" } },
      ]);
      expect(events.filter((event) => event.type === "user-input.resolved")).toMatchObject([
        { requestId, payload: { answers: { build: "local build", scope: "npm only" } } },
      ]);
      expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
      const nextComplete = yield* Deferred.make<ProviderRuntimeEvent>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" && event.turnId !== first.turnId
          ? Deferred.succeed(nextComplete, event).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      const next = yield* adapter.sendTurn({ threadId, input: "normal follow-up prompt" });
      expect(yield* Deferred.await(nextComplete)).toMatchObject({
        turnId: next.turnId,
        payload: { state: "completed" },
      });
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("cancels the exact approval without manufacturing a denial option", () =>
    Effect.gen(function* () {
      const { adapter, approval, complete, readReport } = yield* setup;
      yield* adapter.sendTurn({ threadId, input: "approval prompt" });
      const request = yield* Deferred.await(approval);
      if (!request.requestId) return yield* Effect.die("Missing exact approval identity");
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(request.requestId),
        "cancel",
      );
      yield* Deferred.await(complete);
      expect((yield* readReport)?.reply.state).toBe("incomplete");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("resumes the account-bound native session and refuses foreign security reads", () =>
    Effect.gen(function* () {
      const { adapter, complete } = yield* setup;
      yield* adapter.sendTurn({ threadId, input: "normal prompt" });
      yield* Deferred.await(complete);
      const old = (yield* adapter.listSessions())[0]!;
      for (const wrong of [
        { instanceId: ProviderInstanceId.make("other-account") },
        { modelId: "other-model" },
        { configurationKey: "f".repeat(64) },
      ])
        expect(
          (yield* adapter.readSecurity!({
            instanceId,
            threadId,
            runtimeId: old.subagentRuntimeId!,
            modelId: old.model!,
            configurationKey: old.commandCatalogConfigurationKey!,
            ...wrong,
          })).report,
        ).toBeNull();
      yield* adapter.stopSession(threadId);
      const resumed = yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: old.resumeCursor,
        modelSelection: { instanceId, model: "test-model" },
      });
      expect(resumed.resumeCursor).toMatchObject(old.resumeCursor as object);
      expect(resumed.subagentRuntimeId).not.toBe(old.subagentRuntimeId);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it("never guesses a prefix grant or an unavailable session choice", () => {
    const request = {
      sessionId: "native",
      toolCall: { toolCallId: "tool" },
      options: [{ optionId: "prefix-only", name: "Prefix", kind: "allow_always" as const }],
    };
    expect(selectAxiomPermissionOption(request, "acceptForSession")).toBeUndefined();
    expect(selectAxiomPermissionOption(request, "accept")).toBeUndefined();
  });
  it.effect("rejects policy and attestation consent commands before native prompt admission", () =>
    Effect.gen(function* () {
      const { adapter, events } = yield* setup;
      for (const input of [
        "/security accept-outdated",
        "/attestation accept-outdated",
        "/signin",
        "/delete-sessions",
        "/reasoning high",
      ])
        expect((yield* adapter.sendTurn({ threadId, input }).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
      expect(events.filter((event) => event.type === "turn.started")).toHaveLength(0);
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
  it.effect("refreshes only exact idle configuration and rejects unreviewed consent", () =>
    Effect.gen(function* () {
      const { adapter } = yield* setup;
      const current = (yield* adapter.listSessions())[0]!;
      const input = {
        instanceId,
        threadId,
        runtimeId: current.subagentRuntimeId!,
        modelId: current.model!,
        configurationKey: current.commandCatalogConfigurationKey!,
      };
      expect(
        (yield* adapter.refreshSecurity!({ ...input, configurationKey: "d".repeat(64) }).pipe(
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* adapter.refreshSecurity!({ ...input, acceptOutdatedTee: true }).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
      const refreshed = yield* adapter.refreshSecurity!(input);
      expect(refreshed.report?.attestation.state).toBe("verified");
      expect(refreshed.report?.reply.state).toBe("none");
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
});
