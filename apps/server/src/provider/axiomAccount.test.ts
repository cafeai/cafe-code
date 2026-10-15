import { describe, expect, it } from "vitest";
import { ProviderAdapterValidationError } from "./Errors.ts";
import {
  AXIOM_LOGIN_ERRORS,
  axiomAccountHealth,
  axiomLoginFailureMessage,
  axiomLoginUrl,
} from "./axiomAccount.ts";

const url =
  "https://auth.axiom.stream/native/authorize?authorization_id=fixture&state=fixture-private-authorization-state";

describe("Axiom account status", () => {
  it.each(["starting", "unavailable"] as const)(
    "does not call %s a signed-out account",
    (state) => {
      const result = axiomAccountHealth({ state, revision: 1 });
      expect(result.auth.status).toBe("unknown");
      expect(result.status).toBe("warning");
      expect(result.message).not.toMatch(/sign in|sign-in/i);
    },
  );
  it.each(["signed_out", "expired"] as const)(
    "asks for sign-in only for conclusive %s",
    (state) => {
      expect(axiomAccountHealth({ state, revision: 1 })).toMatchObject({
        status: "warning",
        auth: { status: "unauthenticated" },
      });
      expect(axiomAccountHealth({ state, revision: 1 }).message).toMatch(/sign in/i);
    },
  );
  it("requires a valid account receipt and exposes no private account id", () => {
    expect(axiomAccountHealth({ state: "valid", revision: 1 }).auth.status).toBe("unknown");
    const result = axiomAccountHealth({
      state: "valid",
      revision: 1,
      account: { id: "private-native-account", displayName: "Personal" },
    });
    expect(result).toMatchObject({
      status: "ready",
      auth: { status: "authenticated", label: "Personal" },
    });
    expect(JSON.stringify(result)).not.toContain("private-native-account");
  });
});

describe("Axiom native login boundary", () => {
  it("admits only the configured native authorization origin and route", () => {
    expect(axiomLoginUrl(url, {})).toBe(url);
    expect(axiomLoginUrl(url, { AXIOM_AUTH_URL: "https://other.example" })).toBeNull();
    const local = url.replace("https://auth.axiom.stream", "http://127.0.0.1:1234");
    expect(axiomLoginUrl(local, { AXIOM_AUTH_URL: "http://127.0.0.1:1234" })).toBe(local);
  });
  it.each([
    url.replace("https://", "javascript:"),
    url.replace("https://", "http://"),
    url.replace("auth.axiom.stream", "auth.axiom.stream.evil.example"),
    url.replace("auth.axiom.stream", "private@auth.axiom.stream"),
    url.replace("/native/authorize", "/unrelated"),
    `${url}#fragment`,
    `${url}&extra=private`,
    `${url}&state=other-private-state`,
    url.replace("authorization_id=fixture", "authorization_id="),
    url.replace("state=fixture-private-authorization-state", "state=short"),
    `${url}\n`,
  ])("rejects an untrusted authorization URL %#", (candidate) => {
    expect(axiomLoginUrl(candidate, {})).toBeNull();
  });
  it("publishes only finite Cafe-authored login errors", () => {
    for (const issue of Object.values(AXIOM_LOGIN_ERRORS))
      expect(
        axiomLoginFailureMessage(
          new ProviderAdapterValidationError({ provider: "axiom", operation: "login", issue }),
        ),
      ).toBe(issue);
    for (const error of [
      new Error(url),
      { _tag: "ProviderAdapterValidationError", provider: "axiom", operation: "login", issue: url },
      new ProviderAdapterValidationError({ provider: "axiom", operation: "login", issue: url }),
    ]) {
      expect(axiomLoginFailureMessage(error)).toBe(AXIOM_LOGIN_ERRORS.start);
      expect(axiomLoginFailureMessage(error)).not.toContain("fixture-private");
    }
  });
});
