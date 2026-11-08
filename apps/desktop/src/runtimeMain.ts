import { createRequire } from "node:module";
import { installApplicationRuntimeDependencies } from "../../../packages/shared/src/runtimeDependencies.ts";

installApplicationRuntimeDependencies(__filename);
// Native CommonJS require happens only after the reduced module root is held.
createRequire(__filename)("./desktop-main.cjs");
