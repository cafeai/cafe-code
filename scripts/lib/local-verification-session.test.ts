import { describe, expect, it, vi, afterEach } from "vitest";
import {
  localResultCacheArguments,
  openLocalVerificationCache,
} from "./local-verification-session.ts";
import type { LocalVerificationTask } from "./local-verification-cache-contract.ts";

const { store, fingerprint } = vi.hoisted(() => ({
  store: vi.fn(async (_directory: string) => ({
    authenticateEnvironment: () => "a".repeat(64),
    read: async () => false,
    publish: async () => true,
  })),
  fingerprint: vi.fn(
    (
      _root: string,
      _store: unknown,
      _onRefusal?: (reason: string, detail?: unknown, task?: LocalVerificationTask) => void,
    ) =>
      async () =>
        undefined,
  ),
}));
vi.mock("./local-verification-cache-store.ts", () => ({
  createLocalVerificationReceiptStore: store,
}));
vi.mock("./local-verification-inputs.ts", () => ({
  createLocalVerificationFingerprint: fingerprint,
}));
afterEach(() => {
  vi.unstubAllEnvs();
  store.mockClear();
  fingerprint.mockClear();
});

describe("explicit local result-cache session", () => {
  it("never enables reuse from ambient settings or inside CI/release hosts", async () => {
    vi.stubEnv("CI", undefined);
    vi.stubEnv("GITHUB_ACTIONS", undefined);
    vi.stubEnv("CAFE_CODE_LOCAL_VERIFICATION_CACHE", "1");
    expect(await openLocalVerificationCache(import.meta.dirname, false)).toBeUndefined();
    for (const name of ["CI", "GITHUB_ACTIONS"]) {
      vi.stubEnv(name, "true");
      expect(await openLocalVerificationCache(import.meta.dirname, true)).toBeUndefined();
      vi.stubEnv(name, undefined);
    }
    expect(store).not.toHaveBeenCalled();
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "binds private cache selection to a checkout without touching its permissions",
    async () => {
      vi.stubEnv("CI", undefined);
      vi.stubEnv("GITHUB_ACTIONS", undefined);
      expect(await openLocalVerificationCache(import.meta.dirname, true)).toBeDefined();
      expect(
        await openLocalVerificationCache(`${import.meta.dirname}/other-checkout`, true),
      ).toBeDefined();
      const paths = store.mock.calls.map((call) => call[0]);
      expect(paths).toHaveLength(2);
      expect(paths[0]).not.toBe(paths[1]);
      for (const path of paths)
        expect(path).toMatch(/[/\\]cafe-code-local-verification-[a-f0-9]{64}$/u);
    },
  );

  it("accepts one exact opt-in but never turns unknown arguments into selection", () => {
    expect(localResultCacheArguments(["--reuse-local-results", "--concurrency=2"])).toEqual({
      requested: true,
      remaining: ["--concurrency=2"],
    });
    expect(localResultCacheArguments(["--other"])).toEqual({
      requested: false,
      remaining: ["--other"],
    });
    expect(() =>
      localResultCacheArguments(["--reuse-local-results", "--reuse-local-results"]),
    ).toThrow("once");
  });

  it.skipIf(process.platform === "win32")(
    "reports bounded input phases without disclosing task values or producer detail",
    async (context) => {
      vi.stubEnv("CI", undefined);
      vi.stubEnv("GITHUB_ACTIONS", undefined);
      const output: string[] = [];
      const write = vi.spyOn(process.stdout, "write").mockImplementation((value) => {
        output.push(String(value));
        return true;
      });
      context.onTestFinished(() => write.mockRestore());
      const cache = await openLocalVerificationCache(import.meta.dirname, true);
      expect(cache).toBeDefined();
      const task: LocalVerificationTask = {
        id: "PRIVATE_TASK",
        cwd: "/PRIVATE_PATH",
        args: ["PRIVATE_ARGUMENT"],
        environment: { PRIVATE_ENVIRONMENT: "PRIVATE_VALUE" },
        scope: { kind: "node", workspace: "apps/server" },
      };
      const observed: unknown[] = [];
      let executed = 0;
      await cache!.run(
        task,
        context.signal,
        async () => {
          executed += 1;
        },
        (value) => observed.push(value),
      );
      expect(executed).toBe(1);
      expect(observed).toHaveLength(2);
      const refusal = fingerprint.mock.calls[0]?.[2];
      expect(refusal).toBeDefined();
      // An opaque detail object cannot have getters/stringification invoked by
      // ordinary operational diagnostics; it is discarded rather than copied.
      const detail = new Proxy(
        {},
        {
          get() {
            throw new Error("PRIVATE_DETAIL");
          },
        },
      );
      refusal!("imports", detail, task);
      expect(output.join("")).toContain("Local cache server-node pre-execute: unavailable");
      expect(output.join("")).toContain("Local cache server-node post-execute: unavailable");
      expect(output.join("")).toContain("Local cache server-node: input-refused imports.");
      expect(output.join("")).not.toContain("PRIVATE_");
    },
  );
});
