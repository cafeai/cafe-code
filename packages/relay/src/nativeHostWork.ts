// @effect-diagnostics nodeBuiltinImport:off
// Exact native HTTP/worker ownership. The worker runs only checked-in source,
// receives public puzzle bytes, inherits no environment/preloads and joins exit
// before a result is adopted or the next queued reservation can start.
import { Worker } from "node:worker_threads";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupFunction } from "node:net";
import { randomOpaque } from "./bytes.ts";
import { signBytes } from "./crypto.ts";
import { deferred } from "./deferred.ts";
import { relayHttpEndpoint } from "./descriptor.ts";
import { RelayError, requireRelay } from "./errors.ts";
import { epochNow, monotonicMillis, Lifetime } from "./lifetime.ts";
import { RELAY_LIMITS } from "./limits.ts";
import { canonicalBytes, readCanonical } from "./protocol.ts";
import {
  HOST_WORK,
  HostReservation,
  HostWorkChallenge,
  HostWorkSolutions,
  hostWorkPrefix,
  hostWorkProof,
  validateHostWorkScope,
  verifyHostWork,
  type HostWorkClient,
  type HostWorkScope,
} from "./hostWork.ts";

const solverSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const bytes = Buffer.alloc(37); bytes.set(workerData.prefix);
const start = performance.now(), solutions = []; let trials = 0;
const bits = workerData.difficulty - 2, full = Math.floor(bits / 8), rest = bits % 8;
outer: for (let part = 0; part < 4; part++) {
 bytes[32] = part;
 for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
  if ((trials % 2048) === 0 && (trials >= workerData.trials || performance.now() - start >= workerData.budgetMs)) break outer;
  bytes.writeUInt32BE(nonce, 33); trials++;
  const hash = createHash('sha256').update(bytes).digest();
  let valid = true;
  for (let i = 0; i < full; i++) if (hash[i] !== 0) valid = false;
  if (valid && (rest === 0 || (hash[full] >>> (8-rest)) === 0)) { solutions.push(nonce); break; }
 }
}
if (solutions.length === 4) parentPort.postMessage(solutions);
parentPort.close();
`;

export async function solveHostWork(
  challenge: HostWorkChallenge,
  lifetime: Lifetime,
): Promise<HostWorkSolutions> {
  if (challenge.difficulty === 0) {
    requireRelay(lifetime.active, "UNAVAILABLE");
    return [0, 0, 0, 0];
  }
  requireRelay(
    lifetime.active &&
      challenge.difficulty >= 2 &&
      challenge.difficulty <= HOST_WORK.maximumDifficulty,
    "AUTH_DENIED",
  );
  const result = deferred<HostWorkSolutions>();
  let observed: HostWorkSolutions | undefined,
    failed = false;
  const worker = new Worker(solverSource, {
    eval: true,
    execArgv: [],
    env: {},
    stdout: true,
    stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 1 },
    workerData: {
      prefix: hostWorkPrefix(challenge),
      difficulty: challenge.difficulty,
      trials: HOST_WORK.trials,
      budgetMs: HOST_WORK.solveMs,
    },
  });
  const retire = () => {
    failed = true;
    void worker.terminate().catch(() => {});
  };
  lifetime.signal.addEventListener("abort", retire, { once: true });
  const cancel = lifetime.later(HOST_WORK.solveMs + 500, retire);
  worker.on("error", retire);
  worker.on("messageerror", retire);
  worker.stdout.on("error", retire);
  worker.stderr.on("error", retire);
  worker.stdout.on("data", retire);
  worker.stderr.on("data", retire);
  worker.on("message", (value) => {
    try {
      requireRelay(!observed && lifetime.active);
      observed = readCanonical(HostWorkSolutions, canonicalBytes(value, 128), 128);
    } catch {
      retire();
    }
  });
  worker.once("exit", (code) => {
    cancel();
    lifetime.signal.removeEventListener("abort", retire);
    try {
      if (
        !failed &&
        code === 0 &&
        lifetime.active &&
        observed &&
        verifyHostWork(challenge, observed)
      )
        result.resolve(observed);
      else result.reject(new RelayError("UNAVAILABLE"));
    } catch {
      result.reject(new RelayError("UNAVAILABLE"));
    }
  });
  if (!lifetime.active) retire();
  return result.promise;
}

export interface HostWorkTls {
  readonly ca?: string;
  readonly servername?: string;
  readonly lookup?: LookupFunction;
}

/** Bounded native POST. Includes actual request/response close in cancellation. */
async function post(
  url: string,
  body: Uint8Array,
  lifetime: Lifetime,
  tls: HostWorkTls,
  timeoutMs = 10_000,
) {
  requireRelay(lifetime.active && body.byteLength <= 4096);
  const deadline = lifetime.deadline(timeoutMs),
    result = deferred<Uint8Array>();
  const address = new URL(url);
  const request = (address.protocol === "https:" ? https : http).request(address, {
    ...tls,
    method: "POST",
    agent: false,
    maxHeaderSize: 8192,
    headers: {
      "content-type": "application/json",
      "content-length": body.byteLength,
      "x-cafe-host-work-zero": "1",
    },
  });
  const requestClosed = new Promise<void>((resolve) => request.once("close", resolve));
  let response: http.IncomingMessage | undefined, responseClosed: Promise<void> | undefined;
  const fail = () => result.reject(new RelayError("UNAVAILABLE"));
  const retire = () => {
    fail();
    request.destroy();
    response?.destroy();
  };
  request.on("error", fail);
  request.once("close", () => {
    if (!response) fail();
  });
  request.once("response", (value) => {
    response = value;
    responseClosed = new Promise<void>((resolve) => value.once("close", resolve));
    value.on("error", fail);
    value.once("close", () => {
      if (!value.complete) fail();
    });
    if (deadline.signal.aborted) {
      retire();
      return;
    }
    const parts: Uint8Array[] = [];
    let size = 0;
    value.on("data", (chunk: Uint8Array) => {
      size += chunk.byteLength;
      if (size > 4096) {
        retire();
        return;
      }
      parts.push(chunk);
    });
    value.once("end", () => {
      if (deadline.signal.aborted) {
        fail();
        return;
      }
      if (value.statusCode !== 200) {
        result.reject(
          new RelayError(
            value.statusCode === 429
              ? "BUSY"
              : value.statusCode === 400
                ? "AUTH_DENIED"
                : value.statusCode === 404
                  ? "NOT_FOUND"
                  : "UNAVAILABLE",
          ),
        );
        return;
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      result.resolve(bytes);
    });
  });
  deadline.signal.addEventListener("abort", retire, { once: true });
  if (deadline.signal.aborted) retire();
  else request.end(body);
  try {
    return await result.promise;
  } finally {
    request.destroy();
    response?.destroy();
    await requestClosed;
    await responseClosed;
    deadline.signal.removeEventListener("abort", retire);
    deadline.cancel();
  }
}

/** One bounded FIFO per desktop backend, shared by that backend's host networks. */
export class NativeHostWorkClient implements HostWorkClient {
  private readonly lifetime = new Lifetime();
  private readonly jobs = new Set<Promise<unknown>>();
  private tail: Promise<void> = Promise.resolve();
  private readonly failures = new Map<string, { count: number; retryAt: number }>();
  private readonly lastWork = new Map<string, number>();
  private readonly tls: HostWorkTls;
  constructor(tls: HostWorkTls = {}) {
    this.tls = tls;
  }
  private run<A>(
    parent: Lifetime | undefined,
    task: (lifetime: Lifetime) => Promise<A>,
  ): Promise<A> {
    requireRelay(
      this.lifetime.active && (!parent || parent.active) && this.jobs.size < HOST_WORK.jobs,
      "BUSY",
    );
    const lifetime = new Lifetime(),
      retire = () => lifetime.retire();
    this.lifetime.signal.addEventListener("abort", retire, { once: true });
    parent?.signal.addEventListener("abort", retire, { once: true });
    const job = this.tail.then(async () => {
      requireRelay(lifetime.active, "UNAVAILABLE");
      return task(lifetime);
    });
    const joined = job.finally(async () => {
      retire();
      await lifetime.close();
      this.lifetime.signal.removeEventListener("abort", retire);
      parent?.signal.removeEventListener("abort", retire);
      this.jobs.delete(joined);
    });
    this.jobs.add(joined);
    this.tail = joined.then(
      () => {},
      () => {},
    );
    return joined;
  }
  acquire(
    scope: HostWorkScope,
    parent: Lifetime,
    previous?: HostReservation,
    renew = false,
  ): Promise<HostReservation> {
    return this.run(parent, async (lifetime) => {
      const key = scope.network.networkId + "/" + scope.node.id;
      if (
        previous &&
        previous.expiresAt > epochNow() &&
        (!renew || previous.renewAt > epochNow())
      ) {
        validateHostWorkScope(previous, scope);
        return previous;
      }
      requireRelay((this.failures.get(key)?.retryAt ?? 0) <= monotonicMillis(), "BUSY");
      try {
        const claimId = randomOpaque(16),
          request = {
            version: 1,
            networkId: scope.network.networkId,
            locator: scope.locator,
            admissionPublicKey: scope.admissionIdentity.publicKey,
            capacityToken: scope.capacityToken,
            claimId,
            reservationId:
              previous && previous.expiresAt > epochNow() ? previous.credential.id : null,
          };
        const endpoint = (path: Parameters<typeof relayHttpEndpoint>[1]) =>
          relayHttpEndpoint(scope.node, path, scope.allowLoopbackTest);
        const challenge = readCanonical(
          HostWorkChallenge,
          await post(endpoint("/v1/host/challenge"), canonicalBytes(request), lifetime, this.tls),
        );
        validateHostWorkScope(challenge, scope);
        requireRelay(
          challenge.claimId === claimId &&
            ((challenge.reservationId === request.reservationId && !challenge.replace) ||
              (request.reservationId === null &&
                challenge.reservationId !== null &&
                challenge.replace)) &&
            (challenge.difficulty === 0 || challenge.difficulty >= 2) &&
            challenge.difficulty <= HOST_WORK.maximumDifficulty &&
            challenge.reservationMs >= RELAY_LIMITS.leaseMs &&
            challenge.reservationMs <= HOST_WORK.reservationMs &&
            challenge.issuedAt <= epochNow() + RELAY_LIMITS.clockSkewMs &&
            challenge.expiresAt === challenge.issuedAt + HOST_WORK.challengeMs &&
            challenge.expiresAt > epochNow(),
          "AUTH_DENIED",
        );
        if (challenge.difficulty > 0) {
          const lastWork = this.lastWork.get(key);
          requireRelay(
            lastWork === undefined ||
              monotonicMillis() - lastWork >= HOST_WORK.automaticWorkIntervalMs,
            "BUSY",
          );
          requireRelay(this.lastWork.size < 64 || this.lastWork.has(key), "BUSY");
          this.lastWork.set(key, monotonicMillis());
        }
        const solutions = await solveHostWork(challenge, lifetime),
          proof = { challenge, solutions };
        const bytes = canonicalBytes({
          ...proof,
          signature: await signBytes(scope.admissionIdentity, hostWorkProof(proof)),
        });
        requireRelay(lifetime.active, "UNAVAILABLE");
        // At most one retry of the identical signed claim after an uncertain
        // response. The relay reconciles its receipt instead of allocating again.
        let response: Uint8Array;
        try {
          response = await post(endpoint("/v1/host/claim"), bytes, lifetime, this.tls);
        } catch (error) {
          requireRelay(lifetime.active, "UNAVAILABLE");
          if (!(error instanceof RelayError) || error.code !== "UNAVAILABLE") throw error;
          response = await post(endpoint("/v1/host/claim"), bytes, lifetime, this.tls);
        }
        const reservation = readCanonical(HostReservation, response);
        validateHostWorkScope(reservation, scope);
        requireRelay(
          reservation.claimId === claimId &&
            reservation.bootId === challenge.bootId &&
            reservation.renewAt >= challenge.issuedAt + HOST_WORK.automaticWorkIntervalMs &&
            reservation.renewAt < reservation.expiresAt &&
            reservation.expiresAt > epochNow() &&
            reservation.expiresAt <=
              epochNow() + HOST_WORK.reservationMs + RELAY_LIMITS.clockSkewMs &&
            (challenge.replace
              ? reservation.credential.id !== challenge.reservationId
              : !challenge.reservationId || reservation.credential.id === challenge.reservationId),
          "AUTH_DENIED",
        );
        this.failures.delete(key);
        requireRelay(lifetime.active && parent.active, "UNAVAILABLE");
        return reservation;
      } catch {
        if (lifetime.active) {
          const count = Math.min(4, (this.failures.get(key)?.count ?? 0) + 1);
          if (this.failures.size < 64 || this.failures.has(key))
            this.failures.set(key, {
              count,
              retryAt: monotonicMillis() + 60_000 * 2 ** (count - 1),
            });
        }
        throw new RelayError("UNAVAILABLE");
      }
    });
  }
  release(scope: HostWorkScope, reservation: HostReservation): Promise<void> {
    return this.run(undefined, async (lifetime) => {
      validateHostWorkScope(reservation, scope);
      const unsigned = {
        networkId: reservation.networkId,
        nodeId: reservation.nodeId,
        bootId: reservation.bootId,
        locator: reservation.locator,
        admissionPublicKey: reservation.admissionPublicKey,
        credential: reservation.credential,
      };
      const bytes = canonicalBytes({
        ...unsigned,
        signature: await signBytes(scope.admissionIdentity, hostWorkProof(unsigned, true)),
      });
      await post(
        relayHttpEndpoint(scope.node, "/v1/host/release", scope.allowLoopbackTest),
        bytes,
        lifetime,
        this.tls,
        3000,
      );
    });
  }
  async close(): Promise<void> {
    this.lifetime.retire();
    await Promise.allSettled(this.jobs);
    await this.lifetime.close();
    this.failures.clear();
    this.lastWork.clear();
  }
}
