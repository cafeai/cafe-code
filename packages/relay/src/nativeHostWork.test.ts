// @effect-diagnostics nodeBuiltinImport:off
// Native HTTP cancellation qualification uses only this test's owned listener.
import * as http from "node:http";
import { describe, expect, it, type TestContext } from "vitest";
import { randomOpaque } from "./bytes.ts";
import { NativeHostWorkClient, solveHostWork } from "./nativeHostWork.ts";
import { Lifetime } from "./lifetime.ts";
import {
  HOST_WORK,
  hostWorkDigest,
  hostWorkPrefix,
  verifyHostWork,
  HostWorkSolutions,
  type HostWorkChallenge,
} from "./hostWork.ts";
import { canonicalBytes, readCanonical } from "./protocol.ts";
import { createIdentity, deriveIdentityId } from "./crypto.ts";
import { signNetwork } from "./descriptor.ts";
import type { HostWorkScope } from "./hostWork.ts";
import { epochNow } from "./lifetime.ts";

function challenge(difficulty: number): HostWorkChallenge {
  return {
    version: 1,
    purpose: "host-reservation",
    replace: false,
    networkId: randomOpaque(),
    nodeId: randomOpaque(),
    bootId: randomOpaque(16),
    locator: randomOpaque(),
    admissionPublicKey: randomOpaque(),
    claimId: randomOpaque(16),
    reservationId: null,
    slots: 1,
    reservationMs: HOST_WORK.reservationMs,
    difficulty,
    issuedAt: 1000,
    expiresAt: 31_000,
    nonce: randomOpaque(),
    mac: randomOpaque(),
  };
}

function ownSolver(test: TestContext) {
  const lifetime = new Lifetime(),
    pending: Promise<HostWorkSolutions>[] = [];
  let closing: Promise<void> | undefined;
  const retire = () => lifetime.retire();
  const close = () => {
    retire();
    // A solver promise settles only after its actual worker exits (or before
    // acquisition is admitted). Join those original promises before the
    // lifetime's timer finalizers; cancelling the timers alone is not a join.
    return (closing ??= (async () => {
      await Promise.allSettled(pending);
      await lifetime.close();
      test.signal.removeEventListener("abort", retire);
    })());
  };
  test.signal.addEventListener("abort", retire, { once: true });
  test.onTestFinished(close);
  if (test.signal.aborted) retire();
  return {
    lifetime,
    solve(value: HostWorkChallenge) {
      // Cleanup is registered before acquisition. A late body continuation
      // after public test retirement must not acquire an unowned worker.
      test.signal.throwIfAborted();
      if (closing !== undefined) throw Error("fixture-retired");
      const promise = solveHostWork(value, lifetime);
      pending.push(promise);
      // Preserve the original promise for assertions and exact cleanup, while
      // observing rejection immediately even if the test is already retiring.
      void promise.catch(() => {});
      return promise;
    },
  };
}

