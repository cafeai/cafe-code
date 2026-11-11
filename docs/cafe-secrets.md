# Cafe Secrets

Cafe Secrets keeps values explicitly marked by the user out of ordinary chat
history and model-facing tool results. It is a best-effort text substitution
feature. It adds no provider permission, sandbox exception, global environment
variable, or persistent project configuration.

## Entering and managing values

Type `[sec:VALUE]` in the composer. Complete markers become opaque, random
`[CAFE_SECRET_<32 lowercase hex characters>]` references before optimistic
messages, queued sends, steering, durable dispatch or provider input. The
value is stored for that exact server/profile/chat. Repeating the same value
in a chat reuses its reference. Values are never inferred from API-key shapes.

Type `\[sec:VALUE]` for literal text. Escapes remain in the stored/wire text;
admission and retries never decode a literal marker into a secret. A closing
bracket inside a value can be written as `\]`, and a backslash as `\\`.
Incomplete and empty markers cannot be sent. Complete/incomplete raw ranges
are omitted from persisted composer drafts; unsent values remain only in the
editor's memory. Ordinary text and attachments retain their existing behavior.

The chat context menu's **Secrets…** dialog lists safe labels and references.
Add, reveal, copy, edit, remove and clear are explicit owner actions. Raw
values stay in the dialog's local state. Closing it or opening a different
chat discards revealed values. List responses contain no values. Exports and
duplicated chats retain references and do not copy vault contents.

Unescaped actual references also require admission. A removed or foreign
reference fails before optimistic insertion or native execution. Documentation
examples such as `[CAFE_SECRET_<id>]` are ordinary text. An actual reference can
be escaped with a backslash when it is being discussed literally.

Other providers, older servers without this API, and unconfirmed capability
reads block a secret-bearing send. The composer keeps the input editable,
highlights the affected ranges in red and explains the literal escape.
Backend admission independently checks the selected configured instance's
driver. The orchestration engine rejects raw markers from callers that bypass
normalization; raw markers never enter its command queue or event journal.

## Native execution

Fresh Cafe-owned Claude and Codex sessions receive an exact private runner
invocation. The model calls it through its ordinary native shell tool. The
provider retains sandbox, approval, timeout and process ownership. Cafe adds
no blanket helper approval or alternate native execution authority.

The compiled server entry recognizes `--cafe-secret-exec` before loading the
backend graph. It loads only the one-shot runner, not SQLite, listeners,
profile-role guards or providers. The runner is part of the primary server
build and its application/source build receipts. Its private connection file
binds the calling chat; request JSON cannot select another chat or vault.

Supported request shapes are:

```json
{"operation":"run","argv":["node","scripts/setup.mjs"],"env":{"API_KEY":"[CAFE_SECRET_<id>]"},"stdin":"optional text","cwd":"optional absolute path"}
{"operation":"write_file","path":"/absolute/project/.env","content":"API_KEY=[CAFE_SECRET_<id>]\n"}
{"operation":"read_file","path":"/absolute/project/.env"}
```

Use actual references in requests. Expansion is literal and single-pass.
References in `argv` and paths are refused: environment, stdin and file content
are the explicit expansion channels, so Cafe never places expanded values in
its native command arguments. Files containing values are private where POSIX
permissions apply; writes refuse symlinks, non-regular files and hard links.
The helper does not change Windows ACL or user profile policy.

Each admitted operation captures its own vault snapshot. Later edits/removal
affect subsequent operations; the captured values continue to redact that
operation's result. Stdout/stderr have separate incremental UTF-8 decoders and
bounded redaction tails, including values split across native reads. Redaction
happens before native output capture/truncation and later process polling.
Cancellation signals only the exact held child and joins its native close.

Claude additionally installs query-bound hooks. Input hooks guide reference
usage to the exact current helper without expanding raw native arguments or
granting permissions. Native result replacement is enabled only for a known
stable CLI version at least 2.1.321. It preserves native output shapes and
retains a bounded set of old values through query retirement, so delayed
output can remain redacted after edits. Ordinary calls without references keep
working if the optional vault cannot be read. An unrepresentable protected
result retires its exact query rather than returning raw output. Unknown/older
native versions use the runner without claiming general hook redaction.
Codex does not depend on tool hooks; `write_stdin` reads the already-sanitized
helper output.

This release supports the runner operations above. It does not provide a
universal dispatcher for every provider-native or external MCP tool. Such a
dispatcher needs a separately qualified path through that tool's authorization
and result-recording behavior; the MCP Apps browser broker is not reused as a
generic secret proxy.

## Storage and limits

The vault is separate from event sourcing under the profile's private
`secrets/cafe-secrets` directory. Thread filenames are hashes; values are
AES-256-GCM ciphertext authenticated to their exact root and chat. The key is
a private profile-local file, not an OS keychain. Directory/file admission uses
bounded no-follow native descriptors, single-link ownership and bigint
namespace identities. Unknown/corrupt records fail closed. Publication is an
atomic private-file replacement after fsync and namespace rechecks.

Each chat has at most 64 values, each at most 16,384 UTF-8 bytes, inside a
2 MiB encrypted-file allowance. The transient write owner set is bounded to
128 chats and 32 queued writes per chat. Idle locks retain no chat/root cache.
Runner requests are at most 64 KiB; file reads, expanded file/stdin/explicit
environment data and each sanitized output stream are bounded to 1 MiB.
Sanitized output reports truncation explicitly. Claude's observational
transform retains its separate 2 MiB text and 100,000-node/64-depth bounds.
Clear/remove preserve opaque history and stop future resolution. Permanent
chat deletion clears values before purging local data; the owner API rechecks
session/chat retirement around asynchronous operations.

## Qualification and limits

Pure tests cover syntax/escapes, exact substitution, overlaps, every stream
split, capability refusal, removal, native hook ownership and finite bounds.
Private-file tests cover encrypted persistence, concurrent writers, corruption,
unsafe permissions and linked files. Browser tests cover real user actions and
retain exact scoped render/async cleanup. Native helper qualification uses
synthetic values and the compiled entry, separately from live providers.

The credential-free compiled-helper qualification is opt-in:

```sh
nice -n 10 corepack yarn workspace @cafeai/cafe-code build
CAFE_CODE_SECRETS_E2E=1 nice -n 10 corepack yarn workspace @cafeai/cafe-code test --config ../../vitest.config.ts integration/CafeSecretsRunner.e2e.test.ts
```

It qualifies the actual compiled entry and native Node children on the current
host. It does not qualify live provider adoption, a provider's sandbox/approval
implementation, other hosts, signing or packaged-artifact policy.

Unwrapped reads, programs' own records, transformed/encoded values, images and
deliberate exfiltration remain outside the guarantee. Native Claude telemetry
may observe original output before a post-tool hook; only the runner sanitizes
output before the provider receives it. A removed value does not revoke its
upstream API credential or erase files a tool already wrote. Existing running
backends/providers do not adopt new code from a build, and no app/provider
restart is performed as part of source verification.
