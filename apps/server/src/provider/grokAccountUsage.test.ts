import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  parseGrokAccountRateLimitsPayload,
  readGrokAccountRateLimits,
} from "./grokAccountUsage.ts";

const CHECKED_AT = "2026-08-16T12:00:00.000Z";
const PERIOD_START = "2026-08-14T08:49:34.446428+00:00";
const PERIOD_END = "2026-08-21T08:49:34.446428+00:00";

function currentBillingPayload(usedPercent = 1) {
  return {
    config: {
      currentPeriod: {
        type: "weekly",
        start: PERIOD_START,
        end: PERIOD_END,
      },
      creditUsagePercent: usedPercent,
      productUsage: [{ product: "Build", usagePercent: usedPercent }],
      onDemandCap: { val: 1_000 },
      onDemandUsed: { val: 50 },
      prepaidBalance: { val: 500 },
      topUpMethod: "automatic",
    },
  };
}

function authStore(input?: { readonly expiresAt?: string; readonly key?: string }) {
  return JSON.stringify({
    "https://auth.x.ai::client-id": {
      key: input?.key ?? "private-access-token",
      user_id: "user-123",
      auth_mode: "oidc",
      expires_at: input?.expiresAt ?? "2026-08-17T12:00:00.000Z",
    },
  });
}

describe("parseGrokAccountRateLimitsPayload", () => {
  it("maps only unified usage and period metadata into Cafe's existing quota shape", () => {
    const parsed = parseGrokAccountRateLimitsPayload(currentBillingPayload(1), CHECKED_AT);

    expect(parsed).toEqual({
      rateLimits: {
        limitId: "grok",
        limitName: "Grok usage",
        primary: {
          usedPercent: 1,
          windowDurationMins: 10_080,
          resetsAt: Math.floor(Date.parse(PERIOD_END) / 1_000),
        },
      },
      rateLimitsByLimitId: {
        grok: {
          limitId: "grok",
          limitName: "Grok usage",
          primary: {
            usedPercent: 1,
            windowDurationMins: 10_080,
            resetsAt: Math.floor(Date.parse(PERIOD_END) / 1_000),
          },
        },
      },
      checkedAt: CHECKED_AT,
    });
    expect(JSON.stringify(parsed)).not.toMatch(/prepaid|topUp|onDemand|productUsage/);
  });

  it("accepts the legacy included-limit shape without using on-demand monetary fields", () => {
    const parsed = parseGrokAccountRateLimitsPayload(
      {
        result: {
          config: {
            monthlyLimit: { val: 1_000 },
            usage: { totalUsed: { val: 250 } },
            billingPeriodStart: PERIOD_START,
            billingPeriodEnd: PERIOD_END,
          },
        },
      },
      CHECKED_AT,
    );
    expect(parsed?.rateLimits.primary?.usedPercent).toBe(25);

    expect(
      parseGrokAccountRateLimitsPayload(
        { config: { onDemandCap: { val: 100 }, onDemandUsed: { val: 90 } } },
        CHECKED_AT,
      ),
    ).toBeUndefined();
  });

  it("clamps malformed upstream percentages to the displayable quota range", () => {
    expect(
      parseGrokAccountRateLimitsPayload(currentBillingPayload(104.5), CHECKED_AT)?.rateLimits
        .primary?.usedPercent,
    ).toBe(100);
    expect(
      parseGrokAccountRateLimitsPayload(currentBillingPayload(-4), CHECKED_AT)?.rateLimits.primary
        ?.usedPercent,
    ).toBe(0);
  });
});

it.layer(NodeServices.layer)("readGrokAccountRateLimits", (it) => {
  it.effect("uses a regular GROK_HOME auth file and keeps the bearer out of the result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cafecode-grok-usage-",
        });
        yield* fileSystem.writeFileString(path.join(homePath, "auth.json"), authStore());
        yield* fileSystem.chmod(path.join(homePath, "auth.json"), 0o600);

        const fetchMock = vi.fn(
          async (_request: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const headers = new Headers(init?.headers);
            expect(headers.get("authorization")).toBe("Bearer private-access-token");
            expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
            expect(headers.get("x-userid")).toBe("user-123");
            expect(headers.get("x-grok-client-version")).toBe("1.0.4");
            return new Response(JSON.stringify(currentBillingPayload(1)), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        );
        const result = yield* readGrokAccountRateLimits(
          { enabled: true, binaryPath: "grok", homePath, customModels: [] },
          {},
          CHECKED_AT,
          {
            fetch: fetchMock as typeof globalThis.fetch,
            nowMs: Date.parse(CHECKED_AT),
            clientVersion: "1.0.4",
          },
        );

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(result?.rateLimits.primary?.usedPercent).toBe(1);
        expect(JSON.stringify(result)).not.toContain("private-access-token");
        expect(JSON.stringify(result)).not.toContain("user-123");
      }),
    ),
  );

  it.effect("does not send expired or header-unsafe credentials", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cafecode-grok-expired-usage-",
        });
        const fetchMock = vi.fn(async (): Promise<Response> => new Response("{}"));

        yield* fileSystem.writeFileString(
          path.join(homePath, "auth.json"),
          authStore({ expiresAt: "2026-08-15T12:00:00.000Z" }),
        );
        expect(
          yield* readGrokAccountRateLimits(
            { enabled: true, binaryPath: "grok", homePath, customModels: [] },
            {},
            CHECKED_AT,
            { fetch: fetchMock as typeof globalThis.fetch, nowMs: Date.parse(CHECKED_AT) },
          ),
        ).toBeUndefined();

        yield* fileSystem.writeFileString(
          path.join(homePath, "auth.json"),
          authStore({ key: "unsafe\nheader" }),
        );
        expect(
          yield* readGrokAccountRateLimits(
            { enabled: true, binaryPath: "grok", homePath, customModels: [] },
            {},
            CHECKED_AT,
            { fetch: fetchMock as typeof globalThis.fetch, nowMs: Date.parse(CHECKED_AT) },
          ),
        ).toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("rejects a symlinked Grok auth file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homePath = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cafecode-grok-symlink-usage-",
        });
        const targetPath = path.join(homePath, "auth-target.json");
        const authPath = path.join(homePath, "auth.json");
        yield* fileSystem.writeFileString(targetPath, authStore());
        const symlinkExit = yield* fileSystem.symlink(targetPath, authPath).pipe(Effect.exit);
        if (Exit.isFailure(symlinkExit) && process.platform === "win32") {
          return;
        }
        expect(Exit.isSuccess(symlinkExit)).toBe(true);

        const fetchMock = vi.fn(async (): Promise<Response> => new Response("{}"));
        expect(
          yield* readGrokAccountRateLimits(
            { enabled: true, binaryPath: "grok", homePath, customModels: [] },
            {},
            CHECKED_AT,
            { fetch: fetchMock as typeof globalThis.fetch, nowMs: Date.parse(CHECKED_AT) },
          ),
        ).toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
      }),
    ),
  );
});
