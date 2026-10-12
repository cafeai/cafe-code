import * as Schema from "effect/Schema";

import { MessageId, ThreadId, TurnId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { VisualizationReference } from "./mcpApps.ts";
import {
  GeneratedVisualizationDiagnostics,
  GeneratedVisualizationInputJsonText,
  GeneratedVisualizationSource,
  VisualizationArtifactId,
  VisualizationGenerationId,
  VisualizationRevisionId,
} from "./visualizations.ts";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
// Canonical copy:<thread>: anchors grow on an ordinary history fork. They are
// still finite received presentation IDs, never file paths or native authority.
const historyIdentifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
const timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
);
const token = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

export const VISUALIZATION_POSTER_PATH = "/api/visualizations/poster";
export const VISUALIZATION_LIST_PAGE_SIZE = 50;

/** Attribution is display data. Native ownership must be proven separately. */
export const VisualizationActor = Schema.Union([
  Schema.Struct({ type: Schema.Literal("root") }).annotate(strict),
  Schema.Struct({
    type: Schema.Literal("child"),
    id: identifier,
    label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(160))),
  }).annotate(strict),
]);
export type VisualizationActor = typeof VisualizationActor.Type;

/** Durable compact history is independent of the bounded work-log activity tail. */
export const VisualizationTimelineEntry = Schema.Struct({
  messageId: MessageId.check(Schema.isMaxLength(2048)),
  turnId: TurnId.check(Schema.isMaxLength(2048)),
  originItemId: historyIdentifier,
  occurredAt: timestamp,
  actor: VisualizationActor,
  reference: VisualizationReference,
}).annotate(strict);
export type VisualizationTimelineEntry = typeof VisualizationTimelineEntry.Type;

export const VisualizationListInput = Schema.Struct({
  threadId: ThreadId.check(Schema.isMaxLength(200)),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/))),
}).annotate(strict);
export type VisualizationListInput = typeof VisualizationListInput.Type;
export const VisualizationListResult = Schema.Struct({
  entries: Schema.Array(VisualizationTimelineEntry).check(
    Schema.isMaxLength(VISUALIZATION_LIST_PAGE_SIZE),
  ),
  nextCursor: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/))),
}).annotate(strict);
export type VisualizationListResult = typeof VisualizationListResult.Type;

export const VisualizationDetailsInput = Schema.Struct({
  threadId: ThreadId.check(Schema.isMaxLength(200)),
  artifactId: VisualizationArtifactId,
  revisionId: VisualizationRevisionId,
}).annotate(strict);
export type VisualizationDetailsInput = typeof VisualizationDetailsInput.Type;
export const VisualizationPrivateSource = Schema.Struct({
  ...GeneratedVisualizationSource.fields,
  purpose: Schema.Literals(["generated-visualization", "mcp-app"]),
}).annotate(strict);
export type VisualizationPrivateSource = typeof VisualizationPrivateSource.Type;
export const VisualizationDetailsResult = Schema.Struct({
  threadId: ThreadId.check(Schema.isMaxLength(200)),
  artifactId: VisualizationArtifactId,
  revisionId: VisualizationRevisionId,
  source: VisualizationPrivateSource,
  diagnostics: GeneratedVisualizationDiagnostics,
  // This private string is only retrieved after an explicit authenticated read.
  // Its schema does not attest redaction and must never become a public summary.
  rawJson: GeneratedVisualizationInputJsonText,
}).annotate(strict);
export type VisualizationDetailsResult = typeof VisualizationDetailsResult.Type;

export const VisualizationViewerInput = VisualizationDetailsInput;
export type VisualizationViewerInput = typeof VisualizationViewerInput.Type;
export const VisualizationViewerTicketResult = Schema.Struct({
  threadId: ThreadId.check(Schema.isMaxLength(200)),
  artifactId: VisualizationArtifactId,
  revisionId: VisualizationRevisionId,
  ticket: token,
  expiresAtMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
}).annotate(strict);
export type VisualizationViewerTicketResult = typeof VisualizationViewerTicketResult.Type;
export const VisualizationExportHtmlResult = Schema.Struct({
  ...VisualizationDetailsInput.fields,
  html: Schema.String.check(Schema.isMaxLength(16 * 1024 * 1024)),
}).annotate(strict);
export type VisualizationExportHtmlResult = typeof VisualizationExportHtmlResult.Type;

/**
 * Internal shape only, never a renderer RPC or proof of native completion. The
 * owning adapter supplies this through its private activated session binding.
 * Server authorization, invocation proof and native-call uniqueness are checked
 * transactionally before any public reference is admitted.
 */
export const GeneratedVisualizationNativeWitness = Schema.Struct({
  provider: Schema.Literals(["codex", "claudeAgent", "grok"]),
  threadId: ThreadId.check(Schema.isMaxLength(200)),
  providerInstanceId: ProviderInstanceId,
  sessionGeneration: VisualizationGenerationId,
  nativeThreadId: identifier,
  nativeTurnId: identifier,
  nativeItemId: identifier,
  serverName: identifier,
  toolName: Schema.Literals(["preview_visualization", "publish_visualization"]),
  inputSha256: token,
  actor: VisualizationActor,
  messageId: MessageId.check(Schema.isMaxLength(200)),
  turnId: TurnId.check(Schema.isMaxLength(200)),
  occurredAt: timestamp,
}).annotate(strict);
export type GeneratedVisualizationNativeWitness = typeof GeneratedVisualizationNativeWitness.Type;

/** Fixed failures must not contain decoder issues, SQL errors or generated source. */
export class VisualizationApiError extends Schema.TaggedErrorClass<VisualizationApiError>()(
  "VisualizationApiError",
  { message: Schema.String.check(Schema.isMaxLength(160)) },
) {}
