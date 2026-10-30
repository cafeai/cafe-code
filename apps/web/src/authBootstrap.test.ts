import type { DesktopBridge } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFailed,
  vi,
  type TestContext,
} from "vitest";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    ...init,
  });
}

type TestWindow = {
  location: URL;
  history: {
    replaceState: (_data: unknown, _unused: string, url: string) => void;
  };
  desktopBridge?: DesktopBridge;
};

function installTestBrowser(url: string) {
  const testWindow: TestWindow = {
    location: new URL(url),
    history: {
      replaceState: (_data, _unused, nextUrl) => {
        testWindow.location = new URL(nextUrl, testWindow.location.href);
      },
    },
  };

  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("document", { title: "Cafe Code" });

  return testWindow;
}

function sessionResponse(body: unknown, init?: ResponseInit) {
  return jsonResponse(body, init);
}

/**
 * Own the first cold-import case through its complete continuation. A hard
 * timeout cannot cancel module evaluation or the real bootstrap promise, so
 * retain its exact globals until those admitted promises settle. Passive
 * phases do not prove why a historical timeout occurred.
 */
type SilentBootstrapPhase =
  | "owner-start"
  | "module-import-pending"
  | "module-import-settled"
  | "bootstrap-pending"
  | "bootstrap-settled"
  | "assertions-completed";

function ownSilentBootstrapFixture(context: TestContext, readFetchCalls: () => number = () => 0) {
  const startedAt = performance.now();
  let phase: SilentBootstrapPhase = "owner-start";
  let retired = false;
  let cleanupPromise: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const observe = () => {
    let elapsed = 0;
    let calls = 0;
    try {
      elapsed = performance.now() - startedAt;
      calls = readFetchCalls();
    } catch {
      // Passive sampling must not prevent retirement or alter test behavior.
    }
    return {
      phase,
      elapsedMs: Number.isFinite(elapsed)
        ? Math.max(0, Math.min(86_400_000, Math.round(elapsed)))
        : 0,
      fetchCalls: Number.isFinite(calls) ? Math.max(0, Math.min(4, Math.floor(calls))) : 0,
    };
  };
  let retiredObservation: ReturnType<typeof observe> | undefined;
  const retire = () => {
    if (retired) return;
    // Fence admission first, even if diagnostic sampling becomes unavailable.
    retired = true;
    retiredObservation = observe();
  };
  const assertActive = () => {
    if (retired || context.signal.aborted) {
      throw new Error("Synthetic auth bootstrap fixture retired.");
    }
  };
  const record = (next: SilentBootstrapPhase) => {
    if (!retired) phase = next;
  };
  const own = <A>(start: () => Promise<A>): Promise<A> => {
    assertActive();
    const operation = start().then((value) => {
      assertActive();
      return value;
    });
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  };
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    retire();
    cleanupPromise = (async () => {
      try {
        // No new operation can be admitted after retirement. Joining the outer
        // body also joins its awaited import and bootstrap work before reset.
        await Promise.allSettled([...pending]);
      } finally {
        context.signal.removeEventListener("abort", retire);
      }
    })();
    return cleanupPromise;
  };
  onTestFailed(() => {
    try {
      // Exactly one fixed-field record, with no credentials, URLs, response
      // bodies, environment values, stacks or received errors.
      Effect.runSync(
        Effect.logError(
          "Synthetic silent bootstrap passive observation",
          retiredObservation ?? observe(),
        ).pipe(Effect.catchCause(() => Effect.void)),
      );
    } catch {
      // Diagnostic delivery cannot replace the original failed assertion.
    }
  });
  context.onTestFinished(cleanup);
  context.signal.addEventListener("abort", retire, { once: true });
  if (context.signal.aborted) retire();
  assertActive();
  return { own, assertActive, record, retire, cleanup };
}

let silentBootstrapCleanup: (() => Promise<void>) | undefined;

