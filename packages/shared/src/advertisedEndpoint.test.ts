import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { AdvertisedEndpoint } from "@cafecode/contracts";

import {
  createAdvertisedEndpoint,
  type CreateAdvertisedEndpointInput,
} from "./advertisedEndpoint.ts";

const input: CreateAdvertisedEndpointInput = {
  id: "opaque-endpoint",
  label: "Received endpoint label",
  provider: { id: "opaque-provider", label: "Received provider", kind: "manual", isAddon: false },
  httpBaseUrl: "https://synthetic.example.test/path?opaque=yes",
  reachability: "public",
  source: "user",
};

describe("advertised endpoint selection metadata", () => {
  it("preserves legacy endpoint shape when no stable selection key was provided", () => {
    const endpoint = createAdvertisedEndpoint(input);
    expect(endpoint).not.toHaveProperty("defaultPreferenceKey");
    expect(Schema.decodeUnknownSync(AdvertisedEndpoint)(endpoint)).toEqual(endpoint);
    expect(endpoint.label).toBe(input.label);
    expect(endpoint.provider).toBe(input.provider);
  });

  it("copies an explicitly provided opaque key without deriving it from translated display", () => {
    const key = "manual:public:https:Custom HTTPS";
    const endpoint = createAdvertisedEndpoint({
      ...input,
      label: "翻訳済み表示",
      defaultPreferenceKey: key,
    });
    expect(endpoint.defaultPreferenceKey).toBe(key);
    expect(Schema.decodeUnknownSync(AdvertisedEndpoint)(endpoint)).toEqual(endpoint);
    expect(endpoint.httpBaseUrl).toBe("https://synthetic.example.test/");
    expect(endpoint.wsBaseUrl).toBe("wss://synthetic.example.test/");
    expect(endpoint.id).toBe(input.id);
    expect(endpoint.source).toBe(input.source);
    expect(endpoint.provider).toBe(input.provider);
  });

  it("rejects malformed selection metadata at the existing contract boundary", () => {
    const endpoint = createAdvertisedEndpoint(input);
    for (const defaultPreferenceKey of [null, 5, {}, [], "", "   "]) {
      expect(() =>
        Schema.decodeUnknownSync(AdvertisedEndpoint)({ ...endpoint, defaultPreferenceKey }),
      ).toThrow();
    }
  });
});
