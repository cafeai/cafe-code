#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureMacDictationHelper } from "./build-mac-dictation-helper.mjs";
import { ensureMacGlideHelper } from "./build-mac-glide-helper.mjs";
import { assertSandboxedPreloadBundles } from "./assert-sandboxed-preloads.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The desktop build must include the native helper before the TS bundle is
// considered usable. Invoke the locked bundler through Node, without a shell
// or any alternate JavaScript runtime.
ensureMacDictationHelper();
ensureMacGlideHelper();

const packagePath = require.resolve("tsdown/package.json");
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
const binPath = packageJson.bin?.tsdown;
if (typeof binPath !== "string") {
  throw new Error("The locked tsdown package does not expose its expected executable.");
}

const child = spawnSync(process.execPath, [resolve(dirname(packagePath), binPath)], {
  cwd: resolve(scriptsDirectory, ".."),
  env: process.env,
  stdio: "inherit",
  shell: false,
});
if (child.error) throw child.error;
if (child.status !== 0) {
  process.exitCode = child.status ?? 1;
} else {
  assertSandboxedPreloadBundles(resolve(scriptsDirectory, ".."));
}
