import { describe, expect, it, vi } from "vitest";

import { dispatchIdempotentCommandWithTransportRetry } from "./idempotentDispatch";

describe("dispatchIdempotentCommandWithTransportRetry", () => {
  it("retries an indeterminate acknowledgement and returns the durable result", async () => {
    const dispatch = vi
      .fn<() => Promise<{ sequence: number }>>()
      .mockRejectedValueOnce(new Error("All fibers interrupted without error"))
      .mockResolvedValueOnce({ sequence: 42 });
    const sleep = vi.fn(async () => undefined);

    await expect(
      dispatchIdempotentCommandWithTransportRetry(dispatch, {
        retryDelaysMs: [250],
        sleep,
      }),
    ).resolves.toEqual({ sequence: 42 });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("does not retry a definitive command rejection", async () => {
    const rejection = new Error("Orchestration command invariant failed");
    const dispatch = vi.fn<() => Promise<never>>().mockRejectedValue(rejection);

    await expect(
      dispatchIdempotentCommandWithTransportRetry(dispatch, {
        retryDelaysMs: [0],
        sleep: async () => undefined,
      }),
    ).rejects.toBe(rejection);

    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("bounds reconnect retries during a sustained outage", async () => {
    const interruption = new Error("SocketCloseError: 1006");
    const dispatch = vi.fn<() => Promise<never>>().mockRejectedValue(interruption);
    const onRetry = vi.fn();

    await expect(
      dispatchIdempotentCommandWithTransportRetry(dispatch, {
        retryDelaysMs: [0, 0],
        sleep: async () => undefined,
        onRetry,
      }),
    ).rejects.toBe(interruption);

    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });
});
