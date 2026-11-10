// @effect-diagnostics nodeBuiltinImport:off
// Native HTTP cancellation qualification uses only this test's owned listener.
import * as http from "node:http";
import { describe, expect, it } from "vitest";
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

describe("native host-only work solver", () => {
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
    const lifetime = new Lifetime();
    test.signal.addEventListener("abort", () => lifetime.retire(), { once: true });
    test.onTestFinished(() => lifetime.close());
    const value = challenge(8),
      solutions = await solveHostWork(value, lifetime);
    expect(verifyHostWork(value, solutions)).toBe(true);
    const prefix = hostWorkPrefix(value),
      bytes = new Uint8Array(37);
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
    const lifetime = new Lifetime();
    test.signal.addEventListener("abort", () => lifetime.retire(), { once: true });
    test.onTestFinished(() => lifetime.close());
    const pending = solveHostWork(challenge(HOST_WORK.maximumDifficulty), lifetime);
    lifetime.retire();
    await expect(pending).rejects.toThrow();
    const fresh = new Lifetime();
    try {
      await expect(
        solveHostWork(challenge(HOST_WORK.maximumDifficulty + 1), fresh),
      ).rejects.toThrow();
    } finally {
      await fresh.close();
    }
  });
});
