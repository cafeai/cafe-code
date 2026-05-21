import type { ProjectScript } from "@cafecode/contracts";
import { writeCafeCodeEnv } from "./compatEnv.ts";

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {};
  writeCafeCodeEnv(env, "CAFE_CODE_PROJECT_ROOT", input.project.cwd);
  if (input.worktreePath) {
    writeCafeCodeEnv(env, "CAFE_CODE_WORKTREE_PATH", input.worktreePath);
  }
  if (input.extraEnv) {
    for (const [key, value] of Object.entries(input.extraEnv)) {
      env[key] = value;
    }
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}
