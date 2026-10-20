# Debug and Production data

Last updated: 2026-10-20 22:11:35 JST (UTC+0900)

Source desktop builds and repository development launchers use a separate,
persistent Debug profile. Installed packaged releases retain their existing
Production data. Enabling diagnostic logging on a release does not change its
data profile.

## Locations and first run

The configured Cafe root remains `CAFE_CODE_HOME` / `--base-dir`, normally
`~/.cafe-code` (Windows: `%USERPROFILE%\.cafe-code`). Production keeps
`userdata/state.sqlite` under that root. Debug uses
`.debug/userdata/state.sqlite`, including its own SQLite WAL/SHM files.

Settings, secrets, attachments, images, logs, caches, managed worktrees,
standalone chat directories, browser storage and runtime ownership files also
follow the selected profile. Built source and Vite/watch source use the same
Debug database; renderer development mode does not select another DB.

The first Debug run is fresh setup. Production and legacy `dev` data are not
copied, migrated, deleted or synchronized into it. Later Debug launches retain
their Debug chats and settings. A new Debug native app identity may require its
own OS permission consent; existing Production permissions are not reset or
copied.

Windows supports the `.debug` directory name; a leading dot alone does not set
its Hidden attribute. No OS setting or file-attribute change is needed.

## Launch behavior

| Launch                                                   | Data                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Installed release, including `--cafe-debug` diagnostics  | Production                                                                         |
| Source `yarn start:desktop` / `yarn start:desktop:debug` | Debug                                                                              |
| Repository `yarn dev:*` launchers                        | Debug                                                                              |
| Source Linux desktop's displayless server fallback       | Debug                                                                              |
| Direct standalone server CLI                             | Existing defaults, unless `--data-profile` or `CAFE_CODE_DATA_PROFILE` is explicit |

For example, a standalone operator can explicitly select
`--base-dir /chosen/cafe-root --data-profile debug`. Do not append `.debug` to
the configured parent yourself unless you intentionally want another nested
profile. Internal children receive both configured and effective roots through
private bootstrap and reject incomplete/conflicting selections before opening
settings or a DB. The legacy bootstrap home is already effective as an extra
defense against misinterpreting the configured parent, not permission to run
pre-feature child bundles.

Source launch also requires successful, profile-capable desktop and server
bundles. A bounded build receipt binds the exact emitted JavaScript bytes; a
missing, outdated or inconsistent receipt refuses startup with
`yarn build:desktop` instructions before opening profile settings or providers.
This prevents a new launcher from silently running an old bundle that still
uses global provider state. It is a build-compatibility check, not a signature
against a person able to edit the source checkout. Packaged releases do not use
this source-launch prerequisite.

General Settings shows the **active server environment's** reported profile
and directory. This can differ from the local desktop profile when connected to
a remote server. An older server that omits profile metadata remains unknown;
the UI does not guess Production.

## Providers and accounts

Debug starts with providers disabled and does not probe terminal/global logins
merely because a built-in provider is available. Configure and enable an account
deliberately. Supported Codex, Claude and Grok accounts use private Debug-native
homes, including native history/index state and login helpers. Their account
settings survive later Debug runs.

Provider account configuration is not wholly inside SQLite: native CLIs also
have their own homes and authentication stores. A separate Cafe DB alone would
not separate those. Debug removes inherited provider-home/auth selectors from
private launches; explicit account credentials remain a deliberate setup choice.
The provider child's `HOME`/`USERPROFILE`, XDG and AppData selectors are private
too, so its Git/SSH/tool defaults may differ. The parent shell is unchanged; no
Git configuration, SSH keys or other credentials are copied automatically.
Claude native account/Keychain selection follows its supported config-home
policy; a different desktop bundle name alone is not Keychain isolation proof.

External native homes, unsupported/custom native-state contracts and external
provider servers require the explicit **shared native provider state** setting.
That mode can share credentials, histories, quota and native configuration. The
UI must not call it private. Even separate local logins to the same remote
account share that account's service limits.

Private Claude setup also refuses custom launch arguments and explicit native
cloud authentication/profile selectors (Bedrock, Vertex or Foundry). Those
controls can select additional external state that the private-home contract
does not qualify; clear them or deliberately choose shared native state.
Settings shows the account's proposed private native home and manual login
selectors: `CODEX_HOME` for Codex, `HOME` plus `CLAUDE_CONFIG_DIR` for Claude,
and `GROK_HOME` for Grok. Login is an explicit user action, not a background
credential import.

Provider executables may be shared with Production. Cafe-managed provider
maintenance is refused in Debug, rather than silently updating/uninstalling a
shared installation. Native provider behavior outside Cafe's supported controls
is not an OS sandbox guarantee.

Do not copy a live Production SQLite/WAL, secret store, browser profile, daemon
credentials/markers or native session/resume identifiers into Debug. No automatic
import is provided. User-selected repositories are still shared files unless
you choose separate checkouts; separate data does not isolate their contents.

## Process safety, errors and rollback

Profile selection precedes desktop foundation IO, Electron browser storage and
instance ownership. Each profile has its own IPC and listener selection.

### Browser, phone and network access

Production retains its preferred HTTP/WebSocket port `3773`. Debug prefers
`13773` and scans upward when occupied, even if it starts before Production.
Repository watch launches use the same Debug preference; their separate Vite
frontend retains its existing development-port selection. HTTPS/WSS selects its
own free port using the existing sibling offset, with a Debug-specific overflow
fallback. Use the actual URL shown by the selected instance rather than assuming
that the preferred port was available.

