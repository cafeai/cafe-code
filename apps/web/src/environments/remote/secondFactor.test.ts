import { afterEach, expect, it, vi } from "vitest";
import { RelayError } from "@cafecode/relay/errors";
import { bootstrapRemotePasswordBearerSession } from "./api";
import { withSecondFactor } from "./secondFactor";

afterEach(() => vi.unstubAllGlobals());

it("connects without prompting when the server accepts the first factor", async () => {
  const attempt = vi.fn().mockResolvedValue("accepted"),
    prompt = vi.fn();
  await expect(withSecondFactor(attempt, { requestSecondFactor: prompt })).resolves.toBe(
    "accepted",
  );
  expect(attempt).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(prompt).not.toHaveBeenCalled();
});

it("continues only an explicit typed HTTP challenge on the same target", async () => {
  vi.stubGlobal("window", { location: { origin: "https://app.example" } });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, { status: 401, headers: { "x-cafe-auth-reason": "two-factor-required" } }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ sessionToken: "test-session" })));
  vi.stubGlobal("fetch", fetch);
  const prompt = vi.fn().mockResolvedValue("123456");
  const result = await withSecondFactor(
    (secondFactor) =>
      bootstrapRemotePasswordBearerSession({
        httpBaseUrl: "https://host.example/",
        password: "synthetic-password",
        ...(secondFactor ? { secondFactor } : {}),
      }),
    { requestSecondFactor: prompt },
  );
  expect(result.sessionToken).toBe("test-session");
  expect(prompt).toHaveBeenCalledOnce();
  expect(prompt.mock.calls[0]![0]).toMatchObject({ reason: "required" });
  expect(fetch.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)])).toEqual([
    ["https://host.example/api/auth/bootstrap/password/bearer", { password: "synthetic-password" }],
    [
      "https://host.example/api/auth/bootstrap/password/bearer",
      { password: "synthetic-password", secondFactor: "123456" },
    ],
  ]);
});

it("requires another explicit code after a typed incorrect code or recovery-only response", async () => {
  const attempt = vi
    .fn()
    .mockRejectedValueOnce(new RelayError("SECOND_FACTOR_REQUIRED"))
    .mockRejectedValueOnce(new RelayError("SECOND_FACTOR_REJECTED"))
    .mockRejectedValueOnce(new RelayError("SECOND_FACTOR_LOCKED"))
    .mockResolvedValue("accepted");
  const prompt = vi
    .fn()
    .mockResolvedValueOnce("bad-code")
    .mockResolvedValueOnce("123456")
    .mockResolvedValueOnce("recovery-code");
  await expect(withSecondFactor(attempt, { requestSecondFactor: prompt })).resolves.toBe(
    "accepted",
  );
  expect(attempt.mock.calls).toEqual([[undefined], ["bad-code"], ["123456"], ["recovery-code"]]);
  expect(prompt.mock.calls.map(([request]) => request.reason)).toEqual([
    "required",
    "invalid",
    "locked",
  ]);
});

it.each(["AUTH_REJECTED", "AUTH_INDETERMINATE", "UNAVAILABLE"] as const)(
  "does not prompt or replay enrollment after %s",
  async (code) => {
    const error = new RelayError(code),
      attempt = vi.fn().mockRejectedValue(error),
      prompt = vi.fn();
    await expect(withSecondFactor(attempt, { requestSecondFactor: prompt })).rejects.toBe(error);
    expect(attempt).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();
  },
);

it("cancels a pending prompt even if its consumer ignores the abort signal", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const attempt = vi.fn().mockRejectedValue(new RelayError("SECOND_FACTOR_REQUIRED"));
  const pending = withSecondFactor(attempt, {
    signal: controller.signal,
    requestSecondFactor: async () => {
      entered();
      return new Promise(() => {});
    },
  });
  const rejected = expect(pending).rejects.toMatchObject({ code: "INCOMPLETE" });
  await enteredPromise;
  controller.abort();
  await rejected;
  expect(attempt).toHaveBeenCalledOnce();
});
