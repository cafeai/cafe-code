import { describe, expect, it } from "vitest";
import {
  getSafeInteractionUrl,
  normalizeElicitationRequest,
  validateInteractionResponse,
} from "./providerInteraction.ts";

const form = (properties: Record<string, unknown>, required: string[] = []) =>
  normalizeElicitationRequest({
    mode: "form",
    serverName: "connector",
    message: "Complete these fields",
    requestedSchema: { type: "object", properties, required },
  });
describe("bounded provider interactions", () => {
  it("keeps authorization tokens transient and never repeats them in durable message text", () => {
    const url = "https://example.com/authorize?token=private-secret";
    const request = normalizeElicitationRequest({
      mode: "url",
      serverName: "connector",
      message: `Visit ${url}`,
      url,
    });
    expect(request).toMatchObject({
      kind: "elicitation",
      mode: "url",
      urlOrigin: "https://example.com",
    });
    expect(JSON.stringify(request)).not.toContain("private-secret");
    expect(JSON.stringify(request)).not.toContain("/authorize");
  });
  it.each([
    "javascript:alert(1)",
    "file:///tmp/private",
    "https://user:password@example.com",
    "https://example.com/\nsecret",
    "https:\\example.com",
    "data:text/html,secret",
  ])("rejects unsafe navigation %s", (url) => expect(getSafeInteractionUrl(url)).toBeNull());
  it("validates primitive fields, titled/multi enums and required/range constraints against the original form", () => {
    const interaction = form(
      {
        name: { type: "string", minLength: 2, maxLength: 8 },
        count: { type: "integer", minimum: 1, maximum: 4 },
        enabled: { type: "boolean" },
        choice: { type: "string", oneOf: [{ const: "a", title: "Alpha" }] },
        tags: { type: "array", minItems: 1, items: { type: "string", enum: ["one", "two"] } },
      },
      ["name", "count", "enabled", "tags"],
    );
    expect(interaction).not.toBeNull();
    const content = { name: "ok", count: 2, enabled: false, choice: "a", tags: ["one"] };
    const accept = (value: unknown) =>
      validateInteractionResponse(interaction!, {
        __cafeInteraction: { action: "accept", content: value },
      });
    expect(accept(content)).toEqual({ action: "accept", content });
    expect(accept({ ...content, count: 2.5 })).toBeNull();
    expect(accept({ ...content, tags: ["one", "one"] })).toBeNull();
    expect(accept({ ...content, choice: "other" })).toBeNull();
    expect(accept({ ...content, additional: "secret" })).toBeNull();
    expect(accept({ name: "ok" })).toBeNull();
  });
  it("declines unsupported schemas rather than ignoring constraints or executing provider patterns", () => {
    for (const field of [
      { type: "object" },
      { type: "string", pattern: "(a+)+$" },
      { type: "number", minLength: 1 },
      { type: "array", items: { type: "object" } },
      { type: "integer", minimum: Infinity },
      { type: "string", enum: ["a"], oneOf: [{ const: "b" }] },
      { type: "string", oneOf: [{ const: "a", pattern: "unsupported" }] },
      { type: "array", items: { enum: ["a"], oneOf: [{ const: "b" }] } },
    ])
      expect(form({ field })).toBeNull();
    expect(
      form(
        Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [String(index), { type: "string" }]),
        ),
      ),
    ).toBeNull();
    expect(form(JSON.parse('{"__proto__":{"type":"string"}}'))).toBeNull();
  });
  it("bounds combined response bytes and rejects unknown permission grants or expanded scopes", () => {
    const interaction = form(
      Object.fromEntries(
        Array.from({ length: 16 }, (_, index) => [String(index), { type: "string" }]),
      ),
    );
    const content = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [String(index), "界".repeat(2000)]),
    );
    expect(
      validateInteractionResponse(interaction!, {
        __cafeInteraction: { action: "accept", content },
      }),
    ).toBeNull();
    const permissions = {
      kind: "permissions" as const,
      message: "Permissions",
      cwd: "/work",
      grants: [{ id: "read:0", label: "Read /work" }],
    };
    expect(
      validateInteractionResponse(permissions, {
        __cafeInteraction: { action: "accept", grantIds: ["write:0"], scope: "session" },
      }),
    ).toBeNull();
    expect(
      validateInteractionResponse(permissions, {
        __cafeInteraction: { action: "accept", grantIds: ["read:0"], scope: "forever" },
      }),
    ).toBeNull();
    expect(
      validateInteractionResponse(permissions, {
        __cafeInteraction: { action: "accept", grantIds: ["read:0"] },
      }),
    ).toEqual({ action: "accept", grantIds: ["read:0"], scope: "turn" });
  });
});
