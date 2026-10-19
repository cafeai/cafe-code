import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type EnvironmentApi,
  type GlideControlResult,
  type ProviderSessionQuotaInput,
  type ProviderSessionQuotaResult,
  type ServerProvider,
} from "@cafecode/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@cafecode/contracts/settings";
import { getUiLocale, setUiLocale } from "@cafecode/shared/i18n";
import { createModelCapabilities, createModelSelection } from "@cafecode/shared/model";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { ChatPaneContext } from "../../chatPaneContext";
import { useComposerDraftStore } from "../../composerDraftStore";
import "../../index.css";
import { applyInterfaceScalePercent } from "../../interfaceScale";
import type { Thread } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { ChatComposer, type ChatComposerHandle, type ChatComposerProps } from "./ChatComposer";
import { ScrollToBottomControl } from "./ScrollToBottomControl";
import {
  __setEnvironmentApiOverrideForTests,
  __resetEnvironmentApiOverridesForTests,
} from "../../environmentApi";

const { quotaConnection, subscribeQuota } = vi.hoisted(() => ({
  quotaConnection: { connected: false },
  subscribeQuota:
    vi.fn<
      (
        input: ProviderSessionQuotaInput,
        listener: (result: ProviderSessionQuotaResult) => void,
      ) => () => void
    >(),
}));

// Only the unrelated external environment integrations are replaced. Provider
// selection, draft resolution, menu placement, dialog ownership and outgoing
// composer snapshots all execute their production code without a live server.
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
        subscribeProviderQuota: subscribeQuota,
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
      select: (state: { byId: Record<string, { connectionState: string }> }) => unknown,
    ) =>
      select({
        byId: quotaConnection.connected
          ? { "composer-test-environment": { connectionState: "connected" } }
          : {},
      }),
  };
});

const environmentId = EnvironmentId.make("composer-test-environment");
const createdAt = "2026-10-07T00:00:00.000Z";

