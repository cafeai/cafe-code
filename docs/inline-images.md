# Inline images and custom instructions

Cafe enables assistant-local image publication for Codex and Claude. Other providers keep their existing behavior.

## Custom instructions

Settings → Chats → **Custom instructions** opens the selected server's existing `system-prompt.md` file. The RPC and filename remain compatible with older clients. Local desktop clients open the file in the configured editor; remote clients copy its server-side path.

Codex reads that file when Cafe materializes a session. The adapter supplies its trimmed contents separately from the user turn, and `thread/start` and `thread/resume` receive `developerInstructions` containing:

1. A Cafe `<app-context>` block advertising the implemented image contract and this chat's workspace roots.
2. The optional custom instructions in `<user-instructions>`.

Claude reads the same file at each query creation and supplies the same shared app/custom instruction text through `systemPrompt: { type: "preset", preset: "claude_code", append }`. This preserves its standard prompt, user/project/local setting sources and permission callbacks. Instructions stay separate from user input.

The file is no longer prepended to either provider's first user input, including copied-chat/provider-continuation bootstrap. Stored user messages stay unchanged. Codex Plan/Build collaboration-mode `developer_instructions` remains independent and retains its existing behavior. Empty custom instructions still leave Cafe's capability advertising enabled. Codex edits take effect at the next native session start/resume. Claude edits are supplied at the next query creation, but recorded sessions may retain their old instructions until compaction or a new native session (see below). Cafe does not interrupt an active turn or send an extra conversation message to apply them. An unreadable Claude instruction file fails with a fixed message before retiring an existing healthy query.

Remaining providers still receive the old first-user-message prefix. This change does not edit provider profiles, project instructions or global provider configuration. Instructions are per server, not automatically synchronized between saved connections. The Custom instructions setting's info tooltip explains when each provider applies changes.

## Model-facing image contract

Include ordinary Markdown in a Codex or Claude assistant reply:

```markdown
![Chart](/absolute/workspace/path/chart.png)
![Screenshot](</absolute/workspace/path/screenshot with spaces.png>)
```

Use forward slashes for native drive paths. Image reference definitions also work. The backend parses completed Markdown nodes; code examples, ordinary links and incomplete image syntax do not authorize publication. Viewing an image with a provider tool remains separate from embedding it in the user-facing reply.

Supported formats are PNG, JPEG, GIF and WebP, identified from their bytes. Limits are 8 MiB per image, 16,384 pixels per side, 40 million pixels, and eight unique image destinations per message. SVG, raw HTML, data URLs and `file://` imports are not supported by the local publication path. Existing ordinary HTTP image rendering is unchanged.

## Publication, ownership and delivery

The independently subscribed publication worker handles completed assistant-message events with a dropping 64-entry queue. It does not parse Markdown, read files or write image bytes on the provider token ingestion path. A viewer's manifest request can also materialize an exact saved, completed assistant message in a Codex/Claude chat, covering historical replies and worker/arrival races. Other providers remain excluded. No caller can supply an arbitrary path to import: import sources come exclusively from parser-admitted image nodes in that saved message.

The server admits regular files only below the chat's worktree/project root and explicit additional workspace roots. Standalone chats use the existing identity-verified owned directory. Leaf and parent symlinks below the admitted root are rejected. Source reads are bounded and check held-file identity, size and modification timestamps plus parent namespace identity before and after reading. Platform-specific traversal qualification is recorded in AGENTS.md.

Migration 93 stores bounded raster bytes in `chat_image_assets`, deduplicated by SHA-256, and exact `(thread, message, source)` ownership in `chat_message_images`. Bytes and ownership commit together, avoiding a split filesystem/database publication and orphan-file cleanup. This deliberately adds bounded binary storage to Cafe's private SQLite database; no base64 or image bytes enter message projections, WebSocket snapshots or provider event journals. Large files remain unsupported. Publication rechecks the unchanged completed message and deletion tombstone after file I/O.

Each message's reference is immutable. Reusing a filename in a later reply saves that later file's bytes without changing earlier replies. Published images survive source deletion and backend restart. Fork/duplicate projection copies the image binding to the copied message identity; rewind/message deletion and hard deletion release ownership, and the final reference releases the shared bytes. Images already published do not require the original workspace to remain available.

`GET /api/chat-images?threadId=…&messageId=…` returns the bounded metadata manifest. Adding `source=…` reads only that exact published message binding. Both operations authenticate through Cafe's existing server sessions. Authenticated guests retain the same read-only chat access as other chat content. Unknown/cross-chat image bindings return no bytes, and hard-deletion tombstones fence reads immediately. Responses use no-store, nosniff, restrictive CSP and the existing browser API CORS headers.

The renderer uses the selected environment's `fileRequest` transport: primary connections use cookies, saved servers use bearer headers, and secrets never appear in image URLs. Image and existing desktop-preview transfers share two active slots. Metadata reserves the image aspect ratio; bytes become a transient object URL with unmount/cancellation cleanup. Clicking an image opens the existing enlarged-image viewer. Failures show a compact unavailable state and Retry; they do not fail a provider turn. Images appear after the assistant message finishes streaming.

## Claude prompt lifecycle

Cafe uses the pinned `@anthropic-ai/claude-agent-sdk` 0.3.288's supported preset append:

```ts
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  append: cafeCapabilitiesAndCustomInstructions,
}
```

`ClaudeAdapter.ts` reads the selected backend file before replacing a query and composes the same `CafeInstructions.ts` text used by Codex. Native start and resume options both receive the append. Image publication and rendering share the existing Codex service, ownership, authentication, format bounds and cancellation behavior; there is no separate Claude file endpoint or inference call.

New Claude sessions receive the image advertising and current custom instructions from their first request. Existing sessions may keep the system prompt recorded before this feature or before a file edit until native compaction/new-session creation. Cafe deliberately leaves `snapshot` unset, preserving the configured runtime's recording policy; it does not set `snapshot: false`, force compaction, recreate conversations, or insert synthetic user turns. Disabling recording can invalidate caches and preserved thinking. Renderer support itself works for saved Markdown image replies regardless of whether a resumed model has already received the new advertising. [Anthropic's system-prompt documentation](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts) describes append, recorded-prompt behavior and its version/account boundaries.

## Qualification

Isolated tests cover actual Markdown nodes, reference definitions and URI encoding; outside-root/symlink/non-image/size/pixel rejection; both providers' exact stored bytes across filename changes, source deletion and database reopen; message identity, guest/authentication and tombstone fences; fork retention and final-owner cleanup; native start/resume instruction fields and unchanged user input. Claude fixtures additionally cover missing/blank files, reading edits at query creation and sanitized read failure before healthy-query retirement. Browser fixtures cover Claude/Codex timeline routing in local/remote environments, enlarge/retry, streaming and code examples, object-URL release, narrow 80/130% layouts and the instruction-lifecycle tooltip. The shared transport's Node fixtures independently verify real cookie/bearer header behavior.

Run repository format, lint, typecheck and default tests; run the focused image/Markdown browser fixtures; finish with the required forced desktop build. Synthetic/local qualification does not claim native Windows/Linux execution or a paid live-provider smoke.
