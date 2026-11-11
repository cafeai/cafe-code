import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import { z } from "zod";
import type { CafeMcpServerOptions } from "./CafeMcpServer.ts";
import { McpToolError, normalizeToolResult, toolFailure } from "./results.ts";
import {
  operationInputHash,
  operationReference,
  operationReferenceSchema,
  operationScopeId,
  PLANNED_TARGET_TOOLS,
  plannedTargetId,
  requestIdSchema,
  type OperationState,
} from "./operations.ts";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type Handler = (
  input: Record<string, unknown>,
  extra: Extra,
) => CallToolResult | Promise<CallToolResult>;
interface RegistrationConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape | z.ZodObject;
  outputSchema?: z.ZodRawShape | z.ZodObject;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}
type Register = (name: string, config: RegistrationConfig, handler: Handler) => RegisteredTool;

/** Adapt this repository's Zod-object registrations once, at the SDK generic
 * boundary. Individual registration sites retain the SDK's inferred argument
 * types. Narrow scheduling keeps its separate revision/approval protocol. */
export function installManagementToolResults(
  server: McpServer,
  options: CafeMcpServerOptions,
): void {
  const register = server.registerTool.bind(server) as Register;
  const wrapped: Register = (name, config, handler) => {
    const mutation =
      config.annotations?.readOnlyHint === false && !name.endsWith("scheduled_followup");
    const object = (schema: z.ZodRawShape | z.ZodObject | undefined) =>
      schema instanceof z.ZodObject ? schema : z.object(schema ?? {});
    return register(
      name,
      {
        ...config,
        ...(mutation
          ? {
              inputSchema: object(config.inputSchema).extend({
                requestId: requestIdSchema.optional(),
              }),
              outputSchema: object(config.outputSchema).extend({
                phase: z.enum(["recorded", "scheduled", "completed"]),
                operation: operationReferenceSchema.optional(),
              }),
            }
          : {}),
      },
      async (args, extra) => {
        let reserved = false;
        const owner = options.operationOwner;
        const operations = options.operations;
        const requestId = typeof args.requestId === "string" ? args.requestId : crypto.randomUUID();
        try {
          if (!mutation) return normalizeToolResult(await handler(args, extra));
          const { requestId: _omit, ...intent } = args;
          if (args.requestId !== undefined && (!owner || !operations))
            throw new McpToolError(
              "unavailable",
              "Durable action tracking is unavailable on this connection.",
            );
          if (owner && operations) {
            const admission = await Effect.runPromise(
              operations.reserve(owner, requestId, name, operationInputHash(owner, name, intent)),
            );
            if (!admission.fresh) {
              if (admission.operation.result !== null && admission.operation.state !== "failed") {
                return normalizeToolResult({
                  structuredContent: {
                    ...admission.operation.result,
                    operation: operationReference(owner, requestId, admission.operation.state),
                  },
                  content: [],
                });
              }
              throw new McpToolError(
                "conflict",
                "This action already has an unconfirmed or failed attempt; it was not executed again.",
                "Use get_operation and inspect the exact target. Do not automatically repeat this action.",
              );
            }
            reserved = true;
          }
          const result = await handler({ ...intent, requestId }, extra);
          if (result.isError) {
            if (reserved && owner && operations)
              await Effect.runPromise(operations.settle(owner, requestId, "failed"));
            return normalizeToolResult(result);
          }
          const state: OperationState = name.startsWith("restart_provider")
            ? "scheduled"
            : name === "set_provider_settings"
              ? "completed"
              : "recorded";
          const value = {
            ...result.structuredContent,
            phase: state,
            ...(reserved && owner
              ? { operation: operationReference(owner, requestId, state) }
              : {}),
          };
          if (reserved && owner && operations) {
            try {
              await Effect.runPromise(operations.settle(owner, requestId, state, value));
            } catch {
              // The action returned its own exact receipt. A journal failure
              // cannot turn that into an execution failure or permit replay.
              // Retain admission and report only unsettled receipt storage.
              value.operation = operationReference(owner, requestId, "unconfirmed");
            }
          }
          return normalizeToolResult({ ...result, structuredContent: value });
        } catch (error) {
          const failure = toolFailure(error, mutation);
          if (reserved && owner && operations) {
            failure.structuredContent = {
              ...failure.structuredContent,
              operation: operationReference(owner, requestId, "failed"),
            };
            // Failure after admission can include a partial multi-command update.
            // Keep the reservation even if recording failure itself is unavailable.
            await Effect.runPromise(
              operations.settle(owner, requestId, "failed", failure.structuredContent),
            ).catch(() => undefined);
          }
          return normalizeToolResult(failure);
        }
      },
    );
  };
  server.registerTool = wrapped as typeof server.registerTool;

  server.registerTool(
    "get_operation",
    {
      title: "Reconcile a Cafe management action",
      description:
        "Read the receipt for a requestId in this exact bearer session. A missing or unconfirmed receipt does not prove that no action ran. Never automatically repeat an uncertain action. Credential rotation changes this scope; compare scopeId. Recorded means durable intent, not provider consumption or finished work. For create_thread/create_thread_group, plannedTargets names the exact ID the reserved action creates: finding it confirms the action; not finding it is not proof it will not appear later and never authorizes a replacement request.",
      inputSchema: { requestId: requestIdSchema },
      outputSchema: z.object({
        scopeId: z.string(),
        found: z.boolean(),
        operation: operationReferenceSchema.nullable(),
        tool: z.string().nullable(),
        result: z.record(z.string(), z.unknown()).nullable(),
        // Exact target a reserved create names. Use it only to confirm a
        // positive recorded result; its absence is not proof of non-creation.
        plannedTargets: z.record(z.string(), z.string()).nullable(),
        updatedAt: z.string().nullable(),
        mayHaveApplied: z.boolean(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ requestId }) => {
      if (!options.operations || !options.operationOwner)
        throw new McpToolError(
          "unavailable",
          "Operation tracking is unavailable on this connection.",
        );
      const owner = options.operationOwner;
      const operation = await Effect.runPromise(options.operations.get(owner, requestId));
      return {
        content: [],
        structuredContent: {
          scopeId: operationScopeId(owner),
          found: operation !== null,
          operation: operation ? operationReference(owner, requestId, operation.state) : null,
          tool: operation?.tool ?? null,
          result: operation?.result ?? null,
          plannedTargets:
            operation && operation.tool in PLANNED_TARGET_TOOLS
              ? {
                  [PLANNED_TARGET_TOOLS[operation.tool as keyof typeof PLANNED_TARGET_TOOLS]]:
                    plannedTargetId(
                      owner,
                      requestId,
                      operation.tool as keyof typeof PLANNED_TARGET_TOOLS,
                    ),
                }
              : null,
          updatedAt: operation?.updatedAt ?? null,
          mayHaveApplied: true,
        },
      };
    },
  );
}
