# Codex command and fixture qualification

The command-backed typed client, ordinary session startup, picker model discovery
CLI health probes and one-shot text-generation helpers use
`effect-codex-app-server/command`. This policy selects
the command's shell option; it does not resolve an alternative executable, grant
filesystem admission, change authentication or alter provider permissions. Platform
rules and compatibility boundaries live in **AGENTS.md → Windows-Specific Notes**.

Keep each caller's existing structured arguments, environment, working directory
and lifecycle options. In particular, disposable probe process-group/SIGKILL
ownership must not replace the long-running session's existing cleanup policy.

## Test boundary

- The pure policy matrix covers all supported platform selections. Intercepted
  client/session spawn tests fail before creating a process and assert the real
  caller's command, arguments and lifecycle options.
- Native serialization tests copy the pinned Node executable and a synthetic
  protocol peer into a scoped directory with spaces/metacharacters. They assert
  literal arguments, synthetic home/cwd/environment and retirement of the exact
  owned child, including a deliberate client construction failure.
- Registry reconciliation tests use absent absolute fixture executables and one
  explicit direct home across settings generations. A narrow spawner guard
  rejects unrelated providers. Filesystem guards reject shadow-home directory
  materialization outside the fixture. Lightweight mocked status probes receive
  an explicit empty environment instead of inheriting real provider auth homes.
- Azure CLI body fixtures use private scoped host-native temporary files. Existing
  symlink security tests remain enabled wherever the host can create symlinks;
  unsupported privilege skips follow the narrow rule in AGENTS.md.

No installed provider, user profile, real credentials, paid inference or account
network request participates in these fixtures. The environment filtering belongs
only to tests: production provider environment inheritance is unchanged. Native
Node qualification does not establish installed-provider or native GUI success.

## Reproduction

Use the exact repository-pinned Node LTS from `.node-version` and Corepack Yarn 4.17.1 with an immutable
install. Run these focused tests on the host being qualified:

```sh
corepack yarn workspace effect-codex-app-server test src/client.test.ts
corepack yarn workspace @cafeai/cafe-code test src/provider/Layers/CodexProvider.test.ts src/provider/Layers/CodexSessionRuntime.exit.test.ts src/provider/Layers/ProviderRegistry.test.ts src/launcher.test.ts src/sourceControl/AzureDevOpsCli.test.ts
corepack yarn workspace @cafeai/cafe-code test src/textGeneration/CodexTextGeneration.test.ts
```

Then run repository formatting, lint, typecheck and full tests, followed by the
forced desktop build. CI executes the focused boundary on each supported native
host; simulated foreign command strings alone are not native execution evidence.

This work incorporates the reviewed intent of PRs #110 and #111. Existing
privilege-specific symlink handling already landed through #109 and is preserved.
It deliberately extends the shared policy to every actual Codex caller, rather
than fixing only disposable typed-client probes.
