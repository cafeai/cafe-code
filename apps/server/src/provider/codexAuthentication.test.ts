import assert from "node:assert/strict";
import {
  ProviderDriverKind,
  EventId,
  ThreadId,
  type ProviderEvent,
  type ServerProvider,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import { describe, it } from "vitest";
import {
  codexAuthenticationObservation,
  makeCodexAuthenticationState,
  withCodexSignInRequired,
} from "./codexAuthentication.ts";

const revoked =
  "2026-10-19T23:32:39.528101Z ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.";
function native(message: string, method = "process/stderr"): ProviderEvent {
  return {
    id: EventId.make("auth-fixture"),
    provider: ProviderDriverKind.make("codex"),
    kind: "notification",
    method,
    message,
    createdAt: "2026-10-19T23:32:39.528Z",
    threadId: ThreadId.make("auth-fixture"),
  };
}

describe("Codex authentication observations", () => {
  it("uses terminal structured 401s and native success, not retries or 403 policy failures", () => {
    const error = (status: number, willRetry: boolean): ProviderEvent => ({
      ...native("", "error"),
      payload: {
        willRetry,
        error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: status } } },
      },
    });
    assert.equal(codexAuthenticationObservation(error(401, false)), false);
    assert.equal(codexAuthenticationObservation(error(401, true)), undefined);
    assert.equal(codexAuthenticationObservation(error(403, false)), undefined);
    for (const variant of [
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseTooManyFailedAttempts",
    ]) {
      assert.equal(
        codexAuthenticationObservation({
          ...native("", "turn/completed"),
          payload: {
            turn: {
              status: "failed",
              error: { codexErrorInfo: { [variant]: { httpStatusCode: 401 } } },
            },
          },
        }),
        false,
      );
    }
    assert.equal(
      codexAuthenticationObservation({
        ...native("", "error"),
        payload: { willRetry: false, error: { codexErrorInfo: "unauthorized" } },
      }),
      false,
    );
    assert.equal(
      codexAuthenticationObservation({
        ...native("", "error"),
        payload: {
          willRetry: false,
          error: { codexErrorInfo: { unknownFailure: { httpStatusCode: 401 } } },
        },
      }),
      undefined,
    );
    assert.equal(
      codexAuthenticationObservation({
        ...native("", "turn/completed"),
        payload: { turn: { status: "completed" } },
      }),
      true,
    );
    assert.equal(
      codexAuthenticationObservation({
        ...native("", "account/updated"),
        payload: { authMode: "chatgpt" },
      }),
      undefined,
    );
    let reads = 0;
    const payload = Object.defineProperty({}, "error", {
      get() {
        reads++;
        return { codexErrorInfo: "unauthorized" };
      },
    });
    Object.defineProperty(payload, "willRetry", { value: false });
    assert.equal(codexAuthenticationObservation({ ...native("", "error"), payload }), undefined);
    assert.equal(reads, 0);
  });
  it("recognizes the exact native auth-manager revocation without trusting unrelated prose", () => {
    assert.equal(codexAuthenticationObservation(native(revoked)), false);
    for (const event of [
      native(revoked, "item/completed"),
      native(`tool output: ${revoked}`),
      native(revoked.replace("codex_login::auth::manager:", "rmcp::transport::worker:")),
      native(revoked.replace("was revoked", "could not be refreshed")),
      native(
        "2026-10-19T23:32:39.528101Z ERROR codex_login::auth::manager: Failed to refresh token: 503 Service Unavailable",
      ),
      native("workspace routing discovery unauthorized (401)"),
    ])
      assert.equal(codexAuthenticationObservation(event), undefined);
  });

  it("retains a refusal for the exact credential revision across cached positive status reads", async () => {
    const state = makeCodexAuthenticationState(Effect.succeed("account-a-revision-1"));
    const observe = await Effect.runPromise(state.capture);
    assert.equal(await Effect.runPromise(observe(false)), true);
    assert.equal(await Effect.runPromise(observe(false)), false);
    assert.equal(await Effect.runPromise(state.isRejected), true);
    const badge = withCodexSignInRequired({
      status: "ready",
      auth: {
        status: "authenticated",
        email: "private@example.invalid",
        label: "ChatGPT subscription",
      },
      accountRateLimits: { privateFixture: true },
    } as unknown as ServerProvider);
    assert.equal(badge.status, "error");
    assert.deepEqual(badge.auth, { status: "unauthenticated" });
    assert.equal(badge.accountRateLimits, undefined);
  });

  it("retires old refusal evidence on rotation and fences delayed old-process observations", async () => {
    let identity = "account-a-revision-1";
    const state = makeCodexAuthenticationState(Effect.sync(() => identity));
    const old = await Effect.runPromise(state.capture);
    await Effect.runPromise(old(false));
    identity = "account-a-revision-2";
    assert.equal(await Effect.runPromise(state.isRejected), false);
    assert.equal(await Effect.runPromise(old(false)), false);
    const current = await Effect.runPromise(state.capture);
    await Effect.runPromise(current(false));
    assert.equal(await Effect.runPromise(old(true)), false);
    assert.equal(await Effect.runPromise(state.isRejected), true);
    assert.equal(await Effect.runPromise(current(true)), true);
    assert.equal(await Effect.runPromise(state.isRejected), false);
  });

  it("keeps account instances independent and refuses missing credential identity", async () => {
    const first = makeCodexAuthenticationState(Effect.succeed("revision"));
    const second = makeCodexAuthenticationState(Effect.succeed("revision"));
    const unknown = makeCodexAuthenticationState(Effect.succeed(undefined));
    const observe = await Effect.runPromise(first.capture);
    await Effect.runPromise(observe(false));
    assert.equal(await Effect.runPromise(second.isRejected), false);
    assert.equal(await Effect.runPromise(unknown.reject("revision")), false);
    assert.equal(await Effect.runPromise((await Effect.runPromise(unknown.capture))(false)), false);
  });

  it("requires the actual login source to retain the same rejected overlay credentials", async () => {
    const state = makeCodexAuthenticationState(Effect.succeed("rejected-overlay"));
    await Effect.runPromise(state.reject("rejected-overlay"));
    let source = "rejected-overlay";
    const requiresReauthentication = state.isRejectedIn(Effect.sync(() => source));
    assert.equal(await Effect.runPromise(requiresReauthentication), true);
    source = "fresh-source-credentials";
    assert.equal(await Effect.runPromise(requiresReauthentication), false);
    assert.equal(await Effect.runPromise(state.isRejected), true);
    assert.equal(await Effect.runPromise(state.isRejectedIn(Effect.succeed(undefined))), false);
  });
});
