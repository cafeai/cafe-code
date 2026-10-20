// @effect-diagnostics nodeBuiltinImport:off
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import {
  GeneratedVisualizationNativeWitness,
  VisualizationApiError,
  VisualizationDetailsResult,
  VisualizationInlineResult,
  VisualizationInlineFrameInput,
  VisualizationTimelineEntry,
  VISUALIZATION_LIST_PAGE_SIZE,
  type VisualizationDetailsInput,
  type VisualizationListInput,
  type VisualizationListResult,
  type VisualizationInlineInput,
  type VisualizationInlineFrameInput as InlineFrameInput,
  type VisualizationDiscardViewerTicketInput,
} from "@cafecode/contracts/visualizationApi";
import {
  VisualizationReference,
  type McpAppPrepareInput,
  type VisualizationReference as Reference,
} from "@cafecode/contracts/mcpApps";
import {
  GeneratedVisualizationInput,
  GeneratedVisualizationSourceText,
  VisualizationArtifactId,
  VisualizationRevisionId,
  VISUALIZATION_MAX_INPUT_JSON_BYTES,
} from "@cafecode/contracts/visualizations";
import { PngBytesSchema } from "@cafecode/contracts";
import { VisualizationHostAsset } from "@cafecode/contracts/visualizationHost";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import {
  requireVisualizationSessionAuthority,
  requireVisualizationFullAccess,
  type VisualizationSessionAuthority,
} from "./sessionRuntime.ts";
import {
  createInlineGeneratedVisualizationHtml,
  embedStaticVisualizationAssets,
  exportGeneratedVisualizationHtml,
} from "./offlineHtml.ts";
import { rasterDimensions } from "@cafecode/shared/visualizationRasterPolicy";

export const VISUALIZATION_STORE_MAX_BYTES = 256 * 1024 * 1024;
export const VISUALIZATION_THREAD_MAX_BYTES = 64 * 1024 * 1024;
export const VISUALIZATION_INVOCATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const decodeInput = Schema.decodeUnknownResult(GeneratedVisualizationInput);
const decodeReference = Schema.decodeUnknownResult(VisualizationReference);
const decodeDetails = Schema.decodeUnknownResult(VisualizationDetailsResult);
const decodeInline = Schema.decodeUnknownResult(VisualizationInlineResult);
const decodeInlineFrameInput = Schema.decodeUnknownResult(VisualizationInlineFrameInput);
const decodeAssets = Schema.decodeUnknownResult(
  Schema.Array(VisualizationHostAsset).check(Schema.isMaxLength(16)),
);
const decodeWitness = Schema.decodeUnknownResult(GeneratedVisualizationNativeWitness);
const decodeAppWitness = Schema.decodeUnknownResult(
  Schema.Struct({
    ...GeneratedVisualizationNativeWitness.fields,
    toolName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }).annotate({ parseOptions: { onExcessProperty: "error" as const } }),
);
const decodeEntry = Schema.decodeUnknownResult(VisualizationTimelineEntry);
const validSource = Schema.is(GeneratedVisualizationSourceText);
const validPng = Schema.is(PngBytesSchema);
const sha = (domain: string, value: string | Uint8Array) =>
  createHash("sha256").update(domain).update("\0").update(value).digest("hex");
const proofDigest = (proof: string) => sha("cafe-visual-invocation-v1", proof);
const failure = () =>
  new VisualizationApiError({
    message: "Visualization could not be completed. Inspect its work-log entry.",
  });
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
/** JSON encoding is part of the immutable private commitment. Keep the codec's
 * standard JSON byte order/escaping, but never retain received private input in
 * a schema encoding exception that can reach operational diagnostics. */
const encodePrivateJson = (value: unknown): string => {
  try {
    return encodeJson(value);
  } catch {
    throw failure();
  }
};
const bytes = (value: string) => Buffer.byteLength(value, "utf8");
/** Corrupt private storage must not turn JSON parser messages into diagnostic
 * payloads containing source. Only a fixed classification crosses this fence. */
const parsePrivateJson = (value: string): unknown => {
  try {
    return decodeJson(value);
  } catch {
    throw failure();
  }
};
const publicActor = (actor: GeneratedVisualizationNativeWitness["actor"]) =>
  actor.type === "root"
    ? actor
    : {
        type: "child" as const,
        id: `agent-${sha("cafe-visual-child-v1", actor.id)}`,
        ...(actor.label ? { label: actor.label } : {}),
      };
const contentDigest = (
  source: string,
  assetsJson: string,
  referenceJson: string,
  diagnosticsJson: string,
  privateJson: string,
  posterSha256: string | null,
) =>
  sha(
    "cafe-visual-private-content-v1",
    encodePrivateJson([
      source,
      assetsJson,
      referenceJson,
      diagnosticsJson,
      privateJson,
      posterSha256,
    ]),
  );
const parseReference = (text: string): Reference => {
  if (bytes(text) > 8192) throw failure();
  const value = decodeReference(parsePrivateJson(text));
  if (Result.isFailure(value)) throw failure();
  return value.success;
};

/** Canonical field order and exact source bytes are shared with native receipt
 * correlation. A rejected schema never contributes an input or formatter issue. */
export function computeGeneratedVisualizationInputSha256(input: unknown): string | undefined {
  const admitted = decodeInput(input);
  if (Result.isFailure(admitted)) return undefined;
  const value = admitted.success;
  return sha(
    "cafe-visual-input-v1",
    encodePrivateJson({
      version: value.version,
      purpose: value.purpose,
      requestId: value.requestId,
      source: value.source,
      title: value.title,
      assets: value.assets.map((asset) => ({
        assetId: asset.assetId,
        attachmentId: asset.attachmentId,
      })),
      appearance: value.appearance,
      ...(value.viewport
        ? { viewport: { width: value.viewport.width, height: value.viewport.height } }
        : {}),
    }),
  );
}

