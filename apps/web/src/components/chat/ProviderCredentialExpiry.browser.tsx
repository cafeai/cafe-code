import "../../index.css";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cafecode/contracts";
import { getUiLocale, setUiLocale } from "@cafecode/shared/i18n";
import { afterEach, beforeEach, expect, it, vi, type TestContext } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ProviderInstanceCard } from "../settings/ProviderInstanceCard";
import { DRIVER_OPTION_BY_VALUE } from "../settings/providerDriverMeta";
import { TooltipProvider } from "../ui/tooltip";
import { createChatViewFixtureRetirement } from "../chatViewFixtureRetirement.test.fixture";
import { ProviderStatusBanner } from "./ProviderStatusBanner";

const api = vi.hoisted(() => ({
  unexpected: vi.fn(() => {
    throw new Error("Expiry presentation must not request provider operations");
  }),
}));
vi.mock("../../rpc/serverState", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../rpc/serverState")>();
  return { ...original, useServerConfig: () => null };
});
vi.mock("../../localApi", () => ({ ensureLocalApi: api.unexpected }));
vi.mock("../../environments/workspaceApi", () => ({ ensureWorkspaceApi: api.unexpected }));
vi.mock("../../environments/runtime", () => ({ requireEnvironmentConnection: api.unexpected }));

const retirement = createChatViewFixtureRetirement();
beforeEach(() => retirement.assertIdle());
afterEach(async () => {
  await retirement.retire();
  expect(api.unexpected).not.toHaveBeenCalled();
  api.unexpected.mockClear();
});

type ExpiryFixturePhase =
  | "setup"
  | "render"
  | "initial-settings"
  | "initial-banner"
  | "selected-date"
  | "foreign-date-absent"
  | "dismiss-input"
  | "dismissed-banner"
  | "selected-settings-retained"
  | "foreign-rerender"
  | "foreign-date"
  | "selected-date-retained"
  | "foreign-dismissal-retained"
  | "same-date-rerender"
  | "same-date-dismissal-retained"
  | "localized-rerender"
  | "localized-banner"
  | "localized-settings"
  | "retire-rerender"
  | "retired-banner"
  | "retired-settings";

/** Register public/shared retirement before any render or native acquisition. */
function ownFixture(context: TestContext, restore: () => void) {
  let retired = false;
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  const pending = new Set<Promise<unknown>>();
  let completion: Promise<void> | undefined;
  let phase: ExpiryFixturePhase = "setup";
  let ordinal = 0;
  let failureSnapshot:
    | Readonly<{
        phase: ExpiryFixturePhase;
        ordinal: number;
        pending: number;
        mounted: boolean;
      }>
    | undefined;
  let reportedFailure = false;
  const reportFailure = () => {
    failureSnapshot ??= Object.freeze({
      phase,
      ordinal: Math.min(64, ordinal),
      pending: Math.min(64, pending.size),
      mounted: mounted !== undefined,
    });
    if (reportedFailure) return;
    reportedFailure = true;
    try {
      console.error("Synthetic Claude expiry fixture failure phase", failureSnapshot);
    } catch {
      // Passive diagnostics never replace the original assertion or cleanup.
    }
  };
  const active = () => {
    if (retired || context.signal.aborted) throw new Error("Expiry fixture retired");
  };
  const own = async <T,>(step: ExpiryFixturePhase, run: () => PromiseLike<T>): Promise<T> => {
    active();
    phase = step;
    ordinal = Math.min(64, ordinal + 1);
    const actual = Promise.resolve(run());
    pending.add(actual);
    try {
      const value = await actual;
      active();
      return value;
    } finally {
      pending.delete(actual);
    }
  };
  const cleanup = (): Promise<void> => {
    retired = true;
    context.signal.removeEventListener("abort", onAbort);
    return (completion ??= Promise.resolve().then(async () => {
      while (pending.size) await Promise.allSettled([...pending]);
      await mounted?.unmount();
      mounted = undefined;
      restore();
    }));
  };
  const onAbort = () => {
    // Capture the original operation before retirement/unmount changes state.
    reportFailure();
    void cleanup().catch(() => undefined);
  };
  retirement.admit(cleanup);
  context.onTestFailed(reportFailure);
  context.onTestFinished(cleanup);
  context.signal.addEventListener("abort", onAbort, { once: true });
  if (context.signal.aborted) onAbort();
  return {
    own,
    active,
    render: (...args: Parameters<typeof render>) =>
      own("render", async () => {
        mounted = await render(...args);
        return mounted;
      }),
    async run(body: () => Promise<void>) {
      let failed = false;
      try {
        active();
        await body();
      } catch (failure) {
        reportFailure();
        failed = true;
        throw failure;
      } finally {
        try {
          await cleanup();
        } catch (failure) {
          if (!failed) throw failure;
        }
      }
    },
  };
}

