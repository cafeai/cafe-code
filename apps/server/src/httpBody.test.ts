// @effect-diagnostics nodeBuiltinImport:off
import * as Http from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { describe, expect, it } from "vitest";
import { readHttpBody } from "./httpBody.ts";

async function fixture(task: (port: number) => Promise<void>) {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const bytes = yield* readHttpBody(request, 1024, 150);
            return HttpServerResponse.text(String(bytes.length));
          }).pipe(
            // Deliberately omit Connection: close. Reader retirement must not
            // depend on a route preserving the shared error-response helper.
            Effect.catchTag("HttpBodyError", (error) =>
              Effect.succeed(HttpServerResponse.text("Refused", { status: error.status })),
            ),
          ),
        );
        if (server.address._tag !== "TcpAddress") throw new Error("Expected TCP fixture");
        yield* Effect.promise(() =>
          task(server.address._tag === "TcpAddress" ? server.address.port : 0),
        );
      }),
    ).pipe(
      Effect.provide(NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: 0 })),
      Effect.provide(NodeServices.layer),
    ),
  );
}

describe("native bounded body admission", () => {
  it("closes a rejected declared-size request without waiting for its remaining bytes", async () => {
    await fixture(async (port) => {
      let connection: string | undefined;
      let status: number | undefined;
      await new Promise<void>((resolve, reject) => {
        const request = Http.request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            headers: { "content-length": "1025", connection: "keep-alive" },
          },
          (response) => {
            status = response.statusCode;
            connection = response.headers.connection;
            response.resume();
          },
        );
        request.on("error", reject);
        request.once("close", resolve);
        // Never send the advertised remainder or end the request. The server
        // must send its response and retire this exact socket independently.
        request.write("x");
      });
      expect(status).toBe(413);
      expect(connection).toBe("close");
      expect(
        (await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "ok" })).status,
      ).toBe(200);
    });
  });

  it("admits the boundary and rejects declared/chunked overflow and slow delivery", async () => {
    await fixture(async (port) => {
      const send = (chunks: readonly Buffer[], delay = 0) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const request = Http.request(
            { host: "127.0.0.1", port, path: "/", method: "POST" },
            (response) => {
              let body = "";
              response.on("data", (chunk) => {
                body += chunk;
              });
              response.on("end", () => resolve({ status: response.statusCode!, body }));
            },
          );
          request.on("error", reject);
          for (const chunk of chunks) request.write(chunk);
          if (delay) {
            const timer = setTimeout(() => request.end(), delay);
            request.on("close", () => clearTimeout(timer));
          } else request.end();
        });
      expect(await send([Buffer.alloc(1024)])).toEqual({ status: 200, body: "1024" });
      expect((await send([Buffer.alloc(1024), Buffer.alloc(1)])).status).toBe(413);
      expect(
        (await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "x".repeat(1025) }))
          .status,
      ).toBe(413);
      expect((await send([Buffer.alloc(1)], 350)).status).toBe(408);
      expect((await send([Buffer.alloc(1)])).status).toBe(200);
    });
  });
  it("retires an early-disconnected request without poisoning later admission", async () => {
    await fixture(async (port) => {
      await new Promise<void>((resolve) => {
        const request = Http.request({ host: "127.0.0.1", port, method: "POST" });
        request.on("error", () => {});
        request.on("close", resolve);
        request.write("partial");
        request.destroy();
      });
      expect(
        (await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "ok" })).status,
      ).toBe(200);
    });
  });
});
