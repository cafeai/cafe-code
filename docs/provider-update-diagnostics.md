# Provider update diagnostics

Last updated: 2026-10-30 20:10:57 JST (UTC+0900)

This guide covers one-click **provider executable** updates in Settings. Cafe's
application installer follows the separate [desktop update runbook](desktop-releases-and-updates.md).
A command exit and a refreshed executable check are separate observations.

## Admission and outcome

The registry must match both the requested instance ID and its canonical driver
before exposing an update action. Unknown or mismatched instances remain
manual-only. The runner independently rejects a capability with a different
driver before update-state publication, queuing, preflight HTTP or execution.
RPC input never supplies an arbitrary executable or command line.

Applicable Codex package preflight checks the wrapper and host-native package
before freezing its install target. A zero command exit still requires fresh
runtime/version verification. Missing, disabled, unhealthy or inconclusive
results cannot prove that the intended executable was installed.

## Claude Homebrew stable and latest casks

Claude documents distinct `claude-code` and `claude-code@latest` casks in its
[official setup guide](https://code.claude.com/docs/en/setup). The older Cafe
definition always selected `brew upgrade claude-code`. On October 30, the user
identified the reported installation as `claude-code@latest`. Updating an absent
stable cask could explain a nonzero exit, but the historical command's stderr
is still required to establish that cause.

On macOS, Cafe selects a Brew channel only from a successful native `realPath`
observation under exact `/opt/homebrew/Caskroom` or `/usr/local/Caskroom`:
an allowlisted stable/latest token, one bounded version component and exact
`claude` executable. Only a source-owned constant becomes the upgrade argument;
observed path text never becomes argv. Known Caskroom ownership is considered
before native/npm/pnpm/Vite-plus-looking aliases. Malformed or unknown casks
within those known namespaces remain manual-only without updater fallthrough.
A failed observation, alias alone or custom prefix cannot qualify a Brew channel.
Outside that known namespace, existing manager precedence remains unchanged.

For a separately authorized manual update of the confirmed latest cask, the
matching command is `brew upgrade claude-code@latest`; the stable-cask command
is `brew upgrade claude-code`. Choose the installed channel rather than switching
or installing another one. These are guidance examples: no Brew command was run
to prepare this change. This selection fix adds no new channel-specific advisory
source and does not prove successful update or adoption; runtime verification
remains separate.

## Operational metadata

New unsuccessful update states can carry optional `diagnostics`:

| Field                                                   | Meaning                                                                                                                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase`                                                 | Observed `preflight`, `command`, `verification` or `lifecycle` stage.                                                                                                |
| `category`                                              | Fixed `preflight_failed`, `command_failed`, `command_timed_out`, `runtime_check_failed`, `version_unverified`, `unexpected_failure` or `interrupted` classification. |
| `exitCode`                                              | Observed integer native status, including signed/unsigned Windows statuses; `null` means unavailable, never zero.                                                    |
| `timedOut`                                              | Whether the updater command reached its existing timeout.                                                                                                            |
| `stdoutTruncated`, `stderrTruncated`, `outputTruncated` | Limits applied to the returned retained capture, including the joined output cap.                                                                                    |

Exit code 1 alone cannot establish a permission, network, registry or upstream
availability problem. Missing diagnostics from an older backend remain unknown;
do not reconstruct a phase, exit code or capture completeness from old prose.

Timeout currently discards partial command streams. Its exit code and output
are unavailable. False truncation flags do **not** prove that the process emitted
nothing or that its original capture was complete. Unexpected failures and
interruption likewise do not manufacture partial output.

Operational logs retain fixed classifications, bounded scalar metadata and
provider/instance correlation. Fleet debug `instances[].update` includes
`status`, `startedAt`, `finishedAt` and explicitly copied diagnostic fields. It
excludes `message`, `output`, unknown future fields and account data. Correlate
the same server environment, instance, driver and attempt times; another account
or later attempt is not evidence for this failure. Routine diagnostic copying
excludes raw command output.

## Explicit output inspection

The existing authenticated provider-settings payload may retain bounded output.
Disclosure starts closed and requires an explicit button action. It is bound to
a copied exact environment/instance/driver/attempt state, including text and
diagnostics. Changed attempts close it before paint; identical status polling
does not reopen or reset it. Running/successful state replaces the failure view.
This display control is not a new RPC, authorization check, private storage
boundary or universal secret scrubber.

Each stdout/stderr capture retains at most 10,000 bytes. Stderr precedes stdout
in the joined output, which retains at most 10,000 JavaScript string units.
The UI displays inert text, visibly escapes control/bidirectional characters
within finite display bounds and preserves ordinary Unicode. Output never
becomes Markdown, HTML, a link or an executable action. It can contain private
paths or credentials; deliberate local inspection does not authorize putting
it into routine logs or fleet debug.

Timeout always reports output unavailable. Other empty captures report no
available output. Neither statement identifies what an earlier process emitted
outside the retained capture.

## Adoption and recovery

A source change, dependency pin, rebuilt bundle or dev push does not update a
selected external CLI or prove adoption by a running backend/provider.
Debug and Production preserve their [data-profile boundaries](data-profiles.md);
a deliberately requested executable update can affect a shared installation.
Synthetic checks do not prove a live update, native installation or historical
failure's cause.

Reading details never retries an update, installs a provider, changes accounts,
stops active work or restarts Cafe. Those actions retain separate authority.
Cafe application installation keeps its explicit confirmation and
[owned-runtime retirement](decisions/provider-daemon-update-retirement.md) requirements.
