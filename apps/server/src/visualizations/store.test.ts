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
import { VisualizationGenerationId } from "@cafecode/contracts/visualizations";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as Effect from "effect/Effect";
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
import { registerVisualizationTools } from "./mcp.ts";

function pngChunk(name: string, data: Buffer) {
  const type = Buffer.from(name);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([header, type, data, checksum]);
}
const noCaptureHook = async () => undefined;
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
        response.end(
          JSON.stringify({
            status: "ready",
            ticket: input.payload.ticket,
            expiresAtMs: Date.now() + 60000,
          }),
        );
      } else {
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

it.layer(services)("immutable private visualization store", (it) => {
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
    "serves only the two dedicated tools over the real MCP wire with fixed private failures",
    () =>
      Effect.gen(function* () {
        const { service, binding, input, witness } = yield* fixture;
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
          visualizationReceipt: { proof: string; reference: { revisionId: string } };
        };
        assert.ok(/^[a-f0-9]{64}$/.test(structured.visualizationReceipt.proof));
        assert.equal((yield* service.list({ threadId: witness.threadId })).entries.length, 0);
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
