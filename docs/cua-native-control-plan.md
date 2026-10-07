# Local Cua desktop control

## Outcome and scope

Replace the retired Linux virtual desktop implementation with native control of
the computer running Cafe's Electron app. The first provider integrations are
Codex and Claude Code, on macOS. Other hosts have no control UI, provider tools,
host publication or runtime staging in this first release. Both providers use the same small
Cafe-owned MCP catalog. Cua Spaces, Fleet, Cua accounts, hosted inference,
perception models and provider-global configuration edits are out of scope.

The first testable milestone is a development desktop build with a settings
panel that can start/stop the verified controller, report native permission
status, and expose real local desktop tools to new Codex and Claude sessions.
An isolated synthetic-provider test must exercise the complete tool bridge.
Native permission/input checks remain explicit opt-in tests; default tests must
not touch user applications, profiles, credentials or paid inference.

## Architecture

1. **Reviewed runtime.** Build from the exact Cua source commit in the release
   pin, applying a checked-in dependency patch and lockfile. Record source,
   patch and resulting executable hashes. Do not enable the previously reviewed
   upstream archives without resolving their findings. Keep upgrades centered
   on one upstream pin plus a small explicit patch. Retain redistribution
   notices. Development setup is an explicit Corepack Yarn/Node command.
2. **Electron-owned helper.** Electron main starts `cua-driver serve --embedded`
   directly with a fresh private socket/named pipe, parent-liveness stdin and
   standard permission mode. Set telemetry and update opt-outs on this actual
   process; do not use the embedded SDK's incomplete environment allowlist.
   Verify readiness against the spawned PID, version and host identity. Never
   adopt an ambient Cua daemon. Stop the exact child on disable/quit/death.
3. **Local control host.** A private authenticated loopback endpoint connects
   provider-session bridges to Electron's controller. Renderer IPC alone can
   enable/disable control. Provider credentials are short-lived, revocable,
   session-bound capabilities in private temporary files. No credential appears
   in argv, URLs, logs, conversation events or provider-global settings.
4. **Tool catalog.** Publish an explicit local native catalog for health,
   applications/windows, desktop observation and computer input. Hide Cua's
   session labels and transport metadata from agent arguments. Deny arbitrary
   tool names, reserved arguments, file outputs, extension/update/model tools,
   remote connections and unbounded script execution. Preserve native errors
   and permission requirements without retrying uncertain physical actions.
5. **Ownership and cleanup.** One provider session owns native control at a
   time. Concurrent sessions get a visible busy result. Ending/revoking a
   session awaits Cua cleanup; pending/partial cleanup blocks new ownership.
   Lost transport or timed-out input is uncertain, so fail closed and stop the
   helper before another owner can acquire control. Disable immediately prevents
   new admission. Restart creates a new generation and invalidates old tokens.
6. **Codex and Claude.** Mint private MCP bindings at provider startup, activate
   only after session admission, and retire on startup failure/session exit.
   Codex receives complete process-local TOML overrides under random server
   names. Claude receives per-query `mcpServers`. Keep scheduling and management
   transports independent, preserve each provider's permission policies, and
   redact desktop payloads from native event journals. Existing sessions may
   need normal stop/resume after enabling; never silently create a replacement
   conversation or interrupt a running turn to change tools.
7. **Settings and packaging.** Add a desktop-only local settings panel with
   enable/disable, refresh diagnostics, permission guidance and release state.
   Include only qualified native payloads outside ASAR in installable artifacts.
   Missing/wrong runtime assets fail visibly; ordinary builds do not download
   unreviewed executables. Existing saved screenshots and database migrations
   stay intact.

## Dependency and privacy qualification

Update applicable `anyhow`, `event-listener`, `lru` and `memmap2` dependencies to
their advisory-fixed compatible releases. Determine exact target/build-time
reachability for the XML advisories; upgrade or patch a runtime-reachable path.
Record target exclusion or bounded bundled-input evidence for informational
maintenance findings rather than suppressing them. Cua's optional update and
extension facilities must be inaccessible through the Cafe catalog. Test actual
helper launch environment and do not edit the user's Cua profile as an opt-out.

## Verification and delivery

Default tests cover release admission, launch identity, catalog filtering,
reserved-argument rejection, authentication, concurrent ownership, revocation,
timeouts and acknowledged cleanup. Provider fixtures assert complete Codex and
Claude configuration and unchanged permission policies. Browser fixtures cover
settings/diagnostics states. An opt-in isolated Electron/Node bridge test proves
single-file bundled MCP initialization, discovery and native-response routing.

Run `corepack yarn fmt`, `corepack yarn lint`, `corepack yarn typecheck` and
`corepack yarn test`. Run focused browser/native fixtures appropriate to the
change, then `corepack yarn build:desktop --force` as the final verification.
Deliver the verified worktree branch for the user to merge into their current
`dev`, without launching another Cafe instance. Include build/setup commands, manual screenshot/input
steps, and an honest per-host qualification status. macOS execution here cannot
establish native Linux or Windows qualification.

## Implemented Mac milestone

- Pinned source build and telemetry/dependency patch; automatic verified native
  preparation before desktop build cache lookup.
- Electron-owned helper and authenticated session-only MCP host; active-turn
  admission, one owner, generation fencing, idempotent cleanup and no replay of
  uncertain input.
- Codex/Claude configuration and lifecycle wiring with unchanged provider
  permission policies and desktop-payload redaction, including Codex snapshots.
- Local Mac settings for enable/disable, diagnostics and screenshot preview.
- Verified native artifact staging outside ASAR and Mac signing/hash finalization.
- Isolated provider/settings/authority tests, real copied Electron/Node bridge
  tests, native driver health/screen-size tests and ad-hoc signing qualification.

The first user test after merging is `corepack yarn build:desktop --force`, then
the user's normal desktop launch. In local Settings → MCP, enable control,
grant Accessibility and Screen Recording to Cafe when requested, check
permissions and test a screenshot. Start or normally stop/resume a Codex/Claude
session and use a disposable window for initial input. No separate app is
launched by this work. Real screenshot/input grants and a live provider task
remain the user's acceptance test, distinct from isolated automated tests.
