import { scopeProjectRef } from "@cafecode/client-runtime";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveLogicalProjectKey,
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  resolveProjectGroupingMode,
} from "./logicalProject";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarThreadsForProjectRef,
  selectSidebarThreadsForProjectRefs,
  type AppState,
  type EnvironmentState,
} from "./store";
import type { Project, SidebarThreadSummary } from "./types";
import { DEFAULT_INTERACTION_MODE } from "./types";

const primaryEnvId = EnvironmentId.make("env-primary");
const repoRootProjectId = ProjectId.make("repo-root-proj");
const repoNestedProjectId = ProjectId.make("repo-nested-proj");
const standaloneProjectId = ProjectId.make("standalone-proj");

const threadRoot1 = ThreadId.make("thread-root-1");
const threadRoot2 = ThreadId.make("thread-root-2");
const threadNested1 = ThreadId.make("thread-nested-1");
const threadStandalone1 = ThreadId.make("thread-standalone-1");

const REPO_CANONICAL_KEY = "github.com/example/shared-repo";
const DEFAULT_GROUPING_SETTINGS = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

function makeProject(
  overrides: Partial<Project> & Pick<Project, "id" | "environmentId" | "name">,
): Project {
  return {
    cwd: `/tmp/${overrides.name}`,
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

function makeSidebarThreadSummary(
  overrides: Partial<SidebarThreadSummary> &
    Pick<SidebarThreadSummary, "id" | "environmentId" | "projectId" | "title">,
): SidebarThreadSummary {
  return {
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeEmptyEnvironmentState(): EnvironmentState {
  return {
    projectIds: [],
    projectById: {},
    threadIds: [],
    threadIdsByProjectId: {},
    threadShellById: {},
    threadSessionById: {},
    threadTurnStateById: {},
    messageIdsByThreadId: {},
    messageByThreadId: {},
    activityIdsByThreadId: {},
    activityByThreadId: {},
    proposedPlanIdsByThreadId: {},
    proposedPlanByThreadId: {},
    turnDiffIdsByThreadId: {},
    turnDiffSummaryByThreadId: {},
    sidebarThreadSummaryById: {},
    bootstrapComplete: true,
  };
}

function makeRepoRootProject(): Project {
  return makeProject({
    id: repoRootProjectId,
    environmentId: primaryEnvId,
    name: "shared-repo",
    cwd: "/workspace/repo",
    repositoryIdentity: {
      canonicalKey: REPO_CANONICAL_KEY,
      rootPath: "/workspace/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/shared-repo.git",
      },
    },
  });
}

function makeRepoNestedProject(): Project {
  return makeProject({
    id: repoNestedProjectId,
    environmentId: primaryEnvId,
    name: "web",
    cwd: "/workspace/repo/apps/web",
    repositoryIdentity: {
      canonicalKey: REPO_CANONICAL_KEY,
      rootPath: "/workspace/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/example/shared-repo.git",
      },
    },
  });
}

function makeFixtureState(): AppState {
  const repoRootProject = makeRepoRootProject();
  const repoNestedProject = makeRepoNestedProject();
  const standaloneProject = makeProject({
    id: standaloneProjectId,
    environmentId: primaryEnvId,
    name: "standalone",
  });

  const environmentState: EnvironmentState = {
    ...makeEmptyEnvironmentState(),
    projectIds: [repoRootProjectId, repoNestedProjectId, standaloneProjectId],
    projectById: {
      [repoRootProjectId]: repoRootProject,
      [repoNestedProjectId]: repoNestedProject,
      [standaloneProjectId]: standaloneProject,
    },
    threadIds: [threadRoot1, threadRoot2, threadNested1, threadStandalone1],
    threadIdsByProjectId: {
      [repoRootProjectId]: [threadRoot1, threadRoot2],
      [repoNestedProjectId]: [threadNested1],
      [standaloneProjectId]: [threadStandalone1],
    },
    sidebarThreadSummaryById: {
      [threadRoot1]: makeSidebarThreadSummary({
        id: threadRoot1,
        environmentId: primaryEnvId,
        projectId: repoRootProjectId,
        title: "Repo root thread 1",
      }),
      [threadRoot2]: makeSidebarThreadSummary({
        id: threadRoot2,
        environmentId: primaryEnvId,
        projectId: repoRootProjectId,
        title: "Repo root thread 2",
      }),
      [threadNested1]: makeSidebarThreadSummary({
        id: threadNested1,
        environmentId: primaryEnvId,
        projectId: repoNestedProjectId,
        title: "Nested project thread 1",
      }),
      [threadStandalone1]: makeSidebarThreadSummary({
        id: threadStandalone1,
        environmentId: primaryEnvId,
        projectId: standaloneProjectId,
        title: "Standalone thread 1",
      }),
    },
  };

  return {
    activeEnvironmentId: primaryEnvId,
    environmentStateById: {
      [primaryEnvId]: environmentState,
    },
  };
}

describe("environment grouping", () => {
  describe("deriveLogicalProjectKey", () => {
    it("uses repositoryIdentity.canonicalKey when present", () => {
      expect(deriveLogicalProjectKey(makeRepoRootProject())).toBe(REPO_CANONICAL_KEY);
    });

    it("falls back to scoped project key when no repositoryIdentity exists", () => {
      const project = makeProject({
        id: standaloneProjectId,
        environmentId: primaryEnvId,
        name: "standalone",
      });

      expect(deriveLogicalProjectKey(project)).toBe(derivePhysicalProjectKey(project));
    });

    it("groups repo root and nested projects from the same repository by default", () => {
      expect(deriveLogicalProjectKey(makeRepoRootProject())).toBe(REPO_CANONICAL_KEY);
      expect(deriveLogicalProjectKey(makeRepoNestedProject())).toBe(REPO_CANONICAL_KEY);
    });

    it("uses repository path grouping when requested", () => {
      expect(
        deriveLogicalProjectKey(makeRepoRootProject(), {
          groupingMode: "repository_path",
        }),
      ).toBe(REPO_CANONICAL_KEY);
      expect(
        deriveLogicalProjectKey(makeRepoNestedProject(), {
          groupingMode: "repository_path",
        }),
      ).toBe(`${REPO_CANONICAL_KEY}::apps/web`);
    });

    it("uses per-project overrides from settings", () => {
      const project = makeRepoRootProject();

      expect(resolveProjectGroupingMode(project, DEFAULT_GROUPING_SETTINGS)).toBe("repository");
      expect(
        deriveLogicalProjectKeyFromSettings(project, {
          ...DEFAULT_GROUPING_SETTINGS,
          sidebarProjectGroupingOverrides: {
            [derivePhysicalProjectKey(project)]: "separate",
          },
        }),
      ).toBe(derivePhysicalProjectKey(project));
    });
  });

  describe("store selectors", () => {
    it("returns primary projects", () => {
      const projects = selectProjectsAcrossEnvironments(makeFixtureState());

      expect(projects).toHaveLength(3);
      expect(projects.map((project) => project.name).toSorted()).toEqual([
        "shared-repo",
        "standalone",
        "web",
      ]);
    });

    it("returns primary sidebar thread summaries", () => {
      const threads = selectSidebarThreadsAcrossEnvironments(makeFixtureState());

      expect(threads.map((thread) => thread.id)).toEqual([
        threadRoot1,
        threadRoot2,
        threadNested1,
        threadStandalone1,
      ]);
    });

    it("returns threads for a single project ref", () => {
      const ref = scopeProjectRef(primaryEnvId, repoRootProjectId);
      const threads = selectSidebarThreadsForProjectRef(makeFixtureState(), ref);

      expect(threads.map((thread) => thread.id)).toEqual([threadRoot1, threadRoot2]);
    });

    it("returns empty array for null or nonexistent refs", () => {
      const state = makeFixtureState();

      expect(selectSidebarThreadsForProjectRef(state, null)).toEqual([]);
      expect(
        selectSidebarThreadsForProjectRef(
          state,
          scopeProjectRef(primaryEnvId, ProjectId.make("missing-project")),
        ),
      ).toEqual([]);
    });

    it("returns combined threads from grouped primary project refs", () => {
      const refs = [
        scopeProjectRef(primaryEnvId, repoRootProjectId),
        scopeProjectRef(primaryEnvId, repoNestedProjectId),
      ];
      const threads = selectSidebarThreadsForProjectRefs(makeFixtureState(), refs);

      expect(threads.map((thread) => thread.id)).toEqual([threadRoot1, threadRoot2, threadNested1]);
    });
  });

  describe("logical project grouping for sidebar", () => {
    it("aggregates threads for grouped primary projects", () => {
      const state = makeFixtureState();
      const allProjects = selectProjectsAcrossEnvironments(state);
      const groups = new Map<string, Project[]>();

      for (const project of allProjects) {
        const key = deriveLogicalProjectKey(project);
        groups.set(key, [...(groups.get(key) ?? []), project]);
      }

      const repoGroup = groups.get(REPO_CANONICAL_KEY);
      expect(repoGroup).toBeDefined();
      expect(repoGroup).toHaveLength(2);

      const memberRefs = repoGroup!.map((project) =>
        scopeProjectRef(project.environmentId, project.id),
      );
      const threads = selectSidebarThreadsForProjectRefs(state, memberRefs);
      expect(threads.map((thread) => thread.id)).toEqual([threadRoot1, threadRoot2, threadNested1]);
    });

    it("keeps standalone projects ungrouped", () => {
      const allProjects = selectProjectsAcrossEnvironments(makeFixtureState());
      const groups = new Map<string, Project[]>();

      for (const project of allProjects) {
        const key = deriveLogicalProjectKey(project);
        groups.set(key, [...(groups.get(key) ?? []), project]);
      }

      expect(groups.size).toBe(2);
      const standaloneKey = deriveLogicalProjectKey(
        allProjects.find((project) => project.id === standaloneProjectId)!,
      );
      expect(groups.get(standaloneKey)).toHaveLength(1);
    });
  });
});