/** Internal private store snapshot; never an RPC result or ordinary event. */
export interface ArtifactRow {
  revisionId: string;
  artifactId: string;
  kind: "generated-visualization" | "mcp-app";
  source: string;
  assetsJson: string;
  referenceJson: string;
  diagnosticsJson: string;
  privateJson: string;
  poster: Uint8Array | null;
  posterSha256: string | null;
  manifestSha256: string;
  inputSha256: string;
  contentSha256: string;
  state: "pending" | "ready" | "retired";
}
// Persisted raster shape is shared with legacy immutable history, but it is
// data only: no current service imports or executes the retired native host.
type StoredVisualizationAssets = readonly (typeof VisualizationHostAsset.Type)[];
export interface McpAppPublicationInput {
  readonly source: string;
  readonly title: string;
  readonly originalInputJson: string;
  readonly originalResultJson: string;
  readonly serverName: string;
  readonly originCallId: string;
  readonly resourceUri: string;
  readonly resourceMetaJson: string;
}
/** Only an authenticated native adapter calls this internal method. Shape
 * validation deliberately does not confer the native observer's authority. */
export type McpAppNativeWitness = Omit<GeneratedVisualizationNativeWitness, "toolName"> & {
  readonly toolName: string;
};

function admittedPoster(png: Uint8Array, width: number, height: number) {
  const data = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  return (
    validPng(png) &&
    png.length <= 8 * 1024 * 1024 &&
    png.length >= 33 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    data.readUInt32BE(8) === 13 &&
    data.toString("ascii", 12, 16) === "IHDR" &&
    data.readUInt32BE(16) === width &&
    data.readUInt32BE(20) === height
  );
}

/** Private asset snapshot: ownership/commitment is admitted before opening, a
 * bounded held descriptor defeats growth/replacement, and identity is rechecked
 * afterward. MIME/magic alone never authorizes an ambient path or another chat. */
async function readOwnedRaster(path: string, expectedSize: number, expectedSha: string) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_ASSET_BYTES)
    throw failure();
  const root = await fs.lstat(dirname(path), { bigint: true });
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (root.uid !== BigInt(process.getuid!()) || (root.mode & 0o022n) !== 0n))
  )
    throw failure();
  const before = await fs.lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size !== BigInt(expectedSize) ||
    (process.platform !== "win32" &&
      (before.uid !== BigInt(process.getuid!()) || (before.mode & 0o077n) !== 0n))
  )
    throw failure();
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = await handle.stat({ bigint: true });
    if (
      held.dev !== before.dev ||
      held.ino !== before.ino ||
      held.size !== before.size ||
      !held.isFile()
    )
      throw failure();
    const output = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < output.length) {
      const read = await handle.read(output, offset, output.length - offset, offset);
      if (read.bytesRead === 0) throw failure();
      offset += read.bytesRead;
    }
    const after = await fs.lstat(path, { bigint: true });
    const parent = await fs.lstat(dirname(path), { bigint: true });
    if (
      after.dev !== held.dev ||
      after.ino !== held.ino ||
      !after.isFile() ||
      after.nlink !== 1n ||
      after.size !== BigInt(expectedSize) ||
      after.isSymbolicLink() ||
      parent.dev !== root.dev ||
      parent.ino !== root.ino ||
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (after.uid !== root.uid ||
          (after.mode & 0o077n) !== 0n ||
          parent.uid !== root.uid ||
          (parent.mode & 0o022n) !== 0n))
    )
      throw failure();
    const actual = createHash("sha256").update(output).digest("hex");
    if (
      !/^[a-f0-9]{64}$/.test(expectedSha) ||
      !timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expectedSha, "hex"))
    )
      throw failure();
    const mime =
      output.length >= 24 &&
      output.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : output.length >= 3 && output[0] === 255 && output[1] === 216 && output[2] === 255
          ? "image/jpeg"
          : output.length >= 12 &&
              output.toString("ascii", 0, 4) === "RIFF" &&
              output.toString("ascii", 8, 12) === "WEBP"
            ? "image/webp"
            : undefined;
    if (!mime) throw failure();
    const dimensions = rasterDimensions(output, mime);
    if (!dimensions) throw failure();
    // Header/pixel admission remains before browser decode. This inert snapshot
    // does not claim a deep native decode or metadata stripping; exact original
    // bytes and ownership stay bound through the held descriptor/hash checks.
    return {
      mime,
      base64: output.toString("base64"),
      size: output.length,
      pixels: dimensions.width * dimensions.height,
    } as const;
  } finally {
    await handle.close();
  }
}

/** A native observer can claim only this exact invocation and canonical input.
 * Tokens/proofs/native IDs never enter the resulting compact history row. */
