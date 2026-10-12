import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import {
  GeneratedVisualizationReference,
  VisualizationArtifactId,
  VisualizationRevisionId,
} from "./visualizations.ts";

// Implement the stable extension directly without installing an SDK. These are
// data shapes, not permission to invoke a native MCP server or execute HTML.
export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
export const MCP_APP_EXTENSION_ID = "io.modelcontextprotocol/ui";
export const MCP_APP_RESOURCE_MIME = "text/html;profile=mcp-app";
export const MCP_APP_MAX_MESSAGE_BYTES = 128 * 1024;
export const MCP_APP_MAX_CONTEXT_BYTES = 16 * 1024;
export const MCP_APP_MAX_PENDING_CONSENTS = 8;
export const MCP_APP_CONSENT_LIFETIME_MS = 30_000;

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const boundedJson = Schema.String.check(
  Schema.isMaxLength(MCP_APP_MAX_MESSAGE_BYTES),
  Schema.makeFilter(
    (value) => new TextEncoder().encode(value).byteLength <= MCP_APP_MAX_MESSAGE_BYTES,
  ),
);
const id = Schema.String.check(Schema.isUUID());
// Reuse the exact received-title admission, including control/bidi refusal;
// escaping HTML alone does not prevent a misleading sidebar/consent label.
const shortLabel = GeneratedVisualizationReference.fields.title;

/** Private data-only poster replay, not live App/provider action authority.
 * The native preview lane must refuse every consequential operation. */
export const McpAppPreviewReplay = Schema.Struct({
  originalInputJson: boundedJson,
  originalResultJson: boundedJson,
}).annotate(strict);
export type McpAppPreviewReplay = typeof McpAppPreviewReplay.Type;

/** Ordinary display reference: no server URI, native call ID, source or proof. */
export const McpAppReference = Schema.Struct({
  ...GeneratedVisualizationReference.fields,
  purpose: Schema.Literal("mcp-app"),
  serverLabel: shortLabel,
}).annotate(strict);
export type McpAppReference = typeof McpAppReference.Type;
export const VisualizationReference = Schema.Union([
  GeneratedVisualizationReference,
  McpAppReference,
]);
export type VisualizationReference = typeof VisualizationReference.Type;

/**
 * Native main independently attests the live ticket/lease/document. A renderer
 * supplied UUID never replaces that observation at preparation or approval.
 */
export const McpAppPrepareInput = Schema.Struct({
  threadId: ThreadId,
  artifactId: VisualizationArtifactId,
  revisionId: VisualizationRevisionId,
  leaseId: id,
  ticket: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  requestJson: boundedJson,
}).annotate(strict);
export type McpAppPrepareInput = typeof McpAppPrepareInput.Type;

export const McpAppReply = Schema.Struct({
  json: boundedJson,
  openUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
}).annotate(strict);
export type McpAppReply = typeof McpAppReply.Type;
export const McpAppPrepareResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("reply"),
    json: boundedJson,
    messages: Schema.optionalKey(Schema.Array(boundedJson).check(Schema.isMaxLength(3))),
    displayMode: Schema.optionalKey(Schema.Literals(["inline", "fullscreen"])),
  }).annotate(strict),
  Schema.Struct({
    kind: Schema.Literal("consent"),
    operationId: id,
    method: Schema.Literals(["tools/call", "resources/read", "ui/message", "ui/open-link"]),
    name: Schema.optionalKey(shortLabel),
  }).annotate(strict),
]);
export type McpAppPrepareResult = typeof McpAppPrepareResult.Type;
export const McpAppResolveInput = Schema.Struct({
  operationId: id,
  decision: Schema.Literals(["approve", "deny"]),
}).annotate(strict);
export type McpAppResolveInput = typeof McpAppResolveInput.Type;
export const McpAppConsentDetailsInput = Schema.Struct({ operationId: id }).annotate(strict);
export type McpAppConsentDetailsInput = typeof McpAppConsentDetailsInput.Type;
