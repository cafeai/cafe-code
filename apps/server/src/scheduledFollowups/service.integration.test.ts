import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  CommandId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ScheduledFollowupDraft,
  type ScheduledFollowupRecord,
  type ScheduledFollowupRun,
  type ServerProvider,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { makeScheduledFollowups, ScheduledFollowups, ScheduledFollowupsLive } from "./service.ts";
import { verifyScheduledFollowUpDispatch } from "./authorization.ts";
import type { SchedulingSessionAuthority } from "./sessionRuntime.ts";

const INITIAL = "2026-10-04T00:00:00.000Z";
const FIVE_MINUTES = "2026-10-04T00:05:00.000Z";
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  // Retire every runtime/SQLite connection before its enclosing temporary root.
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

function provider(driver: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "test-only",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: INITIAL,
    availability: "available",
    models: ["test-model", "test-override"].map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

const draft: ScheduledFollowupDraft = {
  name: "Synthetic CI follow-up",
  prompt: "Inspect only synthetic test state.",
  recurrence: { kind: "interval", timeZone: "UTC", anchorAt: FIVE_MINUTES, everyMinutes: 5 },
  modelSelection: null,
  notificationPolicy: "changes-and-errors",
  endAt: null,
  maxRuns: null,
  allowAutoFinish: false,
};

/**
 * Real migrated SQLite, command admission, receipts, projections and scheduler.
 * The only provider dependency is a cached synthetic registry. There is no
 * ProviderCommandReactor, ProviderService, process spawn or provider credential
 * access: tests author exact native lifecycle observations where needed.
 */
async function harness(persistence?: { readonly dbPath: string; readonly baseDir: string }) {
  let milliseconds = Date.parse(INITIAL);
  let providers = [provider("codex"), provider("claudeAgent"), provider("grok")];
  const liveClock = Effect.runSync(Effect.service(Clock.Clock));
  let sleep: Clock.Clock["sleep"] = liveClock.sleep.bind(liveClock);
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => milliseconds,
    currentTimeMillis: Effect.sync(() => milliseconds),
    currentTimeNanosUnsafe: () => BigInt(milliseconds) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(milliseconds) * 1_000_000n),
    sleep: (duration) => sleep(duration),
  };
  const orchestration = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(
      persistence ? makeSqlitePersistenceLive(persistence.dbPath) : SqlitePersistenceMemory,
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(
        process.cwd(),
        persistence?.baseDir ?? { prefix: "scheduled-followups-test-" },
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(
    ScheduledFollowupsLive.pipe(
      Layer.provideMerge(orchestration),
      Layer.provideMerge(
        Layer.mock(ProviderRegistry)({ getProviders: Effect.sync(() => providers) }),
      ),
    ),
  );
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await runtime.dispose();
  };
  disposals.push(dispose);
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    runtime.runPromise(effect.pipe(Effect.provideService(Clock.Clock, clock)));
  const service = await runtime.runPromise(Effect.service(ScheduledFollowups));
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const projections = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  let commandIndex = 0;
  const createThread = async (name: string, driver = "codex") => {
    const threadId = ThreadId.make(name);
    await run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${name}`),
        threadId,
        projectId: null,
        title: "Synthetic scheduler chat",
        modelSelection: { instanceId: ProviderInstanceId.make(driver), model: "test-model" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: INITIAL,
      }),
    );
    return threadId;
  };
  const session = async (
    threadId: ThreadId,
    turnId: TurnId | null,
    status: "running" | "ready" | "error" = "running",
  ) => {
    await run(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`session:${++commandIndex}`),
        threadId,
        session: {
          threadId,
          status,
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: status === "error" ? "Synthetic failure" : null,
          updatedAt: new Date(milliseconds).toISOString(),
        },
        createdAt: new Date(milliseconds).toISOString(),
      }),
    );
  };
  const read = (threadId: ThreadId) => run(service.list({ threadId }));
  const history = (schedule: ScheduledFollowupRecord, limit = 50) =>
    run(service.history({ threadId: schedule.threadId, id: schedule.id, limit }));
  const attempt = async (occurrence: ScheduledFollowupRun) => {
    expect(occurrence.intentSequence).not.toBeNull();
    const [event] = await run(
      engine.readEvents(occurrence.intentSequence! - 1, 1).pipe(Stream.runCollect),
    );
    if (event?.type !== "thread.turn-start-requested")
      throw new Error("Expected exact scheduled start intent");
    return run(
      verifyScheduledFollowUpDispatch(event).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
    );
  };
  const finish = async (
    schedule: ScheduledFollowupRecord,
    occurrence: ScheduledFollowupRun,
    text: string,
    status: "ready" | "error" = "ready",
  ) => {
    const turnId = TurnId.make(`native:${occurrence.id}`);
    const messageId = MessageId.make(`assistant:${occurrence.id}`);
    // Exercise the actual worker's immutable pre-I/O authorization CAS without
    // ever invoking a provider. Native lifecycle observations below also
    // travel through the real engine and its message/turn projections.
    expect(await attempt(occurrence)).toBe(true);
    await session(schedule.threadId, turnId);
    await run(
      engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make(`final:${occurrence.id}`),
        threadId: schedule.threadId,
        messageId,
        turnId,
        finalText: text,
        createdAt: new Date(milliseconds).toISOString(),
      }),
    );
    await session(schedule.threadId, null, status);
    return { turnId, messageId };
  };
  return {
    run,
    service,
    engine,
    sql,
    createThread,
    session,
    read,
    history,
    finish,
    attempt,
    dispose,
    setSleep: (value: Clock.Clock["sleep"]) => {
      sleep = value;
    },
    setTime: (value: string) => {
      milliseconds = Date.parse(value);
    },
    setProviders: (value: ServerProvider[]) => {
      providers = value;
    },
    anotherService: (dispatch?: typeof engine.dispatch) =>
      runtime.runPromise(
        dispatch
          ? makeScheduledFollowups.pipe(
              Effect.provideService(OrchestrationEngineService, { ...engine, dispatch }),
            )
          : makeScheduledFollowups,
      ),
    shell: (threadId: ThreadId) =>
      run(projections.getThreadShellById(threadId).pipe(Effect.map(Option.getOrThrow))),
  };
}

/** Synthetic durable grant only: no credential, provider process or user home. */
async function grant(h: Awaited<ReturnType<typeof harness>>, threadId: ThreadId) {
  const authority: SchedulingSessionAuthority = {
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    sessionGeneration: "157f122c-77a1-4976-ab77-57bf3c6b6408",
    tokenDigest: "a".repeat(64),
  };
  await h.run(
    h.sql`INSERT INTO scheduling_session_runtime(singleton,generation) VALUES (1,'fixture-runtime')`,
  );
  await h.run(h.sql`INSERT INTO scheduling_session_capabilities
    (thread_id,provider_instance_id,provider,session_generation,runtime_generation,active,token_digest)
    VALUES (${threadId},${authority.providerInstanceId},'codex',${authority.sessionGeneration},'fixture-runtime',1,${authority.tokenDigest})`);
  return authority;
}

describe("session scheduling commit-time authority", () => {
  it("creates only pending proposals and lists/pauses within its bound chat", async () => {
    const h = await harness();
    const threadId = await h.createThread("scoped-proposal");
    const authority = await grant(h, threadId);
    const saved = await h.run(h.service.save({ ...draft, threadId }, "agent", authority));
    expect(saved.state).toBe("pending_confirmation");
    expect(saved.authorizedInstanceId).toBe(authority.providerInstanceId);
    expect(saved.nextRunAt).toBeNull();
    expect((await h.run(h.service.list({ threadId }, authority))).schedules).toHaveLength(1);
    const paused = await h.run(
      h.service.setStatus(
        { threadId, id: saved.id, expectedRevision: saved.revision, state: "paused" },
        authority,
      ),
    );
    expect(paused.state).toBe("paused");
    await expect(
      h.run(
        h.service.setStatus(
          { threadId, id: paused.id, expectedRevision: paused.revision, state: "active" },
          authority,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      h.run(h.service.save({ ...draft, threadId }, "owner", authority)),
    ).rejects.toThrow();
    h.setTime(FIVE_MINUTES);
    await h.run(h.service.tick);
    expect((await h.history(saved)).runs).toEqual([]);
  });
  it("rejects cross-chat reads, proposals and schedule IDs", async () => {
    const h = await harness();
    const threadId = await h.createThread("scoped-owner");
    const foreign = await h.createThread("scoped-foreign");
    const authority = await grant(h, threadId);
    const saved = await h.run(h.service.save({ ...draft, threadId: foreign }));
    await expect(h.run(h.service.list({ threadId: foreign }, authority))).rejects.toThrow();
    await expect(
      h.run(h.service.save({ ...draft, threadId: foreign }, "agent", authority)),
    ).rejects.toThrow();
    await expect(
      h.run(
        h.service.setStatus(
          { threadId, id: saved.id, expectedRevision: saved.revision, state: "paused" },
          authority,
        ),
      ),
    ).rejects.toThrow();
    expect((await h.read(foreign)).schedules[0]?.state).toBe("active");
  });
  it.each(["revoked", "generation", "runtime", "account", "digest"])(
    "rejects a previously admitted authority after %s changes before mutation",
    async (change) => {
      const h = await harness();
      const threadId = await h.createThread(`scoped-retirement-${change}`);
      const authority = await grant(h, threadId);
      const saved = await h.run(h.service.save({ ...draft, threadId }, "agent", authority));
      if (change === "revoked")
        await h.run(h.sql`UPDATE scheduling_session_capabilities SET active = 0`);
      if (change === "generation")
        await h.run(
          h.sql`UPDATE scheduling_session_capabilities SET session_generation = 'other-generation'`,
        );
      if (change === "runtime")
        await h.run(h.sql`UPDATE scheduling_session_runtime SET generation = 'restarted-runtime'`);
      if (change === "account")
        await h.run(
          h.sql`UPDATE projection_threads SET model_selection_json = ${JSON.stringify({ instanceId: "grok", model: "test-model" })} WHERE thread_id = ${threadId}`,
        );
      if (change === "digest")
        await h.run(
          h.sql`UPDATE scheduling_session_capabilities SET token_digest = ${"b".repeat(64)}`,
        );
      await expect(h.run(h.service.list({ threadId }, authority))).rejects.toThrow();
      await expect(
        h.run(h.service.save({ ...draft, threadId }, "agent", authority)),
      ).rejects.toThrow();
      await expect(
        h.run(
          h.service.setStatus(
            { threadId, id: saved.id, expectedRevision: saved.revision, state: "paused" },
            authority,
          ),
        ),
      ).rejects.toThrow();
      expect((await h.read(threadId)).schedules).toHaveLength(1);
    },
  );
  it.each(["active", "paused", "pending_confirmation"] as const)(
    "keeps %s schedules review-gated after switching accounts away and back without a tick",
    async (state) => {
      const h = await harness();
      const threadId = await h.createThread(`account-roundtrip-${state}`);
      const authority = await grant(h, threadId);
      let saved = await h.run(
        h.service.save(
          { ...draft, threadId },
          state === "pending_confirmation" ? "agent" : "owner",
        ),
      );
      if (state === "paused")
        saved = await h.run(
          h.service.setStatus({
            threadId,
            id: saved.id,
            expectedRevision: saved.revision,
            state: "paused",
          }),
        );
      for (const instanceId of ["grok", "codex"])
        await h.run(
          h.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(`switch:${state}:${instanceId}`),
            threadId,
            modelSelection: {
              instanceId: ProviderInstanceId.make(instanceId),
              model: "test-model",
            },
          }),
        );
      const changed = (await h.read(threadId)).schedules[0]!;
      expect(changed.state).toBe("needs_attention");
      expect(changed.revision).toBe(saved.revision + 2);
      expect(changed.nextRunAt).toBeNull();
      await expect(h.run(h.service.list({ threadId }, authority))).rejects.toThrow();
      await expect(
        h.run(
          h.service.setStatus({
            threadId,
            id: saved.id,
            expectedRevision: saved.revision,
            state: "active",
          }),
        ),
      ).rejects.toThrow();
      h.setTime(FIVE_MINUTES);
      await h.run(h.service.tick);
      expect((await h.history(saved)).runs).toEqual([]);
      const approved = await h.run(
        h.service.save({ ...draft, threadId, id: changed.id, expectedRevision: changed.revision }),
      );
      expect(approved.state).toBe("active");
      expect(approved.authorizedInstanceId).toBe("codex");
    },
  );
  it("does not invalidate approval for a model-only change within the same account", async () => {
    const h = await harness();
    const threadId = await h.createThread("same-account-model");
    const saved = await h.run(h.service.save({ ...draft, threadId }));
    await h.run(
      h.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("switch:model-only"),
        threadId,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-override" },
      }),
    );
    expect((await h.read(threadId)).schedules[0]?.revision).toBe(saved.revision);
    expect((await h.read(threadId)).schedules[0]?.state).toBe("active");
  });
  it("rejects a new owner schedule when the reviewed paying account no longer matches", async () => {
    const h = await harness();
    const threadId = await h.createThread("reviewed-account");
    await expect(
      h.run(
        h.service.save({ ...draft, threadId, expectedInstanceId: ProviderInstanceId.make("grok") }),
      ),
    ).rejects.toThrow();
    expect((await h.read(threadId)).schedules).toEqual([]);
    const saved = await h.run(
      h.service.save({ ...draft, threadId, expectedInstanceId: ProviderInstanceId.make("codex") }),
    );
    expect(saved.authorizedInstanceId).toBe("codex");
    const paused = await h.run(
      h.service.setStatus({
        threadId,
        id: saved.id,
        expectedRevision: saved.revision,
        state: "paused",
      }),
    );
    await expect(
      h.run(
        h.service.setStatus({
          threadId,
          id: saved.id,
          expectedRevision: paused.revision,
          state: "active",
          expectedInstanceId: ProviderInstanceId.make("grok"),
        }),
      ),
    ).rejects.toThrow();
    expect((await h.read(threadId)).schedules[0]?.state).toBe("paused");
  });
  it("requires renewed execution approval after permission changes but keeps proposal tools connected", async () => {
    const h = await harness();
    const threadId = await h.createThread("permission-review");
    const authority = await grant(h, threadId);
    const saved = await h.run(h.service.save({ ...draft, threadId }));
    await h.run(
      h.sql`UPDATE projection_threads SET runtime_mode = 'full-access' WHERE thread_id = ${threadId}`,
    );
    const current = (await h.run(h.service.list({ threadId }, authority))).schedules[0]!;
    expect(current.state).toBe("needs_attention");
    expect(current.revision).toBe(saved.revision + 1);
    const proposal = await h.run(h.service.save({ ...draft, threadId }, "agent", authority));
    expect(proposal.state).toBe("pending_confirmation");
    expect(proposal.permissionCeiling).toBe("full-access");
  });
});

function footer(
  occurrence: ScheduledFollowupRun,
  result: "changed" | "no-change" = "no-change",
  finish = false,
) {
  return `Checked synthetic state.\n<!-- cafe-scheduled-followup: ${JSON.stringify({ runId: occurrence.id, result, summary: "Synthetic check complete.", finish })} -->`;
}

/** Fail-clean barriers never rely on a short scheduler timer winning a race. */
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitForBarrier(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Synthetic notification barrier was not reached")),
          2_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("scheduled follow-up real-SQL service", () => {
  it.each(["codex", "claudeAgent", "grok"])(
    "admits a scheduled %s turn through real receipts without altering chat defaults",
    async (driver) => {
      const h = await harness();
      const threadId = await h.createThread("thread-1", driver);
      const before = await h.shell(threadId);
      const schedule = await h.run(
        h.service.save({
          ...draft,
          threadId,
          modelSelection: { instanceId: ProviderInstanceId.make(driver), model: "test-override" },
        }),
      );
      expect(schedule.state).toBe("active");
      expect(schedule.nextRunAt).toBe(FIVE_MINUTES);
      h.setTime(FIVE_MINUTES);
      await h.run(h.service.tick);
      const [occurrence] = (await h.history(schedule)).runs;
      expect(occurrence).toMatchObject({
        state: "dispatching",
        dueAt: FIVE_MINUTES,
        revision: 1,
        modelSelection: { instanceId: driver, model: "test-override" },
      });
      expect(occurrence?.intentSequence).toBeGreaterThan(0);
      const [receipt] = await h.run(
        h.sql<{
          status: string;
        }>`SELECT status FROM orchestration_command_receipts WHERE command_id = ${occurrence!.commandId}`,
      );
      expect(receipt?.status).toBe("accepted");
      expect((await h.shell(threadId)).modelSelection).toEqual(before.modelSelection);
    },
  );

  it("keeps agent proposals dormant until explicit owner approval and rejects stale edits", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const proposal = await h.run(h.service.save({ ...draft, threadId }, "agent"));
    expect(proposal).toMatchObject({ state: "pending_confirmation", nextRunAt: null });
    h.setTime("2026-10-04T01:00:00.000Z");
    await h.run(h.service.tick);
    expect((await h.history(proposal)).runs).toEqual([]);
    await expect(
      h.run(h.service.runNow({ threadId, id: proposal.id, expectedRevision: proposal.revision })),
    ).rejects.toThrow();
    const approved = await h.run(
      h.service.setStatus({
        threadId,
        id: proposal.id,
        expectedRevision: proposal.revision,
        state: "active",
      }),
    );
    expect(approved.state).toBe("active");
    expect(approved.revision).toBe(proposal.revision + 1);
    await expect(
      h.run(
        h.service.setStatus({
          threadId,
          id: proposal.id,
          expectedRevision: proposal.revision,
          state: "paused",
        }),
      ),
    ).rejects.toThrow();
    expect((await h.read(threadId)).schedules[0]?.state).toBe("active");
  });

  it("claims once across independent scheduler instances sharing the database", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const schedule = await h.run(h.service.save({ ...draft, threadId }));
    const second = await h.anotherService();
    const input = { threadId, id: schedule.id, expectedRevision: schedule.revision };
    const settled = await Promise.allSettled([
      h.run(h.service.runNow(input)),
      h.run(second.runNow(input)),
    ]);
    expect(settled.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((value) => value.status === "rejected")).toHaveLength(1);
    expect((await h.history(schedule)).runs).toHaveLength(1);
  });

  it("invalidates queued work on pause and through the real Stop control trigger", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const schedule = await h.run(h.service.save({ ...draft, threadId }));
    await h.run(
      h.service.runNow({ threadId, id: schedule.id, expectedRevision: schedule.revision }),
    );
    const paused = await h.run(
      h.service.setStatus({
        threadId,
        id: schedule.id,
        expectedRevision: schedule.revision,
        state: "paused",
      }),
    );
    expect((await h.history(schedule)).runs[0]?.state).toBe("skipped");
    const resumed = await h.run(
      h.service.setStatus({
        threadId,
        id: schedule.id,
        expectedRevision: paused.revision,
        state: "active",
      }),
    );
    await h.run(
      h.service.runNow({ threadId, id: schedule.id, expectedRevision: resumed.revision }),
    );
    await h.run(
      h.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("explicit-stop"),
        threadId,
        createdAt: INITIAL,
      }),
    );
    expect((await h.read(threadId)).schedules[0]?.state).toBe("paused");
    expect((await h.history(schedule)).runs.every((run) => run.state === "skipped")).toBe(true);
  });

  it("binds model overrides to the approved account and never accepts an unavailable model", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    for (const modelSelection of [
      { instanceId: ProviderInstanceId.make("grok"), model: "test-model" },
      { instanceId: ProviderInstanceId.make("codex"), model: "unavailable-model" },
    ])
      await expect(h.run(h.service.save({ ...draft, threadId, modelSelection }))).rejects.toThrow();
    expect((await h.read(threadId)).schedules).toEqual([]);
  });

  it("marks provider loss as needing attention without dispatching or changing account", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const schedule = await h.run(h.service.save({ ...draft, threadId }));
    h.setProviders([]);
    h.setTime(FIVE_MINUTES);
    await h.run(h.service.tick);
    expect((await h.read(threadId)).schedules[0]?.state).toBe("needs_attention");
    expect((await h.history(schedule)).runs[0]).toMatchObject({
      state: "failed",
      errorCode: "provider-unavailable",
      intentSequence: null,
    });
  });

  it("coalesces missed occurrences to the latest due time rather than enqueuing a backlog", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const schedule = await h.run(h.service.save({ ...draft, threadId }));
    h.setTime("2026-10-05T00:02:00.000Z");
    await h.run(h.service.tick);
    const runs = (await h.history(schedule)).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.dueAt).toBe("2026-10-05T00:00:00.000Z");
    expect((await h.read(threadId)).schedules[0]?.nextRunAt).toBe("2026-10-05T00:05:00.000Z");
  });

  it("keeps waiting behind busy chats while fairly visiting a later idle chat", async () => {
    const h = await harness();
    let later: ScheduledFollowupRecord | undefined;
    for (let index = 0; index < 21; index += 1) {
      const threadId = await h.createThread(`thread-${index}`);
      const schedule = await h.run(h.service.save({ ...draft, threadId }));
      await h.run(
        h.service.runNow({ threadId, id: schedule.id, expectedRevision: schedule.revision }),
      );
      if (index < 20) await h.session(threadId, TurnId.make(`busy-${index}`));
      else later = schedule;
      h.setTime(new Date(Date.parse(INITIAL) + index + 1).toISOString());
    }
    await h.run(h.service.tick);
    h.setTime("2026-10-04T00:01:00.000Z");
    await h.run(h.service.tick);
    expect((await h.history(later!)).runs[0]?.state).toBe("dispatching");
    const [busy] = await h.run(
      h.sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM scheduled_followup_runs WHERE state = 'waiting'`,
    );
    expect(busy?.count).toBe(20);
  });

  it("retains an ambiguous attempted run across a new service and never mints a replacement", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const schedule = await h.run(h.service.save({ ...draft, threadId }));
    h.setTime(FIVE_MINUTES);
    await h.run(h.service.tick);
    const occurrence = (await h.history(schedule)).runs[0]!;
    // Commit the real pre-I/O authorization marker but provide no native ACK.
    // No provider is launched and no prompt is actually sent.
    expect(await h.attempt(occurrence)).toBe(true);
    const restarted = await h.anotherService();
    h.setTime("2026-10-04T00:11:00.000Z");
    await h.run(restarted.tick);
    const runs = (await h.history(schedule)).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: occurrence.id,
      state: "unknown",
      errorCode: "acceptance-unknown",
    });
    expect((await h.read(threadId)).schedules[0]?.state).toBe("needs_attention");
    await expect(
      h.run(restarted.runNow({ threadId, id: schedule.id, expectedRevision: schedule.revision })),
    ).rejects.toThrow();
  });

  it("does not classify an old positively unattempted admission as an unknown paid attempt after restart", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const schedule = await h.run(h.service.save({ ...draft, threadId, maxRuns: 1 }));
    h.setTime(FIVE_MINUTES);
    await h.run(h.service.tick);
    const occurrence = (await h.history(schedule)).runs[0]!;
    expect(occurrence.state).toBe("dispatching");
    const eventsBefore = await h.run(h.engine.readEvents(0).pipe(Stream.runCollect));

    // The backend was offline before its provider worker crossed the durable
    // paid-submission boundary. Admission age is not a lost native ACK.
    const restarted = await h.anotherService();
    h.setTime("2026-10-05T00:05:00.000Z");
    await h.run(restarted.tick);
    expect((await h.history(schedule)).runs).toHaveLength(1);
    expect((await h.history(schedule)).runs[0]).toMatchObject({
      id: occurrence.id,
      state: "dispatching",
      errorCode: null,
      intentSequence: occurrence.intentSequence,
    });
    expect((await h.read(threadId)).schedules[0]).toMatchObject({ state: "active", runCount: 0 });
    expect(await h.run(h.engine.readEvents(0).pipe(Stream.runCollect))).toEqual(eventsBefore);

    // Startup replay may now prepare and submit this exact admitted occurrence
    // once. The CAS timestamp, not yesterday's admission, starts its ACK budget.
    await h.finish(schedule, occurrence, footer(occurrence));
    await h.run(restarted.tick);
    expect((await h.history(schedule)).runs).toHaveLength(1);
    expect((await h.history(schedule)).runs[0]).toMatchObject({
      id: occurrence.id,
      state: "completed",
    });
    expect((await h.read(threadId)).schedules[0]).toMatchObject({
      state: "completed",
      runCount: 1,
    });
  });

  it("completes an expired inactive schedule rather than repeatedly claiming rejected work", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const schedule = await h.run(
      h.service.save({ ...draft, threadId, endAt: "2026-10-04T00:05:00.000Z" }),
    );
    h.setTime("2026-10-04T00:06:00.000Z");
    await h.run(h.service.tick);
    expect((await h.read(threadId)).schedules[0]).toMatchObject({
      state: "completed",
      nextRunAt: null,
    });
    expect((await h.history(schedule)).runs).toEqual([]);
  });

  it("cannot reactivate an uncertain attempted run by editing or approving its replacement proposal", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const schedule = await h.run(h.service.save({ ...draft, threadId }));
    h.setTime(FIVE_MINUTES);
    await h.run(h.service.tick);
    const occurrence = (await h.history(schedule)).runs[0]!;
    expect(await h.attempt(occurrence)).toBe(true);
    h.setTime("2026-10-04T00:11:00.000Z");
    await h.run(h.service.tick);
    const uncertain = (await h.read(threadId)).schedules[0]!;
    expect(uncertain.state).toBe("needs_attention");
    const historyBefore = (await h.history(schedule)).runs;
    const edit = {
      ...draft,
      threadId,
      id: schedule.id,
      expectedRevision: uncertain.revision,
      name: "Edited pending outcome",
    };

    // An owner save normally activates its revision. That shortcut must obey
    // the same unresolved-attempt barrier as the explicit Resume action.
    await expect(h.run(h.service.save(edit))).rejects.toThrow("uncertain outcome");
    expect((await h.read(threadId)).schedules[0]).toEqual(uncertain);
    expect((await h.history(schedule)).runs).toEqual(historyBefore);

    // An agent may still prepare an inert proposal for later owner review,
    // but cannot erase the old occurrence or have it approved while unknown.
    const proposal = await h.run(h.service.save(edit, "agent"));
    expect(proposal).toMatchObject({
      state: "pending_confirmation",
      nextRunAt: null,
      revision: uncertain.revision + 1,
    });
    await expect(
      h.run(
        h.service.setStatus({
          threadId,
          id: proposal.id,
          expectedRevision: proposal.revision,
          state: "active",
        }),
      ),
    ).rejects.toThrow("uncertain outcome");
    await h.run(h.service.tick);
    expect((await h.read(threadId)).schedules[0]?.state).toBe("pending_confirmation");
    expect((await h.history(schedule)).runs).toEqual(historyBefore);
  });

  it.each([false, true])(
    "deleting a schedule hides it and cancels only unattempted work (attempted: %s)",
    async (attempted) => {
      const h = await harness();
      const threadId = await h.createThread("thread-1");
      const schedule = await h.run(h.service.save({ ...draft, threadId }));
      let occurrence: ScheduledFollowupRun;
      if (attempted) {
        h.setTime(FIVE_MINUTES);
        await h.run(h.service.tick);
        occurrence = (await h.history(schedule)).runs[0]!;
        expect(await h.attempt(occurrence)).toBe(true);
        await h.session(threadId, TurnId.make("accepted-live-turn"));
        await h.run(h.service.tick);
      } else {
        occurrence = await h.run(
          h.service.runNow({ threadId, id: schedule.id, expectedRevision: schedule.revision }),
        );
      }
      const eventsBefore = await h.run(h.engine.readEvents(0).pipe(Stream.runCollect));
      const deleted = await h.run(
        h.service.setStatus({
          threadId,
          id: schedule.id,
          expectedRevision: schedule.revision,
          state: "deleted",
        }),
      );
      expect(deleted.state).toBe("deleted");
      expect((await h.read(threadId)).schedules).toEqual([]);
      await expect(
        h.run(h.service.runNow({ threadId, id: schedule.id, expectedRevision: deleted.revision })),
      ).rejects.toThrow();
      h.setTime("2026-10-05T00:00:00.000Z");
      await h.run(h.service.tick);
      const rows = await h.run(
        h.sql<{
          id: string;
          state: string;
          attempt_at: string | null;
          turn_id: string | null;
        }>`SELECT id,state,attempt_at,turn_id FROM scheduled_followup_runs WHERE schedule_id = ${schedule.id}`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: occurrence.id,
        state: attempted ? "running" : "skipped",
        attempt_at: attempted ? FIVE_MINUTES : null,
        turn_id: attempted ? "accepted-live-turn" : null,
      });
      // Removing a schedule is not a Stop command and does not resend anything.
      // The exact accepted native turn remains owned by the ordinary lifecycle.
      expect(await h.run(h.engine.readEvents(0).pipe(Stream.runCollect))).toEqual(eventsBefore);
      expect((await h.read(threadId)).schedules).toEqual([]);
    },
  );

  it("paginates history without duplicates and never leaks another thread's schedule", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const otherThread = await h.createThread("thread-2");
    const schedule = await h.run(h.service.save({ ...draft, threadId }));
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      h.setTime(new Date(Date.parse(INITIAL) + index + 1).toISOString());
      const run = await h.run(
        h.service.runNow({ threadId, id: schedule.id, expectedRevision: schedule.revision }),
      );
      ids.unshift(run.id);
      await h.run(
        h.sql`UPDATE scheduled_followup_runs SET state = 'skipped',completed_at = ${INITIAL} WHERE id = ${run.id}`,
      );
    }
    const first = await h.history(schedule, 2);
    expect(first.runs.map((run) => run.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    const next = await h.run(
      h.service.history({ threadId, id: schedule.id, before: first.nextCursor!, limit: 2 }),
    );
    expect(next.runs.map((run) => run.id)).toEqual(ids.slice(2));
    expect(next.nextCursor).toBeNull();
    await expect(
      h.run(h.service.history({ threadId: otherThread, id: schedule.id })),
    ).rejects.toThrow();
  });

  it("settles a canonical completed occurrence exactly once and honors the maximum run count", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const schedule = await h.run(h.service.save({ ...draft, threadId, maxRuns: 1 }));
    h.setTime(FIVE_MINUTES);
    await h.run(h.service.tick);
    const occurrence = (await h.history(schedule)).runs[0]!;
    const { turnId, messageId } = await h.finish(schedule, occurrence, footer(occurrence));
    const [projection] = await h.run(
      h.sql<{
        state: string;
        pending_message_id: string;
        assistant_message_id: string;
      }>`SELECT state,pending_message_id,assistant_message_id FROM projection_turns WHERE thread_id = ${threadId} AND turn_id = ${turnId}`,
    );
    expect(projection).toMatchObject({
      state: "completed",
      pending_message_id: occurrence.messageId,
      assistant_message_id: messageId,
    });
    expect(await h.run(h.service.notification(threadId, turnId))).toEqual({ notify: false });
    await h.run(h.service.tick);
    expect((await h.history(schedule)).runs[0]).toMatchObject({
      state: "completed",
      result: "no-change",
      summary: "Synthetic check complete.",
      turnId,
    });
    expect((await h.read(threadId)).schedules[0]).toMatchObject({
      state: "completed",
      runCount: 1,
      nextRunAt: null,
    });
    h.setTime("2026-10-05T00:00:00.000Z");
    await h.run(h.service.tick);
    await h.run((await h.anotherService()).tick);
    expect((await h.history(schedule)).runs).toHaveLength(1);
    expect((await h.read(threadId)).schedules[0]?.runCount).toBe(1);
  });

  it.each([
    { allowAutoFinish: false, finish: true, state: "active" },
    { allowAutoFinish: true, finish: false, state: "active" },
    { allowAutoFinish: true, finish: true, state: "completed" },
  ] as const)(
    "requires both owner authorization and an exact final finish request: %j",
    async ({ allowAutoFinish, finish, state }) => {
      const h = await harness();
      const threadId = await h.createThread("thread-1");
      const schedule = await h.run(h.service.save({ ...draft, threadId, allowAutoFinish }));
      h.setTime(FIVE_MINUTES);
      await h.run(h.service.tick);
      const occurrence = (await h.history(schedule)).runs[0]!;
      await h.finish(schedule, occurrence, footer(occurrence, "no-change", finish));
      await h.run(h.service.tick);
      expect((await h.read(threadId)).schedules[0]).toMatchObject({ state, runCount: 1 });
    },
  );

  it.each([
    { policy: "all-runs", result: "no-change", notify: true },
    { policy: "changes-and-errors", result: "no-change", notify: false },
    { policy: "changes-and-errors", result: "changed", notify: true },
    { policy: "errors-only", result: "changed", notify: false },
  ] as const)(
    "applies notification policy to exact completed evidence before the periodic sweep: %j",
    async ({ policy, result, notify }) => {
      const h = await harness();
      const threadId = await h.createThread("thread-1");
      const schedule = await h.run(
        h.service.save({ ...draft, threadId, notificationPolicy: policy }),
      );
      h.setTime(FIVE_MINUTES);
      await h.run(h.service.tick);
      const occurrence = (await h.history(schedule)).runs[0]!;
      const { turnId } = await h.finish(schedule, occurrence, footer(occurrence, result));
      // Deliberately do not call tick: native terminal notifications can arrive
      // before the scheduler copies the canonical turn's outcome into history.
      expect(await h.run(h.service.notification(threadId, turnId))).toEqual({ notify });
    },
  );

  it.each(["all-runs", "changes-and-errors", "errors-only"] as const)(
    "never hides a failed turn under %s",
    async (notificationPolicy) => {
      const h = await harness();
      const threadId = await h.createThread("thread-1");
      const schedule = await h.run(h.service.save({ ...draft, threadId, notificationPolicy }));
      h.setTime(FIVE_MINUTES);
      await h.run(h.service.tick);
      const occurrence = (await h.history(schedule)).runs[0]!;
      const { turnId } = await h.finish(
        schedule,
        occurrence,
        footer(occurrence, "no-change", true),
        "error",
      );
      expect(await h.run(h.service.notification(threadId, turnId))).toEqual({ notify: true });
      await h.run(h.service.tick);
      expect((await h.history(schedule)).runs[0]).toMatchObject({
        state: "failed",
        result: null,
        summary: null,
      });
      expect((await h.read(threadId)).schedules[0]?.state).toBe("needs_attention");
    },
  );

  it.each([
    "wrong-run",
    "wrong-turn",
    "wrong-canonical-message",
    "streaming",
    "missing-footer",
  ] as const)(
    "rejects %s result evidence without hiding output or finishing the schedule",
    async (mismatch) => {
      const h = await harness();
      const threadId = await h.createThread("thread-1");
      const schedule = await h.run(h.service.save({ ...draft, threadId, allowAutoFinish: true }));
      h.setTime(FIVE_MINUTES);
      await h.run(h.service.tick);
      const occurrence = (await h.history(schedule)).runs[0]!;
      let text = footer(occurrence, "no-change", true);
      if (mismatch === "wrong-run")
        text = text.replace(occurrence.id, "00000000-0000-4000-8000-000000000001");
      if (mismatch === "missing-footer") text = "No changes. Everything looks done.";
      const { turnId, messageId } = await h.finish(schedule, occurrence, text);
      // Model delayed/inconsistent projection observations in this private DB.
      // They may contain a syntactically valid result but lack canonical binding.
      if (mismatch === "wrong-turn")
        await h.run(
          h.sql`UPDATE projection_thread_messages SET turn_id = 'another-native-turn' WHERE thread_id = ${threadId} AND message_id = ${messageId}`,
        );
      if (mismatch === "wrong-canonical-message")
        await h.run(
          h.sql`UPDATE projection_turns SET assistant_message_id = 'different-message' WHERE thread_id = ${threadId} AND turn_id = ${turnId}`,
        );
      if (mismatch === "streaming")
        await h.run(
          h.sql`UPDATE projection_thread_messages SET is_streaming = 1 WHERE thread_id = ${threadId} AND message_id = ${messageId}`,
        );
      expect(await h.run(h.service.notification(threadId, turnId))).toEqual({ notify: true });
      await h.run(h.service.tick);
      expect((await h.history(schedule)).runs[0]).toMatchObject({
        state: "completed",
        result: null,
        summary: null,
      });
      expect((await h.read(threadId)).schedules[0]?.state).toBe("active");
    },
  );

  it("revokes automatic finish and quiet notifications after a later human control", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const schedule = await h.run(h.service.save({ ...draft, threadId, allowAutoFinish: true }));
    h.setTime(FIVE_MINUTES);
    await h.run(h.service.tick);
    const occurrence = (await h.history(schedule)).runs[0]!;
    const { turnId } = await h.finish(schedule, occurrence, footer(occurrence, "no-change", true));
    // A later user Stop is a real persisted control, not a fabricated sequence.
    await h.run(
      h.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("later-stop"),
        threadId,
        createdAt: FIVE_MINUTES,
      }),
    );
    expect(await h.run(h.service.notification(threadId, turnId))).toEqual({ notify: true });
    await h.run(h.service.tick);
    expect((await h.history(schedule)).runs[0]).toMatchObject({
      state: "completed",
      result: null,
      summary: null,
    });
    expect((await h.read(threadId)).schedules[0]?.state).toBe("paused");
  });

  it("expires queued work that waited behind a busy chat beyond its end date", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const schedule = await h.run(h.service.save({ ...draft, threadId, endAt: FIVE_MINUTES }));
    await h.session(threadId, TurnId.make("busy-turn"));
    h.setTime(FIVE_MINUTES);
    await h.run(h.service.tick);
    expect((await h.history(schedule)).runs[0]?.state).toBe("waiting");
    h.setTime("2026-10-04T00:06:00.000Z");
    await h.session(threadId, null, "ready");
    await h.run(h.service.tick);
    expect((await h.history(schedule)).runs[0]).toMatchObject({
      state: "skipped",
      intentSequence: null,
    });
    expect((await h.read(threadId)).schedules[0]?.state).toBe("completed");
  });

  it("isolates a corrupt stored recurrence so another due schedule is still admitted", async () => {
    const h = await harness();
    const firstThread = await h.createThread("thread-1");
    const first = await h.run(h.service.save({ ...draft, threadId: firstThread }));
    const secondThread = await h.createThread("thread-2");
    const second = await h.run(h.service.save({ ...draft, threadId: secondThread }));
    await h.run(
      h.sql`UPDATE scheduled_followups SET definition_json = '{"invalid":"fixture"}' WHERE id = ${first.id}`,
    );
    h.setTime(FIVE_MINUTES);
    await h.run(h.service.tick);
    const [stored] = await h.run(
      h.sql<{ state: string }>`SELECT state FROM scheduled_followups WHERE id = ${first.id}`,
    );
    expect(stored?.state).toBe("needs_attention");
    expect((await h.history(second)).runs[0]?.state).toBe("dispatching");
  });

  it("retries an uncertain local admission using the same frozen command bytes and identities", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const schedule = await h.run(h.service.save({ ...draft, threadId }));
    const commands: Array<Parameters<typeof h.engine.dispatch>[0]> = [];
    const uncertain = await h.anotherService((command) => {
      commands.push(command);
      // The first local transport loses its response before any durable receipt
      // exists. The scheduler cannot infer rejection or mint another identity.
      return commands.length === 1
        ? Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Synthetic missing local acknowledgement",
            }),
          )
        : h.engine.dispatch(command);
    });
    h.setTime(FIVE_MINUTES);
    await h.run(uncertain.tick);
    const first = (await h.history(schedule)).runs[0]!;
    expect(first.state).toBe("waiting");
    h.setTime("2026-10-04T00:06:00.000Z");
    await h.run(uncertain.tick);
    const second = (await h.history(schedule)).runs;
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      id: first.id,
      commandId: first.commandId,
      messageId: first.messageId,
      state: "dispatching",
    });
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
  });

  it("settles a once schedule without inventing another occurrence", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const schedule = await h.run(
      h.service.save({
        ...draft,
        threadId,
        recurrence: { kind: "once", at: FIVE_MINUTES, timeZone: "UTC" },
      }),
    );
    h.setTime(FIVE_MINUTES);
    await h.run(h.service.tick);
    const occurrence = (await h.history(schedule)).runs[0]!;
    await h.finish(schedule, occurrence, footer(occurrence, "changed"));
    await h.run(h.service.tick);
    expect((await h.read(threadId)).schedules[0]).toMatchObject({
      state: "completed",
      runCount: 1,
      nextRunAt: null,
    });
    h.setTime("2026-10-06T00:00:00.000Z");
    await h.run(h.service.tick);
    expect((await h.history(schedule)).runs).toHaveLength(1);
  });

  it("waits for an initially absent native-turn binding before applying quiet completion policy", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    const schedule = await h.run(h.service.save({ ...draft, threadId }));
    h.setTime(FIVE_MINUTES);
    await h.run(h.service.tick);
    const occurrence = (await h.history(schedule)).runs[0]!;
    const turnId = TurnId.make(`native:${occurrence.id}`);
    const sleeping = barrier();
    const wake = barrier();
    let sleeps = 0;
    h.setSleep(() =>
      Effect.promise(() => {
        sleeps += 1;
        sleeping.release();
        return wake.promise;
      }),
    );
    const notification = h.run(h.service.notification(threadId, turnId));
    // Observe a rejection immediately; cleanup below drains the same promise
    // even if canonical projection construction or an assertion fails.
    void notification.catch(() => {});
    try {
      await waitForBarrier(sleeping.promise);
      expect((await h.history(schedule)).runs[0]?.turnId).toBeNull();
      await h.finish(schedule, occurrence, footer(occurrence));
      wake.release();
      expect(await notification).toEqual({ notify: false });
      expect(sleeps).toBe(1);
    } finally {
      wake.release();
      await notification.catch(() => {});
    }
  });

  it.each(["missing-binding", "nonterminal-turn", "binding-then-nonterminal"] as const)(
    "exhausts one bounded notification wait and conservatively notifies for %s",
    async (missing) => {
      const h = await harness();
      const threadId = await h.createThread("thread-1");
      const schedule = await h.run(
        h.service.save({ ...draft, threadId, notificationPolicy: "errors-only" }),
      );
      h.setTime(FIVE_MINUTES);
      await h.run(h.service.tick);
      const occurrence = (await h.history(schedule)).runs[0]!;
      const turnId = TurnId.make(`native:${occurrence.id}`);
      if (missing === "nonterminal-turn") await h.session(threadId, turnId);
      let sleeps = 0;
      h.setSleep(() =>
        Effect.promise(async () => {
          sleeps += 1;
          // The two distinct wait phases must share one total budget. Bind the
          // native turn partway through without completing its generation.
          if (missing === "binding-then-nonterminal" && sleeps === 7)
            await h.session(threadId, turnId);
        }),
      );
      expect(await h.run(h.service.notification(threadId, turnId))).toEqual({ notify: true });
      expect(sleeps).toBe(20);
    },
  );

  it("does not delay an ordinary unscheduled completion", async () => {
    const h = await harness();
    const threadId = await h.createThread("thread-1");
    let sleeps = 0;
    h.setSleep(() =>
      Effect.sync(() => {
        sleeps += 1;
      }),
    );
    expect(await h.run(h.service.notification(threadId, TurnId.make("ordinary-turn")))).toEqual({
      notify: true,
    });
    expect(sleeps).toBe(0);
  });

  it("preserves authorization, pending occurrence and immutable attempt across closing and reopening real SQLite", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "cafe-scheduled-restart-"));
    // This exact filesystem-minted root contains synthetic fixtures only.
    // LIFO cleanup closes both runtimes before removing the directory.
    disposals.push(() => fs.rm(baseDir, { recursive: true, force: true }));
    const persistence = { baseDir, dbPath: path.join(baseDir, "scheduler.sqlite") };
    const first = await harness(persistence);
    const threadId = await first.createThread("thread-persistent");
    const schedule = await first.run(first.service.save({ ...draft, threadId }));
    first.setTime(FIVE_MINUTES);
    await first.run(first.service.tick);
    const occurrence = (await first.history(schedule)).runs[0]!;
    expect(await first.attempt(occurrence)).toBe(true);
    await first.dispose();

    const second = await harness(persistence);
    second.setTime("2026-10-04T00:11:00.000Z");
    const restored = (await second.read(threadId)).schedules[0]!;
    expect(restored).toMatchObject({
      id: schedule.id,
      authorizedInstanceId: "codex",
      permissionCeiling: "approval-required",
      revision: 1,
      runCount: 1,
    });
    expect((await second.history(schedule)).runs[0]).toMatchObject({
      id: occurrence.id,
      commandId: occurrence.commandId,
      messageId: occurrence.messageId,
      intentSequence: occurrence.intentSequence,
    });
    await second.run(second.service.tick);
    expect((await second.history(schedule)).runs).toHaveLength(1);
    expect((await second.history(schedule)).runs[0]).toMatchObject({
      id: occurrence.id,
      state: "unknown",
    });
    expect((await second.read(threadId)).schedules[0]?.state).toBe("needs_attention");
    const [marker] = await second.run(
      second.sql<{
        attempt_at: string;
      }>`SELECT attempt_at FROM scheduled_followup_runs WHERE id = ${occurrence.id}`,
    );
    expect(marker?.attempt_at).toBe(FIVE_MINUTES);
  });
});
