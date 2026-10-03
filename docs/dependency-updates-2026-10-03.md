# Reviewed dependency batch — October 3, 2026

Created: 2026-10-03 07:33:39 JST (UTC+0900)

This is the historical first batch. The subsequent explicitly authorized
[major migration follow-up](dependency-majors-2026-10-03.md) supersedes several
deferrals below with measured compatibility fixes; retain this earlier evidence
as the record of what was qualified at the time.

This batch reviews the proposals in [Renovate dashboard #113](https://github.com/cafeai/cafe-code/issues/113).
It does not approve every dashboard proposal, change Renovate's policy, install
provider executables, call paid providers or modify Cafe profiles. Updates target
`dev`; GitHub's default-branch security alerts require separate `main`/release
triage, as described in the [maintenance guide](dependency-updates.md).

## Selected updates

| Area               | Selected versions / changes                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React              | React/React DOM 19.3.0, matching 19.3 types, scheduler 0.28                                                                                                                                 |
| UI                 | Base UI 1.8.0, Pierre diffs 1.5.1, auto-animate 0.10.0, react-pacer 0.23, React Query 5.103.2, Router 1.170.39 / plugin 1.168.40, Zustand 5.0.15, tailwind-merge 3.7, Lucide 0.577          |
| Build              | Vite 8.3.1 / React plugin 6.1.1, Rolldown 1.2.11, Babel plugin 0.2.4, tsdown 0.22.14, Turbo 2.11.4                                                                                          |
| Tests              | Vitest/browser provider 4.1.11, vitest-browser-react 2.3.0, MSW 2.15.0                                                                                                                      |
| Static checks      | Oxfmt 0.70.0, Oxlint/plugins 1.85.0, Node 24 types 24.13.6                                                                                                                                  |
| Libraries          | noble-hashes 2.4.0, YAML 2.9.1, yauzl/types 3.4.0                                                                                                                                           |
| Manifest alignment | TypeScript 5.9.3, Tailwind 4.3.3, Babel core 7.29.7 and micromark decode-string 2.0.1 were already resolved at those versions; raise stale manifest/catalog minimums                        |
| CI                 | Refresh 34 immutable GitHub Action references within their existing major versions; add the real timeline browser test to macOS/Windows qualification, with no runner or permission changes |

All newly resolved npm packages were checked against registry publication times
with the seven-day hold retained during resolution (`npmMinimalAgeGate=10080`).
Their declared Node engines admit the repository's Node 24.13.1. Review includes
the complete transitive lock diff, platform bindings and new build-time native
AST tooling, not just the direct dependencies. Existing same-version lock entries
retain their dependency metadata and checksums; descriptor regrouping is not a
blanket lockfile refresh.

The audited Vite, Rolldown, YAML and yauzl root resolutions are updated together
with their consumers. Other security resolutions and the patched Effect beta.59
family are unchanged. Provider SDKs, Electron/packaging/PTY, Playwright, Node and
Yarn remain pinned; Renovate's exclusions are not relaxed. Source and staged
desktop yauzl versions remain identical.

The MSW worker is regenerated with the installed package's official CLI and is
byte-identical to its 2.15.0 worker. TanStack's generated route file is refreshed;
route paths, parents and child ordering are unchanged. Oxfmt's changed wrapping
produces mechanical formatting in existing source files, reviewed for identical
TypeScript ASTs. No provider lifecycle behavior is changed by those formatting
diffs. Pierre's now-redundant optional React peer extension is removed because
the new package supplies that metadata itself.

Security-relevant changes include Base UI's unsafe property handling, noble-hashes
correctness/option handling, YAML recursive-alias robustness and Vitest mock
filesystem allowlist handling. Action revisions remain immutable and verified
against their official repositories. These changes do not constitute a complete
security audit or claim that default-branch alerts have been cleared.

## Deliberately deferred

The Zod deferral applies to Cafe's direct validation consumers: server, staged
desktop runtime and scripts still resolve Zod 4.4.3. Updated TanStack build tooling
has its own isolated Zod 4.6.5 dependency; it does not replace those runtime
validators. Future lock updates must preserve the runtime boundary until its
string-limit semantics are explicitly migrated.

| Proposal                                                    | Compatibility / qualification reason                                                                                                                                                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LegendList 3.4.0                                            | The real Cafe timeline's verified-tail append test passes on 3.0.0-beta.44 but fails on 3.4.0: the new row remains 144px below the viewport. Keep beta.44; migrate only after fixing and qualifying follow/anchor behavior.                  |
| KaTeX 0.18                                                  | The stylesheet dependency and rehype-katex's separate renderer dependency are not aligned. The new internal CSS class prefixes require a coordinated renderer/style migration, not a stylesheet-only bump.                                   |
| Lexical 0.51                                                | Built-in node/config migration and ESM changes warrant dedicated composer, selection and IME qualification; preserve the 0.41 family together.                                                                                               |
| Zod 4.6                                                     | Since 4.5, string length bounds count Unicode code points instead of UTF-16 units. Blindly upgrading would loosen existing MCP/desktop bounds for astral characters; explicitly preserve limit semantics first.                              |
| TOML 5                                                      | Default parsing rejects integers outside the safe-number range. Cafe edits whole user configurations that can contain unrelated valid int64 values; bigint mode also changes existing integer values. Audit round-tripping before migration. |
| TypeScript 7 / Babel 8                                      | Native compiler and ESM/AST migrations need coordinated Effect language-service / React compiler support. Keep the compatible TypeScript 5 and Babel 7 families.                                                                             |
| Vitest 5                                                    | The protected Effect test adapter currently declares Vitest 3/4 peers. Retain the patched Vitest 4 line.                                                                                                                                     |
| tsdown 0.23                                                 | Changes dependency-subpath resolution defaults and build/declaration APIs; use the latest 0.22 stepping stone first.                                                                                                                         |
| Lucide 1 / major Actions / Node 26 types / new runner major | Separate migrations, not incidental non-major maintenance. Match types to the actual Node 24 runtime.                                                                                                                                        |
| Age-held Mermaid 12, micromark types and MSW 3 proposals    | Do not override the dashboard's publication-age hold or approve an unqualified major.                                                                                                                                                        |

The new real-list browser test deliberately does **not** mock LegendList. It
checks physical scroll geometry, a verified tail before append, measured row
growth, virtualization and keyed-thread/ref retirement. It passed twice against
beta.44 with React 19.3 before full-suite qualification. It is an ongoing regression
gate, not a claim that every pre-existing virtualizer edge case is fixed.
Linux's full browser suite includes it automatically; the focused macOS/Windows
browser step also runs it so future virtualizer upgrades face the same regression
gate on every supported desktop platform.

The preceding commit's Linux CI also exposed a Mermaid preview fixture race:
its implicit one-second readiness wait expired during the first lazy engine load,
while later real-render cases passed. Give that helper a bounded twenty-second
wait within the existing thirty-second test budget. Keep production's fifteen-
second sandbox deadline and all exact rendering/layout assertions unchanged.

Primary release evidence: [React](https://github.com/react/react/releases/tag/v19.3.0),
[Base UI](https://github.com/mui/base-ui/releases/tag/v1.8.0),
[Pierre](https://github.com/pierrecomputer/pierre/releases/tag/diffs-v1.5.0),
[LegendList](https://github.com/LegendApp/legend-list/releases/tag/v3.4.0),
[KaTeX](https://github.com/KaTeX/KaTeX/releases/tag/v0.18.0),
[Lexical](https://github.com/facebook/lexical/blob/v0.51.0/CHANGELOG.md),
[Zod](https://github.com/colinhacks/zod/releases/tag/v4.5.0),
[TOML](https://github.com/BinaryMuse/toml-node/compare/v4.3.0...v5.0.0),
[tsdown](https://github.com/rolldown/tsdown/releases/tag/v0.23.0),
[Vitest](https://github.com/vitest-dev/vitest/releases/tag/v4.1.11),
[YAML](https://github.com/eemeli/yaml/releases/tag/v2.9.1),
[noble-hashes](https://github.com/paulmillr/noble-hashes/releases/tag/2.4.0),
[MSW](https://github.com/mswjs/msw/releases/tag/v2.15.0).

## Reproducible qualification

Use the repository-pinned Node 24.13.1 and Corepack Yarn 4.17.1. Preserve normal
install-script, age and integrity controls. Run an immutable install both in the
working checkout and an isolated fresh source snapshot, then:

```sh
corepack yarn audit:repository
corepack yarn fmt
corepack yarn lint
corepack yarn typecheck
corepack yarn test
corepack yarn workspace @cafecode/web test:browser --maxWorkers=2
corepack yarn build:desktop --force
```

The forced desktop build is the final software verification, after tests. Local
execution on macOS does not qualify native Windows/Linux behavior by itself;
the pushed commit's cross-platform CI provides separate evidence. A dependency
dashboard refresh is not a CI pass, and a successful desktop bundle is not an
installer/runtime smoke test. Record actual results with the pushed commit in
dashboard #113 rather than presenting pending remote checks as completed.
