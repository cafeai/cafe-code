import assert from "node:assert/strict";
import { CodexSettings } from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { afterEach, describe, it, vi } from "vitest";
import { readCodexAccountRateLimits, readCodexCredentialIdentity } from "./Layers/CodexProvider.ts";

const roots: string[] = [];
const fixtureAccessToken = (expiresAt: number) =>
  `fixture.${Buffer.from(JSON.stringify({ exp: expiresAt })).toString("base64url")}.fixture`;
afterEach(async () => {
  vi.unstubAllGlobals();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      for (const root of roots.splice(0))
        yield* fileSystem.remove(root, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
const prepareFixture = (expired: boolean, refresh: boolean) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const nowMs = yield* Clock.currentTimeMillis;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const home = yield* fileSystem.makeTempDirectory({ prefix: "cafe-codex-auth-observation-" });
    roots.push(home);
    const token = fixtureAccessToken(Math.floor(nowMs / 1000) + (expired ? -60 : 3600));
    const auth = {
      auth_mode: "chatgpt",
      tokens: {
        access_token: token,
        account_id: "fixture-account",
        ...(refresh ? { refresh_token: "fixture-private-refresh" } : {}),
      },
    };
    const authFile = path.join(home, "auth.json");
    const write = (value: unknown) =>
      fileSystem.writeFileString(authFile, JSON.stringify(value), { mode: 0o600 });
    yield* write(auth);
    const refusals: string[] = [];
    const read = readCodexAccountRateLimits(
      Schema.decodeSync(CodexSettings)({ homePath: home }),
      { CODEX_HOME: home },
      checkedAt,
      (identity) =>
        Effect.sync(() => {
          refusals.push(identity);
        }),
    ).pipe(Effect.provide(NodeServices.layer));
    const identity = readCodexCredentialIdentity(
      Schema.decodeSync(CodexSettings)({ homePath: home }),
      { CODEX_HOME: home },
    ).pipe(Effect.provide(NodeServices.layer));
    return { read, refusals, write, auth, identity, checkedAt };
  });
const fixture = (expired = false, refresh = true) =>
  Effect.runPromise(prepareFixture(expired, refresh).pipe(Effect.provide(NodeServices.layer)));

describe("Codex usage authentication evidence", () => {
  it("rejects oversized credential files before making a network request", async () => {
    const f = await fixture();
    await Effect.runPromise(f.write({ ...f.auth, padding: "x".repeat(65_536) }));
    const request = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", request);
    assert.equal(await Effect.runPromise(f.read), undefined);
    assert.equal(request.mock.calls.length, 0);
    assert.deepEqual(f.refusals, []);
  });
  it("does not retire rejected credentials for metadata-only auth-file rewrites", async () => {
    const f = await fixture();
    const before = await Effect.runPromise(f.identity);
    await Effect.runPromise(
      f.write({
        ...f.auth,
        last_refresh: f.checkedAt,
        email: "new-metadata@example.invalid",
      }),
    );
    assert.equal(await Effect.runPromise(f.identity), before);
  });
  it("reports a rejected unexpired credential without exposing credential bytes", async () => {
    const f = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    assert.equal(await Effect.runPromise(f.read), undefined);
    assert.equal(f.refusals.length, 1);
    assert.match(f.refusals[0]!, /^[a-f0-9]{64}$/u);
  });
  it("leaves ordinary expired access tokens refreshable by the native runtime", async () => {
    const f = await fixture(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await Effect.runPromise(f.read);
    assert.deepEqual(f.refusals, []);
  });
  it("requires sign-in when an expired rejected credential has no refresh token", async () => {
    const f = await fixture(true, false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );
    await Effect.runPromise(f.read);
    assert.equal(f.refusals.length, 1);
  });
  it.each([403, 429, 500, 503])(
    "does not turn HTTP %s into a signed-out account",
    async (status) => {
      const f = await fixture();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status })),
      );
      await Effect.runPromise(f.read);
      assert.deepEqual(f.refusals, []);
    },
  );
  it("does not invalidate credentials replaced while the old HTTP request is pending", async () => {
    const f = await fixture();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let complete!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      complete = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        started();
        return response;
      }),
    );
    const reading = Effect.runPromise(f.read);
    try {
      await entered;
      await Effect.runPromise(
        f.write({
          ...f.auth,
          tokens: { ...f.auth.tokens, access_token: "replacement-private-credential" },
        }),
      );
    } finally {
      complete(new Response(null, { status: 401 }));
    }
    await reading;
    assert.deepEqual(f.refusals, []);
  });
  it("does not invalidate an account on a transport failure", async () => {
    const f = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fixture-owned transport failure");
      }),
    );
    await Effect.runPromise(f.read);
    assert.deepEqual(f.refusals, []);
  });
});
