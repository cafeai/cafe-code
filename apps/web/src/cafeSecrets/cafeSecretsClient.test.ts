import { EnvironmentId, ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import {
  hasIncompleteCafeSecret,
  prepareCafeSecretsForSend,
  prepareCafeSecretAnswersForSend,
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

describe("question answer preparation", () => {
  const answers = (value: Record<string, unknown>, isCurrent = () => true, driver = "codex") =>
    prepareCafeSecretAnswersForSend({
      environmentId,
      threadId,
      instanceId,
      driver,
      answers: value,
      isCurrent,
    });
  const reference = "[CAFE_SECRET_0123456789abcdef0123456789abcdef]";

  it("prepares text and nested selections before returning a wire-safe answer object", async () => {
    const prepareRpc = vi.fn(async ({ text }: { text: string }) => ({
      text: text.replace("[sec:synthetic-answer]", reference),
    }));
    install({ capabilities: vi.fn().mockResolvedValue({ supported: true }), prepare: prepareRpc });
    const result = await answers({
      password: "[sec:synthetic-answer]",
      choices: ["plain", "[sec:synthetic-answer]"],
      literal: "\\[sec:literal]",
      enabled: true,
    });
    expect(result).toEqual({
      ok: true,
      answers: {
        password: reference,
        choices: ["plain", reference],
        literal: "\\[sec:literal]",
        enabled: true,
      },
    });
    expect(prepareRpc).toHaveBeenCalledExactlyOnceWith({
      threadId,
      providerInstanceId: instanceId,
      text: "[sec:synthetic-answer]",
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-answer");
  });

  it("keeps ordinary replies available without the optional vault", async () => {
    install(undefined);
    await expect(
      answers(
        { text: "ordinary", literal: "\\[sec:literal]", choices: [1, true, null] },
        () => true,
        "openCode",
      ),
    ).resolves.toEqual({
      ok: true,
      answers: { text: "ordinary", literal: "\\[sec:literal]", choices: [1, true, null] },
    });
  });

  it("preflights every field before capturing any value", async () => {
    const prepareRpc = vi.fn();
    install({ capabilities: vi.fn().mockResolvedValue({ supported: true }), prepare: prepareRpc });
    await expect(answers({ first: "[sec:valid]", last: "[sec:unfinished" })).resolves.toEqual({
      ok: false,
      issue: "incomplete",
      questionId: "last",
    });
    await expect(answers({ key: "[sec:escaped-close\\]" })).resolves.toEqual({
      ok: false,
      issue: "incomplete",
      questionId: "key",
    });
    expect(prepareRpc).not.toHaveBeenCalled();
  });

  it("blocks unsupported providers and unavailable references without exposing received errors", async () => {
    const prepareRpc = vi.fn().mockRejectedValue(new Error("private-synthetic-value"));
    install({ capabilities: vi.fn().mockResolvedValue({ supported: true }), prepare: prepareRpc });
    await expect(answers({ password: "[sec:value]" }, () => true, "openCode")).resolves.toEqual({
      ok: false,
      issue: "unsupported",
      questionId: "password",
    });
    expect(prepareRpc).not.toHaveBeenCalled();
    await expect(answers({ password: reference })).resolves.toEqual({
      ok: false,
      issue: "failed",
      questionId: "password",
    });
  });

  it("withdraws a held answer when its exact question owner changes and admits no later fields", async () => {
    let current = true;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepareRpc = vi.fn(async () => {
      await held;
      return { text: reference };
    });
    install({ capabilities: vi.fn().mockResolvedValue({ supported: true }), prepare: prepareRpc });
    const pending = answers({ first: "[sec:first]", second: "[sec:second]" }, () => current);
    try {
      await vi.waitFor(() => expect(prepareRpc).toHaveBeenCalledTimes(1));
      current = false;
    } finally {
      release();
    }
    await expect(pending).resolves.toEqual({ ok: false, cancelled: true });
    expect(prepareRpc).toHaveBeenCalledTimes(1);
  });

  it("refuses excessive secret-bearing fields before vault IO", async () => {
    const prepareRpc = vi.fn();
    install({ capabilities: vi.fn().mockResolvedValue({ supported: true }), prepare: prepareRpc });
    await expect(
      answers(
        Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [String(index), `[sec:value-${index}]`]),
        ),
      ),
    ).resolves.toEqual({ ok: false, issue: "failed" });
    expect(prepareRpc).not.toHaveBeenCalled();
  });

  it.each(["question", "connection"] as const)(
    "does not begin capture after the %s changes during capability admission",
    async (change) => {
      let current = true;
      let release!: (value: { supported: boolean }) => void;
      const capability = new Promise<{ supported: boolean }>((resolve) => {
        release = resolve;
      });
      const capabilities = vi.fn(() => capability);
      const prepareRpc = vi.fn().mockResolvedValue({ text: reference });
      install({ capabilities, prepare: prepareRpc });
      const pending = answers({ password: "[sec:held-capability]" }, () => current);
      try {
        expect(capabilities).toHaveBeenCalledTimes(1);
        if (change === "question") current = false;
        else install({ capabilities: vi.fn(), prepare: vi.fn() });
      } finally {
        release({ supported: true });
      }
      await expect(pending).resolves.toEqual({ ok: false, cancelled: true });
      expect(prepareRpc).not.toHaveBeenCalled();
    },
  );

  it("retains the admitted answer snapshot across private preparation", async () => {
    const input = { password: "[sec:original-answer]", other: ["initial"] };
    const prepareRpc = vi.fn(async () => {
      input.password = "[sec:later-answer]";
      input.other[0] = "[sec:later-array-value]";
      return { text: reference };
    });
    install({ capabilities: vi.fn().mockResolvedValue({ supported: true }), prepare: prepareRpc });
    await expect(answers(input)).resolves.toEqual({
      ok: true,
      answers: { password: reference, other: ["initial"] },
    });
  });
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
