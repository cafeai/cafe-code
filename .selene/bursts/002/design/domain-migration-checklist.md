# Burst 002 Deferred Domain And External Distribution Checklist

This checklist records the `t3.codes`, channel-cookie, pairing, registry, and
external release surfaces that are intentionally not moved in Burst 002. No
Cafe-hosted domain is declared live by this artifact.

## Deferred Surfaces

| Surface                                     | Current value                                                                               | Later Cafe-owned replacement needed                         | Criteria before changing code/defaults                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Router domain                               | `https://app.t3.codes`                                                                      | Chosen Cafe-owned router domain                             | DNS ownership verified, TLS issued, Vercel/router deployment live, old route redirects tested, pairing URLs tested from desktop and browser.              |
| Latest channel domain                       | `latest.app.t3.codes`                                                                       | Chosen Cafe-owned latest channel domain                     | Stable deploy succeeds, cache behavior verified, router rewrite from the new router domain reaches latest, old domain remains available during migration. |
| Nightly channel domain                      | `nightly.app.t3.codes`                                                                      | Chosen Cafe-owned nightly channel domain                    | Nightly deploy succeeds, Nightly version/tag semantics unchanged, router rewrite reaches nightly, old domain remains available during migration.          |
| Hosted pairing URL                          | `https://app.t3.codes/pair`                                                                 | New Cafe router `/pair` URL                                 | Pair-code parsing, fragment token handling, HTTPS backend links, and mixed-content rejection behavior verified on old and new URLs.                       |
| Channel route                               | `/__t3code/channel`                                                                         | New Cafe route, if desired                                  | Dual route period added, both routes select `latest`/`nightly`, redirects do not drop query params, old route retirement date recorded.                   |
| Channel cookie                              | `t3code_web_channel`                                                                        | New Cafe cookie, if desired                                 | Dual read/write implemented, precedence documented, expiry/domain/path tested, old cookie accepted until retirement.                                      |
| Well-known endpoint                         | `/.well-known/t3/environment`                                                               | `/.well-known/cafe-code/environment` already added as alias | Clients fetch new endpoint successfully, legacy endpoint remains served until all desktop/web/SSH clients have migrated.                                  |
| Web release workflow env vars               | `T3CODE_WEB_ROUTER_URL`, `T3CODE_WEB_LATEST_DOMAIN`, `T3CODE_WEB_NIGHTLY_DOMAIN`            | `CAFE_CODE_WEB_*` values                                    | New vars configured in CI, legacy vars still accepted, deploy logs prove final values, no fallback to fake Cafe domains.                                  |
| Install registry IDs                        | `T3Tools.T3Code`, `t3-code`, `t3code-bin`                                                   | Cafe-owned Winget, Homebrew, and AUR IDs                    | Registry submissions accepted, package signatures/checksums verified, README install commands restored only after IDs resolve publicly.                   |
| Desktop app IDs and OS integration          | `com.t3tools.t3code`, `t3code.desktop`, `t3code` WM class                                   | Cafe-owned app IDs / desktop entries                        | Migration plan covers existing installed apps, notifications, shortcuts, update continuity, and Linux desktop entry replacement.                          |
| Desktop artifact filenames                  | `T3-Code-${version}-${arch}.${ext}`                                                         | Cafe artifact filename pattern                              | `latest*.yml`/`nightly*.yml` manifests validated, old assets retained or redirected, updater smoke tests pass from old installed versions.                |
| Release repository / updater publish target | Current GitHub release target and `GITHUB_REPOSITORY`/`CAFE_CODE_DESKTOP_UPDATE_REPOSITORY` | Final Cafe release repository                               | GitHub redirects verified, updater publish config verified, release-download URLs and Discord announcement URLs point at the final repo.                  |
| Discord/release destinations                | Existing webhook and role configuration                                                     | Cafe-owned release channels/roles, if changed               | Secrets configured, dry-run payload reviewed, Nightly and latest notifications point at live release URLs.                                                |

## Migration Order

1. Choose and verify Cafe-owned domains and registry IDs outside the codebase.
2. Add dual-route and dual-cookie support before changing defaults.
3. Configure CI with `CAFE_CODE_WEB_*` and desktop update repository variables.
4. Deploy router, latest, and Nightly targets and verify end-to-end pairing.
5. Publish a release smoke build that can update from an old installed app.
6. Update docs and remove old defaults only after telemetry/support confirms the
   old surfaces are no longer required.

## Hard Non-Claims

- No Selene artifact claims that cafe-code is secure, correct, race-free,
  deadlock-free, data-loss-free, or compatible with any upstream provider API
  outside the artifact's predeclared scope.
- No user-facing behavior, migration, protocol, or security claim is promoted
  unless it is grounded in source review and the repository's required quality
  gates for the touched surface.
- Provider output is untrusted. Selene enforces process discipline; it does not
  make Claude, Codex, Cursor, OpenCode, or any other provider semantically
  correct.
- This artifact does not claim coverage of credentials, tokens, local files,
  persisted conversations, WebSocket sessions, or provider subprocess behavior
  beyond the exact checks recorded in the artifact.
- This artifact does not promote any classification beyond what the executable
  strict-close rules in `.selene/classifications.py` admit.
