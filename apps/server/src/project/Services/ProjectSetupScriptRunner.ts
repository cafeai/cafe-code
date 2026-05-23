import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export type ProjectSetupScriptRunnerResult = ProjectSetupScriptRunnerResultNoScript;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
}

export class ProjectSetupScriptRunnerError extends Data.TaggedError(
  "ProjectSetupScriptRunnerError",
)<{
  readonly message: string;
}> {}

export interface ProjectSetupScriptRunnerShape {
  readonly runForThread: (
    input: ProjectSetupScriptRunnerInput,
  ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
}

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  ProjectSetupScriptRunnerShape
>()("cafecode/project/ProjectSetupScriptRunner") {}
