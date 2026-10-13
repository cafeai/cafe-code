import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import type { GeneratedVisualizationNativeWitness } from "@cafecode/contracts/visualizationApi";
import {
  VisualizationGenerationId,
  VisualizationArtifactId,
  VisualizationRevisionId,
  type GeneratedVisualizationReference,
} from "@cafecode/contracts/visualizations";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as TestSqliteClient from "../persistence/TestSqliteClient.ts";
import { copyVisualizationHistory, reconcileVisualizationHistory } from "./history.ts";
import {
  makeVisualizationArtifactService,
  computeGeneratedVisualizationInputSha256,
} from "./store.ts";
import { makeVisualizationSessionRuntime } from "./sessionRuntime.ts";
import { createAttachmentId } from "../attachmentStore.ts";
import { GENERATED_VISUALIZATION_INSTRUCTIONS, registerVisualizationTools } from "./mcp.ts";
import { claimVisualizationNativeItem } from "./nativePrivacy.ts";
import { visualizationFluidScript } from "@cafecode/shared/visualizationFluidRuntime";
import { VISUALIZATION_FONT_LICENSE } from "@cafecode/shared/visualizationFontData";
import { GENERATED_VISUALIZATION_FONT_APPENDIX } from "@cafecode/shared/visualizationFonts";
import { exportGeneratedVisualizationHtml } from "./offlineHtml.ts";

