#!/usr/bin/env node

import { rmSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const generatedPaths = [
  ".turbo",
  ".yarn/install-state.gz",
  "node_modules",
  "apps/desktop/.turbo",
  "apps/desktop/dist-electron",
  "apps/desktop/node_modules",
  "apps/server/.turbo",
  "apps/server/dist",
  "apps/server/node_modules",
  "apps/web/.turbo",
  "apps/web/dist",
  "apps/web/node_modules",
  "oxlint-plugin-cafecode/dist",
  "oxlint-plugin-cafecode/node_modules",
  "packages/client-runtime/.turbo",
  "packages/client-runtime/dist",
  "packages/client-runtime/node_modules",
  "packages/contracts/.turbo",
  "packages/contracts/dist",
  "packages/contracts/node_modules",
  "packages/effect-codex-app-server/.turbo",
  "packages/effect-codex-app-server/dist",
  "packages/effect-codex-app-server/node_modules",
  "packages/shared/.turbo",
  "packages/shared/dist",
  "packages/shared/node_modules",
  "packaging/aur/cafe-code/pkg",
  "packaging/aur/cafe-code/src",
  "packaging/desktop-runtime/node_modules",
  "scripts/node_modules",
] as const;

for (const relativePath of generatedPaths) {
  rmSync(resolve(repoRoot, relativePath), { recursive: true, force: true });
}

process.stdout.write(`Removed ${generatedPaths.length} generated paths.\n`);
