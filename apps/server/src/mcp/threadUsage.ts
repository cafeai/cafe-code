import { McpToolError } from "./results.ts";
import { ThreadId } from "@cafecode/contracts";
import { deriveLatestContextWindowUsage } from "@cafecode/shared/threadResourceUsage";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { z } from "zod";

import type { CafeMcpDependencies, CafeMcpServerOptions } from "./CafeMcpServer.ts";
import { cachedProviderQuota, nullableQuotaNumber, quotaSchema } from "./quotaMetadata.ts";

const nullableNumber = nullableQuotaNumber;
const usageSchema = z.object({
  threadId: z.string(),
  target: z.object({
    selection: z.enum(["explicit", "authenticated-launch"]),
    scope: z.literal("cafe-thread"),
    launchMatchesSession: z.boolean().nullable(),
  }),
  provider: z.object({
    instanceId: z.string().nullable(),
    driver: z.string().nullable(),
    source: z.enum(["session", "configured", "unknown"]),
  }),
  context: z.object({
    status: z.enum(["reported", "unknown"]),
    scope: z.literal("cafe-thread"),
    observedAt: z.string().nullable(),
    ownerAttribution: z.literal("not-recorded"),
    usedTokens: nullableNumber,
    maxTokens: nullableNumber,
    remainingTokens: nullableNumber,
    usedPercent: nullableNumber,
    totalProcessedTokens: nullableNumber,
    compactsAutomatically: z.boolean().nullable(),
    autoCompactTokenLimit: nullableNumber,
  }),
  quota: quotaSchema,
});

/**
 * Read a whitelist of already-reported metadata. In particular, this path
 * never lists native sessions (which refreshes runtime-owner heartbeats),
 * refreshes an account, hydrates a transcript or submits a provider request.
 */
export function registerThreadUsageTool(
  server: McpServer,
  dependencies: CafeMcpDependencies,
  options: CafeMcpServerOptions,
): void {
  server.registerTool(
    "get_thread_usage",
    {
      title: "Get context and provider quota",
      description:
        "Read a chat's last-reported context tokens and cached account quota without loading messages. For account usage limits across Claude/Codex, model-specific allowances, extra usage or reset details, use get_provider_usage directly instead; it needs no chat lookup. Omit threadId on Cafe-issued connections to use the launch chat; inherited subagents still identify that Cafe chat, not the child's native context. Manual clients supply threadId. Missing values are unknown, not zero. Account quota is shared across chats; checkedAt does not date every retained window. Context reports do not expose Codex's hidden compaction estimate.",
      inputSchema: { threadId: z.string().trim().min(1).optional() },
      outputSchema: usageSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ threadId: requestedThreadId }) => {
      const launch = options.managementLaunchContext;
      const selectedThreadId = requestedThreadId ?? launch?.threadId;
      if (selectedThreadId === undefined) {
        throw new McpToolError(
          "invalid_request",
          "Pass threadId explicitly; this connection has no authenticated Cafe launch chat.",
        );
      }
      const threadId = ThreadId.make(selectedThreadId);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          // Resolve the shell first so missing/deleted targets do not read other
          // metadata. The dedicated indexed report query remains independent of
          // the normal activity tail cap and returns at most one row.
          const thread = yield* dependencies.projectionSnapshotQuery.getThreadShellById(threadId);
          if (Option.isNone(thread)) return null;
          const report =
            yield* dependencies.projectionSnapshotQuery.getThreadContextWindowActivity(threadId);
          const context = deriveLatestContextWindowUsage(
            Option.isSome(report) ? [report.value] : [],
          );
          const providers = yield* dependencies.providerRegistry.getProviders;
          const sessionInstanceId = thread.value.session?.providerInstanceId;
          const instanceId = sessionInstanceId ?? thread.value.modelSelection.instanceId;
          const provider = providers.find((value) => value.instanceId === instanceId);
          // The exact projected native instance wins over the next-turn selection.
          // A legacy session without an instance can only identify configuration.
          const source =
            sessionInstanceId !== undefined ? ("session" as const) : ("configured" as const);
          return {
            threadId: selectedThreadId,
            target: {
              selection:
                requestedThreadId === undefined
                  ? ("authenticated-launch" as const)
                  : ("explicit" as const),
              scope: "cafe-thread" as const,
              launchMatchesSession:
                launch?.threadId === selectedThreadId && sessionInstanceId !== undefined
                  ? launch.providerInstanceId === sessionInstanceId
                  : null,
            },
            provider: { instanceId, driver: provider?.driver ?? null, source },
            context: {
              status: context ? ("reported" as const) : ("unknown" as const),
              scope: "cafe-thread" as const,
              observedAt: context?.updatedAt ?? null,
              // Historical context activity predates native-generation attribution.
              // Do not turn a signed launch intent into proof of that report's owner.
              ownerAttribution: "not-recorded" as const,
              usedTokens: context?.usedTokens ?? null,
              maxTokens: context?.maxTokens ?? null,
              remainingTokens: context?.remainingTokens ?? null,
              usedPercent: context?.usedPercentage ?? null,
              totalProcessedTokens: context?.totalProcessedTokens ?? null,
              compactsAutomatically: context?.compactsAutomatically ?? null,
              autoCompactTokenLimit: context?.autoCompactTokenLimit ?? null,
            },
            quota: cachedProviderQuota(provider, instanceId),
          };
        }),
      ).catch(() => {
        // Provider, SQL and decode errors may contain private paths or payloads.
        // This public tool deliberately emits a fixed failure instead.
        throw new McpToolError(
          "invalid_request",
          "Unable to read thread usage metadata. Retry the read later.",
        );
      });
      if (result === null)
        throw new McpToolError(
          "invalid_request",
          "The requested active Cafe thread does not exist.",
        );
      return {
        structuredContent: result,
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );
}