export const claimVisualizationCompletion = (
  sql: SqlClient.SqlClient,
  authority: VisualizationSessionAuthority,
  witness: GeneratedVisualizationNativeWitness,
  proof: string,
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const admitted = decodeWitness(witness);
      if (
        Result.isFailure(admitted) ||
        !/^[a-f0-9]{64}$/.test(proof) ||
        witness.threadId !== authority.threadId ||
        witness.providerInstanceId !== authority.providerInstanceId ||
        witness.sessionGeneration !== authority.sessionGeneration ||
        witness.serverName !== authority.serverName ||
        witness.toolName !== "publish_visualization"
      )
        return undefined;
      yield* requireVisualizationSessionAuthority(sql, authority);
      const calls = yield* sql<{
        invocationId: string;
        revisionId: string;
        nativeCallKey: string | null;
      }>`SELECT invocation_id AS "invocationId", revision_id AS "revisionId", native_call_key AS "nativeCallKey"
    FROM visualization_invocations WHERE proof_digest = ${proofDigest(proof)} AND thread_id = ${authority.threadId}
      AND provider_instance_id = ${authority.providerInstanceId} AND session_generation = ${authority.sessionGeneration}
      AND runtime_generation = ${authority.runtimeGeneration} AND server_name = ${witness.serverName}
      AND tool_name = ${witness.toolName} AND input_sha256 = ${witness.inputSha256} AND expires_at >= ${DateTime.toEpochMillis(DateTime.nowUnsafe())}`;
      const call = calls[0];
      if (!call) return undefined;
      const key = sha(
        "cafe-visual-native-call-v1",
        encodePrivateJson([
          witness.provider,
          witness.providerInstanceId,
          witness.sessionGeneration,
          witness.nativeThreadId,
          witness.nativeTurnId,
          witness.nativeItemId,
          witness.serverName,
          witness.toolName,
          witness.actor,
        ]),
      );
      if (call.nativeCallKey !== null && call.nativeCallKey !== key) return undefined;
      const existing = yield* sql<{
        id: string;
        turnId: string;
        messageId: string;
        originItemId: string;
        occurredAt: string;
        actorJson: string;
        referenceJson: string;
      }>`SELECT id, turn_id AS "turnId", message_id AS "messageId", origin_item_id AS "originItemId", occurred_at AS "occurredAt", actor_json AS "actorJson", reference_json AS "referenceJson" FROM visualization_history WHERE thread_id = ${authority.threadId} AND native_call_key = ${key}`;
      if (existing[0]) {
        const row = existing[0];
        const decoded = decodeEntry({
          messageId: row.messageId,
          turnId: row.turnId,
          originItemId: row.originItemId,
          occurredAt: row.occurredAt,
          actor: parsePrivateJson(row.actorJson),
          reference: parseReference(row.referenceJson),
        });
        return Result.isSuccess(decoded) ? decoded.success : undefined;
      }
      const artifacts = yield* sql<{
        referenceJson: string;
      }>`SELECT reference_json AS "referenceJson" FROM visualization_artifacts WHERE revision_id = ${call.revisionId} AND state = 'ready'`;
      if (!artifacts[0]) return undefined;
      const entry: VisualizationTimelineEntry = {
        messageId: witness.messageId,
        turnId: witness.turnId,
        originItemId: `visual-${sha("cafe-visual-origin-v1", witness.nativeItemId)}`,
        occurredAt: witness.occurredAt,
        actor: publicActor(witness.actor),
        reference: parseReference(artifacts[0].referenceJson),
      };
      yield* sql`UPDATE visualization_invocations SET native_call_key = ${key} WHERE invocation_id = ${call.invocationId} AND native_call_key IS NULL`;
      yield* sql`INSERT INTO visualization_history(id,thread_id,turn_id,message_id,origin_item_id,occurred_at,actor_json,reference_json,revision_id,native_call_key,byte_length)
    VALUES(${randomUUID()},${authority.threadId},${entry.turnId},${entry.messageId},${entry.originItemId},${entry.occurredAt},${encodePrivateJson(entry.actor)},${encodePrivateJson(entry.reference)},${call.revisionId},${key},${4096 + bytes(encodePrivateJson(entry))})`;
      return entry;
    }).pipe(Effect.mapError(() => failure())),
  );

/** Dedicated private SQLite blobs avoid event-journal amplification and a second
 * filesystem namespace. The shared database already has private owner storage.
 * Host/file work is outside writer transactions; ready revisions never update. */
