import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvironmentId } from "@cafecode/contracts";

import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../primary";
import { getEnvironmentHttpBaseUrl, resolveEnvironmentHttpUrl } from "./catalog";

describe("runtime catalog", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  beforeEach(() => {
    vi.stubGlobal("window", {
      desktopBridge: undefined,
      location: new URL("http://localhost:4173/"),
    });
    resetPrimaryEnvironmentDescriptorForTests();
    writePrimaryEnvironmentDescriptor({
      environmentId: primaryEnvironmentId,
      label: "Local Cafe",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves HTTP URLs for the primary environment", () => {
    const expectedBaseUrl = new URL(window.location.origin).toString();
    expect(getEnvironmentHttpBaseUrl(primaryEnvironmentId)).toBe(expectedBaseUrl);
    expect(
      resolveEnvironmentHttpUrl({
        environmentId: primaryEnvironmentId,
        pathname: "/api/projects",
        searchParams: { q: "hello" },
      }),
    ).toBe(new URL("/api/projects?q=hello", expectedBaseUrl).toString());
  });

  it("rejects stale non-primary environment IDs", () => {
    const staleEnvironmentId = EnvironmentId.make("environment-remote");

    expect(getEnvironmentHttpBaseUrl(staleEnvironmentId)).toBeNull();
    expect(() =>
      resolveEnvironmentHttpUrl({
        environmentId: staleEnvironmentId,
        pathname: "/api/projects",
      }),
    ).toThrow(/Unable to resolve HTTP base URL/);
  });
});
