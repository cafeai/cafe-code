#!/usr/bin/env node

import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronExecutable = require("electron") as unknown;

if (typeof electronExecutable !== "string" || !existsSync(electronExecutable)) {
  throw new Error("The pinned Electron executable is unavailable after installation.");
}