export const makeVisualizationArtifactService = () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig;
    let admittedWork = 0;
    const bounded = <A, E, R>(work: Effect.Effect<A, E, R>) =>
      Effect.suspend((): Effect.Effect<A, E | VisualizationApiError, R> => {
        if (admittedWork >= 3) return Effect.fail(failure());
        admittedWork += 1;
        return work.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              admittedWork -= 1;
            }),
          ),
        );
      });
    type InlineFrame = {
      readonly frameId: string;
      readonly ticketDigest: string;
      readonly threadId: string;
      readonly artifactId: string;
      readonly revisionId: string;
      expiresAtMs: number;
    };
    type InlineFrameLookup = Pick<
      McpAppPrepareInput,
      "threadId" | "artifactId" | "revisionId" | "leaseId" | "ticket"
    >;
    // Source-free ephemeral action grants belong to this exact backend service,
    // not SQLite history or a native Electron host. Expiry/refusal never claims
    // that same-origin JavaScript has stopped or gained process containment.
    const inlineFrames = new Map<string, InlineFrame>();
    const inlineFrameTicketDigest = (ticket: string) => sha("cafe-inline-frame-ticket-v1", ticket);
    const sweepInlineFrames = () => {
      const now = DateTime.toEpochMillis(DateTime.nowUnsafe());
      for (const [id, frame] of inlineFrames) if (frame.expiresAtMs <= now) inlineFrames.delete(id);
    };
    const findInlineFrame = (input: InlineFrameLookup) => {
      if (
        typeof input.ticket !== "string" ||
        typeof input.leaseId !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.ticket)
      )
        return undefined;
      const frame = inlineFrames.get(input.leaseId);
      if (
        !frame ||
        frame.threadId !== input.threadId ||
        frame.artifactId !== input.artifactId ||
        frame.revisionId !== input.revisionId ||
        !timingSafeEqual(
          Buffer.from(frame.ticketDigest, "hex"),
          Buffer.from(inlineFrameTicketDigest(input.ticket), "hex"),
        )
      )
        return undefined;
      if (frame.expiresAtMs <= DateTime.toEpochMillis(DateTime.nowUnsafe())) {
        inlineFrames.delete(frame.frameId);
        return undefined;
      }
      return frame;
    };
    /** Metadata-only broker cleanup hint. Actual operations MUST call the
     * asynchronous read below for fresh persisted Full-access/tuple admission. */
    const inlineFrameDeadline = (input: InlineFrameLookup) => findInlineFrame(input)?.expiresAtMs;
    const requireOwned = (input: VisualizationDetailsInput) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT 1 FROM visualization_history h JOIN visualization_artifacts a ON a.revision_id = h.revision_id
      WHERE h.thread_id = ${input.threadId} AND h.revision_id = ${input.revisionId} AND a.artifact_id = ${input.artifactId}
      AND NOT EXISTS(SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${input.threadId}) LIMIT 1`;
        if (!rows.length) return yield* failure();
      });
    const read = (input: VisualizationDetailsInput) =>
      Effect.gen(function* () {
        yield* requireOwned(input);
        // The selected tuple is fixed and never interpolated as a filesystem path.
        const rows =
          yield* sql<ArtifactRow>`SELECT revision_id AS "revisionId",artifact_id AS "artifactId",kind,source,
      assets_json AS "assetsJson",reference_json AS "referenceJson",diagnostics_json AS "diagnosticsJson",private_json AS "privateJson",
      poster,poster_sha256 AS "posterSha256",manifest_sha256 AS "manifestSha256",input_sha256 AS "inputSha256",content_sha256 AS "contentSha256",state
      FROM visualization_artifacts WHERE artifact_id = ${input.artifactId} AND revision_id = ${input.revisionId} AND state = 'ready'`;
        const row = rows[0];
        if (
          !row ||
          sha("cafe-visual-manifest-v1", row.assetsJson) !== row.manifestSha256 ||
          contentDigest(
            row.source,
            row.assetsJson,
            row.referenceJson,
            row.diagnosticsJson,
            row.privateJson,
            row.posterSha256,
          ) !== row.contentSha256 ||
          (row.poster && sha("cafe-visual-poster-v1", row.poster) !== row.posterSha256)
        )
          return yield* failure();
        yield* requireOwned(input);
        return row;
      });
    const ensureQuota = (threadId: string, additional: number, newArtifact = false) =>
      Effect.gen(function* () {
        const totals = yield* sql<{
          total: number;
          own: number;
          artifacts: number;
        }>`SELECT bytes AS total,artifacts,
      COALESCE((SELECT bytes FROM visualization_thread_quota WHERE thread_id = ${threadId}),0) AS own FROM visualization_storage_quota WHERE singleton = 1`;
        if (
          !totals[0] ||
          totals[0].total + additional > VISUALIZATION_STORE_MAX_BYTES ||
          totals[0].own + additional > VISUALIZATION_THREAD_MAX_BYTES ||
          (newArtifact && totals[0].artifacts >= 2048)
        )
          return yield* failure();
      });
    const snapshotAssets = (
      authority: VisualizationSessionAuthority,
      input: GeneratedVisualizationInput,
    ) =>
      Effect.gen(function* () {
        const result: Array<StoredVisualizationAssets[number]> = [];
        let aggregate = 0;
        let pixels = 0;
        for (const asset of input.assets) {
          const commitments = yield* sql<{
            contentSha256: string;
            sizeBytes: number;
          }>`SELECT content_sha256 AS "contentSha256",size_bytes AS "sizeBytes" FROM attachment_content_commitments
        WHERE attachment_id = ${asset.attachmentId} AND thread_id = ${authority.threadId}
          AND NOT EXISTS(SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${authority.threadId})`;
          const commitment = commitments[0];
          if (!commitment || aggregate + commitment.sizeBytes > MAX_ASSET_BYTES)
            return yield* failure();
          const path = resolveAttachmentPathById({
            attachmentsDir: config.attachmentsDir,
            attachmentId: asset.attachmentId,
          });
          if (!path) return yield* failure();
          const captured = yield* Effect.tryPromise({
            try: () => readOwnedRaster(path, commitment.sizeBytes, commitment.contentSha256),
            catch: () => failure(),
          });
          aggregate += captured.size;
          pixels += captured.pixels;
          if (pixels > 16_000_000) return yield* failure();
          result.push({ id: asset.assetId, mime: captured.mime, base64: captured.base64 });
        }
        return result;
      });
    const publishInternal = (
      authority: VisualizationSessionAuthority,
      value: unknown,
      app?: { input: McpAppPublicationInput; witness: McpAppNativeWitness },
    ) =>
      bounded(
        Effect.gen(function* () {
          const admitted = decodeInput(value);
          const inputSha256 = app
            ? sha(
                "cafe-visual-native-app-input-v1",
                encodePrivateJson({ input: app.input, witness: app.witness }),
              )
            : computeGeneratedVisualizationInputSha256(value);
          if (Result.isFailure(admitted) || !inputSha256) return yield* failure();
          const input = admitted.success;
          yield* sweep;
          const previous = yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* requireVisualizationSessionAuthority(sql, authority);
              const rows = yield* sql<{
                revisionId: string;
                inputSha256: string;
                referenceJson: string;
                state: string;
              }>`SELECT revision_id AS "revisionId",input_sha256 AS "inputSha256",reference_json AS "referenceJson",state FROM visualization_artifacts WHERE thread_id = ${authority.threadId} AND session_generation = ${authority.sessionGeneration} AND request_id = ${input.requestId}`;
              const row = rows[0];
              if (row && (row.inputSha256 !== inputSha256 || row.state !== "ready"))
                return yield* failure();
              return row;
            }),
          );
          let reference: Reference;
          let revisionId: string;
          if (previous) {
            reference = parseReference(previous.referenceJson);
            revisionId = previous.revisionId;
          } else {
            const assets = yield* snapshotAssets(authority, input);
            const assetsJson = encodePrivateJson(assets);
            const privateJson = encodePrivateJson(
              app ? { input: app.input, witness: app.witness } : input,
            );
            if (bytes(privateJson) > VISUALIZATION_MAX_INPUT_JSON_BYTES) return yield* failure();
            const artifactId = VisualizationArtifactId.make(randomUUID());
            const revision = VisualizationRevisionId.make(randomUUID());
            revisionId = revision;
            const document = {
              width: input.viewport?.width ?? 960,
              height: input.viewport?.height ?? 640,
            };
            const initialReference: Reference = app
              ? {
                  version: 1,
                  purpose: "mcp-app",
                  artifactId,
                  revisionId: revision,
                  title: input.title,
                  width: document.width,
                  height: document.height,
                  serverLabel: app.input.serverName.slice(0, 160),
                }
              : {
                  version: 1,
                  purpose: "generated-visualization",
                  artifactId,
                  revisionId: revision,
                  title: input.title,
                  width: document.width,
                  height: document.height,
                };
            if (Result.isFailure(decodeReference(initialReference))) return yield* failure();
            const diagnostics = {
              version: 1 as const,
              artifactId,
              revisionId: revision,
              records: [],
              truncated: false,
            };
            const reservedBytes =
              4096 +
              bytes(input.source) +
              bytes(assetsJson) +
              bytes(privateJson) +
              bytes(encodePrivateJson(initialReference)) +
              bytes(encodePrivateJson(diagnostics));
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* requireVisualizationSessionAuthority(sql, authority);
                yield* ensureQuota(authority.threadId, reservedBytes, true);
                yield* sql`INSERT INTO visualization_artifacts(revision_id,artifact_id,kind,thread_id,provider_instance_id,session_generation,request_id,input_sha256,manifest_sha256,content_sha256,source,assets_json,reference_json,diagnostics_json,private_json,byte_length,state,created_at)
          VALUES(${revision},${artifactId},${app ? "mcp-app" : "generated-visualization"},${authority.threadId},${authority.providerInstanceId},${authority.sessionGeneration},${input.requestId},${inputSha256},${sha("cafe-visual-manifest-v1", assetsJson)},${contentDigest(input.source, assetsJson, encodePrivateJson(initialReference), encodePrivateJson(diagnostics), privateJson, null)},${input.source},${assetsJson},${encodePrivateJson(initialReference)},${encodePrivateJson(diagnostics)},${privateJson},${reservedBytes},'pending',${DateTime.formatIso(DateTime.nowUnsafe())})`;
              }),
            );
            // Publishing source is deliberately inert: no native
            // surface, source execution, image capture or persisted poster.
            // The pending row already commits every private byte and the
            // absent-poster reference. Recheck the actual Full-access launch
            // generation under the same writer reservation as readiness;
            // readiness means immutable storage, never successful rendering.
            reference = initialReference;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* requireVisualizationSessionAuthority(sql, authority);
                const changed = yield* sql`UPDATE visualization_artifacts SET state = 'ready'
                    WHERE revision_id = ${revision} AND thread_id = ${authority.threadId} AND state = 'pending' RETURNING revision_id`;
                if (changed.length !== 1) return yield* failure();
              }),
            );
          }
          if (app) {
            const witness = app.witness;
            const key = sha(
              "cafe-visual-native-app-v1",
              encodePrivateJson([
                witness.provider,
                witness.providerInstanceId,
                witness.sessionGeneration,
                witness.nativeThreadId,
                witness.nativeTurnId,
                witness.nativeItemId,
                witness.serverName,
                witness.toolName,
              ]),
            );
            const entry: VisualizationTimelineEntry = {
              messageId: witness.messageId,
              turnId: witness.turnId,
              originItemId: `visual-${sha("cafe-visual-origin-v1", witness.nativeItemId)}`,
              occurredAt: witness.occurredAt,
              actor: publicActor(witness.actor),
              reference,
            };
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* requireVisualizationSessionAuthority(sql, authority);
                yield* sql`INSERT INTO visualization_history(id,thread_id,turn_id,message_id,origin_item_id,occurred_at,actor_json,reference_json,revision_id,native_call_key,byte_length) VALUES(${randomUUID()},${authority.threadId},${entry.turnId},${entry.messageId},${entry.originItemId},${entry.occurredAt},${encodePrivateJson(entry.actor)},${encodePrivateJson(entry.reference)},${revisionId},${key},${4096 + bytes(encodePrivateJson(entry))}) ON CONFLICT(thread_id,native_call_key) DO NOTHING`;
              }),
            );
            return { kind: "mcp-app" as const, entry };
          }
          // Deduplicating publication does not deduplicate native invocations. Every
          // actual call receives a fresh private proof which can claim one native item.
          const invocationId = randomUUID();
          const proof = randomBytes(32).toString("hex");
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* requireVisualizationSessionAuthority(sql, authority);
              const count = yield* sql<{
                count: number;
              }>`SELECT COUNT(*) AS count FROM visualization_invocations WHERE thread_id = ${authority.threadId} AND native_call_key IS NULL`;
              if ((count[0]?.count ?? 0) >= 256) return yield* failure();
              yield* sql`INSERT INTO visualization_invocations(invocation_id,proof_digest,thread_id,provider_instance_id,session_generation,runtime_generation,server_name,tool_name,input_sha256,revision_id,expires_at)
        VALUES(${invocationId},${proofDigest(proof)},${authority.threadId},${authority.providerInstanceId},${authority.sessionGeneration},${authority.runtimeGeneration},${authority.serverName},'publish_visualization',${inputSha256},${revisionId},${DateTime.toEpochMillis(DateTime.nowUnsafe()) + VISUALIZATION_INVOCATION_LIFETIME_MS})`;
            }),
          );
          return {
            version: 1 as const,
            purpose: "cafe-visualization-receipt" as const,
            invocationId,
            proof,
            reference,
            requestId: input.requestId,
            inputSha256,
            sessionGeneration: authority.sessionGeneration,
            serverName: authority.serverName,
            toolName: "publish_visualization" as const,
          };
        }),
      );
    const publish = (authority: VisualizationSessionAuthority, value: unknown) =>
      publishInternal(authority, value).pipe(
        Effect.flatMap((result) =>
          "kind" in result ? Effect.fail(failure()) : Effect.succeed(result),
        ),
      );
    const publishMcpApp = (
      authority: VisualizationSessionAuthority,
      input: McpAppPublicationInput,
      witness: McpAppNativeWitness,
    ) => {
      if (
        Result.isFailure(decodeAppWitness(witness)) ||
        witness.threadId !== authority.threadId ||
        witness.providerInstanceId !== authority.providerInstanceId ||
        witness.sessionGeneration !== authority.sessionGeneration ||
        witness.provider !== "codex" ||
        witness.serverName !== input.serverName ||
        witness.nativeItemId !== input.originCallId ||
        !validSource(input.source) ||
        input.serverName.length < 1 ||
        input.serverName.length > 160 ||
        !witness.toolName ||
        witness.toolName.length > 200
      )
        return Effect.fail(failure());
      const hash = sha(
        "cafe-visual-app-operation-v1",
        encodePrivateJson([witness.sessionGeneration, witness.nativeItemId, input.resourceUri]),
      );
      const requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      return publishInternal(
        authority,
        {
          version: 1,
          purpose: "generated-visualization",
          requestId,
          source: input.source,
          title: input.title,
          assets: [],
          appearance: "auto",
        },
        { input, witness },
      ).pipe(
        Effect.flatMap((result) =>
          "kind" in result && result.kind === "mcp-app"
            ? Effect.succeed(result.entry)
            : Effect.fail(failure()),
        ),
      );
    };
    const details = (input: VisualizationDetailsInput) =>
      bounded(
        Effect.gen(function* () {
          const row = yield* read(input);
          const privateInput = parsePrivateJson(row.privateJson);
          const inputDecoded =
            row.kind === "generated-visualization" ? decodeInput(privateInput) : undefined;
          const assets =
            inputDecoded && Result.isSuccess(inputDecoded) ? inputDecoded.success.assets : [];
          const result = decodeDetails({
            ...input,
            source: {
              version: 1,
              purpose: row.kind,
              artifactId: input.artifactId,
              revisionId: input.revisionId,
              source: row.source,
              assets,
            },
            diagnostics: parsePrivateJson(row.diagnosticsJson),
            rawJson: row.privateJson,
          });
          if (Result.isFailure(result)) return yield* failure();
          return result.success;
        }),
      );
    const list = (
      input: VisualizationListInput,
    ): Effect.Effect<VisualizationListResult, VisualizationApiError> =>
      Effect.gen(function* () {
        const retired =
          yield* sql`SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${input.threadId}`;
        if (retired.length) return yield* failure();
        const cursor = input.cursor
          ? (yield* sql<{
              occurredAt: string;
              id: string;
            }>`SELECT occurred_at AS "occurredAt",id FROM visualization_history WHERE thread_id = ${input.threadId} AND id = ${input.cursor}`)[0]
          : undefined;
        if (input.cursor && !cursor) return yield* failure();
        // A cursor is the sole continuation authority. Do not silently combine
        // a foreign seek boundary with a previously admitted page cursor.
        if (cursor && input.atOrBefore !== undefined) return yield* failure();
        const rows = cursor
          ? yield* sql<{
              id: string;
              turnId: string;
              messageId: string;
              originItemId: string;
              occurredAt: string;
              actorJson: string;
              referenceJson: string;
            }>`SELECT id,turn_id AS "turnId",message_id AS "messageId",origin_item_id AS "originItemId",occurred_at AS "occurredAt",actor_json AS "actorJson",reference_json AS "referenceJson" FROM visualization_history WHERE thread_id = ${input.threadId} AND (occurred_at < ${cursor.occurredAt} OR (occurred_at = ${cursor.occurredAt} AND id < ${cursor.id})) ORDER BY occurred_at DESC,id DESC LIMIT 51`
          : input.atOrBefore !== undefined
            ? yield* sql<{
                id: string;
                turnId: string;
                messageId: string;
                originItemId: string;
                occurredAt: string;
                actorJson: string;
                referenceJson: string;
              }>`SELECT id,turn_id AS "turnId",message_id AS "messageId",origin_item_id AS "originItemId",occurred_at AS "occurredAt",actor_json AS "actorJson",reference_json AS "referenceJson" FROM visualization_history INDEXED BY idx_visualization_history_window WHERE thread_id = ${input.threadId} AND occurred_at <= ${input.atOrBefore} ORDER BY occurred_at DESC,id DESC LIMIT 51`
            : yield* sql<{
                id: string;
                turnId: string;
                messageId: string;
                originItemId: string;
                occurredAt: string;
                actorJson: string;
                referenceJson: string;
              }>`SELECT id,turn_id AS "turnId",message_id AS "messageId",origin_item_id AS "originItemId",occurred_at AS "occurredAt",actor_json AS "actorJson",reference_json AS "referenceJson" FROM visualization_history WHERE thread_id = ${input.threadId} ORDER BY occurred_at DESC,id DESC LIMIT 51`;
        const entries: VisualizationTimelineEntry[] = [];
        for (const row of rows.slice(0, VISUALIZATION_LIST_PAGE_SIZE)) {
          const decoded = decodeEntry({
            turnId: row.turnId,
            messageId: row.messageId,
            originItemId: row.originItemId,
            occurredAt: row.occurredAt,
            actor: parsePrivateJson(row.actorJson),
            reference: parseReference(row.referenceJson),
          });
          if (Result.isFailure(decoded)) return yield* failure();
          entries.push(decoded.success);
        }
        const nowRetired =
          yield* sql`SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${input.threadId}`;
        if (nowRetired.length) return yield* failure();
        return {
          entries,
          ...(rows.length > VISUALIZATION_LIST_PAGE_SIZE
            ? { nextCursor: rows[VISUALIZATION_LIST_PAGE_SIZE - 1]!.id }
            : {}),
        };
      }).pipe(Effect.mapError(() => failure()));
    const poster = (input: VisualizationDetailsInput) =>
      bounded(
        Effect.gen(function* () {
          const row = yield* read(input);
          const reference = parseReference(row.referenceJson);
          if (!row.poster || !admittedPoster(row.poster, reference.width, reference.height))
            return yield* failure();
          return row.poster;
        }),
      );
    const inline = (input: VisualizationInlineInput) =>
      bounded(
        Effect.gen(function* () {
          yield* sql.withTransaction(requireVisualizationFullAccess(sql, input.threadId));
          const row = yield* read(input);
          const admittedAssets = decodeAssets(parsePrivateJson(row.assetsJson));
          if (Result.isFailure(admittedAssets)) return yield* failure();
          const assets = admittedAssets.success;
          const ids = new Set<string>();
          let assetBytes = 0;
          let assetPixels = 0;
          for (const asset of assets) {
            const bytes = Buffer.from(asset.base64, "base64");
            const dimensions = rasterDimensions(bytes, asset.mime);
            if (!dimensions || bytes.toString("base64") !== asset.base64 || ids.has(asset.id))
              return yield* failure();
            ids.add(asset.id);
            assetBytes += bytes.byteLength;
            assetPixels += dimensions.width * dimensions.height;
            if (assetBytes > MAX_ASSET_BYTES || assetPixels > 16_000_000) return yield* failure();
          }
          const html = yield* Effect.try({
            try: () =>
              row.kind === "generated-visualization"
                ? createInlineGeneratedVisualizationHtml(row.source, assets)
                : embedStaticVisualizationAssets(row.source, assets),
            catch: () => failure(),
          });
          // Assembly is inert and may be expensive. Reobserve current policy
          // and exact history ownership after it; a historical Full-access
          // launch or a source-bearing Details response is never permission.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* requireVisualizationFullAccess(sql, input.threadId);
              yield* requireOwned(input);
            }),
          );
          sweepInlineFrames();
          if (
            inlineFrames.size >= 128 ||
            [...inlineFrames.values()].filter((frame) => frame.threadId === input.threadId)
              .length >= 32
          )
            return yield* failure();
          const frameId = randomUUID();
          const ticket = randomBytes(32).toString("hex");
          const expiresAtMs = DateTime.toEpochMillis(DateTime.nowUnsafe()) + 30_000;
          const result = decodeInline({
            ...input,
            purpose: row.kind,
            fullAccess: true,
            html,
            frameId,
            ticket,
            expiresAtMs,
          });
          if (Result.isFailure(result)) return yield* failure();
          inlineFrames.set(frameId, {
            frameId,
            ticketDigest: inlineFrameTicketDigest(ticket),
            ...input,
            expiresAtMs,
          });
          return result.success;
        }),
      );
    const readInlineFrame = (input: InlineFrameLookup) =>
      bounded(
        Effect.gen(function* () {
          const frame = findInlineFrame(input);
          if (!frame) return yield* failure();
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* requireVisualizationFullAccess(sql, input.threadId);
              yield* requireOwned(input);
            }),
          );
          if (findInlineFrame(input) !== frame) return yield* failure();
          return { documentGeneration: frame.frameId, expiresAtMs: frame.expiresAtMs };
        }),
      );
    const touchInlineFrame = (input: InlineFrameInput) =>
      bounded(
        Effect.gen(function* () {
          const decoded = decodeInlineFrameInput(input);
          if (Result.isFailure(decoded)) return yield* failure();
          const owned = decoded.success;
          const lookup = { ...owned, leaseId: owned.frameId };
          const frame = findInlineFrame(lookup);
          if (!frame) return yield* failure();
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* requireVisualizationFullAccess(sql, owned.threadId);
              yield* requireOwned(owned);
            }),
          );
          if (findInlineFrame(lookup) !== frame) return yield* failure();
          frame.expiresAtMs = DateTime.toEpochMillis(DateTime.nowUnsafe()) + 30_000;
          return {
            threadId: owned.threadId,
            artifactId: owned.artifactId,
            revisionId: owned.revisionId,
            frameId: frame.frameId,
            expiresAtMs: frame.expiresAtMs,
          };
        }),
      );
    const retireInlineFrame = (input: InlineFrameInput) =>
      bounded(
        Effect.gen(function* () {
          const decoded = decodeInlineFrameInput(input);
          if (Result.isFailure(decoded)) return yield* failure();
          const owned = decoded.success;
          const frame = findInlineFrame({ ...owned, leaseId: owned.frameId });
          // Cleanup is exact-token/tuple-bound and remains allowed after a
          // policy downgrade. Never revoke a replacement or whole revision.
          const retired = frame ? inlineFrames.delete(frame.frameId) : false;
          return {
            threadId: owned.threadId,
            artifactId: owned.artifactId,
            revisionId: owned.revisionId,
            frameId: owned.frameId,
            retired,
          };
        }),
      );
    // Wire compatibility is refusal-only. The retired native viewer architecture
    // must never read source, host markers, tickets or ledgers, and cannot send
    // native preparation/discard requests even when an old client invokes it.
    // Current inline grants below/above are the only live display admission.
    const viewerTicket = (_input: VisualizationDetailsInput) => Effect.fail(failure());
    const readViewerTicket = (_input: VisualizationDetailsInput, _ticket: string) =>
      Effect.fail(failure());
    const discardViewerTicket = (_input: VisualizationDiscardViewerTicketInput) =>
      Effect.fail(failure());
    const exportHtml = (input: VisualizationDetailsInput) =>
      bounded(
        Effect.gen(function* () {
          const row = yield* read(input);
          if (row.kind !== "generated-visualization") return yield* failure();
          const assets = parsePrivateJson(row.assetsJson) as StoredVisualizationAssets;
          const html = yield* Effect.try({
            try: () => exportGeneratedVisualizationHtml(row.source, assets),
            catch: () => failure(),
          });
          if (bytes(html) > 16 * 1024 * 1024) return yield* failure();
          yield* requireOwned(input);
          return { ...input, html };
        }),
      );
    const sweep = sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM visualization_invocations WHERE invocation_id IN (SELECT invocation_id FROM visualization_invocations WHERE expires_at < ${DateTime.toEpochMillis(DateTime.nowUnsafe())} ORDER BY expires_at,invocation_id LIMIT 16)`;
        yield* sql`DELETE FROM visualization_viewer_tickets WHERE ticket_digest IN (SELECT ticket_digest FROM visualization_viewer_tickets WHERE expires_at < ${DateTime.toEpochMillis(DateTime.nowUnsafe())} ORDER BY expires_at,ticket_digest LIMIT 16)`;
        yield* sql`DELETE FROM visualization_artifacts WHERE revision_id IN (SELECT a.revision_id FROM visualization_artifacts a WHERE NOT EXISTS(SELECT 1 FROM visualization_history h WHERE h.revision_id = a.revision_id) AND NOT EXISTS(SELECT 1 FROM visualization_invocations i WHERE i.revision_id = a.revision_id) AND (a.state = 'retired' OR a.created_at < ${DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) - VISUALIZATION_INVOCATION_LIFETIME_MS))}) ORDER BY a.created_at,a.revision_id LIMIT 16)`;
      }),
    );
    const debug = (threadId: string) =>
      Effect.gen(function* () {
        const retired =
          yield* sql`SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${threadId}`;
        if (retired.length) return yield* failure();
        const counts = (yield* sql<{
          pendingCount: number;
          failedCaptureCount: number;
          readyCount: number;
          storedBytes: number;
        }>`SELECT
      COALESCE(SUM(state = 'pending'),0) AS "pendingCount",
      COALESCE(SUM(state = 'pending' AND failure_reason = 'capture-unavailable'),0) AS "failedCaptureCount",
      COALESCE(SUM(state = 'ready'),0) AS "readyCount",
      COALESCE(SUM(byte_length),0) AS "storedBytes"
      FROM visualization_artifacts WHERE thread_id = ${threadId}`)[0]!;
        const policy = yield* sql<{
          runtimeMode: string;
        }>`SELECT runtime_mode AS "runtimeMode" FROM projection_threads WHERE thread_id=${threadId}`;
        sweepInlineFrames();
        let frameCount = 0;
        for (const frame of inlineFrames.values()) if (frame.threadId === threadId) frameCount++;
        // Counts and finite policy only: never source, frame tokens, native IDs,
        // request IDs, private paths or received errors. Legacy capture failures
        // remain historical evidence rather than an active hosting-mode claim.
        return {
          ...counts,
          executionMode: "inline-browser" as const,
          fullAccess: policy.length === 1 && policy[0]!.runtimeMode === "full-access",
          frameCount,
          frameLimit: 32,
          globalFrameLimit: 128,
          frameGrantMs: 30_000,
          ...(counts.failedCaptureCount > 0 ? { reason: "capture-unavailable" as const } : {}),
        };
      });
    return {
      publish,
      publishMcpApp,
      list,
      details,
      poster,
      inline,
      touchInlineFrame,
      retireInlineFrame,
      readInlineFrame,
      inlineFrameDeadline,
      viewerTicket,
      discardViewerTicket,
      readViewerTicket,
      exportHtml,
      sweep,
      debug,
      // Private native owner operations revalidate this exact activated tuple
      // around asynchronous provider I/O; registration/UUID shape is not proof.
      requireActiveSession: (authority: VisualizationSessionAuthority) =>
        sql.withTransaction(requireVisualizationSessionAuthority(sql, authority)),
      readMcpAppSnapshot: read,
    };
  });
export type VisualizationArtifactService = Effect.Success<
  ReturnType<typeof makeVisualizationArtifactService>
>;
