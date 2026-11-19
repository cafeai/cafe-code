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

Chats support streamed replies, reasoning and tool activity, native one-time approvals, and context usage when the CLI reports it. PNG, JPEG, and WebP attachments are available when the session advertises images. Stop cancels the turn and retires the process. Reopening a native conversation requires an acknowledged ACP resume or load. A message sent while Gemini is running becomes a queued follow-up.

The provider uses Antigravity’s Default permissions for a single workspace, including native tool consent. The composer labels that policy **Antigravity CLI permissions**. Cafe sandbox and bypass modes, live steering, thread goals, account quota readouts, computer use, and Cafe Secrets are unavailable for this provider.
