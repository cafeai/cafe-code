import { EnvironmentId } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import { applySavedEnvironmentEdit, savedEnvironmentEditFields } from "./savedEnvironmentEdit";

const record = {
  environmentId: EnvironmentId.make("saved-server"),
  label: "Box",
  httpBaseUrl: "http://10.0.0.1:3774/",
  wsBaseUrl: "ws://10.0.0.1:3774/",
  createdAt: "2026-10-25T00:00:00.000Z",
  lastConnectedAt: null,
};

describe("saved environment edits", () => {
  it("changes the local name and both addresses while preserving identity and history", () => {
    expect(
      applySavedEnvironmentEdit(record, { label: " New box ", host: "10.0.0.2", port: "3775" }),
    ).toEqual({
      ...record,
      label: "New box",
      httpBaseUrl: "http://10.0.0.2:3775/",
      wsBaseUrl: "ws://10.0.0.2:3775/",
    });
  });

  it("retains TLS, accepts IPv6 and exposes default ports for editing", () => {
    const secure = {
      ...record,
      httpBaseUrl: "https://box.example/",
      wsBaseUrl: "wss://box.example/",
    };
    expect(savedEnvironmentEditFields(secure)).toEqual({
      label: "Box",
      host: "box.example",
      port: "443",
    });
    expect(
      applySavedEnvironmentEdit(secure, { label: "IPv6 box", host: "::1", port: "8443" }),
    ).toMatchObject({
      httpBaseUrl: "https://[::1]:8443/",
      wsBaseUrl: "wss://[::1]:8443/",
    });
    expect(savedEnvironmentEditFields({ ...record, httpBaseUrl: "http://box.example/" }).port).toBe(
      "80",
    );
  });

  it.each([
    { label: " ", host: "box.example", port: "3774" },
    { label: "Box", host: "", port: "3774" },
    { label: "Box", host: "user:secret@box.example", port: "3774" },
    { label: "Box", host: "https://box.example/path", port: "3774" },
    { label: "Box", host: "box.example:1234", port: "3774" },
    { label: "Box", host: "box.example", port: "0" },
    { label: "Box", host: "box.example", port: "65536" },
    { label: "Box", host: "box.example", port: "37.5" },
    { label: "Box", host: "box.example", port: "1e3" },
  ])("rejects invalid edit fields before saving: %j", (input) => {
    expect(() => applySavedEnvironmentEdit(record, input)).toThrow();
  });
});
