import "../../index.css";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@cafecode/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@cafecode/contracts/settings";
import { createModelCapabilities, createModelSelection } from "@cafecode/shared/model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { useComposerDraftStore } from "../../composerDraftStore";
import type { Thread } from "../../types";
import { ChatComposer, type ChatComposerHandle, type ChatComposerProps } from "./ChatComposer";

// Only the unrelated external environment integrations are replaced. Provider
// selection, draft resolution, menu placement, dialog ownership and outgoing
// composer snapshots all execute their production code without a live server.
vi.mock("../virtualDesktop/VirtualDesktops", () => ({ DesktopPicker: () => null }));
vi.mock("../../hooks/useSettings", () => {
  return {
    useSettings: (select?: (value: typeof DEFAULT_UNIFIED_SETTINGS) => unknown) =>
      select ? select(DEFAULT_UNIFIED_SETTINGS) : DEFAULT_UNIFIED_SETTINGS,
    useUpdateSettings: () => vi.fn().mockResolvedValue(undefined),
    getClientSettings: () => DEFAULT_UNIFIED_SETTINGS,
  };
});
vi.mock("../../environments/runtime", () => {
  const connection = {
    client: {
      server: {
        refreshProviders: vi.fn().mockResolvedValue(undefined),
        getClientSettings: vi.fn().mockResolvedValue(null),
        updateClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      dictation: { getStatus: vi.fn().mockResolvedValue({ configured: false }) },
    },
  };
  return {
    requireEnvironmentConnection: () => connection,
    readEnvironmentConnection: () => null,
    getPrimaryEnvironmentConnection: () => null,
    getEnvironmentHttpBaseUrl: () => null,
    resolveEnvironmentHttpUrl: () => null,
    subscribeEnvironmentConnections: () => () => {},
    useSavedEnvironmentRuntimeStore: (
      select: (state: { byId: Record<string, never> }) => unknown,
    ) => select({ byId: {} }),
  };
});

const environmentId = EnvironmentId.make("composer-test-environment");
const createdAt = "2026-10-07T00:00:00.000Z";

function provider(
  driver: "codex" | "claudeAgent" | "grok",
  id: string,
  label: string,
): ServerProvider {
  return {
    driver: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(id),
    displayName: label,
    enabled: true,
    installed: true,
    version: "fixture-version",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: createdAt,
    slashCommands: [],
    skills: [],
    ...(driver === "claudeAgent"
      ? {
          runtimeCapabilities: {
            liveSteer: "supported",
            threadGoals: "unsupported",
            deliveryPriority: true,
          },
        }
      : {}),
    models: [
      {
        slug:
          driver === "codex"
            ? "gpt-5-codex"
            : driver === "claudeAgent"
              ? "claude-opus-4-6"
              : "grok-code-fast-1",
        name: `${label} model`,
        isCustom: false,
        capabilities: createModelCapabilities({ optionDescriptors: [] }),
      },
    ],
  };
}

const providers = [
  provider("codex", "codex", "Codex personal"),
  provider("codex", "codex-work", "Codex work"),
  provider("claudeAgent", "claudeAgent", "Claude personal"),
  provider("claudeAgent", "claude-work", "Claude work"),
  provider("grok", "grok", "Grok"),
];

function thread(id = "composer-test-chat"): Thread {
  return {
    id: ThreadId.make(id),
    environmentId,
    codexThreadId: "synthetic-codex-session",
    projectId: null,
    title: "Composer controls fixture",
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5-codex"),
    runtimeMode: "full-access",
    interactionMode: "default",
    session: {
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "ready",
      orchestrationStatus: "ready",
      createdAt,
      updatedAt: createdAt,
      subagentRuntimeId: "fixture-runtime",
    },
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt,
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
  };
}

async function mountComposer(width: number, overrides: Partial<ChatComposerProps> = {}) {
  const previousViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(Math.max(width + 24, 414), 900);
  const activeThread = thread();
  const threadRef = { environmentId, threadId: activeThread.id };
  const composerRef = createRef<ChatComposerHandle>();
  const onStartCodeReview = vi
    .fn<NonNullable<ChatComposerProps["onStartCodeReview"]>>()
    .mockResolvedValue();
  const onSend = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  host.style.width = `${width}px`;
  document.body.append(host);
  const props: ChatComposerProps = {
    onStartCodeReview,
    composerDraftTarget: threadRef,
    environmentId,
    routeKind: "server",
    routeThreadRef: threadRef,
    draftId: null,
    activeThreadId: activeThread.id,
    activeThreadEnvironmentId: environmentId,
    activeThread,
    isServerThread: true,
    isLocalDraftThread: false,
    phase: "ready",
    isConnecting: false,
    isSendBusy: false,
    isPreparingWorktree: false,
    environmentUnavailable: null,
    activePendingApproval: null,
    pendingApprovals: [],
    pendingUserInputs: [],
    activePendingProgress: null,
    activePendingResolvedAnswers: null,
    activePendingIsResponding: false,
    activePendingAutoResolutionSnoozed: false,
    activePendingDraftAnswers: {},
    activePendingQuestionIndex: 0,
    respondingRequestIds: [],
    showPlanFollowUpPrompt: false,
    activeProposedPlan: null,
    activePlan: null,
    sidebarProposedPlan: null,
    planSidebarLabel: "Plan",
    planSidebarOpen: false,
    goalControlsSupported: false,
    runtimeMode: "approval-required",
    interactionMode: "default",
    lockedProvider: null,
    providerStatuses: providers,
    activeProjectDefaultModelSelection: null,
    activeThreadModelSelection: activeThread.modelSelection,
    activeThreadActivities: [],
    resolvedTheme: "dark",
    settings: DEFAULT_UNIFIED_SETTINGS,
    keybindings: [],
    gitCwd: null,
    followUpQueueItems: [],
    steeringFollowUpItems: [],
    followUpQueueActionLabel: "Queue",
    followUpQueueActionTitle: "Queue message",
    promptRef: { current: "Unsent prompt must remain here" },
    composerImagesRef: { current: [] },
    composerRef,
    shouldAutoScrollRef: { current: false },
    scheduleStickToBottom: vi.fn(),
    onSend,
    onSteer: vi.fn(),
    onToggleFollowUpQueueItem: vi.fn(),
    onActivateFollowUpQueueItem: vi.fn(),
    onRemoveFollowUpQueueItem: vi.fn(),
    onClearFollowUpQueue: vi.fn(),
    onInterrupt: vi.fn(),
    onImplementPlanInNewThread: vi.fn(),
    onRespondToApproval: vi.fn().mockResolvedValue(undefined),
    onSelectActivePendingUserInputOption: vi.fn(),
    onAdvanceActivePendingUserInput: vi.fn(),
    onPreviousActivePendingUserInputQuestion: vi.fn(),
    onChangeActivePendingUserInputCustomAnswer: vi.fn(),
    onSnoozeActivePendingUserInput: vi.fn(),
    onProviderModelSelect: (instanceId, model) => {
      useComposerDraftStore
        .getState()
        .setModelSelection(props.composerDraftTarget, createModelSelection(instanceId, model));
    },
    toggleInteractionMode: vi.fn(),
    handleRuntimeModeChange: vi.fn(),
    handleInteractionModeChange: vi.fn(),
    togglePlanSidebar: vi.fn(),
    onOpenGoalDialog: vi.fn(),
    focusComposer: vi.fn(),
    scheduleComposerFocus: vi.fn(),
    setThreadError: vi.fn(),
    onExpandImage: vi.fn(),
    ...overrides,
  };
  useComposerDraftStore.getState().setPrompt(threadRef, props.promptRef.current);
  const content = () => (
    <QueryClientProvider client={queryClient}>
      <ChatComposer {...props} />
    </QueryClientProvider>
  );
  const view = await render(content(), { container: host });
  return {
    props,
    composerRef,
    onStartCodeReview,
    onSend,
    async update(next: Partial<ChatComposerProps>) {
      Object.assign(props, next);
      await view.rerender(content());
    },
    async select(id: string) {
      const selected = providers.find((entry) => entry.instanceId === id)!;
      const trigger = host.querySelector<HTMLElement>('[data-chat-provider-model-picker="true"]')!;
      await page.elementLocator(trigger).click();
      await page.getByRole("button", { name: selected.displayName!, exact: true }).click();
      await page.getByText(selected.models[0]!.name, { exact: true }).click();
      await vi.waitFor(() =>
        expect(composerRef.current?.getSendContext().selectedModelSelection.instanceId).toBe(id),
      );
      await expect.element(page.elementLocator(trigger)).toHaveAttribute("aria-expanded", "false");
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    },
    async [Symbol.asyncDispose]() {
      await view.unmount();
      queryClient.clear();
      host.remove();
      await page.viewport(previousViewport.width, previousViewport.height);
    },
  };
}

async function closeComposerControlsWithKeyboard() {
  const menu = page.getByRole("menu");
  await expect.element(menu).toBeVisible();
  // Base UI queues initial popup focus on the next animation frame. A
  // negative provider-content assertion can pass before that handoff, so it
  // cannot establish that Escape will reach the menu. Observe the real focus
  // transition without forcing focus or bypassing the modal backdrop.
  await vi.waitFor(() => expect(menu.element().contains(document.activeElement)).toBe(true));
  await userEvent.keyboard("{Escape}");
  await expect.element(menu).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: "More composer controls", exact: true }))
    .toHaveFocus();
}

