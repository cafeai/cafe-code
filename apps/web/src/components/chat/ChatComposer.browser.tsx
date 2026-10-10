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
import { useUiStateStore } from "../../uiStateStore";
import { applyInterfaceScalePercent } from "../../interfaceScale";
import { ChatPaneContext } from "../../chatPaneContext";
import type { Thread } from "../../types";
import { ChatComposer, type ChatComposerHandle, type ChatComposerProps } from "./ChatComposer";

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
  afterEach(() => {
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

  it.each([
    { width: 1100, scale: 100, dark: false },
    { width: 1100, scale: 100, dark: true },
    { width: 1100, scale: 80, dark: false },
    { width: 1100, scale: 130, dark: true },
    { width: 390, scale: 80, dark: true },
    { width: 390, scale: 130, dark: false },
  ])(
    "folds the shared tab into a shallow lip at width $width and $scale% scale",
    async ({ width, scale, dark }) => {
      applyInterfaceScalePercent(scale);
      document.documentElement.classList.toggle("dark", dark);
      await using fixture = await mountComposer(width);
      const sharedTab = document.querySelector<HTMLElement>(".cafe-composer-tab")!;
      const provider = "codex";
      await waitForTabEntrance();
      const capture = (state: string) =>
        page.screenshot({
          element: document.querySelector('[data-chat-composer-form="true"]')!,
          path: `../../../../../.explorations/composer-tab-visual/${provider}-${width}-${scale}-${dark ? "dark" : "light"}-${state}.png`,
        });
      await capture("expanded");
      const content = document.querySelector(".cafe-composer-tab-content")!.getBoundingClientRect();
      const items = document.querySelector(".cafe-composer-tab-items")!.getBoundingClientRect();
      expect(items.left).toBeGreaterThanOrEqual(content.left - 1);
      expect(items.right).toBeLessThanOrEqual(content.right + 1);
      expect(document.querySelector(".cafe-composer-tab")).toBe(sharedTab);
      const caret = page
        .getByRole("button", { name: "Minimize composer tools", exact: true })
        .element();
      const initial = caret.getBoundingClientRect();
      const caretIcon = caret.querySelector("svg")!;
      const initialIconY = caretIcon.getBoundingClientRect().y;
      const frame = document.querySelector('[data-chat-composer-tab="true"]')!.parentElement!;
      const initialFrameTop = frame.getBoundingClientRect().top;
      const expandedWidth = document
        .querySelector(".cafe-composer-tab")!
        .getBoundingClientRect().width;
      // The visible caret lowers into the lip, while the same larger hit
      // target stays fixed throughout the animation and repeated toggles.
      for (let count = 0; count < 4; count++) {
        // Arm the native transition before the real pointer click. The
        // collapsed attribute changes in the same React commit as the CSS
        // width. Observe that commit and force the style update before the
        // browser can advance frames: transitionrun is queued separately,
        // so its delivery does not prove that the animation is still in
        // getAnimations(). A timed frame loop can also miss the entire
        // 200ms transition on a busy worker.
        let stopListening: (() => void) | undefined;
        let transitionWaitTimeout: number | undefined;
        let pausedAnimations: Animation[] = [];
        const transitionReady = new Promise<CSSTransition>((resolve, reject) => {
          const previousCollapsed = sharedTab.getAttribute("data-collapsed");
          const observer = new MutationObserver(() => {
            if (sharedTab.getAttribute("data-collapsed") === previousCollapsed) return;
            observer.disconnect();
            try {
              const transition = sharedTab
                .getAnimations()
                .find(
                  (animation): animation is CSSTransition =>
                    animation instanceof CSSTransition && animation.transitionProperty === "width",
                );
              if (!transition) {
                throw new Error("Composer tab changed collapse state without a width transition");
              }
              // The shallow lip also animates its decoration height and
              // caret. Sample them on the same clock as the width.
              pausedAnimations = sharedTab.getAnimations({ subtree: true });
              pausedAnimations.forEach((animation) => animation.pause());
              resolve(transition);
            } catch (error) {
              reject(error);
            }
          });
          observer.observe(sharedTab, { attributes: true, attributeFilter: ["data-collapsed"] });
          stopListening = () => observer.disconnect();
        });
        const widths = new Set<number>();
        try {
          await page.elementLocator(caret).click();
          const transition = await Promise.race([
            transitionReady,
            new Promise<never>((_, reject) => {
              transitionWaitTimeout = window.setTimeout(
                () => reject(new Error("Composer tab width transition did not start within 5s")),
                5_000,
              );
            }),
          ]);
          expect(transition.effect?.getComputedTiming().duration).toBe(200);
          for (const time of [0, 40, 80, 120, 160, 200]) {
            pausedAnimations.forEach((animation) => {
              animation.currentTime = time;
            });
            const current = caret.getBoundingClientRect();
            expect(current.x).toBeCloseTo(initial.x, 1);
            expect(current.y).toBeCloseTo(initial.y, 1);
            expect(current.width).toBeCloseTo(initial.width, 1);
            expect(current.height).toBeCloseTo(initial.height, 1);
            expect(frame.getBoundingClientRect().top).toBeCloseTo(initialFrameTop, 1);
            widths.add(Math.round(sharedTab.getBoundingClientRect().width));
          }
          pausedAnimations.forEach((animation) => animation.finish());
        } finally {
          if (transitionWaitTimeout !== undefined) window.clearTimeout(transitionWaitTimeout);
          stopListening?.();
          for (const animation of pausedAnimations) {
            if (animation.playState !== "finished" && animation.playState !== "idle") {
              animation.finish();
            }
          }
        }
        // An endpoint-only assertion missed the max-content regression: the
        // tab reached both sizes but jumped between them without animating.
        expect(widths.size).toBeGreaterThan(2);
        expect(caret.getAttribute("aria-expanded")).toBe(count % 2 === 0 ? "false" : "true");
        const tab = document.querySelector(".cafe-composer-tab")!.getBoundingClientRect();
        expect(tab.left).toBeGreaterThanOrEqual(0);
        expect(tab.right).toBeLessThanOrEqual(window.innerWidth);
        const shape = document.querySelector(".cafe-composer-tab-shape")!.getBoundingClientRect();
        const icon = caretIcon.getBoundingClientRect();
        if (count % 2 === 0) {
          expect(tab.width).toBeLessThan(expandedWidth);
          expect(shape.height).toBeLessThan(tab.height / 2);
          const exposedHeight = initialFrameTop - shape.top;
          expect(exposedHeight).toBeGreaterThan(0);
          expect(exposedHeight).toBeLessThan(tab.height / 3);
          expect(icon.y).toBeGreaterThan(initialIconY);
          expect(icon.y + icon.height / 2).toBeGreaterThan(shape.top);
          expect(icon.y + icon.height / 2).toBeLessThan(initialFrameTop);
        } else {
          expect(shape.height).toBeCloseTo(tab.height, 1);
          expect(icon.y).toBeCloseTo(initialIconY, 1);
        }
        if (count === 0) await capture("minimized");
      }
      await fixture.update({
        followUpQueueItems: [
          {
            id: "attached-queue-message",
            preview: "Keep the next changes together",
            promptText: "Keep the next changes together",
            images: [],
            queuedAt: createdAt,
            expanded: false,
            canExpand: false,
            blockedReason: null,
          },
        ],
        steeringFollowUpItems: [
          {
            id: "attached-steering-message",
            preview: "Just checking in, what's the current progress?",
            promptText: "Just checking in, what's the current progress?",
            dispatchedAt: createdAt,
          },
        ],
      });
      const queue = document.querySelector('[data-cafe-followup-queue="true"]')!;
      const typingArea = document.querySelector("[data-chat-composer-mobile-collapsed]")!;
      const expectAttachedQueue = async () => {
        await vi.waitFor(() => {
          const queueRect = queue.getBoundingClientRect();
          const typingRect = typingArea.getBoundingClientRect();
          expect(queueRect.bottom).toBeCloseTo(typingRect.top, 1);
          expect(queueRect.left).toBeCloseTo(typingRect.left, 1);
          expect(queueRect.right).toBeCloseTo(typingRect.right, 1);
          // The curved tab's decorative base sits behind the shared frame;
          // its buttons must stay clear of the queue's heading and actions.
          const headingTop = queue.firstElementChild!.getBoundingClientRect().top;
          for (const button of document.querySelectorAll(".cafe-composer-tab button")) {
            expect(button.getBoundingClientRect().bottom).toBeLessThanOrEqual(headingTop);
          }
        });
      };
      await expectAttachedQueue();
      await capture("queue-expanded");
      await page.getByRole("button", { name: "Minimize composer tools", exact: true }).click();
      await waitForTabEntrance();
      await expectAttachedQueue();
      await capture("queue-minimized");
      await page.getByRole("button", { name: "Expand composer tools", exact: true }).click();
      await waitForTabEntrance();
      await fixture.update({ followUpQueueItems: [], steeringFollowUpItems: [] });
      expect(fixture.onSend).not.toHaveBeenCalled();
      expect(fixture.onStartCodeReview).not.toHaveBeenCalled();
    },
  );

  it("preserves the original rise-in animation and rounded outline during collapse", async () => {
    document.documentElement.classList.add("dark");
    await using fixture = await mountComposer(1100);
    const entry = document.querySelector(".cafe-composer-tab-entry")!;
    const entrance = entry
      .getAnimations()
      .find(
        (animation) =>
          animation instanceof CSSAnimation &&
          animation.animationName === "cafe-composer-tab-enter",
      )!;
    entrance.pause();
    entrance.currentTime = 100;
    const style = getComputedStyle(entry);
    expect(Number(style.opacity)).toBeLessThan(1);
    expect(new DOMMatrixReadOnly(style.transform).m42).toBeGreaterThan(0);
    const capture = (state: string) =>
      page.screenshot({
        element: document.querySelector('[data-chat-composer-form="true"]')!,
        path: `../../../../../.explorations/composer-tab-visual/animation-${state}.png`,
      });
    await capture("entrance");
    entrance.finish();

    const tab = document.querySelector(".cafe-composer-tab")!;
    const caret = page
      .getByRole("button", { name: "Minimize composer tools", exact: true })
      .element() as HTMLButtonElement;
    const anchor = caret.getBoundingClientRect();
    const expandedWidth = tab.getBoundingClientRect().width;
    caret.click();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const transitions = tab.getAnimations({ subtree: true });
    expect(
      transitions.some(
        (animation) =>
          animation instanceof CSSTransition && animation.transitionProperty === "width",
      ),
    ).toBe(true);
    for (const animation of transitions) {
      animation.pause();
      animation.currentTime = 100;
    }
    const intermediateWidth = tab.getBoundingClientRect().width;
    expect(intermediateWidth).toBeLessThan(expandedWidth);
    expect(caret.getBoundingClientRect().x).toBeCloseTo(anchor.x, 1);
    expect(caret.getBoundingClientRect().y).toBeCloseTo(anchor.y, 1);
    await capture("collapse-midpoint");
    transitions.forEach((animation) => animation.finish());
    expect(tab.getBoundingClientRect().width).toBeLessThan(intermediateWidth);
    expect(document.querySelector(".cafe-composer-tab-content")?.hasAttribute("inert")).toBe(true);
    expect(fixture.onSend).not.toHaveBeenCalled();
  });

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