function provider(
  driver: "codex" | "claudeAgent" | "grok" | "axiom",
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
  let pane = { active: true, visible: true };
  const content = () => (
    <QueryClientProvider client={queryClient}>
      <ChatPaneContext value={pane}>
        <div hidden={!pane.visible}>
          <ChatComposer {...props} />
        </div>
      </ChatPaneContext>
    </QueryClientProvider>
  );
  const view = await render(content(), { container: host });
  return {
    props,
    host,
    composerRef,
    onStartCodeReview,
    onSend,
    async setPane(next: typeof pane) {
      pane = next;
      await view.rerender(content());
    },
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

async function waitForTabEntrance() {
  const tab = document.querySelector(".cafe-composer-tab-entry")!;
  await Promise.all(tab.getAnimations({ subtree: true }).map((animation) => animation.finished));
}

describe("provider-specific composer menu actions", () => {
  it.each(["draft", "server"] as const)(
    "opens Claude account limits from the %s composer before sending a prompt",
    async (routeKind) => {
      quotaConnection.connected = true;
      subscribeQuota.mockReturnValue(vi.fn());
      const modelSelection = createModelSelection(
        ProviderInstanceId.make("claude-work"),
        "claude-opus-4-6",
      );
      const showOnSide = vi.fn();
      await using fixture = await mountComposer(860, {
        routeKind,
        isServerThread: routeKind === "server",
        isLocalDraftThread: routeKind === "draft",
        activeThread: { ...thread(), session: null, modelSelection },
        activeThreadModelSelection: modelSelection,
        activeThreadActivities: [],
        onShowSessionRail: showOnSide,
      });
      expect(subscribeQuota).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Usage", exact: true }).click();
      await expect.poll(() => subscribeQuota.mock.calls.length).toBe(1);
      expect(subscribeQuota).toHaveBeenCalledWith(
        { instanceId: modelSelection.instanceId },
        expect.any(Function),
        expect.any(Object),
      );
      subscribeQuota.mock.calls[0]![1]({
        report: {
          source: "claude-cli",
          observedAt: new Date().toISOString(),
          meters: [
            {
              kind: "session",
              group: "session",
              usedPercent: 25,
              resetsAt: null,
              severity: "normal",
              isActive: true,
            },
          ],
        },
      });
      await expect.element(page.getByText("75% left", { exact: true })).toBeVisible();
      expect(fixture.composerRef.current?.getSendContext().prompt).toBe(
        "Unsent prompt must remain here",
      );
      expect(fixture.onSend).not.toHaveBeenCalled();
      expect(subscribeQuota).toHaveBeenCalledOnce();
      await page.getByRole("button", { name: "Show on the side", exact: true }).click();
      expect(showOnSide).toHaveBeenCalledOnce();
    },
  );

  it("enables computer use before the first message, retains the exact draft choice, and starts another draft off", async () => {
    const control = vi.fn(async (_input: unknown) => ({
      available: true,
      connected: false,
      enabled: false,
      fullAccess: false,
      busy: false,
      paused: false,
      accessibility: true,
      screenRecording: true,
      apps: [],
      runningApps: [],
      message: "Background desktop control",
    }));
    __setEnvironmentApiOverrideForTests(environmentId, {
      glide: { control },
    } as unknown as EnvironmentApi);
    try {
      const draftRef = { environmentId, threadId: ThreadId.make("computer-use-local-draft") };
      await using fixture = await mountComposer(860, {
        runtimeMode: "full-access",
        isServerThread: false,
        isLocalDraftThread: true,
        composerDraftTarget: draftRef,
        activeThreadId: draftRef.threadId,
      });
      const button = page.getByRole("button", { name: "Computer use", exact: true });
      await expect.element(button).toBeEnabled();
      await button.click();
      await expect.element(button).toHaveAttribute("aria-pressed", "true");
      expect(fixture.composerRef.current?.getSendContext().computerUseEnabled).toBe(true);
      expect(control.mock.calls.map(([input]) => input)).toEqual([{ action: "status" }]);
      expect(fixture.onSend).not.toHaveBeenCalled();
      await fixture.update({ isSendBusy: true });
      await expect.element(button).toBeDisabled();
      await fixture.update({ isSendBusy: false });
      await expect.element(button).toBeEnabled();
      await button.click();
      await expect.element(button).toHaveAttribute("aria-pressed", "false");
      await button.click();
      await expect.element(button).toHaveAttribute("aria-pressed", "true");
      const nextRef = { environmentId, threadId: ThreadId.make("other-local-computer-draft") };
      await fixture.update({ composerDraftTarget: nextRef, activeThreadId: nextRef.threadId });
      await expect.element(button).toHaveAttribute("aria-pressed", "false");
      expect(fixture.composerRef.current?.getSendContext().computerUseEnabled).toBe(false);
      expect(useComposerDraftStore.getState().getComposerDraft(draftRef)?.computerUseEnabled).toBe(
        true,
      );
    } finally {
      __resetEnvironmentApiOverridesForTests();
    }
  });
  it("switches computer use from its own composer button after thinking without submitting the draft", async () => {
    const state: GlideControlResult = {
      available: true,
      connected: true,
      enabled: false,
      fullAccess: true,
      busy: false,
      paused: false,
      accessibility: true,
      screenRecording: true,
      apps: [],
      runningApps: [],
      message: "Background desktop control",
    };
    const control = vi.fn(async (input: { action: string; enabled?: boolean }) => ({
      ...state,
      enabled: input.action === "set-enabled" && input.enabled === true,
    }));
    __setEnvironmentApiOverrideForTests(environmentId, {
      glide: { control },
    } as unknown as EnvironmentApi);
    try {
      const codex = {
        ...providers[0]!,
        models: providers[0]!.models.map((model) => ({
          ...model,
          slug: "gpt-5.4",
          name: "GPT-5.4",
          capabilities: createModelCapabilities({
            optionDescriptors: [
              {
                id: "effort",
                label: "Thinking",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "high", label: "High", isDefault: true },
                ],
              },
            ],
          }),
        })),
      };
      await using fixture = await mountComposer(860, {
        runtimeMode: "full-access",
        providerStatuses: [codex, ...providers.slice(1)],
      });
      const computer = page.getByRole("button", { name: "Computer use", exact: true });
      await expect.element(computer).toBeEnabled();
      const thinking = fixture.host.querySelector('[aria-label="More composer controls"]')!;
      await expect.element(page.elementLocator(thinking)).toHaveTextContent("High");
      expect(thinking.nextElementSibling?.getAttribute("data-computer-use")).toBe("true");
      const prompt = fixture.props.promptRef.current;
      await computer.click();
      await expect.element(computer).toHaveAttribute("aria-pressed", "true");
      expect(control.mock.calls.at(-1)?.[0]).toEqual({
        action: "set-enabled",
        threadId: fixture.props.activeThreadId,
        enabled: true,
      });
      const composer = page.elementLocator(
        fixture.host.querySelector('[data-chat-composer-form="true"]')!,
      );
      await composer.screenshot({ path: "../../../../../.logs/computer-use-composer.png" });
      await computer.click();
      await expect.element(computer).toHaveAttribute("aria-pressed", "false");
      await composer.screenshot({ path: "../../../../../.logs/computer-use-composer-off.png" });
      expect(fixture.onSend).not.toHaveBeenCalled();
      expect(fixture.props.promptRef.current).toBe(prompt);
      await page.getByRole("button", { name: "More composer controls", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Glide", exact: true }))
        .not.toBeInTheDocument();
      await closeComposerControlsWithKeyboard();
    } finally {
      __resetEnvironmentApiOverridesForTests();
    }
  });
  it("keeps scroll controls from submitting or changing the composer draft", async () => {
    const onScrollToBottom = vi.fn();
    const onHideUntilBottom = vi.fn();
    await using fixture = await mountComposer(860, {
      scrollToBottomControl: (
        <ScrollToBottomControl
          onScrollToBottom={onScrollToBottom}
          onHideUntilBottom={onHideUntilBottom}
        />
      ),
    });
    const prompt = fixture.props.promptRef.current;
    await page.getByRole("button", { name: "Scroll to bottom", exact: true }).click();
    expect(onScrollToBottom).toHaveBeenCalledOnce();
    expect(fixture.onSend).not.toHaveBeenCalled();
    expect(fixture.props.promptRef.current).toBe(prompt);
    await page.getByRole("button", { name: "Scroll to bottom options", exact: true }).click();
    await page.getByRole("button", { name: "Hide until bottom", exact: true }).click();
    expect(onHideUntilBottom).toHaveBeenCalledOnce();
    expect(fixture.onSend).not.toHaveBeenCalled();
    expect(fixture.props.promptRef.current).toBe(prompt);
  });

  it.each([
    { width: 860, scale: 100, dark: true },
    { width: 860, scale: 100, dark: false },
    { width: 390, scale: 130, dark: false },
    { width: 390, scale: 80, dark: true },
  ])(
    "places Axiom web search inside the composer after thinking at $width and $scale% scale",
    async ({ width, scale, dark }) => {
      applyInterfaceScalePercent(scale);
      document.documentElement.classList.toggle("dark", dark);
      const axiom: ServerProvider = {
        ...provider("axiom", "axiom-personal", "Axiom personal"),
        models: [
          {
            slug: "native-model",
            name: "DeepSeek V4.1 Flash",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                {
                  id: "thinkingLevel",
                  label: "Thinking",
                  type: "select",
                  options: [
                    { id: "medium", label: "Medium", isDefault: true },
                    { id: "high", label: "High" },
                  ],
                },
              ],
            }),
          },
        ],
      };
      const activeThread = thread();
      activeThread.modelSelection = createModelSelection(axiom.instanceId, "native-model");
      activeThread.session = {
        ...activeThread.session!,
        provider: ProviderDriverKind.make("axiom"),
        providerInstanceId: axiom.instanceId,
      };
      await using fixture = await mountComposer(width, {
        providerStatuses: [...providers, axiom],
        activeThread,
        activeThreadModelSelection: activeThread.modelSelection,
      });
      const web = page.getByRole("button", { name: "Web search", exact: true });
      await expect.element(web).toHaveAttribute("aria-pressed", "false");
      expect(fixture.composerRef.current?.getSendContext().axiomWebEnabled).toBe(false);
      await web.click();
      await expect.element(web).toHaveAttribute("aria-pressed", "true");
      expect(fixture.composerRef.current?.getSendContext().axiomWebEnabled).toBe(true);
      const thinking = fixture.host.querySelector<HTMLButtonElement>(
        '[aria-label="More composer controls"]',
      )!;
      expect(thinking.textContent).toContain("Medium");
      const modelPicker = fixture.host.querySelector('[data-chat-provider-model-picker="true"]')!;
      expect(modelPicker.textContent).toContain("DeepSeek V4.1 Flash");
      expect(modelPicker.textContent).not.toContain("Tinfoil");
      expect(
        fixture.host
          .querySelector('[data-provider-model-trigger-title="true"]')
          ?.classList.contains("grid"),
      ).toBe(false);
      await expect
        .element(page.getByRole("button", { name: "MCP tools", exact: true }))
        .not.toBeInTheDocument();
      const button = fixture.host.querySelector<HTMLButtonElement>(
        '[data-axiom-web-search="true"]',
      )!;
      const footer = fixture.host.querySelector('[data-chat-composer-footer="true"]')!;
      expect(footer.contains(button)).toBe(true);
      expect(fixture.host.querySelector(".cafe-composer-tab")?.contains(button)).toBe(false);
      useComposerDraftStore.getState().clearComposerContent(fixture.props.composerDraftTarget);
      await expect.element(web).toHaveAttribute("aria-pressed", "true");
      expect(fixture.composerRef.current?.getSendContext().axiomWebEnabled).toBe(true);
      useComposerDraftStore.getState().setPrompt(fixture.props.composerDraftTarget, "Next message");
      useComposerDraftStore.getState().clearComposerContent(fixture.props.composerDraftTarget);
      await expect.element(web).toHaveAttribute("aria-pressed", "true");
      expect(fixture.composerRef.current?.getSendContext().axiomWebEnabled).toBe(true);
      await web.click();
      useComposerDraftStore.getState().clearComposerContent(fixture.props.composerDraftTarget);
      await expect.element(web).toHaveAttribute("aria-pressed", "false");
      expect(fixture.composerRef.current?.getSendContext().axiomWebEnabled).toBe(false);
      expect(fixture.onSend).not.toHaveBeenCalled();
    },
  );
  it("uses the existing composer tab for Axiom and clears its inspector when the selected model changes", async () => {
    const axiom: ServerProvider = {
      ...provider("axiom", "axiom-personal", "Axiom personal"),
      models: [
        {
          slug: "axiom-model",
          name: "Axiom model",
          isCustom: false,
          capabilities: createModelCapabilities({ optionDescriptors: [] }),
        },
        {
          slug: "axiom-other",
          name: "Axiom other model",
          isCustom: false,
          capabilities: createModelCapabilities({ optionDescriptors: [] }),
        },
      ],
    };
    const activeThread = thread();
    activeThread.modelSelection = createModelSelection(axiom.instanceId, "axiom-model");
    activeThread.session = {
      ...activeThread.session!,
      provider: ProviderDriverKind.make("axiom"),
      providerInstanceId: axiom.instanceId,
    };
    await using fixture = await mountComposer(860, {
      providerStatuses: [...providers, axiom],
      activeThread,
      activeThreadModelSelection: activeThread.modelSelection,
    });
    await waitForTabEntrance();
    const tab = document.querySelector<HTMLElement>(".cafe-composer-tab")!;
    await expect.element(page.elementLocator(tab)).toHaveAttribute("data-popup-open", "false");
    await page.getByRole("button", { name: "Verification unavailable", exact: true }).click();
    await expect.element(page.getByRole("dialog", { name: "Axiom verification" })).toBeVisible();
    await expect.element(page.elementLocator(tab)).toHaveAttribute("data-popup-open", "true");
    useComposerDraftStore
      .getState()
      .setModelSelection(
        fixture.props.composerDraftTarget,
        createModelSelection(axiom.instanceId, "axiom-other"),
      );
    await expect
      .element(page.getByRole("dialog", { name: "Axiom verification" }))
      .not.toBeInTheDocument();
    await expect.element(page.elementLocator(tab)).toHaveAttribute("data-popup-open", "false");
    expect(fixture.onSend).not.toHaveBeenCalled();
  });
  afterEach(() => {
    quotaConnection.connected = false;
    subscribeQuota.mockReset();
    useUiStateStore.setState({ composerTabCollapsed: false });
    applyInterfaceScalePercent(100);
    document.documentElement.classList.remove("dark");
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it.each(["connecting", "disconnected", "error"] as const)(
    "repaints the complete %s environment placeholder without changing the draft or actions",
    async (connectionState) => {
      const originalLocale = getUiLocale();
      const label = "Synthetic <iframe> server";
      setUiLocale("en");
      try {
        await using fixture = await mountComposer(1100, {
          environmentUnavailable: { label, connectionState },
        });
        const editor = document.querySelector<HTMLElement>("[aria-placeholder]")!;
        await expect
          .element(page.elementLocator(editor))
          .toHaveAttribute(
            "aria-placeholder",
            `${label} is ${connectionState === "connecting" ? "connecting" : "disconnected"}`,
          );
        setUiLocale("ko");
        await expect
          .element(page.elementLocator(editor))
          .toHaveAttribute(
            "aria-placeholder",
            connectionState === "connecting" ? `${label}에 연결 중` : `${label} 연결이 끊어짐`,
          );
        expect(fixture.props.promptRef.current).toBe("Unsent prompt must remain here");
        expect(fixture.composerRef.current?.getSendContext().prompt).toBe(
          "Unsent prompt must remain here",
        );
        expect(fixture.onSend).not.toHaveBeenCalled();
        expect(fixture.props.onSteer).not.toHaveBeenCalled();
        expect(fixture.onStartCodeReview).not.toHaveBeenCalled();
      } finally {
        setUiLocale(originalLocale);
      }
    },
  );

  it("keeps delivery explanations in hover/focus tooltips and changes only the next message choice", async () => {
    await using fixture = await mountComposer(390);
    await fixture.select("claudeAgent");
    const automaticHelp = "Use Cafe’s normal queue and Claude’s default priority.";
    const laterHelp = "Let Claude defer this behind more urgent messages—not a scheduled time.";
    expect(document.querySelector('[data-chat-composer-tab="true"]')).toBeNull();
    await expect.element(page.getByText(automaticHelp, { exact: true })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "More composer controls", exact: true }).click();
    const automatic = page.getByRole("menuitemradio", { name: "Automatic", exact: true });
    await automatic.hover();
    await expect.element(page.getByRole("tooltip")).toHaveTextContent(automaticHelp);
    const later = page.getByRole("menuitemradio", { name: "Later", exact: true });
    await expect.element(later).toBeVisible();
    await expect.element(page.getByText(laterHelp, { exact: true })).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(page.getByRole("menu").element().contains(document.activeElement)).toBe(true),
    );
    automatic.element().focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}");
    await expect.element(later).toHaveFocus();
    await expect.element(page.getByRole("tooltip")).toHaveTextContent(laterHelp);
    await userEvent.keyboard("{Enter}");
    await closeComposerControlsWithKeyboard();
    expect(fixture.composerRef.current?.getSendContext().deliveryPriority).toBe("later");
    expect(fixture.onSend).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "More composer controls", exact: true }).click();
    await expect.element(later).toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitemradio", { name: "Automatic", exact: true }).click();
    await closeComposerControlsWithKeyboard();
    expect(fixture.composerRef.current?.getSendContext()).not.toHaveProperty("deliveryPriority");
  });

  it("preserves minimized state across chats and providers without sending the draft", async () => {
    await using fixture = await mountComposer(1100);
    await page.getByRole("button", { name: "Code review", exact: true }).click();
    await expect.element(page.getByRole("dialog", { name: "Start a Codex review" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Minimize composer tools", exact: true }).click();
    const nextThread = thread("next-tab-chat");
    const nextRef = { environmentId, threadId: nextThread.id };
    await fixture.update({
      activeThread: nextThread,
      activeThreadId: nextThread.id,
      routeThreadRef: nextRef,
      composerDraftTarget: nextRef,
    });
    await expect
      .element(page.getByRole("button", { name: "Expand composer tools", exact: true }))
      .toBeVisible();
    await fixture.select("claudeAgent");
    expect(document.querySelector('[data-chat-composer-tab="true"]')).toBeNull();
    expect(useUiStateStore.getState().composerTabCollapsed).toBe(true);
    await fixture.select("codex");
    const sharedTab = document.querySelector(".cafe-composer-tab");
    const sharedCaret = page
      .getByRole("button", { name: "Expand composer tools", exact: true })
      .element();
    await page.getByRole("button", { name: "Expand composer tools", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Code review", exact: true }))
      .toBeVisible();
    const review = page.getByRole("button", { name: "Code review", exact: true });
    for (const unavailable of [
      { phase: "running" as const },
      { phase: "ready" as const, isServerThread: false },
      { isServerThread: true, isConnecting: true },
      { isConnecting: false, codeReviewDisabled: true },
    ]) {
      await fixture.update(unavailable);
      await expect.element(review).toBeVisible();
      await expect.element(review).toHaveAttribute("aria-disabled", "true");
      expect(document.querySelector(".cafe-composer-tab")).toBe(sharedTab);
      expect(
        page.getByRole("button", { name: "Minimize composer tools", exact: true }).element(),
      ).toBe(sharedCaret);
      // aria-disabled controls remain focusable for their explanation, but
      // mouse and keyboard activation must never open or dispatch a review.
      (review.element() as HTMLButtonElement).click();
      review.element().focus();
      await userEvent.keyboard("{Enter}{Space}");
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    }
    await fixture.update({ codeReviewDisabled: false });
    await expect.element(review).toHaveAttribute("aria-disabled", "false");
    expect(document.querySelector(".cafe-composer-tab")).toBe(sharedTab);
    expect(fixture.onSend).not.toHaveBeenCalled();
    expect(fixture.onStartCodeReview).not.toHaveBeenCalled();
  });

  it.each([
    { width: 1100, compact: "false" },
    { width: 390, compact: "true" },
  ])(
    "keeps Code review in its tab and Claude delivery only in the controls menu at width $width",
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
      await expect
        .element(page.getByRole("button", { name: "Code review", exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByText("Message delivery", { exact: true }))
        .not.toBeInTheDocument();
      await waitForTabEntrance();
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
      await expect
        .element(page.getByText(/· Full access · runs without approval prompts$/))
        .toBeVisible();
      await page.getByRole("button", { name: "Start review", exact: true }).click();
      expect(fixture.onStartCodeReview).toHaveBeenCalledExactlyOnceWith({
        type: "uncommittedChanges",
      });
      expect(fixture.onSend).not.toHaveBeenCalled();
      expect(fixture.composerRef.current?.getSendContext().prompt).toBe(
        "Unsent prompt must remain here",
      );

      await fixture.select("claudeAgent");
      expect(document.querySelector('[data-chat-composer-tab="true"]')).toBeNull();
      await expect
        .element(page.getByText("Message delivery", { exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "More composer controls", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: "Codex review", exact: true }))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("Message delivery", { exact: true })).toBeVisible();
      await page.getByRole("menuitemradio", { name: "Next", exact: true }).click();
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
      if (id === "grok" || id === "claudeAgent") {
        expect(document.querySelector('[data-chat-composer-tab="true"]')).toBeNull();
      } else if (id === "codex-work") {
        const review = page.getByRole("button", { name: "Code review", exact: true });
        await expect.element(review).toBeVisible();
        await expect.element(review).toHaveAttribute("aria-disabled", "true");
        (review.element() as HTMLButtonElement).click();
        await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      }
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
      await page.getByRole("combobox", { name: "Review target" }).click();
      await page.getByRole("option", { name: "Custom instructions", exact: true }).click();
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
        .toHaveTextContent("Uncommitted changes");
      await expect
        .element(page.getByText("Review private account changes"))
        .not.toBeInTheDocument();
    },
  );

  it("binds message priority to the selected Claude account, capability and chat", async () => {
    await using fixture = await mountComposer(1100);
    await fixture.select("claudeAgent");
    await page.getByRole("button", { name: "More composer controls", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Later", exact: true }).click();
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
    expect(document.querySelector('[data-chat-composer-tab="true"]')).toBeNull();
    await fixture.update({ providerStatuses: providers });
    await page.getByRole("button", { name: "More composer controls", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Now", exact: true }).click();
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
