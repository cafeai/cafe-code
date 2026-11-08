import { installApplicationRuntimeDependencies } from "../../../../packages/shared/src/runtimeDependencies.ts";

// Synchronous module-loader hooks belong to one thread. The backend's hook
// does not authorize this worker to borrow packages from an ancestor checkout.
// Keep every application/native module behind a real dynamic import until the
// compiled worker has admitted its own exact private dependency generation.
const sourceEntry = import.meta.url.endsWith(".ts");
if (!sourceEntry) installApplicationRuntimeDependencies(new URL(import.meta.url));

// Direct source execution is the deliberate repository/native-fixture path;
// compiled output never falls back to source or proceeds without its loader.
await import(
  new URL(sourceEntry ? "./sqliteWorkerNative.ts" : "./sqlite-worker-native.mjs", import.meta.url)
    .href
);