describe("native host-only work solver", () => {
  it("completes disabled proof without any hash puzzle and still rejects retired work", async (test) => {
    const owner = ownSolver(test);
    const proof = await owner.solve(challenge(0));
    expect(proof).toEqual([0, 0, 0, 0]);
    expect(verifyHostWork(challenge(0), proof)).toBe(true);
    expect(verifyHostWork(challenge(0), [1, 0, 0, 0])).toBe(false);
    owner.lifetime.retire();
    await expect(owner.solve(challenge(0))).rejects.toThrow();
  });
  it("bounds queued attempts and joins an admitted HTTP request before closing", async (test) => {
    const lifetime = new Lifetime(),
      client = new NativeHostWorkClient(),
      entered = Promise.withResolvers<void>();
    let retired = false,
      requests = 0;
    let listening: Promise<void> | undefined;
    const server = http.createServer((request, response) => {
      request.on("error", () => {});
      response.on("error", () => {});
      if (retired) {
        request.destroy();
        response.destroy();
        return;
      }
      requests++;
      entered.resolve();
      request.resume();
    });
    server.on("error", () => {});
    const retire = () => {
      retired = true;
      lifetime.retire();
      server.closeAllConnections();
    };
    const close = async () => {
      retire();
      await client.close();
      await listening?.catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await lifetime.close();
    };
    test.signal.addEventListener("abort", retire, { once: true });
    test.onTestFinished(close);
    const root = await createIdentity(),
      node = await createIdentity(),
      admission = await createIdentity();
    if (retired) throw Error("fixture-retired");
    listening = new Promise<void>((resolve, reject) => {
      const failed = () => reject(Error("fixture-listen-refused"));
      server.once("error", failed);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", failed);
        resolve();
      });
    });
    await listening;
    if (retired) {
      await close();
      throw Error("fixture-retired");
    }
    const address = server.address();
    if (!address || typeof address === "string") throw Error("fixture-address");
    const member = {
      id: deriveIdentityId("node", node.publicKey),
      publicKey: node.publicKey,
      url: `ws://127.0.0.1:${address.port}/v1/relay`,
    };
    const network = await signNetwork({
      root,
      revision: 1,
      expiresAt: epochNow() + 60_000,
      nodes: [member],
    });
    const scope: HostWorkScope = {
      network,
      node: member,
      locator: randomOpaque(),
      capacityToken: randomOpaque(),
      admissionIdentity: admission,
      allowLoopbackTest: true,
    };
    const pending = Array.from({ length: HOST_WORK.jobs }, () => client.acquire(scope, lifetime));
    const settled = Promise.allSettled(pending);
    expect(() => client.acquire(scope, lifetime)).toThrow();
    await entered.promise;
    expect(requests).toBe(1);
    await client.close();
    expect((await settled).every((value) => value.status === "rejected")).toBe(true);
    expect(requests).toBe(1);
  });
  it("joins its native worker and solves all four parts using interoperable SHA-256 bytes", async (test) => {
    const owner = ownSolver(test);
    // Public inputs were fixed before the independent reference search. Keep
    // default-strength work and the real bounded worker, but do not turn a
    // correctness test into a fresh probabilistic search-cost sample per run.
    // The reference used createHash with explicit big-endian counter bytes,
    // crosschecked against WebCrypto; all four first solutions take 118002
    // trials. Literal inputs keep that reference independent of later policy.
    const value: HostWorkChallenge = {
      version: 1,
      purpose: "host-reservation",
      replace: false,
      networkId: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      nodeId: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
      bootId: "AwMDAwMDAwMDAwMDAwMDAw",
      locator: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ",
      admissionPublicKey: "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU",
      claimId: "BgYGBgYGBgYGBgYGBgYGBg",
      reservationId: null,
      slots: 1,
      reservationMs: 600_000,
      difficulty: 17,
      issuedAt: 1000,
      expiresAt: 31_000,
      nonce: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
      mac: "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg",
    };
    const solutions = await owner.solve(value);
    expect(solutions).toEqual([8171, 56137, 5895, 47795]);
    expect(verifyHostWork(value, solutions)).toBe(true);
    const prefix = hostWorkPrefix(value),
      bytes = new Uint8Array(37);
    expect(Buffer.from(prefix).toString("hex")).toBe(
      "72d8e0e6fc5bdb8d956f2840035302bc656d688d1ea6c3491bf510d01586c37c",
    );
    bytes.set(prefix);
    bytes[32] = 3;
    new DataView(bytes.buffer).setUint32(33, solutions[3]);
    expect(hostWorkDigest(prefix, 3, solutions[3])).toEqual(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    );
    expect(() => readCanonical(HostWorkSolutions, canonicalBytes([1, 2, 3]))).toThrow();
    expect(() => readCanonical(HostWorkSolutions, canonicalBytes([1, 2, 3, -1]))).toThrow();
  });
  it("cancels a held worker and rejects a late or unsupported result", async (test) => {
    const owner = ownSolver(test);
    const pending = owner.solve(challenge(HOST_WORK.maximumDifficulty));
    owner.lifetime.retire();
    await expect(pending).rejects.toThrow();
    const fresh = ownSolver(test);
    await expect(fresh.solve(challenge(HOST_WORK.maximumDifficulty + 1))).rejects.toThrow();
  });
});
