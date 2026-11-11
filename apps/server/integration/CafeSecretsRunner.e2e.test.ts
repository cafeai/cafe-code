// Opt-in compiled-entry qualification with synthetic credentials and exact
// test-owned native children. No provider, real credential, or app restart.
// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { expect, it, type TestContext } from "vitest";
import { ThreadSecretsStore } from "../src/secrets/store.ts";
import { makeSecretRunnerSession, type SecretRunnerSession } from "../src/secrets/session.ts";

async function fixture(context: TestContext) {
  let rootAcquisition: Promise<string> | undefined;
  let bindingAcquisition: Promise<SecretRunnerSession> | undefined;
  const pending = new Set<Promise<unknown>>();
  context.onTestFinished(async () => {
    await Promise.allSettled([...pending]);
    if (bindingAcquisition) await (await bindingAcquisition).dispose();
    if (rootAcquisition) await fs.rm(await rootAcquisition, { recursive: true, force: true });
  });
  rootAcquisition = fs.mkdtemp(path.join(os.tmpdir(), "cafe-secrets-native-"));
  const root = await fs.realpath(await rootAcquisition);
  const store = new ThreadSecretsStore(root);
  bindingAcquisition = makeSecretRunnerSession({ secretsDir: root, threadId: "native-chat" });
  const binding = await bindingAcquisition;
  const run = (request: unknown) => {
    let child: ReturnType<typeof spawn> | undefined;
    const abort = () => child?.kill("SIGTERM");
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) {
      context.signal.removeEventListener("abort", abort);
      throw new Error("Native fixture retired.");
    }
    const result = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const entry = process.env.CAFE_CODE_SECRET_RUNNER_ENTRY ?? path.resolve("dist/bin.mjs");
      const executable = process.env.CAFE_CODE_SECRET_RUNNER_EXECUTABLE ?? process.execPath;
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: root,
        ELECTRON_RUN_AS_NODE: "1",
      };
      for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"])
        if (process.env[name] !== undefined) env[name] = process.env[name];
      child = spawn(
        executable,
        [entry, "--cafe-secret-exec", binding.connectionPath, JSON.stringify(request)],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      const output = { stdout: "", stderr: "" };
      let failed = false;
      child.on("error", () => {
        failed = true;
      });
      for (const stream of ["stdout", "stderr"] as const)
        child[stream]?.on("data", (chunk: Buffer) => {
          if (output[stream].length + chunk.length > 1_048_576) {
            failed = true;
            child?.kill("SIGTERM");
            return;
          }
          output[stream] += chunk.toString("utf8");
        });
      child.on("close", (code) => {
        context.signal.removeEventListener("abort", abort);
        resolve({ code: failed ? 1 : (code ?? 1), ...output });
      });
    });
    pending.add(result);
    void result.finally(() => pending.delete(result));
    return result;
  };
  return { root, store, binding, run };
}

it.skipIf(process.env.CAFE_CODE_SECRETS_E2E !== "1")(
  "expands env/stdin and redacts split native stdout/stderr before outer capture",
  async (context) => {
    const f = await fixture(context);
    const value = "synthetic-native-secret-12345";
    const { secret } = await f.store.set({ threadId: "native-chat", value });
    const result = await f.run({
      operation: "run",
      argv: [
        process.execPath,
        "-e",
        "process.stdin.resume();process.stdin.on('data',()=>{});process.stdout.write(process.env.CAFE_TEST_KEY.slice(0,5));setImmediate(()=>{process.stdout.write(process.env.CAFE_TEST_KEY.slice(5));process.stderr.write(process.env.CAFE_TEST_KEY);});",
      ],
      env: { CAFE_TEST_KEY: secret.reference },
      stdin: secret.reference,
    });
    expect(result).toEqual({ code: 0, stdout: secret.reference, stderr: secret.reference });
    expect(result.stdout + result.stderr).not.toContain(value);
    expect((await fs.readdir(f.root)).sort()).toEqual(["cafe-secrets"]);
  },
);

it.skipIf(process.env.CAFE_CODE_SECRETS_E2E !== "1")(
  "writes a real value, reads its reference, and refuses a retired connection",
  async (context) => {
    const f = await fixture(context);
    const value = "synthetic-file-secret-12345";
    const { secret } = await f.store.set({ threadId: "native-chat", value });
    const filename = path.join(f.root, ".env");
    expect(
      (
        await f.run({
          operation: "write_file",
          path: filename,
          content: `KEY=${secret.reference}\n`,
        })
      ).code,
    ).toBe(0);
    expect(await fs.readFile(filename, "utf8")).toBe(`KEY=${value}\n`);
    expect(await f.run({ operation: "read_file", path: filename })).toEqual({
      code: 0,
      stdout: `KEY=${secret.reference}\n`,
      stderr: "",
    });
    await f.binding.dispose();
    const retired = await f.run({ operation: "read_file", path: filename });
    expect(retired.code).not.toBe(0);
    expect(retired.stdout + retired.stderr).not.toContain(value);
  },
);

it.skipIf(process.env.CAFE_CODE_SECRETS_E2E !== "1")(
  "rejects foreign and removed references before opening a native child",
  async (context) => {
    const f = await fixture(context);
    const foreign = await f.store.set({
      threadId: "other-chat",
      value: "synthetic-foreign-secret",
    });
    const marker = path.join(f.root, "must-not-run");
    const request = {
      operation: "run",
      argv: [
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`,
      ],
      env: { KEY: foreign.secret.reference },
    };
    expect((await f.run(request)).code).not.toBe(0);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const own = await f.store.set({ threadId: "native-chat", value: "synthetic-own-secret" });
    await f.store.remove("native-chat", own.secret.id);
    expect((await f.run({ ...request, env: { KEY: own.secret.reference } })).code).not.toBe(0);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
