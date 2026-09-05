// Cafe intentionally does not inject a default threshold or accounting scope.
// Codex app-server resolves both from its current model metadata and config,
// matching the official CUI. This label is used only by renderer diagnostics.
export const CODEX_AUTO_COMPACT_POLICY_SOURCE = "codex-app-server";