describe("resolveInitialServerAuthGateState", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    installTestBrowser("http://localhost/");
  });

  afterEach(async () => {
    // Vitest completion hooks run later. Join this same exact owner before
    // resetting auth state, timers or mocks that its late body could still use.
    const cleanup = silentBootstrapCleanup;
    silentBootstrapCleanup = undefined;
    await cleanup?.();
    const { __resetServerAuthBootstrapForTests } = await import("./environments/primary");
    __resetServerAuthBootstrapForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reuses an in-flight silent bootstrap attempt", async (context) => {
    let readFetchCalls = () => 0;
    const lifetime = ownSilentBootstrapFixture(context, () => readFetchCalls());
    silentBootstrapCleanup = lifetime.cleanup;
    try {
      await lifetime.own(async () => {
        const fetchMock = vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            sessionResponse({
              authenticated: false,
              auth: {
                policy: "desktop-managed-local",
                bootstrapMethods: ["desktop-bootstrap"],
                sessionMethods: ["browser-session-cookie"],
                sessionCookieName: "t3_session",
              },
            }),
          )
          .mockResolvedValueOnce(
            jsonResponse({
              authenticated: true,
              sessionMethod: "browser-session-cookie",
              expiresAt: "2026-04-05T00:00:00.000Z",
            }),
          )
          .mockResolvedValueOnce(
            sessionResponse({
              authenticated: true,
              auth: {
                policy: "loopback-browser",
                bootstrapMethods: ["one-time-token"],
                sessionMethods: ["browser-session-cookie"],
                sessionCookieName: "t3_session",
              },
              sessionMethod: "browser-session-cookie",
              expiresAt: "2026-04-05T00:00:00.000Z",
            }),
          );
        readFetchCalls = () => fetchMock.mock.calls.length;
        vi.stubGlobal("fetch", fetchMock);

        const testWindow = installTestBrowser("http://localhost/");
        testWindow.desktopBridge = {
          getLocalEnvironmentBootstrap: () => ({
            label: "Local environment",
            httpBaseUrl: "http://localhost:3773",
            wsBaseUrl: "ws://localhost:3773",
            bootstrapToken: "desktop-bootstrap-token",
          }),
        } as DesktopBridge;

        lifetime.record("module-import-pending");
        const { resolveInitialServerAuthGateState } = await lifetime.own(
          () => import("./environments/primary"),
        );
        lifetime.record("module-import-settled");
        lifetime.assertActive();

        lifetime.record("bootstrap-pending");
        await lifetime.own(() =>
          Promise.all([
            lifetime.own(() => resolveInitialServerAuthGateState()),
            lifetime.own(() => resolveInitialServerAuthGateState()),
          ]),
        );
        lifetime.record("bootstrap-settled");
        lifetime.assertActive();

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:3773/api/auth/session");
        expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:3773/api/auth/bootstrap");
        expect(fetchMock.mock.calls[2]?.[0]).toBe("http://localhost:3773/api/auth/session");

        lifetime.record("assertions-completed");
      });
    } finally {
      await lifetime.cleanup();
    }
  });

  it("does not start bootstrap after its held import owner retires", async (context) => {
    const lifetime = ownSilentBootstrapFixture(context);
    silentBootstrapCleanup = lifetime.cleanup;
    let releaseImport!: () => void;
    const heldImport = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const bootstrap = vi.fn(async () => undefined);
    const operation = lifetime.own(async () => {
      lifetime.record("module-import-pending");
      await lifetime.own(() => heldImport);
      lifetime.record("module-import-settled");
      lifetime.assertActive();
      await lifetime.own(bootstrap);
    });
    try {
      // This models completion of the exact already-admitted import after the
      // public timeout path has retired its owner. It must not start auth work.
      lifetime.retire();
      releaseImport();
      await expect(operation).rejects.toThrow("Synthetic auth bootstrap fixture retired.");
      expect(bootstrap).not.toHaveBeenCalled();
      await lifetime.cleanup();
      expect(bootstrap).not.toHaveBeenCalled();
    } finally {
      releaseImport();
      await lifetime.cleanup();
    }
  });

  it("uses https fetch urls when the primary environment uses wss", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/api/auth/session", {
      credentials: "include",
    });
  });

  it("uses the current origin as an auth proxy base for local dev environments", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    installTestBrowser("http://localhost:5735/");

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:5735/api/auth/session", {
      credentials: "include",
    });
  });

  it("uses the vite proxy for desktop-managed loopback auth requests during local dev", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "desktop-managed-local",
          bootstrapMethods: ["desktop-bootstrap"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5733");

    const testWindow = installTestBrowser("http://127.0.0.1:5733/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstrap: () => ({
        label: "Local environment",
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
      }),
    } as DesktopBridge;

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "desktop-managed-local",
        bootstrapMethods: ["desktop-bootstrap"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:5733/api/auth/session", {
      credentials: "include",
    });
  });

  it("returns a requires-auth state instead of throwing when no bootstrap credential exists", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });
  });

  it("retries transient auth session bootstrap failures after restart", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    const gateStatePromise = resolveInitialServerAuthGateState();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(gateStatePromise).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("takes a pairing token from the location hash and strips it immediately", async () => {
    const testWindow = installTestBrowser("http://localhost/#token=pairing-token");
    const { takePairingTokenFromUrl } = await import("./environments/primary");

    expect(takePairingTokenFromUrl()).toBe("pairing-token");
    expect(testWindow.location.hash).toBe("");
    expect(testWindow.location.searchParams.get("token")).toBeNull();
  });

  it("accepts query-string pairing tokens as a backward-compatible fallback", async () => {
    const testWindow = installTestBrowser("http://localhost/?token=pairing-token");
    const { takePairingTokenFromUrl } = await import("./environments/primary");

    expect(takePairingTokenFromUrl()).toBe("pairing-token");
    expect(testWindow.location.searchParams.get("token")).toBeNull();
  });

  it("allows manual token submission after the initial auth check requires pairing", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    installTestBrowser("http://localhost/");

    const { resolveInitialServerAuthGateState, submitServerAuthCredential } =
      await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });
    await expect(submitServerAuthCredential("retry-token")).resolves.toBeUndefined();
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces a friendly error message when an invalid pairing token is submitted", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(
        {
          error: "Invalid bootstrap credential.",
        },
        {
          status: 401,
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { submitServerAuthCredential } = await import("./environments/primary");

    await expect(submitServerAuthCredential("bad-token")).rejects.toThrow(
      "Invalid pairing token. Check the token and try again.",
    );
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/api/auth/bootstrap", {
      body: JSON.stringify({ credential: "bad-token" }),
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
  });

  it("submits admin password credentials to the password bootstrap endpoint", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token", "password"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { submitServerPasswordCredential } = await import("./environments/primary");

    await expect(
      submitServerPasswordCredential({
        username: "admin",
        password: "correct horse battery staple",
      }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/api/auth/bootstrap/password", {
      body: JSON.stringify({
        username: "admin",
        password: "correct horse battery staple",
      }),
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
  });

  it("surfaces a friendly error message when an invalid admin password is submitted", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(
        {
          error: "Invalid password credential.",
        },
        {
          status: 401,
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { submitServerPasswordCredential } = await import("./environments/primary");

    await expect(
      submitServerPasswordCredential({
        password: "bad password",
      }),
    ).rejects.toThrow("Invalid password. Check the password and try again.");
  });

  it("waits for the authenticated session to become observable after silent desktop bootstrap", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const testWindow = installTestBrowser("http://localhost/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstrap: () => ({
        label: "Local environment",
        httpBaseUrl: "http://localhost:3773",
        wsBaseUrl: "ws://localhost:3773",
        bootstrapToken: "desktop-bootstrap-token",
      }),
    } as DesktopBridge;

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    const gateStatePromise = resolveInitialServerAuthGateState();
    await vi.advanceTimersByTimeAsync(100);

    await expect(gateStatePromise).resolves.toEqual({
      status: "authenticated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("http://localhost:3773/api/auth/session");
    expect(fetchMock.mock.calls[3]?.[0]).toBe("http://localhost:3773/api/auth/session");
  });

  it("memoizes the authenticated gate state after the first successful read", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates a pairing credential from the authenticated auth endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        id: "pairing-link-1",
        credential: "pairing-token",
        label: "Julius iPhone",
        expiresAt: "2026-04-05T00:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createServerPairingCredential } = await import("./environments/primary");

    await expect(createServerPairingCredential("Julius iPhone")).resolves.toEqual({
      id: "pairing-link-1",
      credential: "pairing-token",
      label: "Julius iPhone",
      expiresAt: "2026-04-05T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/api/auth/pairing-token", {
      body: JSON.stringify({ label: "Julius iPhone" }),
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
  });

  it("manages admin password status through authenticated auth endpoints", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ configured: false }))
      .mockResolvedValueOnce(jsonResponse({ configured: true }))
      .mockResolvedValueOnce(jsonResponse({ configured: false }));
    vi.stubGlobal("fetch", fetchMock);

    const { clearServerAdminPassword, fetchServerAdminPasswordStatus, setServerAdminPassword } =
      await import("./environments/primary");

    await expect(fetchServerAdminPasswordStatus()).resolves.toEqual({ configured: false });
    await expect(setServerAdminPassword(" correct horse battery staple ")).resolves.toEqual({
      configured: true,
    });
    await expect(clearServerAdminPassword()).resolves.toEqual({ configured: false });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "http://localhost/api/auth/admin-password", {
      credentials: "include",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "http://localhost/api/auth/admin-password", {
      body: JSON.stringify({ password: "correct horse battery staple" }),
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "http://localhost/api/auth/admin-password/clear", {
      credentials: "include",
      method: "POST",
    });
  });
});
