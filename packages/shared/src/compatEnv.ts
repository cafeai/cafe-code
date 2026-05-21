import * as Config from "effect/Config";
import * as Option from "effect/Option";

export const CAFE_CODE_ENV_PREFIX = "CAFE_CODE_";

export type EnvRecord = Readonly<Record<string, string | undefined>>;

export function cafeCodeEnvName(name: string): string {
  if (!name.startsWith(CAFE_CODE_ENV_PREFIX)) {
    throw new Error(`Expected Cafe Code env var to start with ${CAFE_CODE_ENV_PREFIX}.`);
  }
  return name;
}

export function readCafeCodeEnv(env: EnvRecord, name: string): string | undefined {
  return env[cafeCodeEnvName(name)];
}

export function writeCafeCodeEnv(
  env: Record<string, string | undefined>,
  name: string,
  value: string | undefined,
): void {
  const cafeName = cafeCodeEnvName(name);
  if (value === undefined) {
    delete env[cafeName];
    return;
  }
  env[cafeName] = value;
}

export function deleteCafeCodeEnv(env: Record<string, string | undefined>, name: string): void {
  writeCafeCodeEnv(env, name, undefined);
}

export function cafeCodeOptionalConfig<A>(
  name: string,
  makeConfig: (name: string) => Config.Config<A>,
): Config.Config<Option.Option<A>> {
  return makeConfig(cafeCodeEnvName(name)).pipe(Config.option);
}

export function cafeCodeOptionalValueConfig<A>(
  name: string,
  makeConfig: (name: string) => Config.Config<A>,
): Config.Config<A | undefined> {
  return cafeCodeOptionalConfig(name, makeConfig).pipe(Config.map(Option.getOrUndefined));
}

export function cafeCodeConfigWithDefault<A>(
  name: string,
  makeConfig: (name: string) => Config.Config<A>,
  defaultValue: A,
): Config.Config<A> {
  return cafeCodeOptionalConfig(name, makeConfig).pipe(
    Config.map(Option.getOrElse(() => defaultValue)),
  );
}
