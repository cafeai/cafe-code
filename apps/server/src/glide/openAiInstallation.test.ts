// Native filesystem qualification uses only a fresh test-owned installation tree.
// @effect-diagnostics nodeBuiltinImport:off
import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  validateOpenAiComputerInstallation,
  type OpenAiComputerInstallation,
} from "./openAiInstallation.ts";

it.skipIf(process.platform !== "darwin")(
  "admits only canonical private runtime files and the qualified package interfaces",
  async (context) => {
    let root: string | undefined,
      retired = false,
      preparation: Promise<void> | undefined,
      cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        retired = true;
        await preparation?.catch(() => undefined);
        if (root) await rm(root, { recursive: true, force: true });
      })());
    context.signal.addEventListener(
      "abort",
      () => {
        void cleanup();
      },
      { once: true },
    );
    context.onTestFinished(cleanup);
    let installation: OpenAiComputerInstallation;
    const alive = () => {
      if (retired) throw new Error("Fixture retired.");
    };
    preparation = (async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "openai-installation-fixture-")));
      alive();
      const applicationPath = join(root, "OpenAI.app"),
        runtimeRoot = join(applicationPath, "runtime"),
        moduleDirectory = join(runtimeRoot, "modules"),
        servicePath = join(root, "Computer.app");
      for (const path of [moduleDirectory, join(servicePath, "Contents/MacOS")]) {
        await mkdir(path, { recursive: true });
        alive();
      }
      installation = {
        applicationPath,
        runtimeRoot,
        moduleDirectory,
        servicePath,
        nodePath: join(runtimeRoot, "node"),
        replPath: join(runtimeRoot, "node_repl"),
        codexPath: join(runtimeRoot, "codex"),
      };
      for (const path of [
        installation.nodePath,
        installation.replPath,
        installation.codexPath,
        join(servicePath, "Contents/MacOS/SkyComputerUseService"),
      ]) {
        await writeFile(path, "inert metadata fixture", { mode: 0o700 });
        alive();
      }
      for (const [name, version] of [
        ["sky", "0.7.18"],
        ["cua", "0.2.6"],
        ["cua-repl", "0.1.3"],
      ]) {
        const path = join(moduleDirectory, "@oai", name!);
        await mkdir(path, { recursive: true });
        alive();
        await writeFile(
          join(path, "package.json"),
          JSON.stringify({ name: `@oai/${name}`, version }),
          { mode: 0o600 },
        );
        alive();
      }
    })();
    try {
      await preparation;
      alive();
      await expect(validateOpenAiComputerInstallation(installation!)).resolves.toBeUndefined();
      await chmod(installation!.replPath, 0o722);
      await expect(validateOpenAiComputerInstallation(installation!)).rejects.toThrow();
      await chmod(installation!.replPath, 0o700);
      await link(installation!.replPath, join(root!, "second-link"));
      await expect(validateOpenAiComputerInstallation(installation!)).rejects.toThrow();
      await rm(join(root!, "second-link"));
      const alias = join(root!, "alias");
      await symlink(installation!.runtimeRoot, alias);
      await expect(
        validateOpenAiComputerInstallation({ ...installation!, runtimeRoot: alias }),
      ).rejects.toThrow();
      const manifest = join(installation!.moduleDirectory, "@oai/sky/package.json");
      await writeFile(manifest, JSON.stringify({ name: "@oai/sky", version: "0.7.19" }));
      await expect(validateOpenAiComputerInstallation(installation!)).rejects.toThrow(
        "Unsupported",
      );
      await writeFile(manifest, " ".repeat(65537));
      await expect(validateOpenAiComputerInstallation(installation!)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  },
);
