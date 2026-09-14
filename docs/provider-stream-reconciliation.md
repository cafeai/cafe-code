# Provider stream reconciliation

Last updated: 2026-09-10 11:58:47 JST (UTC+0900)

## Ownership and exact text

Provider adapters normalize upstream events into canonical item identities and append-only text deltas. `ProviderRuntimeIngestion` coalesces small deltas before durable orchestration writes. `ProjectionPipeline` persists the message and keeps terminal turn lifecycle separate from late content reconciliation. The renderer displays the projected text; it must not guess that a short word is invalid or remove it heuristically.

Ingestion commits every observed UTF-16 code unit with a fixed-memory SHA-256 commitment. An authoritative completed item may replace lagging projected text only when it contains that exact committed prefix, or no stream was observed. It flushes its own buffered tail, never derives a suffix from an asynchronously lagging SQL row. Different text and shorter completions fail closed. Completion remains a content boundary, not permission to reopen a stopped turn or change a newer turn's state.

Codex `item/agentMessage/delta` and `item/completed` must preserve identical source text. `CodexAdapter.itemDetail` may check whether an `agentMessage` is blank, but must not trim a nonblank message. One removed trailing newline is enough to invalidate an otherwise complete stream commitment. In the observed failure, the native completion matched all streamed text; trimming caused the final replacement to be rejected, leaving an older terminal message with only its first projected chunk. The fix preserves source whitespace rather than weakening the commitment or hiding short output.

Source: [official Codex app-server item lifecycle](https://learn.chatgpt.com/docs/app-server#items). The exact-prefix guard is Cafe's persistence integrity boundary, not an upstream claim.

## Claude block snapshots and compatibility

The [official Claude streaming flow](https://code.claude.com/docs/en/agent-sdk/streaming-output#message-flow) emits an `assistant` snapshot for one completed content block before `content_block_stop`. Multiple snapshots may share the API `message.id`; each wrapper UUID identifies its own frame. A later model response can reuse block index zero within the same long-running Cafe turn.

`ClaudeAdapter` tracks those identities separately. It matches a snapshot to one unmatched block in the native message, verifies the exact streamed prefix, and appends only a missing suffix under that block's existing canonical item id. A no-delta block uses its full snapshot. Ambiguous or nonmatching snapshots cannot overwrite another block. Delayed snapshots of already-closed blocks are recognized without duplicating a message. Nested subagent streams remain isolated from primary assistant text.

Stream commitments retain fixed-size hash state, not another copy of every streamed paragraph. Completed blocks leave the result-drain list and release full snapshot text. Unmatched snapshot correlation and wrapper replay keys use the existing bounded Claude message limit; reset them at the response-segment boundary. Identity commitments preserve exact UTF-16 code units, including malformed surrogate units that would otherwise collapse during UTF-8 conversion. Warnings contain fixed explanations and counts, not provider text.

The compatibility review compared installed/runtime protocol behavior and current official releases. At the stream-fix audit timestamp, [Codex's changelog](https://learn.chatgpt.com/docs/changelog) targeted CLI/app-server 0.153.4; the subsequent [0.154 capability update](codex-154-compatibility.md) records the newer audit without changing these stream-integrity requirements. The initial Claude stream correction retained SDK 0.3.260 while the newest releases were quarantined. The subsequent [0.3.266 compatibility update](claude-266-compatibility.md) moves all three pins after the package-age audit and adds correlation regressions; it does not replace the local query transport. A newer explicitly configured system CLI remains authoritative; matching wrapper and CLI version numbers is not itself a compatibility requirement.

## Diagnostics and historical data

A rejected nonempty completed item emits `provider.assistantCompletion/textMismatch` at completion, not per token. Fields are restricted to provider kind, the fixed reason `completion-shorter-than-stream` or `completion-prefix-mismatch`, and `streamedCodeUnits`/`completionCodeUnits`. Consuming the stream commitment and normal canonical event deduplication prevent repeated warnings from the same completion. No prompt, output, digest, account, conversation identity, credential or filesystem path is logged by this diagnostic.

The fix affects newly handled provider events. It does not rewrite historical rows on startup, replay all provider history, or restart live providers. Previously stranded text remains unchanged unless the user explicitly chooses **Attempt repair from provider history** in the thread's sidebar context menu while debug mode is enabled. That bounded, authenticated service independently validates terminal message ownership and prefix-safe repair from retained journal or configured provider history; recovery depends on the source data still being available.

## Verification

Use the repository-pinned Node runtime and Yarn through Corepack, with the checked-in lockfile and setup. The stream correction itself requires no dependency change; the accompanying Claude compatibility update deliberately changes the SDK pin. These regressions do not require credentials, network access or live provider binaries.

- `yarn workspace @cafeai/cafe-code test src/provider/Layers/CodexAdapter.test.ts`: exact leading/trailing whitespace, CRLF, whitespace-only suppression and strict streamed-prefix compatibility.
- `yarn workspace @cafeai/cafe-code test src/provider/Layers/ClaudeAdapter.test.ts`: multiple block snapshots sharing an API message id, reused block indexes, duplicate wrappers, partial/no-delta repair, split surrogates and cross-message/prefix rejection.
- `yarn workspace @cafeai/cafe-code test src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`: late old-turn exact completion restores full text without disturbing a newer active turn or timestamps; replay is idempotent, mismatches retain streamed text and diagnostics remain content-free.
- Run `yarn fmt`, `yarn lint`, `yarn typecheck`, and `yarn test`, followed by `yarn build:desktop --force` after tests. A successful build does not replace the already-running desktop/daemon processes; applying it requires the normal app restart lifecycle.

These are corrections within the existing adapter/ingestion/projection contracts. They add no public protocol, persistence migration, provider inference or new repair authority.
