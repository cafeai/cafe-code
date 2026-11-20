# Gemini in Cafe Code

1. Install the standalone [Google Antigravity CLI](https://antigravity.google/docs/install?tab=cli) on the machine running the Cafe server. Cafe supports ACP in CLI 1.5.9 and newer. Google added Gemini 4 Neon in 1.5.11. [Antigravity changelog](https://antigravity.google/docs/changelog)
2. Sign in using `agy acp --login` on that machine as the user running the server. For a remote Cafe environment, use the remote host. [Google ACP setup](https://antigravity.google/docs/ide/extensions/acp/)
3. In Cafe, open **Settings → Providers → Add provider instance** and choose **Gemini (Antigravity CLI)**. Enter the absolute path to the standalone executable if `agy` on PATH opens the IDE. In Debug, choose **Allow shared native provider state** if you want it to use this native sign-in.
4. Refresh the provider after changing accounts, updating the CLI, or gaining access to models. Choose an available Gemini model in the composer. Atrium can filter by Gemini and shows the model, thinking setting, and permissions recorded for the turn.

The model picker uses the current account’s ACP model list. Cafe confirms a switch with the CLI and checks the new model’s native effort selector before sending a selected effort. When the selected model exposes that control, Cafe shows the choices and default reported by the CLI. These are the documented choices for the Gemini 4 family. [Google’s Antigravity model guide](https://antigravity.google/docs/models) · [Gemini thinking levels](https://aistudio.google.com/docs/thinking#thinking-levels)

| Model             | Thinking levels          |
| ----------------- | ------------------------ |
| Gemini 4 Neon     | Low, Medium, High, Extra |
| Gemini 4 Carbon   | Low, Medium, High        |
| Gemini 4 Argon    | Low, Medium, High        |
| Gemini 4 Hydrogen | Low, Medium, High, Extra |

Chats support streamed replies, reasoning and tool activity, native one-time approvals, and context usage when the CLI reports it. PNG, JPEG, and WebP attachments are available when the session advertises images. Stop cancels the active work and retires the process. Reopening a native conversation requires an acknowledged ACP resume or load.

Use **Steer** while Gemini is working to send a follow-up to its current Antigravity session. Cafe keeps the turn open until both native responses settle. It queues a follow-up for later if the original request is no longer available before submission. If a submitted request loses its response, the message stays in the conversation with a delivery warning. [Antigravity ACP steering](https://antigravity.google/docs/ide/extensions/acp/)

Expand **Gemini thinking** in the work log to read the text Antigravity streams for the current turn. Tool entries show the native calls and their progress. When desktop notifications are enabled, Cafe can notify you that a Gemini turn finished or is waiting for tool approval while you’re away from its chat. Antigravity's terminal-specific status hints and bells are local to that terminal. [ACP session updates](https://agentclientprotocol.com/protocol/v1/prompt-turn)

With Antigravity CLI 1.5.10 or newer, Cafe shows **Gemini background reply** entries and follows live tool calls that Antigravity reports after the foreground turn ends. Matching tool activity keeps the chat active in Tasks and Atrium until that task reports a terminal status or the owning session closes. Antigravity’s ACP interface does not expose a complete roster of its background subagents. [Antigravity changelog](https://antigravity.google/docs/changelog#v1510)

**Settings → Usage** and **Atrium → Usage & Cost** include Gemini tokens from qualifying Antigravity CLI 1.5.13 prompt responses. A response reports input, output, and, when present, cached reads and thinking tokens. Cached reads count toward input, and thinking counts toward output. Reports from overlapping steering requests cover the final response only, so Cafe marks that accounting as partial. Context-window occupancy remains in the chat’s Context window panel.

With Antigravity CLI 1.5.13, the chat’s **Usage** popover, docked session sidebar, and **Settings → Providers** show account quota for the selected Gemini provider instance. Cafe reads Antigravity’s built-in `/usage` report with the configured CLI and its native sign-in, on provider refresh and after turns at most once per minute per provider instance. Each model group shows the reported five-hour and weekly percentages and reset times when available. A reset time alone leaves the percentage unknown. Disabled windows are hidden. An unavailable read clears the previous quota, and older CLI versions can still chat. [Antigravity model quotas](https://antigravity.google/docs/cli/commands/usage) · [Antigravity CLI changelog](https://antigravity.google/docs/changelog#v1111)

The composer offers **Ask permissions**, **Accept edits**, **Plan**, **Auto**, and **Bypass permissions** for Gemini. Existing chats keep Antigravity’s Default policy unless you select another mode. Cafe checks that the CLI advertises and acknowledges Accept edits, Plan, or Auto before sending.

Bypass permissions starts a separate Antigravity process with its native tool-approval bypass flag. It applies to the selected chat and lets that process run tools without asking. Use it only in a workspace you trust. Changing modes takes effect with the next idle session, using the same native conversation when the CLI supports resume. [Antigravity execution modes](https://antigravity.google/docs/cli/modes/) · [ACP launch flags](https://antigravity.google/docs/ide/extensions/acp/)

Gemini uses one workspace per session. Cafe sandbox overrides, thread goals, computer use, and Cafe Secrets are unavailable for this provider.
