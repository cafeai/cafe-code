// These are host-native, lexically fixed fixture paths, not an alternate
// filesystem implementation or authority to inspect a user's Git profile.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { isAbsolute, join, resolve } from "node:path";
import { types } from "node:util";
import type { LocalVerificationTask } from "./local-verification-cache-contract.ts";
import { eligibleForLocalVerificationReuse } from "./local-verification-reuse-policy.ts";

type Environment = Readonly<Record<string, string | undefined>>;

const maximumEnvironmentEntries = 4096;
const maximumEnvironmentBytes = 1024 * 1024;
const maximumEnvironmentValueBytes = 64 * 1024;
const runtimeHooks = [
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
] as const;
const controlledGitKeys = new Set([
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_SYSTEM",
  "GIT_ATTR_NOSYSTEM",
  "GIT_TEMPLATE_DIR",
]);

/** Exact bytes of the reviewed global-config fixture. This deliberately does
 * not force command-line settings or hooksPath: local repository settings and
 * explicit test-owned per-command overrides keep their ordinary precedence.
 * Native admission separately verifies this file and the dot-only template
 * namespace before any cached task can use their identity.
 */
export const localVerificationGitConfiguration =
  "[core]\n\tattributesFile = /dev/null\n\texcludesFile = /dev/null\n";

/** No getters, prototype inheritance or proxy traps may become environment
 * inputs. Only bounded ordinary own enumerable data scalars can be copied to
 * the exact executor environment; a refusal leaves the original fresh path
 * unchanged rather than repairing or serializing received values.
 */
function readEnvironment(value: unknown): Environment | undefined {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Array.isArray(value))
    return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const names = Reflect.ownKeys(value);
  if (names.length > maximumEnvironmentEntries) return undefined;
  const environment: Record<string, string | undefined> = Object.create(null);
  let bytes = 0;
  for (const name of names) {
    if (typeof name !== "string" || name.length === 0 || /[=\u0000]/u.test(name)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    const scalar: unknown = descriptor.value;
    if (scalar !== undefined && (typeof scalar !== "string" || scalar.includes("\u0000")))
      return undefined;
    const valueBytes = Buffer.byteLength(scalar ?? "");
    bytes += Buffer.byteLength(name) + valueBytes;
    if (valueBytes > maximumEnvironmentValueBytes || bytes > maximumEnvironmentBytes)
      return undefined;
    environment[name] = scalar;
  }
  return Object.freeze(environment);
}

function simpleHeapOptions(value: string | undefined): boolean {
  if (value === undefined || value === "") return true;
  const seen = new Set<string>();
  for (const option of value.split(" ")) {
    const match = /^(--max-(?:old|semi)-space-size)=(?:0|[1-9][0-9]{0,5})$/u.exec(option);
    if (!match?.[1] || seen.has(match[1])) return false;
    seen.add(match[1]);
  }
  return true;
}

function supported(environment: Environment): boolean {
  if (runtimeHooks.some((name) => environment[name] !== undefined && environment[name] !== ""))
    return false;
  if (!simpleHeapOptions(environment.NODE_OPTIONS)) return false;
  for (const [name, value] of Object.entries(environment)) {
    if (!name.startsWith("GIT_")) continue;
    if (name === "GIT_PAGER") {
      if (value !== undefined && value !== "" && value !== "cat") return false;
    } else if (!controlledGitKeys.has(name)) return false;
  }
  return (
    (environment.GIT_CONFIG_NOSYSTEM === undefined || environment.GIT_CONFIG_NOSYSTEM === "1") &&
    (environment.GIT_CONFIG_SYSTEM === undefined ||
      environment.GIT_CONFIG_SYSTEM === "/dev/null") &&
    (environment.GIT_ATTR_NOSYSTEM === undefined || environment.GIT_ATTR_NOSYSTEM === "1")
  );
}

/** This pure guard is shared by every eligible task. Root-dependent Git path
 * qualification belongs to localVerificationGitEnvironmentMatches below; an
 * admitted runtime environment alone never authorizes server-Node reuse.
 */
export function localVerificationRuntimeEnvironmentSupported(environment: unknown): boolean {
  const own = readEnvironment(environment);
  return own !== undefined && supported(own);
}

/** The calling Codex terminal supplies a fresh RPC tracing ID for every shell
 * operation. That ID is not an input to these credential-free local checks.
 * Remove only this inherited field from the ACTUAL native child environment,
 * before fingerprinting it: ignoring an executed field only in the key would
 * wrongly attest different executions as equal. Every other field stays bound.
 *
 * Disabled/unknown/hosted/Windows or unsupported environments retain their exact
 * original fresh path. The caller must also keep explicit per-step overrides
 * literal, rather than stripping a value which runTestPlan would merge back.
 * This function never mutates process.env, profiles, another task or a provider.
 * The platform argument is for pure policy controls, not native ACL evidence.
 */
export function prepareLocalVerificationTaskEnvironment(
  task: LocalVerificationTask,
  enabled: boolean,
  platform: NodeJS.Platform = process.platform,
): Environment {
  const original = task.environment;
  if (!enabled || platform === "win32" || !eligibleForLocalVerificationReuse(task)) return original;
  const own = readEnvironment(original);
  if (
    !own ||
    !supported(own) ||
    own.CI ||
    own.GITHUB_ACTIONS ||
    !Object.hasOwn(own, "CODEX_TOOL_CALL_ID")
  )
    return original;
  if (
    task.scope.kind === "node" &&
    task.scope.workspace === "apps/server" &&
    !localVerificationGitEnvironmentMatches(task.cwd, own)
  )
    return original;
  const prepared = { ...own };
  delete prepared.CODEX_TOOL_CALL_ID;
  return Object.freeze(prepared);
}

export function localVerificationGitEnvironment(root: string) {
  if (
    root.length === 0 ||
    root.length > 8192 ||
    root.includes("\u0000") ||
    !isAbsolute(root) ||
    resolve(root) !== root
  )
    throw new Error("Unsupported local verification repository path.");
  return Object.freeze({
    GIT_CONFIG_GLOBAL: join(root, "scripts/fixtures/local-verification-git.config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: join(root, "scripts/fixtures/local-verification-git-template"),
  });
}

/** Matching the five selectors is necessary, not sufficient: the fingerprint
 * producer still admits the exact static files/template and native null
 * device. Unknown/conflicting inherited Git selectors cannot be overwritten
 * into an apparently qualified run.
 */
export function localVerificationGitEnvironmentMatches(
  root: string,
  environment: unknown,
): boolean {
  const own = readEnvironment(environment);
  if (!own || !supported(own)) return false;
  const expected = localVerificationGitEnvironment(root);
  return Object.entries(expected).every(([name, value]) => own[name] === value);
}

/** Only an explicitly enabled POSIX server lane receives a frozen environment
 * clone. Refused/disabled/other lanes return the SAME original object and must
 * follow their ordinary fresh execution path. This function owns no IO, native
 * process, user profile or process.env mutation.
 */
export function prepareLocalNodeVerificationEnvironment(
  root: string,
  workspace: string,
  original: Environment,
  enabled: boolean,
): Environment {
  if (!enabled || process.platform === "win32" || workspace !== "apps/server") return original;
  const own = readEnvironment(original);
  if (!own || !supported(own)) return original;
  const expected = localVerificationGitEnvironment(root);
  for (const [name, value] of Object.entries(expected))
    if (own[name] !== undefined && own[name] !== value) return original;
  return Object.freeze({ ...own, ...expected });
}
