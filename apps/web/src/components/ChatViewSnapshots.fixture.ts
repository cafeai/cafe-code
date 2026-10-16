// Feature-specific inert snapshots; the router/RPC/provider harness stays in its owner.
import {
  EventId,
  MessageId,
  type OrchestrationReadModel,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import type { ChatViewSnapshotSources, RuntimeTaskStep } from "./ChatViewBrowser.shared";
export function createChatViewSnapshots({
  createSnapshotForTargetUser,
  THREAD_ID,
  isoAt,
  RUNTIME_TASK_STEPS,
  RUNTIME_TASK_TURN_ID,
  SUBAGENT_RUNTIME_ID,
  SECOND_PROJECT_ID,
  ARCHIVED_SECONDARY_THREAD_ID,
  NOW_ISO,
  PROJECT_ID,
}: ChatViewSnapshotSources) {
  function createSnapshotWithLongProposedPlan(): OrchestrationReadModel {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-plan-target" as MessageId,
      targetText: "plan thread",
    });
    const planMarkdown = [
      "# Ship plan mode follow-up",
      "",
      "- Step 1: capture the thread-open trace",
      "- Step 2: identify the main-thread bottleneck",
      "- Step 3: keep collapsed cards cheap",
      "- Step 4: render the full markdown only on demand",
      "- Step 5: preserve export and save actions",
      "- Step 6: add regression coverage",
      "- Step 7: verify route transitions stay responsive",
      "- Step 8: confirm no server-side work changed",
      "- Step 9: confirm short plans still render normally",
      "- Step 10: confirm long plans stay collapsed by default",
      "- Step 11: confirm preview text is still useful",
      "- Step 12: confirm plan follow-up flow still works",
      "- Step 13: confirm timeline virtualization still behaves",
      "- Step 14: confirm theme styling still looks correct",
      "- Step 15: confirm save dialog behavior is unchanged",
      "- Step 16: confirm download behavior is unchanged",
      "- Step 17: confirm code fences do not parse until expand",
      "- Step 18: confirm preview truncation ends cleanly",
      "- Step 19: confirm markdown links still open in editor after expand",
      "- Step 20: confirm deep hidden detail only appears after expand",
      "",
      "```ts",
      "export const hiddenPlanImplementationDetail = 'deep hidden detail only after expand';",
      "```",
    ].join("\n");

    return {
      ...snapshot,
      threads: snapshot.threads.map((thread) =>
        thread.id === THREAD_ID
          ? Object.assign({}, thread, {
              proposedPlans: [
                {
                  id: "plan-browser-test",
                  turnId: null,
                  planMarkdown,
                  implementedAt: null,
                  implementationThreadId: null,
                  createdAt: isoAt(1_000),
                  updatedAt: isoAt(1_001),
                },
              ],
              updatedAt: isoAt(1_001),
            })
          : thread,
      ),
    };
  }

  function createSnapshotWithRuntimeTaskProgress(options?: {
    readonly steps?: ReadonlyArray<RuntimeTaskStep>;
    readonly terminal?: boolean;
    readonly withAuthoredPlan?: boolean;
    readonly withContextWindow?: boolean;
  }): OrchestrationReadModel {
    const snapshot = options?.withAuthoredPlan
      ? createSnapshotWithPlanFollowUpPrompt()
      : createSnapshotForTargetUser({
          targetMessageId: "msg-user-runtime-task-progress" as MessageId,
          targetText: "implement the runtime task checklist",
        });
    const terminal = options?.terminal ?? false;
    const steps = options?.steps ?? RUNTIME_TASK_STEPS;

    return {
      ...snapshot,
      threads: snapshot.threads.map((thread) =>
        thread.id === THREAD_ID
          ? Object.assign({}, thread, {
              interactionMode: terminal ? thread.interactionMode : ("default" as const),
              latestTurn: {
                turnId: RUNTIME_TASK_TURN_ID,
                state: terminal ? ("completed" as const) : ("running" as const),
                requestedAt: isoAt(1_000),
                startedAt: isoAt(1_001),
                completedAt: terminal ? isoAt(1_020) : null,
                assistantMessageId: null,
                ...(options?.withAuthoredPlan
                  ? {
                      sourceProposedPlan: {
                        threadId: THREAD_ID,
                        planId: "plan-follow-up-browser-test",
                      },
                    }
                  : {}),
              },
              activities: [
                {
                  id: EventId.make("activity-runtime-task-progress"),
                  tone: "info" as const,
                  kind: "turn.plan.updated",
                  summary: "Runtime task plan updated",
                  payload: {
                    explanation:
                      "The provider is working through the complete implementation checklist for the current turn.",
                    plan: [...steps],
                  },
                  turnId: RUNTIME_TASK_TURN_ID,
                  sequence: 1,
                  createdAt: isoAt(1_005),
                },
                ...(options?.withContextWindow
                  ? [
                      {
                        id: EventId.make("activity-runtime-context-window"),
                        tone: "info" as const,
                        kind: "context-window.updated",
                        summary: "Context window updated",
                        payload: {
                          usedTokens: 213_000,
                          maxTokens: 258_000,
                          totalProcessedTokens: 6_600_000,
                          compactsAutomatically: true,
                        },
                        turnId: RUNTIME_TASK_TURN_ID,
                        sequence: 2,
                        createdAt: isoAt(1_006),
                      },
                    ]
                  : []),
              ],
              session: {
                ...thread.session,
                status: terminal ? ("ready" as const) : ("running" as const),
                activeTurnId: terminal ? null : RUNTIME_TASK_TURN_ID,
                updatedAt: terminal ? isoAt(1_020) : isoAt(1_005),
              },
              updatedAt: terminal ? isoAt(1_020) : isoAt(1_005),
            })
          : thread,
      ),
    };
  }

  function createSnapshotWithActiveSubagent(): OrchestrationReadModel {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-active-subagent" as MessageId,
      targetText: "verify subagent and Atrium navigation",
      sessionStatus: "running",
    });
    const turnId = "turn-active-subagent" as TurnId;
    return {
      ...snapshot,
      threads: snapshot.threads.map((thread) =>
        thread.id === THREAD_ID
          ? Object.assign({}, thread, {
              latestTurn: {
                turnId,
                state: "running" as const,
                requestedAt: isoAt(1_000),
                startedAt: isoAt(1_001),
                completedAt: null,
                assistantMessageId: null,
              },
              activities: [
                {
                  id: EventId.make("activity-active-subagent"),
                  tone: "info" as const,
                  kind: "task.started",
                  summary: "Subagent started",
                  payload: {
                    taskId: "provider-child-browser-audit",
                    taskType: "subagent",
                    subagent: {
                      threadId: "provider-child-browser-audit",
                      runtimeId: SUBAGENT_RUNTIME_ID,
                      label: "Browser lifecycle audit",
                      path: "/root/browser_lifecycle_audit",
                      objective: "Verify Atrium navigation",
                      status: "active",
                      startedAt: isoAt(1_001),
                    },
                  },
                  turnId,
                  sequence: 1,
                  createdAt: isoAt(1_001),
                },
              ],
              session: {
                ...thread.session,
                subagentRuntimeId: SUBAGENT_RUNTIME_ID,
                status: "running" as const,
                activeTurnId: turnId,
                updatedAt: isoAt(1_001),
              },
              updatedAt: isoAt(1_001),
            })
          : thread,
      ),
    };
  }

  function createSnapshotWithCrossTurnActiveSubagent(): OrchestrationReadModel {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-cross-turn-active-subagent" as MessageId,
      targetText: "keep the older-turn child visible while newer work runs",
      sessionStatus: "running",
    });
    const spawningTurnId = "turn-cross-turn-subagent-spawn" as TurnId;
    const latestTurnId = "turn-after-cross-turn-subagent-spawn" as TurnId;

    return {
      ...snapshot,
      threads: snapshot.threads.map((thread) =>
        thread.id === THREAD_ID
          ? Object.assign({}, thread, {
              latestTurn: {
                turnId: latestTurnId,
                state: "running" as const,
                requestedAt: isoAt(1_010),
                startedAt: isoAt(1_011),
                completedAt: null,
                assistantMessageId: null,
              },
              activities: [
                {
                  id: EventId.make("activity-cross-turn-active-subagent"),
                  tone: "info" as const,
                  kind: "task.started",
                  summary: "Subagent started",
                  payload: {
                    taskId: "provider-child-cross-turn-roster",
                    taskType: "subagent",
                    subagent: {
                      threadId: "provider-child-cross-turn-roster",
                      runtimeId: SUBAGENT_RUNTIME_ID,
                      label: "Cross-turn roster audit",
                      path: "/root/cross_turn_roster_audit",
                      objective: "Verify the child survives latest-turn filtering",
                      status: "active",
                      startedAt: isoAt(1_001),
                    },
                  },
                  turnId: spawningTurnId,
                  sequence: 1,
                  createdAt: isoAt(1_001),
                },
              ],
              session: {
                ...thread.session,
                subagentRuntimeId: SUBAGENT_RUNTIME_ID,
                status: "running" as const,
                activeTurnId: latestTurnId,
                updatedAt: isoAt(1_011),
              },
              updatedAt: isoAt(1_011),
            })
          : thread,
      ),
    };
  }

  function createSnapshotWithSecondaryProject(options?: {
    includeSecondaryThread?: boolean;
    includeArchivedSecondaryThread?: boolean;
  }): OrchestrationReadModel {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-secondary-project-target" as MessageId,
      targetText: "secondary project",
    });
    const includeSecondaryThread = options?.includeSecondaryThread ?? true;
    const includeArchivedSecondaryThread = options?.includeArchivedSecondaryThread ?? true;
    const secondaryThreads: OrchestrationReadModel["threads"] = includeSecondaryThread
      ? [
          {
            id: "thread-secondary-project" as ThreadId,
            projectId: SECOND_PROJECT_ID,
            title: "Release checklist",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
            interactionMode: "default",
            runtimeMode: "full-access",
            branch: "release/docs-portal",
            worktreePath: null,
            latestTurn: null,
            createdAt: isoAt(30),
            updatedAt: isoAt(31),
            deletedAt: null,
            messages: [],
            activities: [],
            proposedPlans: [],
            checkpoints: [],
            session: {
              threadId: "thread-secondary-project" as ThreadId,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: isoAt(31),
            },
            archivedAt: null,
          },
        ]
      : [];
    const archivedSecondaryThreads: OrchestrationReadModel["threads"] =
      includeArchivedSecondaryThread
        ? [
            {
              id: ARCHIVED_SECONDARY_THREAD_ID,
              projectId: SECOND_PROJECT_ID,
              title: "Archived Docs Notes",
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
              interactionMode: "default",
              runtimeMode: "full-access",
              branch: "release/docs-archive",
              worktreePath: null,
              latestTurn: null,
              createdAt: isoAt(24),
              updatedAt: isoAt(25),
              deletedAt: null,
              messages: [],
              activities: [],
              proposedPlans: [],
              checkpoints: [],
              session: {
                threadId: ARCHIVED_SECONDARY_THREAD_ID,
                status: "ready",
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: isoAt(25),
              },
              archivedAt: isoAt(26),
            },
          ]
        : [];

    return {
      ...snapshot,
      projects: [
        ...snapshot.projects,
        {
          id: SECOND_PROJECT_ID,
          title: "Docs Portal",
          workspaceRoot: "/repo/clients/docs-portal",
          additionalWorkspaceRoots: [],
          defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          scripts: [],
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
          deletedAt: null,
        },
      ],
      threads: [...snapshot.threads, ...secondaryThreads, ...archivedSecondaryThreads],
    };
  }

  function createSnapshotWithPendingUserInput(): OrchestrationReadModel {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-pending-input-target" as MessageId,
      targetText: "question thread",
    });

    return {
      ...snapshot,
      threads: snapshot.threads.map((thread) =>
        thread.id === THREAD_ID
          ? Object.assign({}, thread, {
              interactionMode: "plan",
              activities: [
                {
                  id: EventId.make("activity-user-input-requested"),
                  tone: "info",
                  kind: "user-input.requested",
                  summary: "User input requested",
                  payload: {
                    requestId: "req-browser-user-input",
                    questions: [
                      {
                        id: "scope",
                        header: "Scope",
                        question: "What should this change cover?",
                        options: [
                          {
                            label: "Tight",
                            description: "Touch only the footer layout logic.",
                          },
                          {
                            label: "Broad",
                            description: "Also adjust the related composer controls.",
                          },
                        ],
                      },
                      {
                        id: "risk",
                        header: "Risk",
                        question: "How aggressive should the imaginary plan be?",
                        options: [
                          {
                            label: "Conservative",
                            description: "Favor reliability and low-risk changes.",
                          },
                          {
                            label: "Balanced",
                            description: "Mix quick wins with one structural improvement.",
                          },
                        ],
                      },
                    ],
                  },
                  turnId: null,
                  sequence: 1,
                  createdAt: isoAt(1_000),
                },
              ],
              updatedAt: isoAt(1_000),
            })
          : thread,
      ),
    };
  }

  function createSnapshotWithPlanFollowUpPrompt(options?: {
    modelSelection?: { instanceId: ProviderInstanceId; model: string };
    planMarkdown?: string;
  }): OrchestrationReadModel {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-plan-follow-up-target" as MessageId,
      targetText: "plan follow-up thread",
    });
    const modelSelection = options?.modelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    };
    const planMarkdown =
      options?.planMarkdown ?? "# Follow-up plan\n\n- Keep the composer footer stable on resize.";

    return {
      ...snapshot,
      projects: snapshot.projects.map((project) =>
        project.id === PROJECT_ID ? { ...project, defaultModelSelection: modelSelection } : project,
      ),
      threads: snapshot.threads.map((thread) =>
        thread.id === THREAD_ID
          ? Object.assign({}, thread, {
              modelSelection,
              interactionMode: "plan",
              latestTurn: {
                turnId: "turn-plan-follow-up" as TurnId,
                state: "completed",
                requestedAt: isoAt(1_000),
                startedAt: isoAt(1_001),
                completedAt: isoAt(1_010),
                assistantMessageId: null,
              },
              proposedPlans: [
                {
                  id: "plan-follow-up-browser-test",
                  turnId: "turn-plan-follow-up" as TurnId,
                  planMarkdown,
                  implementedAt: null,
                  implementationThreadId: null,
                  createdAt: isoAt(1_002),
                  updatedAt: isoAt(1_003),
                },
              ],
              session: {
                ...thread.session,
                status: "ready",
                updatedAt: isoAt(1_010),
              },
              updatedAt: isoAt(1_010),
            })
          : thread,
      ),
    };
  }
  return {
    createSnapshotWithLongProposedPlan,
    createSnapshotWithRuntimeTaskProgress,
    createSnapshotWithActiveSubagent,
    createSnapshotWithCrossTurnActiveSubagent,
    createSnapshotWithSecondaryProject,
    createSnapshotWithPendingUserInput,
    createSnapshotWithPlanFollowUpPrompt,
  };
}