it("shows a ready Claude session's reported expiry in Settings and chat without transferring dismissal or account metadata", async (context) => {
  const previousLocale = getUiLocale();
  const fixture = ownFixture(context, () => setUiLocale(previousLocale));
  await fixture.run(async () => {
    fixture.active();
    setUiLocale("en");
    const now = Date.now();
    const date = (days: number) => new Date(now + days * 24 * 60 * 60 * 1_000).toISOString();
    const makeProvider = (id: string, expiresAt: string): ServerProvider => ({
      instanceId: ProviderInstanceId.make(id),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: id,
      enabled: true,
      installed: true,
      version: "2.1.318",
      status: "ready",
      auth: {
        status: "authenticated",
        credentialExpiry: { source: "native-result", expiresAt, observedAt: date(0) },
      },
      checkedAt: date(0),
      models: [],
      slashCommands: [],
      skills: [],
    });
    let selected = makeProvider("claude-selected", date(5));
    let other = makeProvider("claude-other", date(2));
    const update = vi.fn();
    const card = (provider: ServerProvider) => (
      <ProviderInstanceCard
        instanceId={provider.instanceId}
        instance={{ driver: provider.driver, enabled: true, config: {} }}
        driverOption={DRIVER_OPTION_BY_VALUE[provider.driver]}
        liveProvider={provider}
        isSettingsOpen={false}
        onSettingsOpenChange={update}
        isDefaultProvider={false}
        onSetDefaultProvider={update}
        onUpdate={update}
        hiddenModels={[]}
        favoriteModels={[]}
        modelOrder={[]}
        onHiddenModelsChange={update}
        onFavoriteModelsChange={update}
        onModelOrderChange={update}
      />
    );
    const content = () => (
      <TooltipProvider>
        <section data-testid="selected-settings">{card(selected)}</section>
        <section data-testid="other-settings">{card(other)}</section>
        <section data-testid="selected-chat">
          <ProviderStatusBanner status={selected} />
        </section>
      </TooltipProvider>
    );
    const mounted = await fixture.render(content());
    const settings = page.getByTestId("selected-settings");
    const foreign = page.getByTestId("other-settings");
    const chat = page.getByTestId("selected-chat");
    const format = (expiresAt: string, locale: string) =>
      new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(expiresAt),
      );
    await fixture.own("initial-settings", () =>
      expect.element(settings.getByText(/An active Claude session reported/)).toBeVisible(),
    );
    await fixture.own("initial-banner", () =>
      expect.element(chat.getByRole("alert")).toMatchTextContent("Claude sign-in may expire soon."),
    );
    await fixture.own("selected-date", () =>
      expect.element(chat.getByRole("alert")).toMatchTextContent(format(date(5), "en")),
    );
    await fixture.own("foreign-date-absent", () =>
      expect.element(chat.getByRole("alert")).not.toMatchTextContent(format(date(2), "en")),
    );
    await fixture.own("dismiss-input", () =>
      chat.getByRole("button", { name: "Dismiss provider status", exact: true }).click(),
    );
    await fixture.own("dismissed-banner", () =>
      expect.element(chat.getByRole("alert")).not.toBeInTheDocument(),
    );
    await fixture.own("selected-settings-retained", () =>
      expect.element(settings.getByText(/An active Claude session reported/)).toBeVisible(),
    );

    // A different account's newer metadata never replaces the selected
    // account's date or reopens its already dismissed local warning.
    other = makeProvider("claude-other", date(1));
    await fixture.own("foreign-rerender", () => mounted.rerender(content()));
    await fixture.own("foreign-date", () =>
      expect
        .element(foreign.getByText(/An active Claude session reported/))
        .toMatchTextContent(format(date(1), "en")),
    );
    await fixture.own("selected-date-retained", () =>
      expect
        .element(settings.getByText(/An active Claude session reported/))
        .toMatchTextContent(format(date(5), "en")),
    );
    await fixture.own("foreign-dismissal-retained", () =>
      expect.element(chat.getByRole("alert")).not.toBeInTheDocument(),
    );
    selected = {
      ...selected,
      checkedAt: date(0.01),
      auth: {
        ...selected.auth,
        credentialExpiry: { ...selected.auth.credentialExpiry!, observedAt: date(0.01) },
      },
    };
    await fixture.own("same-date-rerender", () => mounted.rerender(content()));
    await fixture.own("same-date-dismissal-retained", () =>
      expect.element(chat.getByRole("alert")).not.toBeInTheDocument(),
    );

    // A genuinely different reported deadline gets its own dismissal identity.
    // Localized native Intl output owns the displayed instant on every host.
    fixture.active();
    setUiLocale("ja");
    selected = makeProvider("claude-selected", date(6));
    await fixture.own("localized-rerender", () => mounted.rerender(content()));
    await fixture.own("localized-banner", () =>
      expect.element(chat.getByRole("alert")).toMatchTextContent(format(date(6), "ja")),
    );
    await fixture.own("localized-settings", () =>
      expect.element(settings).toMatchTextContent(format(date(6), "ja")),
    );
    selected = { ...selected, auth: { status: "authenticated" } };
    await fixture.own("retire-rerender", () => mounted.rerender(content()));
    await fixture.own("retired-banner", () =>
      expect.element(chat.getByRole("alert")).not.toBeInTheDocument(),
    );
    await fixture.own("retired-settings", () =>
      expect.element(settings).not.toMatchTextContent(format(date(6), "ja")),
    );
    fixture.active();
    expect(selected.status).toBe("ready");
    expect(selected.auth.status).toBe("authenticated");
    expect(update).not.toHaveBeenCalled();
  });
});
