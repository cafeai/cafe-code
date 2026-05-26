// Cafe supplies this as Codex app-server thread config because Codex 0.133.0's
// `gpt-5.5` model metadata advertises the context window while leaving
// `auto_compact_token_limit` unset. OpenAI's current public compaction guide
// uses a 200k threshold for Codex-style long-running Responses loops, and
// upstream Codex compact tests exercise 200k for the same automatic compaction
// path. That leaves practical headroom under the app-server's currently
// reported 272k input / 258.4k effective window while avoiding the premature
// compactions caused by Cafe's older 100k override.
export const CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT = 200_000;
export const CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_SCOPE = "total";
export const CODEX_AUTO_COMPACT_POLICY_SOURCE = "cafecode-thread-config";
