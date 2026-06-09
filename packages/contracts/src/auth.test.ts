import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  AuthPasswordBootstrapInput,
  ServerAuthBootstrapMethod,
  ServerAuthDescriptor,
} from "./auth.ts";

const isServerAuthBootstrapMethod = Schema.is(ServerAuthBootstrapMethod);
const decodeServerAuthDescriptor = Schema.decodeUnknownSync(ServerAuthDescriptor);
const decodePasswordBootstrapInput = Schema.decodeUnknownSync(AuthPasswordBootstrapInput);

describe("auth contracts", () => {
  it("accepts password as a bootstrap method", () => {
    expect(isServerAuthBootstrapMethod("password")).toBe(true);
    expect(isServerAuthBootstrapMethod("one-time-token")).toBe(true);
  });

  it("decodes descriptors that advertise password auth without secret details", () => {
    const descriptor = {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token", "password"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
    };

    expect(decodeServerAuthDescriptor(descriptor)).toEqual(descriptor);
    expect(JSON.stringify(descriptor)).not.toContain("hash");
  });

  it("validates password bootstrap payloads", () => {
    expect(
      decodePasswordBootstrapInput({
        username: "admin",
        password: "correct horse battery staple",
      }),
    ).toEqual({
      username: "admin",
      password: "correct horse battery staple",
    });
    expect(() => decodePasswordBootstrapInput({ password: "" })).toThrow();
  });
});
