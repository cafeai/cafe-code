# Gemini in Cafe Code

1. Install the standalone [Google Antigravity CLI](https://antigravity.google/docs/install?tab=cli) on the machine running the Cafe server. Cafe supports ACP in CLI 1.5.9 and newer. Google added Gemini 4 Neon in 1.5.11. [Antigravity changelog](https://antigravity.google/docs/changelog)
2. Sign in from **Settings → Providers** using **Log in** (works for both local and remote Cafe environments: open the Google sign-in link in your browser, paste the authorization code or callback URL, and follow any additional Google account verification link if prompted), or run `agy acp --login` directly on the machine running the server. [Google ACP setup](https://antigravity.google/docs/ide/extensions/acp/)
3. To add a second Gemini account, open **Settings → Providers** and click **Add account** (or click the **Add another Gemini account** button on your existing Gemini card). Enter the absolute path to the standalone executable if `agy` on PATH opens the IDE. Leave **Create a private provider home** on to keep its sign-in, history, and usage limits isolated, then click **Add & log in** (or use **Log in** on the new card).
4. Refresh the provider after changing accounts, updating the CLI, or gaining access to models. Choose an available Gemini model in the composer. Atrium can filter by Gemini and shows the model, thinking setting, and permissions recorded for the turn.

### Private Google sign-in

Cafe gives each new private instance a backend-owned directory. Google sign-in,
ACP model discovery, chat and headless `/usage` use that directory through
`--gemini_dir` and request file-only storage with
`AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` instead of the OS keychain or credential
store. Cafe leaves the credential file to `agy`. Private Antigravity homes
require Antigravity CLI 1.5.16 or newer and work across macOS, Linux, and
Windows. Older CLI versions can use the explicit existing-home choice in Add
account. Debug requires explicit **Allow shared native provider state** for
that choice.

Native resume receipts retain the private home's scope. Existing accounts use
their saved native selection and resumable history. Resume under a different
home is refused. The local qualification used synthetic credentials and an
empty-profile control, with external network access blocked. Live two-account
OAuth, other hosts and shared-history resume are separate qualification.
[Google CLI changelog](https://antigravity.google/docs/changelog#v1516) ·
[Independent macOS sign-in verification](https://github.com/pingdotgg/t3code/pull/41982#issue-)

The model picker uses the current account’s ACP model list. Cafe confirms a switch with the CLI and checks the new model’s native effort selector before sending a selected effort. When the selected model exposes that control, Cafe shows the choices and default reported by the CLI. These are the documented choices for the Gemini 4 family. [Google’s Antigravity model guide](https://antigravity.google/docs/models) · [Gemini thinking levels](https://aistudio.google.com/docs/thinking#thinking-levels)

| Model             | Thinking levels          |
| ----------------- | ------------------------ |
| Gemini 4 Neon     | Low, Medium, High, Extra |
| Gemini 4 Carbon   | Low, Medium, High        |
| Gemini 4 Argon    | Low, Medium, High        |
| Gemini 4 Hydrogen | Low, Medium, High, Extra |

Chats support streamed replies, reasoning and tool activity, native one-time approvals, structured questions (single-select, multi-select, custom answers, and skip/dismiss via ACP form elicitation), and context usage when the CLI reports it. PNG, JPEG, and WebP attachments are available when the session advertises images. Stop cancels the active work and retires the process. Reopening a native conversation requires an acknowledged ACP resume or load.

Attach files such as Markdown, source code, PDFs, and DOCX in the composer. Cafe includes a validated inventory in the prompt, and Antigravity opens those files with its available read tools and the chat’s tool permissions. When available, PDFs and DOCX also include a bounded extracted text view. Document and binary support depends on the available readers.

Use **Steer** while Gemini is working to send a follow-up to its current Antigravity session. Cafe keeps the turn open until both native responses settle. It queues a follow-up for later if the original request is no longer available before submission. If a submitted request loses its response, the message stays in the conversation with a delivery warning. [Antigravity ACP steering](https://antigravity.google/docs/ide/extensions/acp/)

Expand **Gemini thinking** in the work log to read the text Antigravity streams for the current turn. Tool entries show the native calls and their progress. When desktop notifications are enabled, Cafe can notify you that a Gemini turn finished or is waiting for tool approval while you’re away from its chat. Antigravity's terminal-specific status hints and bells are local to that terminal. [ACP session updates](https://agentclientprotocol.com/protocol/v1/prompt-turn)

With Antigravity CLI 1.5.10 or newer, Cafe shows **Gemini background reply** entries and keeps reported running tools visible in **Tasks** and **Atrium** when the foreground turn ends. The row stays active until Antigravity reports that exact tool finished or its session closes. A workflow can represent several internal streams under one reported tool call. [Antigravity changelog](https://antigravity.google/docs/changelog#v1510)

**Settings → Usage** and **Atrium → Usage & Cost** include Gemini tokens from qualifying Antigravity CLI prompt responses. A response reports input, output, and, when present, cached reads and thinking tokens. Cached reads count toward input, and thinking counts toward output. Reports from overlapping steering requests cover the final response only, so Cafe marks that accounting as partial. Context-window occupancy remains in the chat’s Context window panel.

When the configured Antigravity CLI returns a matching built-in `/usage` report, the chat’s **Usage** popover, docked session sidebar, and **Settings → Providers** show account quota for the selected Gemini provider instance. Cafe reads `/usage` with the configured CLI and its native sign-in, without pinning a single CLI version. It allows up to 15 seconds for a read and refreshes after turns at most once per minute per provider instance. **Refresh provider status** in Settings also requests a fresh reading. Each model group shows the reported five-hour and weekly percentages and reset times when available. A reset time alone leaves the percentage unknown. Disabled windows are hidden. If a quota refresh cannot get a new report, Cafe shows the last reading from the same running provider instance and uses its original observation time to label its age. The CLI report does not identify its login, so the older reading describes historical usage. Cafe clears it on sign-in refusal, an explicit empty report, or replacement of the provider instance or qualified executable. This history lives in memory. CLI versions without a matching report can still chat. [Antigravity model quotas](https://antigravity.google/docs/cli/commands/usage) · [Antigravity CLI changelog](https://antigravity.google/docs/changelog#v1111)

The composer offers **Ask permissions**, **Accept edits**, **Plan**, **Auto**, and **Bypass permissions** for Gemini. New Gemini chats default to **Bypass permissions** to match other providers, while existing chats saved with Antigravity’s legacy Default policy keep **Ask permissions** unless you select another mode. Cafe checks that the CLI advertises and acknowledges Accept edits, Plan, or Auto before sending.

Bypass permissions starts a separate Antigravity process with its native tool-approval bypass flag. It applies to the selected chat and lets that process run tools without asking. Use it only in a workspace you trust. Changing modes takes effect with the next idle session, using the same native conversation when the CLI supports resume. [Antigravity execution modes](https://antigravity.google/docs/cli/modes/) · [ACP launch flags](https://antigravity.google/docs/ide/extensions/acp/)

Cafe attaches its management MCP when it opens or resumes a Gemini session. The connection uses the chat’s exact provider instance and follows **Settings → Cafe tools → Enable Cafe management tools**. An already running native session gets the connection on its next stop and resume. [Cafe Code MCP](cafe-mcp.md) · [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup)

Gemini uses one workspace per session. Cafe sandbox overrides, thread goals, computer use, and Cafe Secrets are unavailable for this provider.
