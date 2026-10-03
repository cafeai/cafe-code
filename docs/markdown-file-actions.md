# Markdown file actions

Created: 2026-10-02 16:43:01 JST (UTC+0900)
Last updated: 2026-10-02 17:29:19 JST (UTC+0900)
Implementation status: complete. Verification commands and the separate native GUI acceptance boundary are documented below; platform CI results belong to the tested PR revision.

Cafe's chat renderer recognizes filesystem destinations and presents the existing user-initiated Open, Reveal and copy-path actions. This is not a new file-management interface or a filesystem sandbox. It does not create, modify or delete files, and provider text never grants a native shell capability.

## Responsibilities and boundaries

Markdown parsing and rendering own link syntax, escaping and sanitized destinations. `markdown-links.ts` owns file-target classification, position suffixes and workspace presentation. Math normalization must preserve Markdown destinations rather than interpreting escaped parentheses in a filename as TeX delimiters. Source recovery must occur before the common URL safety transform; it must not resurrect a rejected destination in a rendering callback.

`editorPreferences.ts` owns configured editor selection for chat and existing settings/keybindings callers. An explicitly configured available editor takes precedence over a remembered editor and keeps its line/column suffix. System-default uses the existing native file-association operation with that suffix removed, not the file-manager reveal command. An unavailable configured editor falls back to a detected remembered editor or the existing catalog order. Malformed or inaccessible remembered storage is non-authoritative and cannot prevent a valid detected editor from opening.

The menu says **Open file** because System default delegates to the operating system rather than promising a text editor. Potentially executable, script, shortcut, application and extensionless destinations require additional cancel-safe consent in the shared preference helper, including settings callers. Declining launches nothing; approving invokes the exact position-stripped path once. Control characters, Windows device namespaces and alternate-stream syntax are rejected. Suffix-based consent is not authoritative file typing: user-defined associations and symlink aliases remain native OS behavior.

The chat action layer checks the local editor/reveal capabilities. Outside-workspace destinations require confirmation, including parent traversal that resolves outside the lexical workspace. Declining must perform no launch. Browser clients without those local capabilities retain copy-path alternatives. These renderer checks are UI consent, not proof of canonical filesystem containment: symlinks and the operating system remain authoritative, and this change does not introduce a filesystem authorization service.

The existing authenticated API and trusted desktop IPC own execution. Editor arguments remain structured, and the existing native open/reveal routes stay unchanged. Recognized Windows editor batch wrappers are admitted as data, not evaluated: the exact installation's native executable and CLI entrypoint are invoked directly, including supported versioned layouts. Unsupported wrappers fail instead of adding a command shell or silently selecting another installation. Keep diagnostics and test fixtures free of credentials or private workstation filenames.

The CommonMark decoder is the existing locked `micromark-util-decode-string` 2.0.1, now explicitly declared by the web workspace. No transitive artifact/version changed. The renderer bounds source-destination reads to 32,768 UTF-16 code units and parenthesis depth to CommonMark's 32-level limit; malformed candidates do not authorize source restoration. It keeps filename entities/escapes consistent with the parser instead of introducing a partial entity decoder.

Slash-based relative links retain CommonMark punctuation escapes even under a Windows workspace. Only unambiguous native relative backslash paths, explicit drive paths and UNC paths retain raw separators. Destination shielding excludes code/math fences and does not hide equation-shaped non-path text from the existing math classifier. Math-only text repairs run after restoration and skip genuine destinations encountered outside a formula, preserving both TeX identifiers and math-looking filenames.

These changes correct existing parsing, preference and launch boundaries; they do not add a public API or a new filesystem authority, so no new architecture decision record is required. The Windows compatibility adapter follows the [official VS Code wrapper](https://github.com/microsoft/vscode/blob/3105ef6d4409c52eeb18800eea5b5d40ac2c539a/resources/win32/bin/code.cmd), its [versioned layout](https://github.com/microsoft/vscode/blob/3105ef6d4409c52eeb18800eea5b5d40ac2c539a/resources/win32/versioned/bin/code.cmd), and [Node 24's batch-file spawning limitation](https://nodejs.org/download/release/v24.13.1/docs/api/child_process.html#spawning-bat-and-cmd-files-on-windows). Cafe does not evaluate those wrappers or enable a command shell.

## Cross-platform regression coverage

Unit cases cover Unix and drive/UNC-shaped paths, relative and absolute links, spaces, balanced/escaped parentheses, reference links, position suffixes, outside paths and hostile schemes. Rendered browser cases cover menu actions, cancellation, HTTPS/document fragments, configured-editor choices and system associations. Tests use synthetic paths and mocked shell APIs; foreign path strings alone do not prove a native host action.

CI's Ubuntu, Windows and macOS quality matrix runs unit/typecheck/build checks. Linux runs the complete browser suite; Windows and macOS additionally run the file-action/settings browser subset. Windows explicitly opts into a native spawn fixture built from a copied Node executable and synthetic CLI script, not an installed application or provider. The current dev compiler heap/serialization and exact dictation executable-fixture admission fixes are retained. Symlink-dependent assertions skip only when Windows itself reports the exact privilege `EPERM`; other errors fail and non-symlink identity tests still run.

The CI toolchain is the exact repository-pinned Node LTS from `.node-version`, Corepack Yarn 4.17.1 and the immutable lockfile. Hosted OS images and existing package-installation services remain external inputs, so passing CI is platform compatibility evidence, not a claim of bit-for-bit artifact reproduction. Fresh locked installation must replay without dependency resolution changes.

Replay with pinned Node and Corepack Yarn from the repository manifests:

```sh
corepack yarn install --immutable
corepack yarn workspace @cafecode/web test src/markdown-links.test.ts src/filePathDisplay.test.ts src/editorPreferences.test.ts src/lib/chatMarkdownMath.test.ts
corepack yarn workspace @cafecode/web test:browser src/components/ChatMarkdown.browser.tsx src/components/settings/SettingsPanels.browser.tsx --maxWorkers=2
```

On an isolated Windows host, set `CAFE_CODE_WINDOWS_EDITOR_E2E=1` and run:

```sh
corepack yarn workspace @cafeai/cafe-code exec vitest run --config vitest.e2e.config.ts integration/WindowsEditorCommand.e2e.test.ts
```

This qualifies native argument/environment delivery for normal and versioned wrappers with shell metacharacters in synthetic paths. It does not launch a real editor GUI. macOS/Linux skip this explicitly Windows-only native fixture and keep their original launcher route.

Repository completion also requires formatting, lint, typecheck, the full test suite and a final `corepack yarn build:desktop --force` after tests. The PR remains a draft until any separate native-platform acceptance is satisfied.

## Native GUI acceptance boundary

On each desktop OS, explicitly verify an inside file and an outside file (accept and decline), spaces/parentheses, relative/absolute paths, line/column navigation, copy-relative/full paths, configured installed editors, OS associations and native reveal. Use isolated synthetic files and a disposable app profile; never use provider credentials or a live conversation. Verify settings/keybindings callers and browser clients without native capabilities too.

Windows installed editor shims, Linux desktop session/file associations and macOS Finder/editor UI have independent native requirements. A successful renderer test or artifact build cannot certify those applications. Record the exact native host, installed editor and observed result rather than claiming universal support.
