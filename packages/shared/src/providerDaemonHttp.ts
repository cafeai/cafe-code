// @effect-diagnostics nodeBuiltinImport:off
import * as http from "node:http";

import type { ProviderDaemonClientConfig } from "@cafecode/contracts";

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
  readonly onLine: (line: string) => void;
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
    const request = http.request(
      requestOptions(endpoint, path, "GET", {
        authorization: `Bearer ${endpoint.token}`,
        accept: "application/x-ndjson",
        ...options.headers,
      }),
      (response) => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          reject(new Error(`provider daemon stream failed with HTTP ${response.statusCode ?? 0}`));
          response.resume();
          return;
        }

        const decoder = new TextDecoder();
        let pending = "";
        response.on("data", (chunk: Buffer) => {
          pending += decoder.decode(chunk, { stream: true });
          while (true) {
            const lineEnd = pending.indexOf("\n");
            if (lineEnd < 0) {
              break;
            }
            const line = pending.slice(0, lineEnd).trim();
            pending = pending.slice(lineEnd + 1);
            if (line.length > 0) {
              options.onLine(line);
            }
          }
        });
        response.on("error", reject);
        response.on("end", () => resolve());
      },
    );

    request.on("error", reject);
    request.end();
  });
}