describe("provider-specific composer menu actions", () => {
  afterEach(() => {
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it.each([
    { width: 1100, compact: "false" },
    { width: 390, compact: "true" },
  ])(
    "keeps provider actions inside the existing controls menu at width $width",
    async ({ width, compact }) => {
      await using fixture = await mountComposer(width);
      await vi.waitFor(() =>
        expect(
          document
            .querySelector("[data-chat-composer-footer]")
            ?.getAttribute("data-chat-composer-footer-compact"),
        ).toBe(compact),
      );
      await expect
        .element(page.getByRole("menuitem", { name: "Codex review", exact: true }))
        .not.toBeInTheDocument();
      expect(document.querySelector(".cafe-code-review-tab")).toBeNull();
      await expect
        .element(page.getByText("Message delivery", { exact: true }))
        .not.toBeInTheDocument();
      await page.screenshot({
        path: `../../../../../.explorations/composer-menu-ui/codex-closed-${width}.png`,
      });
      await page.getByRole("button", { name: "More composer controls", exact: true }).click();
      const review = page.getByRole("menuitem", { name: "Codex review", exact: true });
      await expect.element(review).toBeVisible();
      await review.click();
      await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
      await expect
        .element(page.getByRole("dialog", { name: "Start a Codex review" }))
        .toBeVisible();
      // The native reviewer runs the saved session, including its full-access
      // policy, even when the unsent composer policy has changed to supervised.
      await expect.element(page.getByText(/This chat currently has full access/)).toBeVisible();
      await page.getByRole("button", { name: "Start review", exact: true }).click();
      expect(fixture.onStartCodeReview).toHaveBeenCalledExactlyOnceWith({
        type: "uncommittedChanges",
      });
      expect(fixture.onSend).not.toHaveBeenCalled();
      expect(fixture.composerRef.current?.getSendContext().prompt).toBe(
        "Unsent prompt must remain here",
      );

      await fixture.select("claudeAgent");
      await expect
        .element(page.getByText("Message delivery", { exact: true }))
        .not.toBeInTheDocument();
      await page.screenshot({
        path: `../../../../../.explorations/composer-menu-ui/claude-closed-${width}.png`,
      });
      await page.getByRole("button", { name: "More composer controls", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Codex review", exact: true }))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("Message delivery", { exact: true })).toBeVisible();
      await page.screenshot({
        path: `../../../../../.explorations/composer-menu-ui/claude-menu-${width}.png`,
      });
      await page.getByRole("menuitemradio", { name: /^Next / }).click();
      await closeComposerControlsWithKeyboard();
      await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
      expect(fixture.composerRef.current?.getSendContext()).toMatchObject({
        selectedProvider: "claudeAgent",
        selectedModelSelection: { instanceId: "claudeAgent" },
        deliveryPriority: "next",
      });
      expect(fixture.onSend).not.toHaveBeenCalled();
    },
  );

  it("follows unsent picker provider and exact Codex account instead of the saved session alone", async () => {
    await using fixture = await mountComposer(1100);
    for (const id of ["claudeAgent", "codex-work", "grok"]) {
      await fixture.select(id);
      await page.getByRole("button", { name: "More composer controls", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Codex review", exact: true }))
        .not.toBeInTheDocument();
      await closeComposerControlsWithKeyboard();
    }
    await fixture.select("codex");
    const trigger = page.getByRole("button", { name: "More composer controls", exact: true });
    // Keyboard activation must open the same menu without submitting the draft.
    trigger.element().focus();
    await userEvent.keyboard("{Enter}");
    const review = page.getByRole("menuitem", { name: "Codex review", exact: true });
    await expect.element(review).toBeVisible();
    review.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("dialog", { name: "Start a Codex review" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(fixture.onStartCodeReview).not.toHaveBeenCalled();
    expect(fixture.onSend).not.toHaveBeenCalled();
  });

  it.each(["claudeAgent", "codex-work"])(
    "invalidates an open dialog when another pane selects %s",
    async (id) => {
      await using fixture = await mountComposer(1100);
      await page.getByRole("button", { name: "More composer controls", exact: true }).click();
      await page.getByRole("menuitem", { name: "Codex review", exact: true }).click();
      await page.getByRole("combobox", { name: "Review target" }).selectOptions("custom");
      await page
        .getByRole("textbox", { name: "Review instructions" })
        .fill("Review private account changes");
      const selected = providers.find((entry) => entry.instanceId === id)!;
      // A second pane may change the shared real draft while this modal is open.
      useComposerDraftStore
        .getState()
        .setModelSelection(
          fixture.props.composerDraftTarget,
          createModelSelection(selected.instanceId, selected.models[0]!.slug),
        );
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(fixture.onStartCodeReview).not.toHaveBeenCalled();
      await fixture.select("codex");
      await page.getByRole("button", { name: "More composer controls", exact: true }).click();
      await page.getByRole("menuitem", { name: "Codex review", exact: true }).click();
      await expect
        .element(page.getByRole("combobox", { name: "Review target" }))
        .toHaveValue("uncommittedChanges");
      await expect
        .element(page.getByText("Review private account changes"))
        .not.toBeInTheDocument();
    },
  );

  it("binds message priority to the selected Claude account, capability and chat", async () => {
    await using fixture = await mountComposer(1100);
    await fixture.select("claudeAgent");
    await page.getByRole("button", { name: "More composer controls", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /^Later / }).click();
    await closeComposerControlsWithKeyboard();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    expect(fixture.composerRef.current?.getSendContext().deliveryPriority).toBe("later");
    for (const id of ["claude-work", "codex", "grok"]) {
      await fixture.select(id);
      expect(fixture.composerRef.current?.getSendContext()).not.toHaveProperty("deliveryPriority");
      if (id !== "claude-work") {
        await page.getByRole("button", { name: "More composer controls", exact: true }).click();
        await expect
          .element(page.getByText("Message delivery", { exact: true }))
          .not.toBeInTheDocument();
        await closeComposerControlsWithKeyboard();
      }
    }
    await fixture.select("claudeAgent");
    await fixture.update({
      providerStatuses: providers.map((entry) =>
        entry.instanceId === "claudeAgent"
          ? {
              ...entry,
              runtimeCapabilities: {
                liveSteer: "supported",
                threadGoals: "unsupported",
                deliveryPriority: false,
              },
            }
          : entry,
      ),
    });
    expect(fixture.composerRef.current?.getSendContext()).not.toHaveProperty("deliveryPriority");
    await page.getByRole("button", { name: "More composer controls", exact: true }).click();
    await expect
      .element(page.getByText("Message delivery", { exact: true }))
      .not.toBeInTheDocument();
    await closeComposerControlsWithKeyboard();
    await fixture.update({ providerStatuses: providers });
    await page.getByRole("button", { name: "More composer controls", exact: true }).click();
    await page.getByRole("menuitemradio", { name: /^Now / }).click();
    await closeComposerControlsWithKeyboard();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    expect(fixture.composerRef.current?.getSendContext().deliveryPriority).toBe("now");
    const nextThread = thread("other-chat");
    const nextRef = { environmentId, threadId: nextThread.id };
    useComposerDraftStore
      .getState()
      .setModelSelection(
        nextRef,
        createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6"),
      );
    await fixture.update({
      activeThread: nextThread,
      activeThreadId: nextThread.id,
      routeThreadRef: nextRef,
      composerDraftTarget: nextRef,
    });
    expect(fixture.composerRef.current?.getSendContext()).not.toHaveProperty("deliveryPriority");
    expect(fixture.onSend).not.toHaveBeenCalled();
  });
});
