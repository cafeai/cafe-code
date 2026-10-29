// Resolve the actual SDK dependency graph rather than an unrelated hoisted copy.
import { createRequire } from "node:module";
// This fixture owns its native temporary directory and joins every admitted IO
// operation before deleting it; the package under test uses native filesystem IO.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
// Host-native paths preserve Windows drives and separators in the real helper.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
// The only selected native location is a filesystem-minted test directory.
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(
  require.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js"),
);
const { Hono } = sdkRequire("hono") as typeof import("hono");
const { serveStatic: serveGenericStatic } = sdkRequire(
  "hono/serve-static",
) as typeof import("hono/serve-static");
const { serveStatic: serveNodeStatic } = sdkRequire(
  "@hono/node-server/serve-static",
) as typeof import("@hono/node-server/serve-static");
const { StreamableHTTPServerTransport } = sdkRequire(
  "@modelcontextprotocol/sdk/server/streamableHttp.js",
) as typeof import("@modelcontextprotocol/sdk/server/streamableHttp.js");

describe("MCP transitive Hono security compatibility", () => {
  it("rejects a second static-path decode before the generic helper reads protected content", async () => {
    // The malformed leading percent makes routing retain an encoded segment.
    // A second decode used to turn it into `admin` after the authorization
    // middleware had already been bypassed. The file remains inside the static
    // root: this checks prefix authorization, not outside-root traversal.
    const getContent = vi.fn(async (path: string) => {
      if (path === "static/public.txt") return "public fixture";
      if (path === "static/hello world.txt") return "encoded public fixture";
      if (path === "static/admin/secret.txt") return "protected fixture";
      return null;
    });
    const onFound = vi.fn();
    const app = new Hono();
    app.use("/static/admin/*", (context) => context.text("Unauthorized", 401));
    app.use("/static/*", serveGenericStatic({ getContent, onFound }));

    const protectedResponse = await app.request("/static/admin/secret.txt");
    expect(protectedResponse.status).toBe(401);
    expect(await protectedResponse.text()).toBe("Unauthorized");
    expect(getContent).not.toHaveBeenCalled();
    expect(onFound).not.toHaveBeenCalled();

    // This is the upstream advisory's actual malformed path, not a source-text
    // or version-label assertion. The vulnerable helper returns protected data.
    const bypassResponse = await app.request("/static/%%36%31dmin/secret.txt");
    expect(bypassResponse.status).toBe(404);
    expect(await bypassResponse.text()).not.toContain("protected fixture");
    expect(getContent).not.toHaveBeenCalled();
    expect(onFound).not.toHaveBeenCalled();

    const publicResponse = await app.request("/static/public.txt");
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.text()).toBe("public fixture");
    expect(getContent).toHaveBeenCalledTimes(1);
    expect(getContent.mock.calls[0]?.[0]).toBe("static/public.txt");
    expect(onFound).toHaveBeenCalledTimes(1);

    // Ordinary routing has already decoded this valid space. The security
    // default must not become a blanket ban on normal URL-encoded filenames.
    const encodedResponse = await app.request("/static/hello%20world.txt");
    expect(encodedResponse.status).toBe(200);
    expect(await encodedResponse.text()).toBe("encoded public fixture");
    expect(getContent).toHaveBeenCalledTimes(2);
    expect(getContent.mock.calls[1]?.[0]).toBe("static/hello world.txt");
    expect(onFound).toHaveBeenCalledTimes(2);
  });

  it("rejects the same prefix bypass in the independent native static helper", async (context) => {
    let retired = false;
    let root: string | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>();
    const assertActive = () => {
      if (retired || context.signal.aborted) throw new Error("Static security fixture retired.");
    };
    const own = <A>(start: () => Promise<A>): Promise<A> => {
      assertActive();
      const operation = start();
      pending.add(operation);
      // Observe the original result without introducing an unhandled rejected
      // finally promise. Late acquisition still assigns the owned root, so
      // cleanup can join and remove it after the timeout signal fences input.
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    };
    const retire = () => {
      retired = true;
    };
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      retire();
      cleanupPromise = (async () => {
        try {
          while (pending.size) await Promise.allSettled([...pending]);
          if (root !== undefined) await rm(root, { recursive: true, force: true });
        } finally {
          context.signal.removeEventListener("abort", retire);
        }
      })();
      return cleanupPromise;
    };
    // Register ownership before the first asynchronous filesystem acquisition.
    // A hard timeout is not owned by an ordinary async body's finally alone.
    context.signal.addEventListener("abort", retire, { once: true });
    context.onTestFinished(cleanup);
    if (context.signal.aborted) retire();
    let bodyFailed = false;
    try {
      const directory = await own(async () => {
        const created = await mkdtemp(join(tmpdir(), "cafe-hono-security-"));
        root = created;
        return created;
      });
      assertActive();
      await own(() => mkdir(join(directory, "static", "admin"), { recursive: true }));
      assertActive();
      await own(() => writeFile(join(directory, "static", "public.txt"), "public fixture"));
      assertActive();
      await own(() =>
        writeFile(join(directory, "static", "admin", "secret.txt"), "protected fixture"),
      );
      assertActive();

      const onFound = vi.fn();
      const app = new Hono();
      app.use("/static/admin/*", (requestContext) => requestContext.text("Unauthorized", 401));
      app.use("/static/*", serveNodeStatic({ root: directory, onFound }));
      const head = (path: string) =>
        own(async () => {
          // HEAD exercises actual native stat/path authorization and the exact
          // advisory without constructing a native ReadStream. Consequently
          // response completion does not masquerade as a stream-close proof.
          const response = await app.request(path, { method: "HEAD" });
          const body = await response.text();
          assertActive();
          return { response, body };
        });

      const protectedResult = await head("/static/admin/secret.txt");
      expect(protectedResult.response.status).toBe(401);
      expect(protectedResult.body).toBe("");
      expect(onFound).not.toHaveBeenCalled();

      const bypassResult = await head("/static/%%36%31dmin/secret.txt");
      expect(bypassResult.response.status).toBe(404);
      expect(bypassResult.body).toBe("");
      expect(onFound).not.toHaveBeenCalled();

      const publicResult = await head("/static/public.txt");
      expect(publicResult.response.status).toBe(200);
      expect(publicResult.response.headers.get("Content-Length")).toBe(
        String(Buffer.byteLength("public fixture")),
      );
      expect(publicResult.body).toBe("");
      expect(onFound).toHaveBeenCalledTimes(1);
      expect(onFound.mock.calls[0]?.[0]).toBe(join(directory, "static", "public.txt"));
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      // Preserve the original assertion if cleanup also fails. The exact same
      // cleanup promise remains registered with the runner and reports its own
      // failure rather than silently converting the test into a pass.
      if (bodyFailed) await cleanup().catch(() => {});
      else await cleanup();
    }
  });

  it("retains the SDK Node transport's explicit no-global-override boundary", async () => {
    const originalRequest = Object.getOwnPropertyDescriptor(globalThis, "Request");
    const originalResponse = Object.getOwnPropertyDescriptor(globalThis, "Response");
    // Construct the actual consumer: its constructor invokes the installed
    // getRequestListener with overrideGlobalObjects:false. No listener, native
    // session, provider or network connection is created by this transport.
    let transport: InstanceType<typeof StreamableHTTPServerTransport> | undefined;
    try {
      transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
      expect(Object.getOwnPropertyDescriptor(globalThis, "Request")).toEqual(originalRequest);
      expect(Object.getOwnPropertyDescriptor(globalThis, "Response")).toEqual(originalResponse);
    } finally {
      try {
        await transport?.close();
      } finally {
        // Restore exact descriptors even if construction or close fails: a
        // failed compatibility check must not contaminate the next fixture.
        if (originalRequest) Object.defineProperty(globalThis, "Request", originalRequest);
        else Reflect.deleteProperty(globalThis, "Request");
        if (originalResponse) Object.defineProperty(globalThis, "Response", originalResponse);
        else Reflect.deleteProperty(globalThis, "Response");
      }
    }
  });
});
