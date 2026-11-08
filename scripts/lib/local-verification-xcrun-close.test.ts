import { EventEmitter } from "node:events";
import { describe, expect, it, vi, type TestContext } from "vitest";
import { lookupLocalVerificationGitWithXcrun } from "./local-verification-inputs.ts";

type MetadataResult = { stdout: string; stderr: string };
type MetadataOptions = {
  env: Readonly<Record<string, string | undefined>>;
  encoding: "utf8";
  shell: false;
  timeout: number;
  killSignal: "SIGKILL";
  maxBuffer: number;
  signal: AbortSignal;
};
const metadataLookup = vi.hoisted(() => ({
  invoke:
    vi.fn<
      (
        command: string,
        args: readonly string[],
        options: MetadataOptions,
      ) => Promise<MetadataResult> & { child: EventEmitter }
    >(),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const native = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  // Preserve the real producer's promisified-execFile seam. Only this isolated
  // file's fixed metadata invocation is synthetic; no subprocess is launched.
  return {
    ...native,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: metadataLookup.invoke }),
  };
});

const success = { stdout: "/synthetic/developer/git\n", stderr: "" };

function fixture(context: TestContext) {
  const child = new EventEmitter();
  const controller = new AbortController();
  const environment = Object.freeze({ PATH: "/synthetic/bin", CAFE_FIXTURE: "metadata-only" });
  let resolveResult!: (value: typeof success) => void;
  let rejectResult!: (failure: unknown) => void;
  const result = new Promise<typeof success>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const invocation = Object.assign(result, { child });
  let pending: ReturnType<typeof lookupLocalVerificationGitWithXcrun> | undefined;
  let settled = false;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    child.emit("close", 0, null);
  };
  context.onTestFinished(async () => {
    // Release and join only this fixture's original promise/child event even
    // when an assertion fails. No ignored rejection or held native resources
    // can escape into the next test's mock configuration.
    resolveResult(success);
    close();
    if (pending) await Promise.allSettled([pending]);
    metadataLookup.invoke.mockReset();
  });
  metadataLookup.invoke.mockImplementation(() => invocation);
  const start = () => {
    pending = lookupLocalVerificationGitWithXcrun(environment, controller.signal);
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    return pending;
  };
  // A receipt from the original callback result, registered after start(),
  // orders assertions after its existing promise reactions. This is not a
  // sleep, timer, scheduler prewarm or substitute for the held close event.
  const resultReceipt = () =>
    result.then(
      () => undefined,
      () => undefined,
    );
  return {
    child,
    controller,
    environment,
    start,
    close,
    resolveResult,
    rejectResult,
    resultReceipt,
    settled: () => settled,
  };
}

describe("fixed xcrun metadata child ownership", () => {
  it("retains the exact invocation options and joins close after an early successful callback", async (context) => {
    const f = fixture(context);
    const pending = f.start();
    expect(metadataLookup.invoke).toHaveBeenCalledOnce();
    const [command, args, options] = metadataLookup.invoke.mock.calls[0]!;
    expect(command).toBe("/usr/bin/xcrun");
    expect(args).toEqual(["--find", "git"]);
    expect(options).toEqual({
      env: f.environment,
      encoding: "utf8",
      shell: false,
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 4_096,
      signal: f.controller.signal,
    });
    expect(options.env === f.environment).toBe(true);
    expect(f.child.listenerCount("close")).toBe(1);
    f.resolveResult(success);
    await f.resultReceipt();
    expect(f.settled()).toBe(false);
    f.close();
    expect(await pending).toBe(success);
    expect(f.child.listenerCount("close")).toBe(0);
  });

  it("joins the exact child after an abort callback and preserves its original rejection", async (context) => {
    const f = fixture(context);
    const failure = new Error("Synthetic metadata abort");
    const onAbort = () => f.rejectResult(failure);
    f.controller.signal.addEventListener("abort", onAbort, { once: true });
    context.onTestFinished(() => {
      f.controller.signal.removeEventListener("abort", onAbort);
    });
    const pending = f.start();
    f.controller.abort();
    await f.resultReceipt();
    expect(f.settled()).toBe(false);
    expect(f.child.listenerCount("close")).toBe(1);
    f.close();
    await expect(pending).rejects.toBe(failure);
    expect(metadataLookup.invoke).toHaveBeenCalledOnce();
    expect(f.child.listenerCount("close")).toBe(0);
  });

  it("does not replace a non-abort callback error or treat it as native close", async (context) => {
    const f = fixture(context);
    const failure = Object.freeze({ synthetic: "opaque native callback failure" });
    const pending = f.start();
    f.rejectResult(failure);
    await f.resultReceipt();
    expect(f.controller.signal.aborted).toBe(false);
    expect(f.settled()).toBe(false);
    f.close();
    await expect(pending).rejects.toBe(failure);
  });

  it("arms the close join for an already-aborted invocation before awaiting its callback", async (context) => {
    const f = fixture(context);
    const failure = new Error("Synthetic pre-aborted metadata lookup");
    f.controller.abort();
    const pending = f.start();
    expect(metadataLookup.invoke.mock.calls[0]![2].signal.aborted).toBe(true);
    expect(f.child.listenerCount("close")).toBe(1);
    f.rejectResult(failure);
    await f.resultReceipt();
    expect(f.settled()).toBe(false);
    f.close();
    await expect(pending).rejects.toBe(failure);
  });

  it("waits for the original callback result even when close has already arrived", async (context) => {
    const f = fixture(context);
    const pending = f.start();
    f.close();
    expect(f.settled()).toBe(false);
    f.resolveResult(success);
    expect(await pending).toBe(success);
  });

  it("preserves a synchronous invocation throw when no child was returned", async (context) => {
    const f = fixture(context);
    const failure = Object.freeze({ synthetic: "synchronous native invocation failure" });
    metadataLookup.invoke.mockImplementation(() => {
      throw failure;
    });
    await expect(f.start()).rejects.toBe(failure);
    expect(metadataLookup.invoke).toHaveBeenCalledOnce();
    expect(f.child.listenerCount("close")).toBe(0);
  });
});
