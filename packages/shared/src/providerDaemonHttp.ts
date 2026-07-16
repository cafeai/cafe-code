// @effect-diagnostics nodeBuiltinImport:off
import * as http from "node:http";

import type { ProviderDaemonClientConfig } from "@cafecode/contracts";

import { PROVIDER_PIPELINE_POLICY } from "./providerPipelinePolicy.ts";
import {
  addProviderBackendBridgeDiagnostics,
  recordProviderBackendBridgeLine,
  setProviderBackendBridgeDiagnostics,
} from "./providerPipelineDiagnostics.ts";

export interface ProviderDaemonHttpResponse {
  readonly statusCode: number;
  readonly body: string;
}

export interface ProviderDaemonJsonRequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
}

export interface ProviderDaemonNdjsonRequestOptions {
  readonly headers?: Record<string, string>;
  readonly onLine: (line: string) => void | Promise<void>;
  readonly maxLineBytes?: number;
  readonly maxPendingBytes?: number;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function requestOptions(
  endpoint: ProviderDaemonClientConfig,
  path: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
): http.RequestOptions {
  const url = new URL(
    path,
    endpoint.httpBaseUrl.endsWith("/") ? endpoint.httpBaseUrl : `${endpoint.httpBaseUrl}/`,
  );
  const common = {
    method,
    path: `${url.pathname}${url.search}`,
    headers,
  } satisfies http.RequestOptions;

  if (endpoint.transport === "ipc" && endpoint.socketPath !== undefined) {
    return {
      ...common,
      socketPath: endpoint.socketPath,
    };
  }

  return {
    ...common,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port.length > 0 ? Number.parseInt(url.port, 10) : undefined,
  };
}

export function requestProviderDaemonJson(
  endpoint: ProviderDaemonClientConfig,
  path: string,
  options: ProviderDaemonJsonRequestOptions = {},
): Promise<ProviderDaemonHttpResponse> {
  const method = options.method ?? "GET";
  const body = options.body;
  const headers = {
    authorization: `Bearer ${endpoint.token}`,
    accept: "application/json",
    ...(body === undefined
      ? {}
      : {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body, "utf8")),
        }),
    ...options.headers,
  };

  return new Promise((resolve, reject) => {
    const request = http.request(requestOptions(endpoint, path, method, headers), (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    request.on("error", reject);
    request.setTimeout(options.timeoutMs ?? 30_000, () => {
      request.destroy(new Error("provider daemon request timed out"));
    });
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

export function streamProviderDaemonNdjson(
  endpoint: ProviderDaemonClientConfig,
  path: string,
  options: ProviderDaemonNdjsonRequestOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const maxLineBytes = Math.max(
      1,
      Math.trunc(options.maxLineBytes ?? PROVIDER_PIPELINE_POLICY.ndjsonMaxLineBytes),
    );
    const maxPendingBytes = Math.max(
      maxLineBytes,
      Math.trunc(options.maxPendingBytes ?? PROVIDER_PIPELINE_POLICY.ndjsonMaxPendingBytes),
    );
    let settled = false;
    const settleReject = (cause: unknown): void => {
      if (settled) return;
      settled = true;
      reject(cause);
    };
    const settleResolve = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const request = http.request(
      requestOptions(endpoint, path, "GET", {
        authorization: `Bearer ${endpoint.token}`,
        accept: "application/x-ndjson",
        ...options.headers,
      }),
      (response) => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          settleReject(
            new Error(`provider daemon stream failed with HTTP ${response.statusCode ?? 0}`),
          );
          response.resume();
          return;
        }

        let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        let processing = false;
        let ended = false;
        let pauseStartedAt = 0;

        const beginPause = (): void => {
          response.pause();
          if (pauseStartedAt !== 0) return;
          pauseStartedAt = performance.now();
          addProviderBackendBridgeDiagnostics({ pauseCount: 1 });
        };
        const finishPause = (): void => {
          if (pauseStartedAt === 0) return;
          addProviderBackendBridgeDiagnostics({ pausedMs: performance.now() - pauseStartedAt });
          pauseStartedAt = 0;
        };

        const processPending = async (): Promise<void> => {
          if (processing || settled) return;
          processing = true;
          try {
            let turnRecords = 0;
            let turnBytes = 0;
            let turnStartedAt = performance.now();
            while (true) {
              const lineEnd = pending.indexOf(0x0a);
              if (lineEnd < 0) break;
              if (lineEnd > maxLineBytes) {
                throw new RangeError(`provider daemon NDJSON line exceeds ${maxLineBytes} bytes`);
              }
              const lineBuffer = pending.subarray(0, lineEnd);
              pending = pending.subarray(lineEnd + 1);
              setProviderBackendBridgeDiagnostics({ pendingBytes: pending.byteLength });
              recordProviderBackendBridgeLine(lineBuffer.byteLength);
              const line = lineBuffer.toString("utf8").trim();
              if (line.length > 0) {
                await options.onLine(line);
                addProviderBackendBridgeDiagnostics({ decodedRecordCount: 1 });
                turnRecords += 1;
                turnBytes += lineBuffer.byteLength;
              }
              if (
                turnRecords >= PROVIDER_PIPELINE_POLICY.workTurnMaxRecords ||
                turnBytes >= PROVIDER_PIPELINE_POLICY.workTurnMaxBytes ||
                performance.now() - turnStartedAt >= PROVIDER_PIPELINE_POLICY.workTurnMaxElapsedMs
              ) {
                await yieldToEventLoop();
                turnRecords = 0;
                turnBytes = 0;
                turnStartedAt = performance.now();
              }
            }
            if (pending.indexOf(0x0a) < 0 && pending.byteLength > maxLineBytes) {
              throw new RangeError(`provider daemon NDJSON line exceeds ${maxLineBytes} bytes`);
            }
            if (pending.byteLength > maxPendingBytes) {
              throw new RangeError(
                `provider daemon NDJSON pending data exceeds ${maxPendingBytes} bytes`,
              );
            }
            if (ended) {
              if (pending.byteLength > 0) {
                if (pending.byteLength > maxLineBytes) {
                  throw new RangeError(`provider daemon NDJSON line exceeds ${maxLineBytes} bytes`);
                }
                recordProviderBackendBridgeLine(pending.byteLength);
                const trailing = pending.toString("utf8").trim();
                pending = Buffer.alloc(0);
                setProviderBackendBridgeDiagnostics({ pendingBytes: 0 });
                if (trailing.length > 0) {
                  await options.onLine(trailing);
                  addProviderBackendBridgeDiagnostics({ decodedRecordCount: 1 });
                }
              }
              finishPause();
              settleResolve();
              return;
            }
            if (
              pauseStartedAt !== 0 &&
              pending.byteLength <= PROVIDER_PIPELINE_POLICY.bridgeQueueLowWaterBytes
            ) {
              finishPause();
              response.resume();
            }
          } catch (cause) {
            addProviderBackendBridgeDiagnostics({ decodeFailureCount: 1 });
            finishPause();
            response.destroy();
            request.destroy();
            settleReject(cause);
          } finally {
            processing = false;
          }
        };

        response.on("data", (chunk: Buffer) => {
          pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
          setProviderBackendBridgeDiagnostics({ pendingBytes: pending.byteLength });
          if (pending.byteLength > maxPendingBytes) {
            const error = new RangeError(
              `provider daemon NDJSON pending data exceeds ${maxPendingBytes} bytes`,
            );
            response.destroy();
            request.destroy();
            settleReject(error);
            return;
          }
          if (pending.byteLength >= PROVIDER_PIPELINE_POLICY.bridgeQueueHighWaterBytes) {
            beginPause();
          }
          void processPending();
        });
        response.on("error", settleReject);
        response.on("end", () => {
          ended = true;
          void processPending();
        });
      },
    );

    request.on("error", settleReject);
    request.end();
  });
}
