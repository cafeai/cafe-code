import * as Effect from "effect/Effect";

// Reserved intentionally as a no-op. The original version attempted to repair
// historical assistant projections by scanning `orchestration_events` and
// rebuilding streamed message text during startup migration execution. That
// shape is not acceptable: migrations run before the backend/provider-daemon
// sockets are ready, so a large Cafe database can keep the provider daemon from
// opening its IPC socket before the desktop health timeout. Historical
// projection repair must be bounded and post-readiness; the forward fix lives in
// ProviderRuntimeIngestion where completed provider items append any missing
// streamed suffix before terminalization.
export default Effect.void;