function pngChunk(name: string, data: Buffer) {
  const type = Buffer.from(name);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([header, type, data, checksum]);
}
const noCaptureHook = async () => undefined;
const noPrepareHook = async (_ticket: string) => undefined;
// A real synthetically encoded PNG, not a successful-looking empty image.
function png(width: number, height: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
const fixture = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  const originalConfig = yield* ServerConfig;
  const config = { ...originalConfig, mode: "desktop" as const };
  const token = "a".repeat(64);
  const generation = randomUUID();
  let captures = 0;
  let lastPreviewPayload: unknown;
  let lastViewerPayload: unknown;
  let captureFailure = false;
  let captureHook: () => Promise<void> = noCaptureHook;
  let prepareHook: (ticket: string) => Promise<void> = noPrepareHook;
  const preparedTickets = new Set<string>();
  const spentTickets = new Set<string>();
  const discardedTickets: string[] = [];
  let preparations = 0;
  let unexpectedMethods = 0;
  let prepareFailures = 0;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (value: Buffer) => chunks.push(value));
    request.on("end", async () => {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        generation: string;
        method: string;
        payload: { ticket?: string; document: { width: number; height: number } };
      };
      if (request.headers.authorization !== `Bearer ${token}` || input.generation !== generation) {
        response.writeHead(403);
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      if (input.method === "prepareViewer") {
        lastViewerPayload = input.payload;
        const ticket = input.payload.ticket!;
        preparedTickets.add(ticket);
        preparations++;
        try {
          await prepareHook(ticket);
        } catch {
          prepareFailures++;
          response.writeHead(503);
          response.end(JSON.stringify({ error: "Synthetic preparation failed." }));
          return;
        }
        response.end(
          JSON.stringify({
            status: "ready",
            ticket: input.payload.ticket,
            expiresAtMs: Date.now() + 60000,
          }),
        );
      } else if (input.method === "discardPrepared") {
        assert.deepEqual(Object.keys(input.payload), ["ticket"]);
        const ticket = input.payload.ticket!;
        discardedTickets.push(ticket);
        response.end(
          JSON.stringify({
            discarded: !spentTickets.has(ticket) && preparedTickets.delete(ticket),
          }),
        );
      } else if (input.method === "preview") {
        lastPreviewPayload = input.payload;
        captures++;
        await captureHook();
        if (captureFailure) {
          response.writeHead(503);
          response.end(JSON.stringify({ error: "Synthetic unavailable host" }));
          return;
        }
        const document = input.payload.document;
        response.end(
          JSON.stringify({
            status: "ready",
            png: png(document.width, document.height).toString("base64"),
            width: document.width,
            height: document.height,
            diagnostics: [],
          }),
        );
      } else {
        unexpectedMethods++;
        response.writeHead(403);
        response.end();
      }
    });
  });
  yield* Effect.promise(
    () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected fixture address.");
  const hostPath = path.join(config.stateDir, "visualization-host.json");
  yield* Effect.promise(() =>
    fs.writeFile(
      hostPath,
      JSON.stringify({
        version: 1,
        generation,
        url: `http://127.0.0.1:${address.port}/visualizations`,
        token,
      }),
      { mode: 0o600 },
    ),
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => fs.unlink(hostPath)));
  const bridgeSource = path.join(config.stateDir, `fixture-${randomUUID()}.mjs`);
  yield* Effect.promise(() =>
    fs.writeFile(bridgeSource, "// Isolated fixture; never executed.\n", { mode: 0o600 }),
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => fs.unlink(bridgeSource)));
  const runtime = yield* makeVisualizationSessionRuntime({ bridgeSource, mcpPort: 12345 });
  yield* Effect.addFinalizer(() => Effect.promise(runtime.close));
  const identity = {
    threadId: ThreadId.make(`visual-${randomUUID()}`),
    providerInstanceId: ProviderInstanceId.make("codex_fixture"),
    provider: "codex" as const,
  };
  const binding = yield* Effect.promise(() => runtime.bind(identity));
  if (!binding) throw new Error("Expected isolated fixture binding.");
  yield* Effect.promise(binding.activate);
  const service = yield* makeVisualizationArtifactService().pipe(
    Effect.provideService(ServerConfig, config),
    Effect.provideService(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("isolated-environment")),
      getDescriptor: Effect.die("Descriptor not used in this isolated fixture."),
    }),
  );
  const input = {
    version: 1 as const,
    purpose: "generated-visualization" as const,
    requestId: randomUUID(),
    source: "<!doctype html><title>Synthetic private page</title><p>private-source-marker 🌸</p>",
    title: "Synthetic chart",
    assets: [],
    appearance: "dark" as const,
    viewport: { width: 240, height: 80 },
  };
  const witness: GeneratedVisualizationNativeWitness = {
    ...identity,
    sessionGeneration: binding.authority.sessionGeneration,
    nativeThreadId: "native-fixture-root",
    nativeTurnId: "native-fixture-turn",
    nativeItemId: "native-fixture-item",
    serverName: binding.name,
    toolName: "publish_visualization",
    inputSha256: computeGeneratedVisualizationInputSha256(input)!,
    actor: { type: "root" },
    messageId: MessageId.make("visual-fixture-message"),
    turnId: TurnId.make("canonical-fixture-turn"),
    occurredAt: new Date().toISOString(),
  };
  yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at) VALUES(${identity.threadId},NULL,'Isolated visualization fixture',${witness.occurredAt},${witness.occurredAt})`;
  yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,checkpoint_turn_count,checkpoint_files_json) VALUES(${identity.threadId},${witness.turnId},'completed',${witness.occurredAt},1,'[]')`;
  return {
    sql,
    service,
    binding,
    input,
    witness,
    config,
    captures: () => captures,
    lastPreviewPayload: () => lastPreviewPayload,
    lastViewerPayload: () => lastViewerPayload,
    hostPath,
    generation,
    preparations: () => preparations,
    preparedTickets,
    spentTickets,
    discardedTickets,
    unexpectedMethods: () => unexpectedMethods,
    prepareFailures: () => prepareFailures,
    setPrepareHook: (hook: (ticket: string) => Promise<void>) => {
      prepareHook = hook;
    },
    setCaptureFailure: (value: boolean) => {
      captureFailure = value;
    },
    setCaptureHook: (hook: () => Promise<void>) => {
      captureHook = hook;
    },
  };
});
const services = Layer.mergeAll(
  TestSqliteClient.layerMemory(),
  ServerConfig.layerTest(process.cwd(), { prefix: "cafe-visual-store-fixture-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

const ownedVisualization = (context: Effect.Success<typeof fixture>) =>
  Effect.gen(function* () {
    const receipt = yield* context.service.publish(context.binding.authority, context.input);
    yield* Effect.promise(() =>
      context.binding.claimNativeCompletion(context.witness, receipt.proof),
    );
    return {
      threadId: context.witness.threadId,
      artifactId: receipt.reference.artifactId,
      revisionId: receipt.reference.revisionId,
    };
  });
const fillTicketLedger = (
  context: Effect.Success<typeof fixture>,
  tuple: Effect.Success<ReturnType<typeof ownedVisualization>>,
  count: number,
) =>
  Effect.gen(function* () {
    for (let index = 0; index < count; index++) {
      const digest = createHash("sha256")
        .update(`synthetic-ticket-${tuple.threadId}-${index}`)
        .digest("hex");
      yield* context.sql`INSERT INTO visualization_viewer_tickets(ticket_digest,thread_id,revision_id,host_generation,expires_at)
      VALUES(${digest},${tuple.threadId},${tuple.revisionId},${context.generation},${Date.now() + 360000})`;
    }
  });

it.layer(services)("immutable private visualization store", (it) => {
  it.effect(
    "discards only the exact unused ticket and retains spent or unknown native ownership",
    () =>
      Effect.gen(function* () {
        const context = yield* fixture;
        const tuple = yield* ownedVisualization(context);
        const first = yield* context.service.viewerTicket(tuple);
        const sibling = yield* context.service.viewerTicket(tuple);
        assert.deepEqual(
          yield* context.service.discardViewerTicket({ ...tuple, ticket: first.ticket }),
          { ...tuple, discarded: true },
        );
        assert.equal(context.preparedTickets.has(first.ticket), false);
        assert.equal(context.preparedTickets.has(sibling.ticket), true);
        assert.equal(
          (yield* Effect.exit(context.service.readViewerTicket(tuple, first.ticket)))._tag,
          "Failure",
        );
        assert.ok(yield* context.service.readViewerTicket(tuple, sibling.ticket));
        context.spentTickets.add(sibling.ticket);
        assert.deepEqual(
          yield* context.service.discardViewerTicket({ ...tuple, ticket: sibling.ticket }),
          { ...tuple, discarded: false },
        );
        assert.ok(yield* context.service.readViewerTicket(tuple, sibling.ticket));
        context.spentTickets.delete(sibling.ticket);
        context.preparedTickets.delete(sibling.ticket);
        assert.equal(
          (yield* context.service.discardViewerTicket({ ...tuple, ticket: sibling.ticket }))
            .discarded,
          false,
        );
        assert.ok(yield* context.service.readViewerTicket(tuple, sibling.ticket));
        assert.deepEqual(context.discardedTickets, [first.ticket, sibling.ticket, sibling.ticket]);
        assert.equal(context.unexpectedMethods(), 0);
      }),
  );
  it.effect(
    "refuses foreign tuples, tokens and a replaced host before unused-ticket dispatch",
    () =>
      Effect.gen(function* () {
        const context = yield* fixture;
        const tuple = yield* ownedVisualization(context);
        const ticket = yield* context.service.viewerTicket(tuple);
        // Schema-valid unrelated IDs must be refused before the native broker sees
        // a token; UUID shape alone never contributes native ownership.
        for (const attack of [
          { ...tuple, threadId: ThreadId.make("foreign-chat"), ticket: ticket.ticket },
          {
            ...tuple,
            artifactId: VisualizationArtifactId.make("00000000-0000-4000-8000-000000000000"),
            ticket: ticket.ticket,
          },
          {
            ...tuple,
            revisionId: VisualizationRevisionId.make("00000000-0000-4000-8000-000000000000"),
            ticket: ticket.ticket,
          },
          { ...tuple, ticket: "b".repeat(64) },
          { ...tuple, ticket: `${ticket.ticket}/other` },
        ])
          assert.equal(
            (yield* Effect.exit(context.service.discardViewerTicket(attack)))._tag,
            "Failure",
          );
        assert.equal(context.discardedTickets.length, 0);
        const host = JSON.parse(
          yield* Effect.promise(() => fs.readFile(context.hostPath, "utf8")),
        ) as Record<string, unknown>;
        yield* Effect.promise(() =>
          fs.writeFile(context.hostPath, JSON.stringify({ ...host, generation: randomUUID() }), {
            mode: 0o600,
          }),
        );
        assert.equal(
          (yield* Effect.exit(
            context.service.discardViewerTicket({ ...tuple, ticket: ticket.ticket }),
          ))._tag,
          "Failure",
        );
        assert.equal(context.discardedTickets.length, 0);
        assert.ok(yield* context.service.readViewerTicket(tuple, ticket.ticket));
      }),
  );
  it.effect("preflights the unchanged ticket quota without preparing native private bytes", () =>
    Effect.gen(function* () {
      const context = yield* fixture;
      const tuple = yield* ownedVisualization(context);
      yield* fillTicketLedger(context, tuple, 32);
      assert.equal((yield* Effect.exit(context.service.viewerTicket(tuple)))._tag, "Failure");
      assert.equal(context.preparations(), 0);
      assert.deepEqual(context.discardedTickets, []);
    }),
  );
  it.effect(
    "cleans up only on the captured generation if host publication changes after preparation",
    () =>
      Effect.gen(function* () {
        const context = yield* fixture;
        const tuple = yield* ownedVisualization(context);
        const sibling = yield* context.service.viewerTicket(tuple);
        const host = JSON.parse(
          yield* Effect.promise(() => fs.readFile(context.hostPath, "utf8")),
        ) as Record<string, unknown>;
        context.setPrepareHook(() =>
          fs.writeFile(context.hostPath, JSON.stringify({ ...host, generation: randomUUID() }), {
            mode: 0o600,
          }),
        );
        assert.equal((yield* Effect.exit(context.service.viewerTicket(tuple)))._tag, "Failure");
        assert.equal(context.discardedTickets.length, 1);
        assert.notEqual(context.discardedTickets[0], sibling.ticket);
        assert.deepEqual([...context.preparedTickets], [sibling.ticket]);
        assert.ok(yield* context.service.readViewerTicket(tuple, sibling.ticket));
        assert.equal(context.prepareFailures(), 0);
        assert.equal(context.unexpectedMethods(), 0);
      }),
  );
  it.effect("cleans up exact preparation when competing SQL tickets exhaust final capacity", () =>
    Effect.gen(function* () {
      const context = yield* fixture;
      const tuple = yield* ownedVisualization(context);
      const sibling = yield* context.service.viewerTicket(tuple);
      context.setPrepareHook(() => Effect.runPromise(fillTicketLedger(context, tuple, 31)));
      assert.equal((yield* Effect.exit(context.service.viewerTicket(tuple)))._tag, "Failure");
      assert.equal(context.discardedTickets.length, 1);
      assert.notEqual(context.discardedTickets[0], sibling.ticket);
      assert.deepEqual([...context.preparedTickets], [sibling.ticket]);
      assert.ok(yield* context.service.readViewerTicket(tuple, sibling.ticket));
      assert.equal(context.unexpectedMethods(), 0);
      assert.equal(context.prepareFailures(), 0);
    }),
  );
  it.effect(
    "cleans up prepared bytes after tombstone ownership loss without revision-wide revoke",
    () =>
      Effect.gen(function* () {
        const context = yield* fixture;
        const tuple = yield* ownedVisualization(context);
        const sibling = yield* context.service.viewerTicket(tuple);
        context.setPrepareHook(() =>
          Effect.runPromise(
            context.sql`INSERT INTO hard_deleted_threads(thread_id,deleted_at) VALUES(${tuple.threadId},${new Date().toISOString()})`,
          ).then(() => undefined),
        );
        assert.equal((yield* Effect.exit(context.service.viewerTicket(tuple)))._tag, "Failure");
        assert.equal(context.discardedTickets.length, 1);
        assert.notEqual(context.discardedTickets[0], sibling.ticket);
        assert.deepEqual([...context.preparedTickets], [sibling.ticket]);
        assert.equal(context.unexpectedMethods(), 0);
      }),
  );
  it.effect("cleans up one uncommitted preparation after a private SQL failure", () =>
    Effect.gen(function* () {
      const context = yield* fixture;
      const tuple = yield* ownedVisualization(context);
      const sibling = yield* context.service.viewerTicket(tuple);
      yield* Effect.addFinalizer(() =>
        context.sql`DROP TRIGGER IF EXISTS synthetic_ticket_refusal`.pipe(
          Effect.asVoid,
          Effect.orDie,
        ),
      );
      yield* context.sql`CREATE TRIGGER synthetic_ticket_refusal BEFORE INSERT ON visualization_viewer_tickets BEGIN SELECT RAISE(ABORT,'private-sql-marker'); END`;
      const failed = yield* Effect.exit(context.service.viewerTicket(tuple));
      assert.equal(failed._tag, "Failure");
      assert.equal(JSON.stringify(failed).includes("private-sql-marker"), false);
      assert.equal(context.discardedTickets.length, 1);
      assert.notEqual(context.discardedTickets[0], sibling.ticket);
      assert.deepEqual([...context.preparedTickets], [sibling.ticket]);
      assert.ok(yield* context.service.readViewerTicket(tuple, sibling.ticket));
    }),
  );
  it.effect("cleans up exact prepared state after interrupted acknowledgement", () =>
    Effect.gen(function* () {
      const context = yield* fixture;
      const tuple = yield* ownedVisualization(context);
      const entered = yield* Deferred.make<string>();
      const release = yield* Deferred.make<void>();
      context.setPrepareHook(async (ticket) => {
        await Effect.runPromise(Deferred.succeed(entered, ticket));
        await Effect.runPromise(Deferred.await(release));
      });
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      const fiber = yield* context.service.viewerTicket(tuple).pipe(Effect.forkScoped);
      const ticket = yield* Deferred.await(entered);
      assert.equal(context.preparedTickets.has(ticket), true);
      yield* Fiber.interrupt(fiber);
      assert.deepEqual(context.discardedTickets, [ticket]);
      assert.equal(context.preparedTickets.size, 0);
      assert.equal(
        (yield* Effect.exit(context.service.readViewerTicket(tuple, ticket)))._tag,
        "Failure",
      );
      yield* Deferred.succeed(release, undefined);
      assert.equal(context.unexpectedMethods(), 0);
    }),
  );
  it.effect(
    "retains three backend work slots through cancellation and releases only exact preparations",
    () =>
      Effect.gen(function* () {
        const context = yield* fixture;
        const tuple = yield* ownedVisualization(context);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let entries = 0;
        context.setPrepareHook(async () => {
          if (++entries === 3) await Effect.runPromise(Deferred.succeed(entered, undefined));
          await Effect.runPromise(Deferred.await(release));
        });
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        const fibers = [];
        for (let index = 0; index < 3; index++)
          fibers.push(yield* context.service.viewerTicket(tuple).pipe(Effect.forkScoped));
        yield* Deferred.await(entered);
        const prepared = [...context.preparedTickets].toSorted();
        assert.equal(prepared.length, 3);
        assert.equal((yield* Effect.exit(context.service.viewerTicket(tuple)))._tag, "Failure");
        assert.equal(context.preparations(), 3);
        for (const fiber of fibers) yield* Fiber.interrupt(fiber);
        assert.deepEqual(context.discardedTickets.toSorted(), prepared);
        assert.equal(context.preparedTickets.size, 0);
        yield* Deferred.succeed(release, undefined);
        context.setPrepareHook(noPrepareHook);
        const next = yield* context.service.viewerTicket(tuple);
        assert.equal(context.preparations(), 4);
        assert.equal(
          (yield* context.service.discardViewerTicket({ ...tuple, ticket: next.ticket })).discarded,
          true,
        );
        assert.equal(context.unexpectedMethods(), 0);
        assert.equal(context.prepareFailures(), 0);
      }),
  );
  it.effect(
    "deduplicates bytes but mints one proof per native invocation and denies forged completions",
    () =>
      Effect.gen(function* () {
        const { service, binding, input, witness, captures, lastPreviewPayload } = yield* fixture;
        const first = yield* service.publish(binding.authority, input);
        assert.equal(Object.hasOwn(lastPreviewPayload() as object, "previewReplay"), false);
        const second = yield* service.publish(binding.authority, input);
        assert.deepEqual(first.reference, second.reference);
        assert.notEqual(first.proof, second.proof);
        assert.equal(captures(), 1);
        assert.equal((yield* service.list({ threadId: witness.threadId })).entries.length, 0);
        for (const forged of [
          { ...witness, inputSha256: "0".repeat(64) },
          { ...witness, serverName: "foreign-server" },
          { ...witness, providerInstanceId: ProviderInstanceId.make("foreign_account") },
          { ...witness, threadId: ThreadId.make("foreign-chat") },
        ])
          assert.equal(
            yield* Effect.promise(() => binding.claimNativeCompletion(forged, first.proof)),
            undefined,
          );
        assert.equal(
          yield* Effect.promise(() => binding.claimNativeCompletion(witness, "0".repeat(64))),
          undefined,
        );
        const admitted = yield* Effect.promise(() =>
          binding.claimNativeCompletion(witness, first.proof),
        );
        assert.ok(admitted);
        const list = yield* service.list({ threadId: witness.threadId });
        assert.equal(list.entries.length, 1);
        assert.equal(JSON.stringify(list).includes("private-source-marker"), false);
        assert.equal(JSON.stringify(list).includes(first.proof), false);
        assert.equal(JSON.stringify(list).includes(witness.nativeItemId), false);
        assert.equal(
          yield* Effect.promise(() =>
            binding.claimNativeCompletion(
              { ...witness, nativeItemId: "different-native-call" },
              first.proof,
            ),
          ),
          undefined,
        );
        assert.equal(
          (yield* Effect.promise(() => binding.claimNativeCompletion(witness, first.proof)))
            ?.reference.revisionId,
          first.reference.revisionId,
        );
      }),
  );
  it.effect(
    "returns private details only for the claimed exact tuple and refuses immutable replacement",
    () =>
      Effect.gen(function* () {
        const { sql, service, binding, input, witness } = yield* fixture;
        const receipt = yield* service.publish(binding.authority, input);
        const tuple = {
          threadId: witness.threadId,
          artifactId: receipt.reference.artifactId,
          revisionId: receipt.reference.revisionId,
        };
        assert.equal((yield* Effect.exit(service.details(tuple)))._tag, "Failure");
        yield* Effect.promise(() => binding.claimNativeCompletion(witness, receipt.proof));
        assert.equal((yield* service.details(tuple)).source.source, input.source);
        assert.equal((yield* service.details(tuple)).rawJson, JSON.stringify(input));
        assert.equal(
          (yield* Effect.exit(service.details({ ...tuple, threadId: ThreadId.make("other-chat") })))
            ._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.exit(
            sql`UPDATE visualization_artifacts SET source = 'replaced' WHERE revision_id = ${tuple.revisionId}`,
          ))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.exit(
            sql`UPDATE visualization_artifacts SET state='pending' WHERE revision_id=${tuple.revisionId}`,
          ))._tag,
          "Failure",
        );
        const ticket = yield* service.viewerTicket(tuple);
        assert.ok(/^[a-f0-9]{64}$/.test(ticket.ticket));
        const ledger = yield* service.readViewerTicket(tuple, ticket.ticket);
        assert.ok(ledger.expiresAtMs > ticket.expiresAtMs);
        assert.equal(
          (yield* Effect.exit(
            service.readViewerTicket(
              { ...tuple, threadId: ThreadId.make("other-chat") },
              ticket.ticket,
            ),
          ))._tag,
          "Failure",
        );
        const poster = yield* service.poster(tuple);
        assert.ok(poster.length > 33);
        const quota = (yield* sql<{
          bytes: number;
        }>`SELECT bytes FROM visualization_storage_quota WHERE singleton=1`)[0]!;
        const total = (yield* sql<{
          bytes: number;
        }>`SELECT (SELECT SUM(byte_length) FROM visualization_artifacts) + COALESCE((SELECT SUM(byte_length) FROM visualization_history),0) AS bytes`)[0]!;
        assert.equal(quota.bytes, total.bytes);
      }),
  );
  it.effect(
    "retains fork-owned bytes after parent deletion and reclaims only after the last canonical reference",
    () =>
      Effect.gen(function* () {
        const { sql, service, binding, input, witness } = yield* fixture;
        const receipt = yield* service.publish(binding.authority, input);
        yield* Effect.promise(() => binding.claimNativeCompletion(witness, receipt.proof));
        const child = ThreadId.make(`fork-${randomUUID()}`);
        const prefix = `copy:${child}:`;
        yield* sql`INSERT INTO projection_turns(thread_id,turn_id,state,requested_at,checkpoint_turn_count,checkpoint_files_json) VALUES(${child},${prefix + witness.turnId},'completed',${witness.occurredAt},1,'[]')`;
        yield* sql.withTransaction(
          copyVisualizationHistory(sql, {
            sourceThreadId: witness.threadId,
            targetThreadId: child,
            completeTurnsOnly: true,
          }),
        );
        assert.equal((yield* service.list({ threadId: child })).entries.length, 1);
        yield* sql`INSERT INTO hard_deleted_threads(thread_id,deleted_at) VALUES(${witness.threadId},${new Date().toISOString()})`;
        assert.equal(
          (yield* Effect.exit(service.list({ threadId: witness.threadId })))._tag,
          "Failure",
        );
        const tuple = {
          threadId: child,
          artifactId: receipt.reference.artifactId,
          revisionId: receipt.reference.revisionId,
        };
        assert.equal((yield* service.details(tuple)).source.source, input.source);
        yield* service.sweep;
        assert.equal((yield* service.details(tuple)).source.source, input.source);
        yield* sql`DELETE FROM projection_turns WHERE thread_id=${child}`;
        yield* sql.withTransaction(reconcileVisualizationHistory(sql, child));
        yield* sql`INSERT INTO hard_deleted_threads(thread_id,deleted_at) VALUES(${child},${new Date().toISOString()})`;
        // Producer deletion already removed invocation authority; only the last
        // immutable fork reference prevented the previous bounded reclamation.
        yield* service.sweep;
        assert.equal(
          (yield* sql`SELECT 1 FROM visualization_artifacts WHERE revision_id=${tuple.revisionId}`)
            .length,
          0,
        );
      }),
  );
  it.effect("preserves exact Unicode input commitments and rejects excess selectors", () =>
    Effect.gen(function* () {
      const { service, binding, input } = yield* fixture;
      assert.notEqual(
        computeGeneratedVisualizationInputSha256(input),
        computeGeneratedVisualizationInputSha256({ ...input, source: input.source + " " }),
      );
      assert.equal(
        computeGeneratedVisualizationInputSha256({ ...input, threadId: "chosen-by-model" }),
        undefined,
      );
      assert.equal(
        (yield* Effect.exit(service.publish(binding.authority, { ...input, source: "\ud800" })))
          ._tag,
        "Failure",
      );
      // Internal native-owner operations need fresh generation authority even
      // when an immutable historical snapshot remains readable by its owner.
      yield* service.requireActiveSession(binding.authority);
      assert.equal(
        (yield* Effect.exit(
          service.requireActiveSession({
            ...binding.authority,
            sessionGeneration: VisualizationGenerationId.make(randomUUID()),
          }),
        ))._tag,
        "Failure",
      );
      yield* Effect.promise(binding.dispose);
      assert.equal(
        (yield* Effect.exit(service.requireActiveSession(binding.authority)))._tag,
        "Failure",
      );
      assert.equal((yield* Effect.exit(service.publish(binding.authority, input)))._tag, "Failure");
    }),
  );
  it.effect("retains fixed failure diagnostics without admitting pending private source", () =>
    Effect.gen(function* () {
      const { sql, service, binding, input, witness, setCaptureFailure } = yield* fixture;
      setCaptureFailure(true);
      assert.equal((yield* Effect.exit(service.publish(binding.authority, input)))._tag, "Failure");
      const debug = yield* service.debug(witness.threadId);
      assert.deepEqual(debug, {
        pendingCount: 1,
        failedCaptureCount: 1,
        readyCount: 0,
        reason: "capture-unavailable",
      });
      assert.equal(JSON.stringify(debug).includes("private-source-marker"), false);
      assert.equal((yield* service.list({ threadId: witness.threadId })).entries.length, 0);
      assert.equal(
        (yield* sql`SELECT 1 FROM visualization_invocations WHERE thread_id=${witness.threadId}`)
          .length,
        0,
      );
      const pending = (yield* sql<{
        artifactId: string;
        revisionId: string;
      }>`SELECT artifact_id AS "artifactId",revision_id AS "revisionId" FROM visualization_artifacts WHERE thread_id=${witness.threadId}`)[0]!;
      assert.equal(
        (yield* Effect.exit(
          service.details({
            threadId: witness.threadId,
            artifactId: pending.artifactId as never,
            revisionId: pending.revisionId as never,
          }),
        ))._tag,
        "Failure",
      );
    }),
  );
  it.effect(
    "refuses publication if its exact generation retires while native capture is in flight",
    () =>
      Effect.gen(function* () {
        const { sql, service, binding, input, witness, setCaptureHook } = yield* fixture;
        setCaptureHook(binding.dispose);
        assert.equal(
          (yield* Effect.exit(service.publish(binding.authority, input)))._tag,
          "Failure",
        );
        assert.equal((yield* service.list({ threadId: witness.threadId })).entries.length, 0);
        assert.equal(
          (yield* sql`SELECT 1 FROM visualization_invocations WHERE thread_id=${witness.threadId}`)
            .length,
          0,
        );
        assert.equal(
          (yield* sql`SELECT 1 FROM visualization_artifacts WHERE thread_id=${witness.threadId} AND state='ready'`)
            .length,
          0,
        );
      }),
  );
  it.effect(
    "snapshots only exact owned raster commitments and refuses altered or foreign originals",
    () =>
      Effect.gen(function* () {
        const { sql, service, binding, input, witness, config } = yield* fixture;
        const id = createAttachmentId(witness.threadId)!;
        const original = png(8, 8);
        const filename = path.join(config.attachmentsDir, `${id}.png`);
        yield* Effect.promise(() => fs.writeFile(filename, original, { mode: 0o600 }));
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.unlink(filename)));
        yield* sql`INSERT INTO attachment_content_commitments(attachment_id,thread_id,content_sha256,size_bytes) VALUES(${id},${witness.threadId},${createHash("sha256").update(original).digest("hex")},${original.length})`;
        const withAsset = {
          ...input,
          requestId: randomUUID(),
          source: '<img src="asset/chart">',
          assets: [{ assetId: "chart", attachmentId: id }],
        };
        const receipt = yield* service.publish(binding.authority, withAsset);
        yield* Effect.promise(() =>
          binding.claimNativeCompletion(
            {
              ...witness,
              nativeItemId: "asset-call",
              inputSha256: computeGeneratedVisualizationInputSha256(withAsset)!,
            },
            receipt.proof,
          ),
        );
        const tuple = {
          threadId: witness.threadId,
          artifactId: receipt.reference.artifactId,
          revisionId: receipt.reference.revisionId,
        };
        assert.ok(
          (yield* service.exportHtml(tuple)).html.startsWith('<img src="data:image/png;base64,'),
        );
        yield* Effect.promise(() =>
          fs.writeFile(filename, Buffer.alloc(original.length, 1), { mode: 0o600 }),
        );
        assert.equal(
          (yield* Effect.exit(
            service.publish(binding.authority, { ...withAsset, requestId: randomUUID() }),
          ))._tag,
          "Failure",
        );
        assert.ok((yield* service.exportHtml(tuple)).html.includes(original.toString("base64")));
        const foreign = createAttachmentId("foreign-chat")!;
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at) VALUES('foreign-chat',NULL,'Isolated foreign attachment fixture',${witness.occurredAt},${witness.occurredAt})`;
        yield* sql`INSERT INTO attachment_content_commitments(attachment_id,thread_id,content_sha256,size_bytes) VALUES(${foreign},'foreign-chat',${"0".repeat(64)},16)`;
        assert.equal(
          (yield* Effect.exit(
            service.publish(binding.authority, {
              ...withAsset,
              requestId: randomUUID(),
              assets: [{ assetId: "chart", attachmentId: foreign }],
            }),
          ))._tag,
          "Failure",
        );
      }),
  );
  it.effect(
    "derives a licensed fluid export without rewriting authenticated immutable source",
    () =>
      Effect.gen(function* () {
        const { sql, service, binding, input, witness } = yield* fixture;
        const authored = {
          ...input,
          requestId: randomUUID(),
          source:
            '<section style="position:relative"><canvas data-cafe-fluid aria-hidden="true"></canvas><p>Exact colorful chart unit</p></section>',
        };
        const receipt = yield* service.publish(binding.authority, authored);
        yield* Effect.promise(() =>
          binding.claimNativeCompletion(
            {
              ...witness,
              nativeItemId: "fluid-export-call",
              inputSha256: computeGeneratedVisualizationInputSha256(authored)!,
            },
            receipt.proof,
          ),
        );
        const tuple = {
          threadId: witness.threadId,
          artifactId: receipt.reference.artifactId,
          revisionId: receipt.reference.revisionId,
        };
        const before =
          yield* sql`SELECT source,input_sha256,content_sha256,manifest_sha256,assets_json,reference_json,private_json,diagnostics_json,byte_length FROM visualization_artifacts WHERE revision_id=${tuple.revisionId}`;
        const exported = yield* service.exportHtml(tuple);
        assert.deepEqual(exported, {
          ...tuple,
          html: exportGeneratedVisualizationHtml(authored.source, []),
        });
        assert.ok(exported.html.endsWith(visualizationFluidScript("generated")));
        assert.ok(exported.html.includes("Copyright (c) Pavel Dobryakov"));
        assert.ok(exported.html.includes(VISUALIZATION_FONT_LICENSE));
        assert.ok(exported.html.includes(GENERATED_VISUALIZATION_FONT_APPENDIX));
        assert.equal(exported.html.match(/@font-face\{/g)?.length, 4);
        assert.equal((yield* service.details(tuple)).source.source, authored.source);
        assert.deepEqual(
          yield* sql`SELECT source,input_sha256,content_sha256,manifest_sha256,assets_json,reference_json,private_json,diagnostics_json,byte_length FROM visualization_artifacts WHERE revision_id=${tuple.revisionId}`,
          before,
        );
        assert.equal(
          (yield* Effect.exit(
            service.exportHtml({ ...tuple, threadId: ThreadId.make("stranger") }),
          ))._tag,
          "Failure",
        );
      }),
  );
  it.effect("retains bounded explicit history pages beyond the activity tail", () =>
    Effect.gen(function* () {
      const { sql, service, binding, input, witness } = yield* fixture;
      const receipt = yield* service.publish(binding.authority, input);
      yield* Effect.promise(() => binding.claimNativeCompletion(witness, receipt.proof));
      // This database fixture qualifies history pagination, not native receipts.
      yield* sql`WITH RECURSIVE sequence(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM sequence WHERE value<510)
      INSERT INTO visualization_history(id,thread_id,turn_id,message_id,origin_item_id,occurred_at,actor_json,reference_json,revision_id,native_call_key,byte_length)
      SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(2)))||'-'||lower(hex(randomblob(6))),${witness.threadId},${witness.turnId},${witness.messageId},'synthetic-history-'||value,${witness.occurredAt},'{"type":"root"}',${JSON.stringify(receipt.reference)},${receipt.reference.revisionId},'synthetic-window-'||value,4096 FROM sequence`;
      let cursor: string | undefined;
      const origins = new Set<string>();
      do {
        const page = yield* service.list({
          threadId: witness.threadId,
          ...(cursor ? { cursor } : {}),
        });
        assert.ok(page.entries.length <= 50);
        for (const entry of page.entries) origins.add(entry.originItemId);
        cursor = page.nextCursor;
      } while (cursor);
      assert.equal(origins.size, 511);
      assert.equal(
        (yield* Effect.exit(service.list({ threadId: witness.threadId, cursor: randomUUID() })))
          ._tag,
        "Failure",
      );
    }),
  );
  it.effect(
    "stores native App ownership privately without giving forks or strangers action authority",
    () =>
      Effect.gen(function* () {
        const { service, binding, input, witness, lastPreviewPayload, lastViewerPayload } =
          yield* fixture;
        const appInput = {
          source: input.source,
          title: input.title,
          originalInputJson: '{"private":"input"}',
          originalResultJson: '{"private":"result"}',
          serverName: "fixture-external-app",
          originCallId: "native-app-call",
          resourceUri: "ui://fixture/exact.html",
          resourceMetaJson: '{"ui":true}',
        };
        const appWitness = {
          ...witness,
          nativeItemId: appInput.originCallId,
          serverName: appInput.serverName,
          toolName: "fixture_chart",
        };
        const entry = yield* service.publishMcpApp(binding.authority, appInput, appWitness);
        assert.deepEqual((lastPreviewPayload() as { previewReplay: unknown }).previewReplay, {
          originalInputJson: appInput.originalInputJson,
          originalResultJson: appInput.originalResultJson,
        });
        assert.equal(entry.reference.purpose, "mcp-app");
        assert.equal(
          JSON.stringify(yield* service.list({ threadId: witness.threadId })).includes(
            'fixture-external-app"',
          ),
          true,
        );
        const tuple = {
          threadId: witness.threadId,
          artifactId: entry.reference.artifactId,
          revisionId: entry.reference.revisionId,
        };
        const row = yield* service.readMcpAppSnapshot(tuple);
        assert.deepEqual(JSON.parse(row.privateJson), { input: appInput, witness: appWitness });
        yield* service.viewerTicket(tuple);
        // Replay belongs only to automatic private poster capture. Opening a
        // viewer still needs its separately authenticated live protocol broker.
        assert.equal(Object.hasOwn(lastViewerPayload() as object, "previewReplay"), false);
        assert.equal(
          (yield* Effect.exit(
            service.readMcpAppSnapshot({ ...tuple, threadId: ThreadId.make("stranger") }),
          ))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.exit(
            service.publishMcpApp(binding.authority, appInput, {
              ...appWitness,
              providerInstanceId: ProviderInstanceId.make("foreign_account"),
            }),
          ))._tag,
          "Failure",
        );
        assert.equal((yield* Effect.exit(service.exportHtml(tuple)))._tag, "Failure");
      }),
  );
  it.effect(
    "admits an exact MCP wire publication into durable history and retains private failures",
    () =>
      Effect.gen(function* () {
        const { sql, service, binding, input, witness } = yield* fixture;
        const server = new McpServer({ name: "isolated-visualization-fixture", version: "1" });
        registerVisualizationTools(server, service, binding.authority);
        const client = new Client({ name: "isolated-owner-fixture", version: "1" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        yield* Effect.promise(() => server.connect(serverTransport));
        yield* Effect.addFinalizer(() => Effect.promise(() => server.close()));
        yield* Effect.promise(() => client.connect(clientTransport));
        yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
        const tools = yield* Effect.promise(() => client.listTools());
        assert.deepEqual(tools.tools.map((tool) => tool.name).toSorted(), [
          "preview_visualization",
          "publish_visualization",
        ]);
        // Discovery must carry the same authoring and privacy guidance as the
        // supported provider instruction channels, without a divergent copy.
        assert.deepEqual(
          tools.tools.map((tool) => tool.description),
          [GENERATED_VISUALIZATION_INSTRUCTIONS, GENERATED_VISUALIZATION_INSTRUCTIONS],
        );
        // The supplied solver is a fixed generated-document helper, not engine
        // source duplicated in provider context or a new external-App ability.
        assert.ok(
          GENERATED_VISUALIZATION_INSTRUCTIONS.includes(
            '<canvas data-cafe-fluid aria-hidden="true"></canvas>',
          ),
        );
        assert.ok(
          GENERATED_VISUALIZATION_INSTRUCTIONS.includes("at most one canvas[data-cafe-fluid]"),
        );
        assert.ok(
          GENERATED_VISUALIZATION_INSTRUCTIONS.includes(
            "the canvas marker never supplies the helper to an external MCP App",
          ),
        );
        assert.equal(GENERATED_VISUALIZATION_INSTRUCTIONS.includes("512x512"), false);
        assert.ok(GENERATED_VISUALIZATION_INSTRUCTIONS.includes("no more than 30fps"));
        assert.ok(GENERATED_VISUALIZATION_INSTRUCTIONS.includes("display-only 2.0 color gain"));
        assert.ok(
          GENERATED_VISUALIZATION_INSTRUCTIONS.includes("canvas opacity between 0.8 and 1.0"),
        );
        assert.ok(GENERATED_VISUALIZATION_INSTRUCTIONS.includes("local veil using 60–70%"));
        assert.ok(
          GENERATED_VISUALIZATION_INSTRUCTIONS.includes(
            "existing received source is not rewritten",
          ),
        );
        assert.ok(
          GENERATED_VISUALIZATION_INSTRUCTIONS.includes(
            "without a five-minute or cumulative frame cutoff",
          ),
        );
        assert.ok(
          GENERATED_VISUALIZATION_INSTRUCTIONS.includes(
            "Play the entrance once per document, not again on scrolling",
          ),
        );
        assert.ok(
          GENERATED_VISUALIZATION_INSTRUCTIONS.includes("role=tooltip or data-cafe-tooltip"),
        );
        assert.ok(
          GENERATED_VISUALIZATION_INSTRUCTIONS.includes(
            "do not hard-code a white tooltip surface in dark mode",
          ),
        );
        assert.ok(
          GENERATED_VISUALIZATION_INSTRUCTIONS.includes("never require horizontal scrolling"),
        );
        assert.ok(GENERATED_VISUALIZATION_INSTRUCTIONS.includes("natural normal-flow unit height"));
        assert.ok(GENERATED_VISUALIZATION_INSTRUCTIONS.includes("preserveAspectRatio=none"));
        assert.ok(GENERATED_VISUALIZATION_INSTRUCTIONS.includes("same actual offline chat font"));
        assert.ok(
          GENERATED_VISUALIZATION_INSTRUCTIONS.includes(
            "DM Sans Variable (normal/italic Latin and Latin-extended)",
          ),
        );
        assert.ok(
          GENERATED_VISUALIZATION_INSTRUCTIONS.includes(
            "reserve --font-mono and monospace for semantic pre/code/kbd/samp or raw/code details only",
          ),
        );
        assert.ok(GENERATED_VISUALIZATION_INSTRUCTIONS.includes("await document.fonts.ready"));
        assert.ok(
          GENERATED_VISUALIZATION_INSTRUCTIONS.includes(
            "actual four fixed binary faces before parsing source",
          ),
        );
        assert.equal(
          GENERATED_VISUALIZATION_INSTRUCTIONS.includes("Use compact system-ui text"),
          false,
        );
        const preview = yield* Effect.promise(() =>
          client.callTool({ name: "preview_visualization", arguments: input }),
        );
        assert.notEqual(preview.isError, true);
        assert.equal(JSON.stringify(preview).includes("private-source-marker"), false);
        const published = yield* Effect.promise(() =>
          client.callTool({ name: "publish_visualization", arguments: input }),
        );
        assert.notEqual(published.isError, true);
        const structured = published.structuredContent as {
          visualizationReceipt: { proof: string; reference: GeneratedVisualizationReference };
        };
        assert.ok(/^[a-f0-9]{64}$/.test(structured.visualizationReceipt.proof));
        assert.equal((yield* service.list({ threadId: witness.threadId })).entries.length, 0);
        // Use the actual SDK return, not a separately manufactured receipt or a
        // spy claim. This crosses the native observer and activated session's
        // transactional SQL admission before the authenticated durable list.
        const completedItem = {
          type: "mcpToolCall",
          id: witness.nativeItemId,
          server: binding.name,
          tool: "publish_visualization",
          arguments: input,
          status: "completed",
          error: null,
          result: {
            content: published.content,
            structuredContent: published.structuredContent,
          },
        };
        yield* Effect.promise(() => claimVisualizationNativeItem(binding, completedItem, witness));
        const admitted = yield* service.list({ threadId: witness.threadId });
        assert.equal(admitted.entries.length, 1);
        const entry = admitted.entries[0]!;
        assert.deepEqual(entry.reference, structured.visualizationReceipt.reference);
        assert.equal(entry.messageId, witness.messageId);
        assert.equal(entry.turnId, witness.turnId);
        assert.equal(entry.occurredAt, witness.occurredAt);
        assert.deepEqual(entry.actor, witness.actor);
        assert.equal(JSON.stringify(admitted).includes("private-source-marker"), false);
        assert.equal(
          JSON.stringify(admitted).includes(structured.visualizationReceipt.proof),
          false,
        );
        assert.equal(JSON.stringify(admitted).includes(witness.nativeItemId), false);
        yield* Effect.promise(() => claimVisualizationNativeItem(binding, completedItem, witness));
        assert.deepEqual(yield* service.list({ threadId: witness.threadId }), admitted);
        // The second envelope has a matching item/witness identity, so its
        // refusal exercises the persisted proof-to-native-call fence rather
        // than merely failing the observer's item-ID comparison.
        const copiedItemId = "different-native-wire-item";
        yield* Effect.promise(() =>
          claimVisualizationNativeItem(
            binding,
            { ...completedItem, id: copiedItemId },
            { ...witness, nativeItemId: copiedItemId },
          ),
        );
        assert.deepEqual(yield* service.list({ threadId: witness.threadId }), admitted);
        const history = yield* sql<{ count: number }>`SELECT COUNT(*) AS count
          FROM visualization_history WHERE thread_id = ${witness.threadId}`;
        assert.equal(history[0]?.count, 1);
        // Actual UTF-8 byte admission is independent of a permissive code-unit cap
        // in the JSON schema advertised to the native client.
        const overflow = yield* Effect.promise(() =>
          client.callTool({
            name: "publish_visualization",
            arguments: { ...input, requestId: randomUUID(), source: "🌸".repeat(131073) },
          }),
        );
        assert.equal(overflow.isError, true);
        assert.equal(JSON.stringify(overflow).includes("🌸"), false);
        const selector = yield* Effect.promise(() =>
          client.callTool({
            name: "publish_visualization",
            arguments: { ...input, threadId: "chosen-chat" },
          }),
        );
        assert.equal(selector.isError, true);
        yield* Effect.promise(binding.dispose);
        const revoked = yield* Effect.promise(() =>
          client.callTool({ name: "publish_visualization", arguments: input }),
        );
        assert.equal(revoked.isError, true);
        assert.equal(JSON.stringify(revoked).includes("private-source-marker"), false);
      }),
  );
});
