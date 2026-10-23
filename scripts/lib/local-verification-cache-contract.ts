/**
 * A local receipt reuses a prior completed task; it is never a fresh execution
 * receipt or authority for hosted CI, a release, providers or application data.
 * Keep the task's complete argv/environment and reviewed input scope explicit.
 */
export interface LocalVerificationTask {
  readonly id: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly scope:
    | { readonly kind: "typecheck"; readonly workspace: string; readonly compiler: string }
    | { readonly kind: "node"; readonly workspace: string }
    | {
        readonly kind: "browser";
        readonly files: readonly string[];
        readonly projects: readonly string[];
      };
}

export interface LocalVerificationInputSnapshot {
  /** Content/command/tool/environment identity; no raw environment values. */
  readonly key: string;
  /** Native identity/change metadata, separate from the reusable content key. */
  readonly fence: string;
}

export interface LocalVerificationReceiptStore {
  /** Keyed, domain-separated authentication; never return or expose the key. */
  authenticateEnvironment(environment: Readonly<Record<string, string | undefined>>): string;
  read(key: string): Promise<boolean>;
  /** A cache write failure cannot turn a freshly passed task into a failure. */
  publish(key: string, signal: AbortSignal): Promise<boolean>;
}

export type LocalVerificationFingerprint = (
  task: LocalVerificationTask,
  signal: AbortSignal,
) => Promise<LocalVerificationInputSnapshot | undefined>;
