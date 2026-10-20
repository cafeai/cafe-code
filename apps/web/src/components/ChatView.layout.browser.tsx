// This file owns only its feature journeys; the shared module owns fixture lifecycle.
import {
  registerChatViewBrowserHooks,
  chatViewFixture,
  THREAD_ID,
  PROJECT_ID,
  NOW_ISO,
  rpcHarness,
  wsRequests,
  DEFAULT_VIEWPORT,
  WIDE_FOOTER_VIEWPORT,
  COMPACT_FOOTER_VIEWPORT,
  createSnapshotForTargetUser,
  waitForElement,
  waitForComposerEditor,
  waitForComposerText,
  waitForComposerMenuItem,
  findComposerProviderModelPicker,
  waitForButtonByText,
  waitForButtonContainingText,
  expectComposerActionsContained,
  waitForServerConfigToApply,
  releaseModShortcut,
  mountChatView,
  createSnapshotWithLongProposedPlan,
  createSnapshotWithPendingUserInput,
  createSnapshotWithPlanFollowUpPrompt,
} from "./ChatViewBrowser.shared";
import {
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
} from "@cafecode/contracts";
import { createModelCapabilities, createModelSelection } from "@cafecode/shared/model";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { isMacPlatform } from "../lib/utils";

describe("ChatView full app (layout)", () => {
  registerChatViewBrowserHooks();

  it("keeps long proposed plans lightweight until the user expands them", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithLongProposedPlan(),
    });

    try {
      await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );

      expect(document.body.textContent).not.toContain("deep hidden detail only after expand");

      const expandButton = await waitForElement(
        () =>
          Array.from(document.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Expand plan",
          ) as HTMLButtonElement | null,
        "Unable to find Expand plan button.",
      );
      expandButton.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain("deep hidden detail only after expand");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the active worktree path when saving a proposed plan to the workspace", async () => {
    const snapshot = createSnapshotWithLongProposedPlan();
    const threads = snapshot.threads.slice();
    const targetThreadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
    const targetThread = targetThreadIndex >= 0 ? threads[targetThreadIndex] : undefined;
    if (targetThread) {
      threads[targetThreadIndex] = {
        ...targetThread,
        worktreePath: "/repo/worktrees/plan-thread",
      };
    }

    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        threads,
      },
    });

    try {
      const planActionsButton = await waitForElement(
        () => document.querySelector<HTMLButtonElement>('button[aria-label="Plan actions"]'),
        "Unable to find proposed plan actions button.",
      );
      planActionsButton.click();

      const saveToWorkspaceItem = await waitForElement(
        () =>
          (Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find(
            (item) => item.textContent?.trim() === "Save to workspace",
          ) ?? null) as HTMLElement | null,
        'Unable to find "Save to workspace" menu item.',
      );
      saveToWorkspaceItem.click();

      await vi.waitFor(
        () => {
          expect(document.body.textContent).toContain(
            "Enter a path relative to /repo/worktrees/plan-thread.",
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps pending-question footer actions inside the composer after a real resize", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
    });

    try {
      const firstOption = await waitForButtonContainingText("Tight");
      firstOption.click();

      await waitForButtonByText("Previous");
      await waitForButtonByText("Submit answers");

      await mounted.setContainerSize(COMPACT_FOOTER_VIEWPORT);
      await expectComposerActionsContained();
    } finally {
      await mounted.cleanup();
    }
  });

  it("submits pending user input after the final option selection resolves the draft answers", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotWithPendingUserInput(),
      resolveRpc: (body) => {
        if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
          return {
            sequence: chatViewFixture.fixture.snapshot.snapshotSequence + 1,
          };
        }
        return undefined;
      },
    });

    try {
      const firstOption = await waitForButtonContainingText("Tight");
      firstOption.click();

      const finalOption = await waitForButtonContainingText("Conservative");
      finalOption.click();

      await vi.waitFor(
        () => {
          const dispatchRequest = wsRequests.find(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.user-input.respond",
          ) as
            | {
                _tag: string;
                type?: string;
                requestId?: string;
                answers?: Record<string, unknown>;
              }
            | undefined;

          expect(dispatchRequest).toMatchObject({
            _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
            type: "thread.user-input.respond",
            requestId: "req-browser-user-input",
            answers: {
              scope: "Tight",
              risk: "Conservative",
            },
          });
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps plan follow-up footer actions fused and aligned after a real resize", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt(),
    });

    try {
      const footer = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
        "Unable to find composer footer.",
      );
      const initialModelPicker = await waitForElement(
        findComposerProviderModelPicker,
        "Unable to find provider model picker.",
      );
      const initialModelPickerOffset =
        initialModelPicker.getBoundingClientRect().left - footer.getBoundingClientRect().left;
      const initialImplementButton = await waitForButtonByText("Implement");
      const initialImplementWidth = initialImplementButton.getBoundingClientRect().width;

      await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await mounted.setContainerSize({
        width: 440,
        height: WIDE_FOOTER_VIEWPORT.height,
      });
      await expectComposerActionsContained();

      const implementButton = await waitForButtonByText("Implement");
      const implementActionsButton = await waitForElement(
        () =>
          document.querySelector<HTMLButtonElement>('button[aria-label="Implementation actions"]'),
        "Unable to find implementation actions trigger.",
      );

      await vi.waitFor(
        () => {
          const implementRect = implementButton.getBoundingClientRect();
          const implementActionsRect = implementActionsButton.getBoundingClientRect();
          const compactModelPicker = findComposerProviderModelPicker();
          expect(compactModelPicker).toBeTruthy();

          const compactModelPickerOffset =
            compactModelPicker!.getBoundingClientRect().left - footer.getBoundingClientRect().left;

          expect(Math.abs(implementRect.right - implementActionsRect.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(implementRect.top - implementActionsRect.top)).toBeLessThanOrEqual(1);
          expect(Math.abs(implementRect.width - initialImplementWidth)).toBeLessThanOrEqual(1);
          expect(Math.abs(compactModelPickerOffset - initialModelPickerOffset)).toBeLessThanOrEqual(
            1,
          );
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("compacts the footer when a wide desktop follow-up layout starts overflowing", async () => {
    const mounted = await mountChatView({
      viewport: WIDE_FOOTER_VIEWPORT,
      snapshot: createSnapshotWithPlanFollowUpPrompt({
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.3-codex-spark",
        },
        planMarkdown:
          "# Imaginary Long-Range Plan: Cafe Code Adaptive Orchestration and Safe-Delay Execution Initiative",
      }),
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          clientSettings: {
            ...nextFixture.serverConfig.clientSettings,
            autoOpenPlanSidebar: false,
          },
        };
      },
    });

    try {
      await waitForButtonByText("Implement");

      await mounted.setContainerSize({
        width: 804,
        height: WIDE_FOOTER_VIEWPORT.height,
      });

      await expectComposerActionsContained();

      await vi.waitFor(
        () => {
          const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
          const actions = document.querySelector<HTMLElement>(
            '[data-chat-composer-actions="right"]',
          );

          expect(footer?.dataset.chatComposerFooterCompact).toBe("true");
          expect(actions?.dataset.chatComposerPrimaryActionsCompact).toBe("true");
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses the live Claude query catalog in the real composer and removes renamed commands", async () => {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const runtimeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const initial = createSnapshotForTargetUser({
      targetMessageId: "msg-claude-catalog" as MessageId,
      targetText: "catalog chat",
    });
    const snapshot = {
      ...initial,
      threads: initial.threads.map((thread) => ({
        ...thread,
        modelSelection: createModelSelection(instanceId, "claude-sonnet-5"),
        session: {
          threadId: thread.id,
          providerName: "claudeAgent",
          providerInstanceId: instanceId,
          subagentRuntimeId: runtimeId,
          status: "ready" as const,
          runtimeMode: "full-access" as const,
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      })),
    };
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot,
      configureFixture: (next) => {
        next.serverConfig = {
          ...next.serverConfig,
          providers: [
            {
              ...next.serverConfig.providers[0]!,
              driver: ProviderDriverKind.make("claudeAgent"),
              instanceId,
              slashCommands: [{ name: "wrong-global-project" }],
            },
          ],
        };
      },
    });
    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/");
      await vi.waitFor(() =>
        expect(
          wsRequests.filter(
            (request) => request._tag === WS_METHODS.serverSubscribeProviderCommands,
          ),
        ).toEqual([
          {
            _tag: WS_METHODS.serverSubscribeProviderCommands,
            threadId: THREAD_ID,
            instanceId,
            runtimeId,
          },
        ]),
      );
      rpcHarness.emitStreamValue(WS_METHODS.serverSubscribeProviderCommands, {
        status: "available",
        commands: [{ name: "plugin:Before" }],
      });
      await waitForComposerMenuItem("provider-slash-command:claudeAgent:plugin:Before");
      expect(
        document.querySelector(
          '[data-composer-item-id="provider-slash-command:claudeAgent:wrong-global-project"]',
        ),
      ).toBeNull();
      rpcHarness.emitStreamValue(WS_METHODS.serverSubscribeProviderCommands, {
        status: "available",
        commands: [{ name: "plugin:After" }],
      });
      const updated = await waitForComposerMenuItem(
        "provider-slash-command:claudeAgent:plugin:After",
      );
      expect(
        document.querySelector(
          '[data-composer-item-id="provider-slash-command:claudeAgent:plugin:Before"]',
        ),
      ).toBeNull();
      await updated.click();
      await waitForComposerText("/plugin:After ");
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the slash-command menu visible above the composer", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-command-menu-target" as MessageId,
        targetText: "command menu thread",
      }),
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/");

      const menuItem = await waitForComposerMenuItem("slash:model");
      const composerForm = await waitForElement(
        () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
        "Unable to find composer form.",
      );

      await vi.waitFor(
        () => {
          const menuRect = menuItem.getBoundingClientRect();
          const composerRect = composerForm.getBoundingClientRect();
          const hitTarget = document.elementFromPoint(
            menuRect.left + menuRect.width / 2,
            menuRect.top + menuRect.height / 2,
          );

          expect(menuRect.width).toBeGreaterThan(0);
          expect(menuRect.height).toBeGreaterThan(0);
          expect(menuRect.bottom).toBeLessThanOrEqual(composerRect.bottom);
          expect(hitTarget instanceof Element && menuItem.contains(hitTarget)).toBe(true);
        },
        { timeout: 8_000, interval: 16 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("opens the model picker when selecting /model", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-command-target" as MessageId,
        targetText: "model command thread",
      }),
    });

    try {
      await waitForComposerEditor();
      await page.getByTestId("composer-editor").fill("/mod");

      const menuItem = await waitForComposerMenuItem("slash:model");
      await menuItem.click();

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).not.toBeNull();
        expect(findComposerProviderModelPicker()?.textContent).not.toContain("/model");
      });

      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });

      await vi.waitFor(() => {
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search models..."]',
        );
        expect(searchInput).not.toBeNull();
        expect(document.activeElement).toBe(searchInput);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles the model picker and shows jump keys immediately from the shortcut", async () => {
    const snapshot = createSnapshotForTargetUser({
      targetMessageId: "msg-user-model-picker-shortcut-target" as MessageId,
      targetText: "model picker shortcut thread",
    });
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: {
        ...snapshot,
        projects: snapshot.projects.map((project) =>
          project.id === PROJECT_ID
            ? Object.assign({}, project, {
                defaultModelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5.4",
                },
              })
            : project,
        ),
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID
            ? Object.assign({}, thread, {
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5.4",
                },
              })
            : thread,
        ),
      },
      configureFixture: (nextFixture) => {
        nextFixture.serverConfig = {
          ...nextFixture.serverConfig,
          keybindings: [
            {
              command: "modelPicker.toggle",
              shortcut: {
                key: "m",
                metaKey: false,
                ctrlKey: true,
                shiftKey: true,
                altKey: false,
                modKey: false,
              },
            },
            {
              command: "thread.jump.1",
              shortcut: {
                key: "1",
                metaKey: false,
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
            },
            {
              command: "modelPicker.jump.1",
              shortcut: {
                key: "1",
                metaKey: false,
                ctrlKey: true,
                shiftKey: false,
                altKey: false,
                modKey: false,
              },
              whenAst: { type: "identifier", name: "modelPickerOpen" },
            },
          ],
          providers: [
            {
              ...nextFixture.serverConfig.providers[0]!,
              models: [
                {
                  slug: "gpt-5.1-codex-max",
                  name: "GPT-5.1 Codex Max",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
                    ],
                  }),
                },
                {
                  slug: "gpt-5.3-codex",
                  name: "GPT-5.3 Codex",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
                    ],
                  }),
                },
                {
                  slug: "gpt-5.4",
                  name: "GPT-5.4",
                  isCustom: false,
                  capabilities: createModelCapabilities({
                    optionDescriptors: [
                      { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
                    ],
                  }),
                },
              ],
            },
          ],
        };
      },
    });

    try {
      await waitForServerConfigToApply();
      await waitForComposerEditor();

      const initialPath = mounted.router.state.location.pathname;
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "m",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).not.toBeNull();
      });

      const jumpLabel = isMacPlatform(navigator.platform) ? "⌃1" : "Ctrl+1";
      await vi.waitFor(() => {
        expect(
          Array.from(
            document.querySelectorAll<HTMLElement>('.model-picker-list [data-slot="kbd"]'),
          ).some((element) => element.textContent?.trim() === jumpLabel),
        ).toBe(true);
      });
      expect(mounted.router.state.location.pathname).toBe(initialPath);

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "m",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).toBeNull();
      });
    } finally {
      releaseModShortcut("Control");
      await mounted.cleanup();
    }
  });

  it("shows a tooltip with the skill description when hovering a skill pill", async () => {
    const mounted = await mountChatView({
      viewport: DEFAULT_VIEWPORT,
      snapshot: createSnapshotForTargetUser({
        targetMessageId: "msg-user-skill-tooltip-target" as MessageId,
        targetText: "skill tooltip thread",
      }),
      resolveRpc: (request) => {
        if (request._tag !== WS_METHODS.serverListProviderSkills) return undefined;
        // Discovery is owned by the current chat/account, not a deprecated
        // provider-global catalogue or a renderer-selected filesystem path.
        expect(request).toEqual({
          _tag: WS_METHODS.serverListProviderSkills,
          instanceId: ProviderInstanceId.make("codex"),
          context: { kind: "thread", threadId: THREAD_ID },
        });
        return {
          status: "available",
          skills: [
            {
              name: "agent-browser",
              displayName: "Agent Browser",
              enabled: true,
              shortDescription: "Open pages, click around, and inspect web apps.",
              scope: "user",
            },
          ],
        };
      },
    });

    try {
      await waitForComposerEditor();
      expect(
        wsRequests.filter((request) => request._tag === WS_METHODS.serverListProviderSkills),
      ).toHaveLength(0);
      await page.getByTestId("composer-editor").fill("use the $agent");
      const skillOption = await waitForComposerMenuItem("skill:codex:agent-browser");
      await skillOption.click();
      await waitForComposerText("use the $agent-browser ");
      expect(
        document.querySelector('[data-composer-item-id="skill:codex:agent-browser"]'),
      ).toBeNull();

      await waitForElement(
        () => document.querySelector<HTMLElement>('[data-composer-skill-chip="true"]'),
        "Unable to find rendered composer skill chip.",
      );
      await page.getByText("Agent Browser").hover();

      await vi.waitFor(
        () => {
          const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
          expect(tooltip).not.toBeNull();
          expect(tooltip?.textContent).toContain("Open pages, click around, and inspect web apps.");
        },
        { timeout: 8_000, interval: 16 },
      );
      expect(
        wsRequests.filter((request) => request._tag === WS_METHODS.serverListProviderSkills),
      ).toHaveLength(1);
    } finally {
      await mounted.cleanup();
    }
  });
});
