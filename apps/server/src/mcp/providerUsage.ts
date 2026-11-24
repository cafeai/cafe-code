import {
  ProviderSessionQuotaReport,
  type ProviderInstanceId,
  type ServerProvider,
} from "@cafecode/contracts";
import { deriveCodexRateLimitBuckets } from "@cafecode/shared/threadResourceUsage";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { z } from "zod";
import type { CafeMcpDependencies } from "./CafeMcpServer.ts";
import { matchesQuery, pageInput, pageOutput, paginate } from "./pagination.ts";
import {
  accountRateLimitsForProvider,
  cachedProviderQuota,
  nullableQuotaNumber,
  quotaLimitSchema,
  quotaSchema,
} from "./quotaMetadata.ts";
import { jsonToolResult, McpToolError } from "./results.ts";
import { providerInstanceId } from "./views.ts";
import type { ProviderRegistryShape } from "../provider/Services/ProviderRegistry.ts";

const resetCreditSchema = z.object({
  id: z.string(),
  resetType: z.enum(["codexRateLimits", "unknown"]),
  status: z.enum(["available", "redeeming", "redeemed", "unknown"]),
  grantedAtEpochSeconds: nullableQuotaNumber,
  expiresAtEpochSeconds: nullableQuotaNumber,
  title: z.string().nullable(),
  description: z.string().nullable(),
});
const cachedRateLimitsSchema = quotaSchema.extend({
  source: z.literal("cached"),
  limits: z
    .array(
      quotaLimitSchema.extend({
        planType: z.string().nullable(),
        rateLimitReachedType: z.string().nullable(),
        spendControlReached: z.boolean().nullable(),
        individualLimit: z
          .object({
            limit: z.string(),
            used: z.string(),
            remainingPercent: z.number().finite(),
            resetsAtEpochSeconds: nullableQuotaNumber,
          })
          .nullable(),
      }),
    )
    .max(128),
  resetCredits: z.object({
    credits: z.array(resetCreditSchema).max(128).nullable(),
    truncated: z.boolean(),
  }),
});
const accountQuotaSchema = z.object({
  status: z.enum(["reported", "unknown", "unsupported"]),
  report: z
    .object({
      source: z.literal("claude-cli"),
      observedAt: z.string(),
      meters: z
        .array(
          z.object({
            kind: z.string(),
            group: z.string(),
            modelLabel: z.string().nullable(),
            surfaceLabel: z.string().nullable(),
            usedPercent: z.number().finite().min(0).max(100),
            remainingPercent: z.number().finite().min(0).max(100),
            resetsAt: z.string().nullable(),
            severity: z.string(),
            isActive: z.boolean(),
          }),
        )
        .max(128)
        .nullable(),
      extraUsage: z
        .object({
          enabled: z.boolean(),
          monthlyLimit: nullableQuotaNumber,
          usedCredits: nullableQuotaNumber,
          usedPercent: nullableQuotaNumber,
          currency: z.string().nullable(),
          amountsUnit: z.literal("minor-currency-units"),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
});
type AccountQuota = z.infer<typeof accountQuotaSchema>;
const isAccountReport = Schema.is(ProviderSessionQuotaReport);

/** The native reader already admits a bounded, redacted report. Project an
 * explicit whitelist again at the management boundary, preserving row order,
 * duplicate/model labels and missing extra usage. No selected chat/model can
 * hide Fable or substitute the normal weekly allowance for its own meter. */
function accountQuota(report: ProviderSessionQuotaReport | null): AccountQuota {
  if (!report || !isAccountReport(report) || report.source !== "claude-cli")
    return { status: "unknown", report: null };
  return {
    status: "reported",
    report: {
      source: report.source,
      observedAt: report.observedAt,
      meters:
        report.meters?.map((meter) => ({
          kind: meter.kind,
          group: meter.group,
          modelLabel: meter.modelLabel ?? null,
          surfaceLabel: meter.surfaceLabel ?? null,
          usedPercent: meter.usedPercent,
          remainingPercent: 100 - meter.usedPercent,
          resetsAt: meter.resetsAt,
          severity: meter.severity,
          isActive: meter.isActive,
        })) ?? null,
      ...(report.extraUsage === undefined
        ? {}
        : {
            extraUsage:
              report.extraUsage === null
                ? null
                : {
                    enabled: report.extraUsage.enabled,
                    monthlyLimit: report.extraUsage.monthlyLimit,
                    usedCredits: report.extraUsage.usedCredits,
                    usedPercent: report.extraUsage.usedPercent,
                    currency: report.extraUsage.currency ?? null,
                    amountsUnit: "minor-currency-units" as const,
                  },
          }),
    },
  };
}

function cachedRateLimits(provider: ServerProvider) {
  const account = accountRateLimitsForProvider(provider);
  const snapshots = new Map(
    deriveCodexRateLimitBuckets(account).map((bucket) => [bucket.id, bucket.snapshot]),
  );
  const quota = cachedProviderQuota(provider, provider.instanceId);
  const credits = account?.rateLimitResetCredits?.credits;
  return {
    ...quota,
    source: "cached" as const,
    limits: quota.limits.map((limit) => {
      const snapshot = snapshots.get(limit.limitId);
      return {
        ...limit,
        planType: snapshot?.planType ?? null,
        rateLimitReachedType: snapshot?.rateLimitReachedType ?? null,
        spendControlReached: snapshot?.spendControlReached ?? null,
        individualLimit: snapshot?.individualLimit
          ? {
              limit: snapshot.individualLimit.limit,
              used: snapshot.individualLimit.used,
              remainingPercent: snapshot.individualLimit.remainingPercent,
              resetsAtEpochSeconds: snapshot.individualLimit.resetsAt,
            }
          : null,
      };
    }),
    resetCredits: {
      credits:
        credits?.slice(0, 128).map((credit) => ({
          id: credit.id,
          resetType: credit.resetType,
          status: credit.status,
          grantedAtEpochSeconds: credit.grantedAt,
          expiresAtEpochSeconds: credit.expiresAt ?? null,
          title: credit.title ?? null,
          description: credit.description ?? null,
        })) ?? null,
      truncated: (credits?.length ?? 0) > 128,
    },
  };
}

/** Account reads use the exact instance registry's existing control-only
 * capability, including its replacement fence, 60-second single-flight cache
 * and joined child cleanup. No session inventory, chat projection or full
 * provider refresh is involved. Limit native admission to two at once and a
 * shared 15-second budget; completed accounts survive a sibling timeout. */
export function readProviderAccountQuotaReports(
  providers: ReadonlyArray<ServerProvider>,
  read: ProviderRegistryShape["readInstanceAccountQuota"],
) {
  return Effect.gen(function* () {
    const reports = new Map<ProviderInstanceId, AccountQuota>();
    if (read) {
      let next = 0;
      let retired = false;
      const worker: Effect.Effect<void> = Effect.suspend(() => {
        if (retired || next >= providers.length) return Effect.void;
        const provider = providers[next++]!;
        return Effect.gen(function* () {
          if (
            provider.driver !== "claudeAgent" ||
            !provider.enabled ||
            provider.availability === "unavailable" ||
            provider.auth.status !== "authenticated"
          )
            return;
          const report = yield* Effect.suspend(() => read(provider.instanceId)).pipe(
            Effect.map(accountQuota),
            // The native cache can retain an interrupted lookup for its TTL.
            // That is unavailable data for this account, not cancellation of
            // the whole MCP request. Actual caller cancellation still retires
            // the enclosing owner before its scope interrupts/joins workers.
            Effect.catchCause(() =>
              Effect.succeed<AccountQuota>({ status: "unknown", report: null }),
            ),
          );
          reports.set(provider.instanceId, report);
        }).pipe(Effect.andThen(worker));
      });
      // Own both workers in a scope outside the timeout's racing joins. The
      // admission fence retires before that scope interrupts/joins workers,
      // including cancellation between the two acquisitions. A race or a
      // collection callback's completion alone is not reader-close evidence.
      yield* Effect.gen(function* () {
        const first = yield* worker.pipe(Effect.forkScoped);
        const second = yield* worker.pipe(Effect.forkScoped);
        yield* Fiber.join(first).pipe(
          Effect.andThen(Fiber.join(second)),
          Effect.timeoutOption("15 seconds"),
        );
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            retired = true;
          }),
        ),
        Effect.scoped,
      );
    }
    return reports;
  });
}

export function registerProviderUsageTool(
  server: McpServer,
  dependencies: CafeMcpDependencies,
): void {
  server.registerTool(
    "get_provider_usage",
    {
      title: "Get provider usage limits",
      description:
        "Get account usage limits across configured providers in one call, independent of any chat. Call directly for current quotas; no get_cafe_context, list_providers or thread lookup is needed. Filter by exact instanceId or name/driver query, or omit filters for all providers (follow pagination). Includes cached quota windows, reset times/credits, plan and spend metadata, plus Claude's normal and model-specific meters (including Fable) and extra usage from its bounded account reader. Claude may reuse its 60-second cache; cachedRateLimits.checkedAt and accountQuota.report.observedAt date separate reports, not guaranteed fresh upstream data. Missing values are unknown, not zero or unlimited. Amounts retain provider units. No inference, reset redemption or settings change.",
      inputSchema: { instanceId: providerInstanceId.optional(), ...pageInput },
      outputSchema: z.object({
        providers: z
          .array(
            z.object({
              instanceId: z.string(),
              driver: z.string(),
              displayName: z.string().nullable(),
              enabled: z.boolean(),
              authStatus: z.string(),
              cachedRateLimits: cachedRateLimitsSchema,
              accountQuota: accountQuotaSchema,
            }),
          )
          .max(100),
        ...pageOutput,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ instanceId, query, limit, cursor }, extra) => {
      const providers = await Effect.runPromise(dependencies.providerRegistry.getProviders, {
        signal: extra.signal,
      }).catch(() => {
        throw new McpToolError(
          "unavailable",
          "Unable to read provider usage metadata.",
          "Retry the read later.",
        );
      });
      const page = paginate(
        providers.filter(
          (provider) =>
            (instanceId === undefined || provider.instanceId === instanceId) &&
            matchesQuery(query, provider.displayName, provider.instanceId, provider.driver),
        ),
        { limit, ...(cursor ? { cursor } : {}) },
        { tool: "get_provider_usage", instanceId, query },
        (provider) => provider.instanceId,
      );
      const read = dependencies.providerRegistry.readInstanceAccountQuota;
      const reports = await Effect.runPromise(readProviderAccountQuotaReports(page.items, read), {
        signal: extra.signal,
      });
      const { items, ...metadata } = page;
      return jsonToolResult({
        providers: items.map((provider) => ({
          instanceId: provider.instanceId,
          driver: provider.driver,
          displayName: provider.displayName ?? null,
          enabled: provider.enabled,
          authStatus: provider.auth.status,
          cachedRateLimits: cachedRateLimits(provider),
          accountQuota: reports.get(provider.instanceId) ?? {
            status:
              provider.driver === "claudeAgent" && read
                ? ("unknown" as const)
                : ("unsupported" as const),
            report: null,
          },
        })),
        ...metadata,
      });
    },
  );
}
