# Gemini via Google Antigravity ACP

Decided 2026-11-19.

- Gemini uses a separately configured built-in driver and the standalone CLI’s ACP v1 server. The version check consumes a bounded executable response, and ACP must identify itself as Antigravity before any session is opened. The child receives the already-admitted provider environment with CLI auto-update disabled. Authentication is external. The client advertises its real identity and has no filesystem or terminal callback authority.
- Model discovery uses a scoped empty session in a private temporary directory with no prompt, and runs at provider admission or on refresh. The account’s complete model list replaces older results. Keep option IDs exact. For unselected models the model picker can show versioned documented Gemini effort choices without assuming a default. The active model’s live option always wins, and selection and effort each require a native acknowledgment before a prompt. Declared image support requires the live ACP image capability.
- Each chat owns its process and a single outstanding prompt. Cafe requires native Default permission selection before a prompt. Exact current-session/turn approval callbacks can grant only the displayed one-time action. All native pending approvals retire with their owner. Provider Stop joins the owned runtime. Reopening requires a negotiated and acknowledged native resume or load. Live steering is unavailable until ACP can target the exact active foreground turn without replay ambiguity.
- Atrium records the accepted Gemini turn configuration. Context usage is session telemetry derived from provider reports. Account quotas, arbitrary provider modes, and a model’s display name convey no runtime authority.

See the [setup guide](../gemini-provider.md) for user-facing capabilities and the [Google ACP guide](https://antigravity.google/docs/ide/extensions/acp/) for the native interface.
