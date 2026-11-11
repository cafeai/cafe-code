import { EnvironmentId, ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import {
  hasIncompleteCafeSecret,
  prepareCafeSecretsForSend,
  resetCafeSecretsCapabilityCacheForTests,
} from "./cafeSecretsClient";

const environmentId = EnvironmentId.make("env-secrets");
const threadId = ThreadId.make("thread-secrets");
const instanceId = ProviderInstanceId.make("codex");

function install(threadSecrets: Record<string, unknown> | undefined) {
  // The environment API reader is browser-only; unit tests run under Node.
  vi.stubGlobal("window", globalThis.window ?? {});
  __setEnvironmentApiOverrideForTests(
    environmentId,
    (threadSecrets ? { threadSecrets } : {}) as never,
  );
}

const prepare = (text: string, driver = "codex") =>
  prepareCafeSecretsForSend({ environmentId, threadId, instanceId, driver, text });

afterEach(() => {
  vi.unstubAllGlobals();
  __resetEnvironmentApiOverridesForTests();
  resetCafeSecretsCapabilityCacheForTests();
});

describe("prepareCafeSecretsForSend", () => {
  it("leaves text without unescaped markers untouched and makes no request", async () => {
    const capabilities = vi.fn();
    install({ capabilities, prepare: vi.fn() });
    await expect(prepare("literal \\[sec:VALUE] only", "opencode")).resolves.toEqual({
      ok: true,
      text: "literal \\[sec:VALUE] only",
      prepared: false,
    });
    expect(capabilities).not.toHaveBeenCalled();
  });

  it("blocks unsupported drivers without contacting the server", async () => {
    const capabilities = vi.fn();
    install({ capabilities, prepare: vi.fn() });
    await expect(prepare("key [sec:abc]", "opencode")).resolves.toEqual({
      ok: false,
      issue: "unsupported",
    });
    expect(capabilities).not.toHaveBeenCalled();
  });

  it("fails closed for an older backend without the secrets API", async () => {
    install(undefined);
    await expect(prepare("key [sec:abc]")).resolves.toEqual({ ok: false, issue: "unsupported" });
  });

  it("fails closed when the capability read rejects or reports unsupported", async () => {
    install({ capabilities: vi.fn().mockRejectedValue(new Error("x")), prepare: vi.fn() });
    await expect(prepare("key [sec:abc]")).resolves.toEqual({ ok: false, issue: "unsupported" });
    resetCafeSecretsCapabilityCacheForTests();
    const prepareRpc = vi.fn();
    install({ capabilities: vi.fn().mockResolvedValue({ supported: false }), prepare: prepareRpc });
    await expect(prepare("key [sec:abc]")).resolves.toEqual({ ok: false, issue: "unsupported" });
    expect(prepareRpc).not.toHaveBeenCalled();
  });

  it("blocks incomplete markers on a supported provider", async () => {
    const prepareRpc = vi.fn();
    install({ capabilities: vi.fn().mockResolvedValue({ supported: true }), prepare: prepareRpc });
    await expect(prepare("key [sec:abc")).resolves.toEqual({ ok: false, issue: "incomplete" });
    await expect(prepare("key [sec:]")).resolves.toEqual({ ok: false, issue: "incomplete" });
    expect(prepareRpc).not.toHaveBeenCalled();
  });

  it("prepares through the exact thread and rejects a result that still carries markers", async () => {
    const prepareRpc = vi
      .fn()
      .mockResolvedValueOnce({ text: "key [CAFE_SECRET_0123] and \\[sec:x]" })
      .mockResolvedValueOnce({ text: "still [sec:abc]" });
    install({ capabilities: vi.fn().mockResolvedValue({ supported: true }), prepare: prepareRpc });
    await expect(prepare("key [sec:abc] and \\[sec:x]")).resolves.toEqual({
      ok: true,
      text: "key [CAFE_SECRET_0123] and \\[sec:x]",
      prepared: true,
    });
    expect(prepareRpc).toHaveBeenCalledWith({
      threadId,
      providerInstanceId: instanceId,
      text: "key [sec:abc] and \\[sec:x]",
    });
    await expect(prepare("key [sec:abc]")).resolves.toEqual({ ok: false, issue: "failed" });
  });
});

describe("capability ownership", () => {
  it("never reuses a cached answer after the connection API is replaced under the same ID", async () => {
    const retired = {
      capabilities: vi.fn().mockResolvedValue({ supported: false }),
      prepare: vi.fn(),
    };
    install(retired);
    await expect(prepare("key [sec:abc]")).resolves.toEqual({ ok: false, issue: "unsupported" });
    const replacementPrepare = vi.fn().mockResolvedValue({ text: "key [CAFE_SECRET_0123]" });
    const replacement = {
      capabilities: vi.fn().mockResolvedValue({ supported: true }),
      prepare: replacementPrepare,
    };
    install(replacement);
    await expect(prepare("key [sec:abc]")).resolves.toEqual({
      ok: true,
      text: "key [CAFE_SECRET_0123]",
      prepared: true,
    });
    expect(replacement.capabilities).toHaveBeenCalledTimes(1);
    expect(retired.prepare).not.toHaveBeenCalled();
    // A supported answer is likewise not inherited by a later connection.
    const later = {
      capabilities: vi.fn().mockResolvedValue({ supported: false }),
      prepare: vi.fn(),
    };
    install(later);
    await expect(prepare("key [sec:abc]")).resolves.toEqual({ ok: false, issue: "unsupported" });
    expect(later.prepare).not.toHaveBeenCalled();
  });
});

describe("existing secret references", () => {
  const reference = "[CAFE_SECRET_0123456789abcdef0123456789abcdef]";

  it("blocks a copied reference on an unsupported provider without contacting the server", async () => {
    const capabilities = vi.fn();
    const prepareRpc = vi.fn();
    install({ capabilities, prepare: prepareRpc });
    await expect(prepare(`use ${reference}`, "opencode")).resolves.toEqual({
      ok: false,
      issue: "unsupported",
    });
    expect(capabilities).not.toHaveBeenCalled();
    expect(prepareRpc).not.toHaveBeenCalled();
  });

  it("fails closed for references on an older backend", async () => {
    install(undefined);
    await expect(prepare(`use ${reference}`)).resolves.toEqual({ ok: false, issue: "unsupported" });
  });

  it("validates references through prepare and reports a removed or foreign id as failed", async () => {
    const prepareRpc = vi
      .fn()
      .mockImplementationOnce(async ({ text }: { text: string }) => ({ text }))
      .mockRejectedValueOnce(new Error("unknown secret"));
    install({ capabilities: vi.fn().mockResolvedValue({ supported: true }), prepare: prepareRpc });
    const text = `use ${reference} and \\[sec:literal]`;
    await expect(prepare(text)).resolves.toEqual({ ok: true, text, prepared: true });
    expect(prepareRpc).toHaveBeenCalledWith({ threadId, providerInstanceId: instanceId, text });
    await expect(prepare(`use ${reference}`)).resolves.toEqual({ ok: false, issue: "failed" });
  });
});

describe("hasIncompleteCafeSecret", () => {
  it("distinguishes complete, incomplete and escaped markers", () => {
    expect(hasIncompleteCafeSecret("[sec:a]")).toBe(false);
    expect(hasIncompleteCafeSecret("[sec:a")).toBe(true);
    expect(hasIncompleteCafeSecret("\\[sec:a")).toBe(false);
  });
});
