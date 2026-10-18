/** Storage selection is immutable startup policy, not diagnostic logging state.
 * Callers retain the configured parent separately from the effective root so
 * exact-child bootstraps never append the Debug suffix a second time. */
export type DataProfile = "production" | "debug";

/** An automatic listener preference is not an ownership or exposure grant.
 * Debug starts in its own range even when it launches before Production;
 * legacy standalone invocations retain the installed application's default.
 * Callers still honor deliberate explicit ports and probe every candidate. */
export function preferredDataProfileHttpPort(profile: DataProfile | undefined): number {
  return profile === "debug" ? 13773 : 3773;
}

export function resolveDataProfileRoot(
  configuredRoot: string,
  profile: DataProfile,
  path: { readonly join: (...parts: string[]) => string },
): string {
  return profile === "debug" ? path.join(configuredRoot, ".debug") : configuredRoot;
}

/** The legacy home is always effective: an older child ignoring new fields
 * must still stay inside Debug. A new child accepts either a complete, bound
 * pair or the wholly legacy contract—never a half-pair that could select the
 * configured production parent instead. This function performs no IO. */
export function resolveBootstrappedDataProfile(
  input: {
    readonly cafeCodeHome: string;
    readonly configuredCafeCodeHome?: string | undefined;
    readonly dataProfile?: DataProfile | undefined;
  },
  path: {
    readonly join: (...parts: string[]) => string;
    readonly resolve: (...parts: string[]) => string;
    readonly isAbsolute: (value: string) => boolean;
  },
): {
  readonly baseDir: string;
  readonly configuredBaseDir: string;
  readonly dataProfile?: DataProfile;
} {
  if ((input.dataProfile === undefined) !== (input.configuredCafeCodeHome === undefined)) {
    throw new Error("Data profile bootstrap is incomplete or inconsistent. No profile was opened.");
  }
  if (input.dataProfile === undefined) {
    return { baseDir: input.cafeCodeHome, configuredBaseDir: input.cafeCodeHome };
  }
  const configuredBaseDir = input.configuredCafeCodeHome!;
  if (
    !path.isAbsolute(configuredBaseDir) ||
    !path.isAbsolute(input.cafeCodeHome) ||
    path.resolve(resolveDataProfileRoot(configuredBaseDir, input.dataProfile, path)) !==
      path.resolve(input.cafeCodeHome)
  ) {
    throw new Error("Data profile bootstrap is incomplete or inconsistent. No profile was opened.");
  }
  return { baseDir: input.cafeCodeHome, configuredBaseDir, dataProfile: input.dataProfile };
}