The backend serves the web interface too. A separate browser on the same machine
can open that instance's URL. A phone or another machine needs that profile's
explicit network-access configuration and reachable network URL; `localhost` on
the phone refers to the phone, not the computer running Cafe Code. Debug,
including source/headless web mode, defaults to loopback. Enabling Production's
network access does not enable Debug's, and this feature does not open firewall
rules or forward router ports.

Each profile keeps its own login/session database, pairing/bootstrap credentials
and TLS material. Debug cookie names are distinct and port-qualified for both
HTTP and HTTPS, including headless web mode; Production and unprofiled standalone
cookie names are unchanged. Names avoid browser-cookie overwrites, not an OS or
browser security sandbox between trusted services on one hostname
([RFC 6265, section 8.5](https://www.rfc-editor.org/rfc/rfc6265.html#section-8.5)). Credentials
from another profile do not authorize its database. Use each instance's own
network access/pairing flow and HTTPS trust setup; none is imported from
Production.

Explicit configured ports remain exact, and an occupied port fails rather than
silently redirecting an operator to another profile. A free-port preflight is
not a socket reservation: simultaneous starts can still lose the final native
bind race. Desktop readiness and later health probes therefore require a fresh
challenge-response proof from the exact launched backend, not merely a public
HTTP success. Each actual child launch receives a new private readiness key over
its inherited bootstrap pipe; the key never travels over HTTP or enters the
public environment descriptor. Probes use fresh challenges and domain-separated
HMAC proofs, so another listener or a recorded response cannot satisfy them.
This proof does not authorize adopting/stopping another listener, selecting its
data or widening network access. A failed bind/readiness check remains a refusal
under the existing startup/health budgets. Native multi-device access remains a
separate qualification boundary from synthetic listener/auth tests.

Executable-path matching is not process ownership. Routine source restart uses
the exact profile's native single-instance channel, not global `killall`.
Custom replacement commands are refused by that scoped restart helper; stop the
intended profile explicitly before using a different launcher. The separately
invoked emergency `killall` command remains intentionally global.

Every explicitly profiled backend also holds a separate, profile-local SQLite
ownership transaction in `userdata/backend-ownership/backend-role-v1.sqlite`
before constructing its runtime layers. This is not a transaction on the chat
database, and the provider daemon intentionally does not take this backend-role
lock. A desktop crash can leave its backend alive; that backend retains the OS
lock, so another desktop cannot start a competing backend by choosing a new port.
The lock releases only after backend layers drain and the connection closes, or
the backend process actually exits. A persistent guard file is normal and is
never deleted as stale PID evidence. Unknown/corrupt, foreign-profile or unsafe
guard files refuse startup without modification. These guarantees require a
supported local filesystem with working SQLite locks, not network/NFS storage.
Any existing guard journal/WAL/SHM also refuses automatic recovery and remains
untouched, including an interrupted first initialization. That rare edge needs
explicit diagnosis/repair; a private journal file alone does not prove ownership.
Older pre-feature or unprofiled standalone writers do not retroactively acquire
the guard; do not run them against the same profile concurrently.

A known profile-selection or backend-guard refusal exits only after scoped
cleanup completes. For its current, fully profiled child that has never reached
authenticated readiness, the desktop stops automatic retries and shows one
localized, sanitized error with recovery guidance. Received stderr is not
parsed as authority. A stale exit, an explicit Stop/quit, or a previously ready
backend cannot use this startup-only notification path; ordinary crashes retain
their existing recovery policy. No file or foreign process is removed to make
the refusal disappear.

On macOS/Linux, an adopted provider daemon may reconnect only after its marker,
credential/IPC namespace and authenticated native profile receipt all match the
selected profile. Legacy or ambiguous records are preserved rather than treated
as absence. Adoption does not grant a retained native child handle: automatic
Stop/recovery cannot signal that PID or replace its writer. Such a refusal keeps
the live owner and recovery files intact and requires a deliberate, separately
authorized runtime stop; do not delete its marker to bypass the check. Windows
retains its existing authenticated generation/FILETIME native guard control,
with the same exact profile and namespace requirement for profiled callers.

In-app updates use a separate read-only ownership preparation before shutdown,
then retire the exact controlled daemon before installing a different build.
The native update warning explicitly includes stopping active provider work.
Unproved/adopted POSIX owners cannot be auto-terminated by this path; the update
is blocked before replacing the app instead. This does not change ordinary
Leave Running behavior or retroactively repair an already stranded legacy
owner. See [update retirement](decisions/provider-daemon-update-retirement.md).

Automatic provider-supervisor handoff remains disabled. The internal POSIX
supervisor ensure path can adopt an exactly qualified existing owner but refuses
fresh detached handoff before any process or recovery-file mutation; its former
PID-only spawn/cleanup path is not qualified ownership. Direct explicitly
requested supervisor-role startup and the Windows native controller are
unchanged. This feature does not add a new POSIX supervisor handoff protocol.

An older source controller from the same checkout can still run its old cleanup
logic. It is not supported alongside a newer Debug instance sharing that entry
path. An installed older release has separate artifact paths, but native
co-existence still needs platform qualification. New code does not change an
already-running older controller.

Unknown or mismatched owners and unsafe filesystem aliases fail closed. Profile
access/corruption/disk/schema failures preserve state and show a safe error;
they never fall back to Production or erase Debug. Startup namespace admission
is not protection from another process controlling the same OS user and changing
files later; individual storage owners retain their own publication checks.

Returning to a packaged release opens unchanged Production data. Debug remains
on disk. Pre-feature source launchers may still open Production, so do not assume
that rolling a source checkout back retains this new separation. Never delete
live ownership evidence or attempt a schema downgrade to bypass a refusal.

See the [architecture decision](decisions/debug-data-profiles.md) and
[source-development guide](source-development.md) for implementation and
verification boundaries.
