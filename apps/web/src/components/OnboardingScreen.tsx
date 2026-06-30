import { type CSSProperties, useCallback, useMemo, useState } from "react";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, CopyIcon, RefreshCwIcon } from "lucide-react";

import type { ProviderDriverKind, ServerProvider } from "@cafecode/contracts";

import { APP_BASE_NAME } from "../branding";
import { isElectron } from "~/env";
import { ensureLocalApi } from "~/localApi";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useUpdateSettings } from "~/hooks/useSettings";
import { useServerProviders } from "~/rpc/serverState";
import { cn } from "~/lib/utils";
import { PROVIDER_CLIENT_DEFINITIONS } from "./settings/providerDriverMeta";
import {
  getProviderSummary,
  getProviderVersionLabel,
  PROVIDER_STATUS_STYLES,
} from "./settings/providerStatus";
import { RedactedSensitiveText } from "./settings/RedactedSensitiveText";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

/**
 * Per-driver install docs + login command shown in the onboarding providers
 * step. Keyed on the driver slug (a branded string) via a plain switch so we
 * don't depend on importing the brand constructors.
 */
function providerGuidance(
  driver: ProviderDriverKind,
): { readonly installUrl: string; readonly loginCommand: string } | null {
  switch (driver as string) {
    case "codex":
      return { installUrl: "https://developers.openai.com/codex/cli", loginCommand: "codex login" };
    case "claudeAgent":
      return {
        installUrl: "https://code.claude.com/docs/en/quickstart",
        loginCommand: "claude /login",
      };
    default:
      return null;
  }
}

/** A clickable link that opens in the user's real browser (Electron-aware). */
function ExternalLink({ href }: { readonly href: string }) {
  return (
    <a
      className="break-all font-medium text-primary underline underline-offset-2 hover:text-primary/80"
      href={href}
      onClick={(event) => {
        event.preventDefault();
        void ensureLocalApi()
          .shell.openExternal(href)
          .catch((error) => {
            console.warn("Failed to open link", error);
          });
      }}
      rel="noreferrer"
      target="_blank"
    >
      {href}
    </a>
  );
}

/** The login command rendered as a copyable code block. */
function LoginCommand({ command }: { readonly command: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 truncate font-mono text-foreground text-xs">{command}</code>
      <button
        aria-label="Copy command"
        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={() => copyToClipboard(command, undefined)}
        type="button"
      >
        {isCopied ? (
          <CheckIcon aria-hidden="true" className="size-3.5 text-success" />
        ) : (
          <CopyIcon aria-hidden="true" className="size-3.5" />
        )}
      </button>
    </div>
  );
}

/**
 * State-dependent guidance under each provider: install link when the CLI is
 * missing, the login command when it's installed but signed out, and the
 * (censored) account email once authenticated.
 */
function ProviderActionArea({
  driver,
  provider,
}: {
  readonly driver: ProviderDriverKind;
  readonly provider: ServerProvider | undefined;
}) {
  const guidance = providerGuidance(driver);
  const installed = provider?.installed ?? false;
  const authStatus = provider?.auth.status;
  const email = provider?.auth.email;

  if (installed && authStatus === "authenticated") {
    if (!email?.trim()) return null;
    return (
      <div className="mt-2 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
        <span>Signed in as</span>
        <RedactedSensitiveText
          ariaLabel="Toggle account email visibility"
          hideTooltip="Click to hide email"
          revealTooltip="Click to reveal email"
          value={email}
        />
      </div>
    );
  }

  if (!installed) {
    if (!guidance) return null;
    return (
      <p className="mt-2 text-muted-foreground text-xs leading-5">
        You can install it with <ExternalLink href={guidance.installUrl} />
      </p>
    );
  }

  if (guidance) {
    return (
      <div className="mt-2 grid gap-1.5">
        <span className="text-muted-foreground text-xs">Log in by running:</span>
        <LoginCommand command={guidance.loginCommand} />
      </div>
    );
  }

  return null;
}

/** Per-item stagger delay, wired to the `cafe-onboarding-item` keyframe. */
function staggerStyle(index: number): CSSProperties {
  return { "--cafe-onboarding-index": index } as CSSProperties;
}

/**
 * Pick the snapshot to represent a driver in the onboarding list. Prefers the
 * default instance whose id matches the driver kind, then falls back to the
 * first instance the server reported for that driver.
 */
function selectProviderForDriver(
  providers: ReadonlyArray<ServerProvider>,
  driver: ProviderDriverKind,
): ServerProvider | undefined {
  const forDriver = providers.filter((provider) => provider.driver === driver);
  // The default instance for a driver shares the driver's slug as its id; both
  // are branded strings so compare on the underlying value.
  return (
    forDriver.find((provider) => (provider.instanceId as string) === (driver as string)) ??
    forDriver[0]
  );
}

function ProviderStatusDot({ provider }: { readonly provider: ServerProvider | undefined }) {
  const dotClass = provider ? PROVIDER_STATUS_STYLES[provider.status]?.dot : undefined;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full ring-2 ring-current/15",
        dotClass ?? "bg-muted-foreground/50",
      )}
    />
  );
}

function IntroPage() {
  return (
    <div className="cafe-onboarding-step grid w-full max-w-md justify-items-center gap-6 text-center">
      <div className="relative">
        <div
          aria-hidden="true"
          className="-z-10 absolute inset-0 scale-[1.8] rounded-full bg-primary/15 blur-2xl"
        />
        <img
          alt={APP_BASE_NAME}
          className="cafe-onboarding-logo size-16 object-contain drop-shadow-sm"
          src="/apple-touch-icon.png"
        />
      </div>
      <div className="cafe-onboarding-item grid gap-2.5" style={staggerStyle(1)}>
        <h1 className="text-balance font-semibold text-3xl tracking-tight">
          Welcome to {APP_BASE_NAME}
        </h1>
        <p className="text-balance text-[0.95rem] text-muted-foreground leading-7">
          A calm, dependable home for long coding sessions with your AI agents.
        </p>
      </div>
    </div>
  );
}

function ProvidersPage() {
  const providers = useServerProviders();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = useCallback(() => {
    setIsRefreshing(true);
    ensureLocalApi()
      .server.refreshProviders()
      .catch((error) => {
        console.warn("Failed to refresh providers", error);
      })
      .finally(() => {
        setIsRefreshing(false);
      });
  }, []);

  return (
    <div className="cafe-onboarding-step grid w-full max-w-xl gap-6">
      <div
        className="cafe-onboarding-item flex items-start justify-between gap-4"
        style={staggerStyle(0)}
      >
        <div className="grid gap-2">
          <h1 className="font-semibold text-2xl tracking-tight">Connect a provider</h1>
          <p className="text-balance text-sm text-muted-foreground leading-6">
            {APP_BASE_NAME} works with these coding agents. Install or sign in to whichever you use
            — you can always change this later in Settings.
          </p>
        </div>
        <Button
          className="group shrink-0"
          disabled={isRefreshing}
          onClick={refresh}
          size="sm"
          variant="outline"
        >
          {isRefreshing ? (
            <Spinner aria-hidden="true" className="size-4" />
          ) : (
            <RefreshCwIcon
              aria-hidden="true"
              className="size-4 transition-transform duration-500 group-hover:rotate-180"
            />
          )}
          Refresh
        </Button>
      </div>
      <ul className="grid gap-3">
        {PROVIDER_CLIENT_DEFINITIONS.map((definition, index) => {
          const provider = selectProviderForDriver(providers, definition.value);
          const summary = getProviderSummary(provider);
          const Icon = definition.icon;
          const versionLabel = getProviderVersionLabel(provider?.version);
          return (
            <li
              key={definition.value}
              className="cafe-onboarding-item flex items-start gap-3.5 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xs transition-colors duration-200 hover:border-primary/30 hover:bg-accent/30"
              style={staggerStyle(index + 1)}
            >
              <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-background">
                <Icon aria-hidden="true" className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-sm">{definition.label}</h2>
                  {versionLabel ? (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[0.7rem] text-muted-foreground">
                      {versionLabel}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <ProviderStatusDot provider={provider} />
                  <span className="font-medium text-sm">{summary.headline}</span>
                </div>
                {summary.detail ? (
                  <p className="mt-1 text-muted-foreground text-sm leading-6">{summary.detail}</p>
                ) : null}
                <ProviderActionArea driver={definition.value} provider={provider} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type OnboardingStep = "intro" | "providers";

/**
 * Full-window first-run onboarding. Rendered by {@link OnboardingSurface} only
 * when `onboardingCompleted` is false. Finishing or skipping flips that flag,
 * which removes this surface — there is no route navigation, so the flow can
 * never loop back to itself.
 */
export function OnboardingScreen() {
  const [step, setStep] = useState<OnboardingStep>("intro");
  const { updateSettings } = useUpdateSettings();

  const complete = useCallback(() => {
    updateSettings({ onboardingCompleted: true });
  }, [updateSettings]);

  const headerClassName = useMemo(
    () =>
      cn(
        "relative z-10 flex h-[52px] shrink-0 items-center justify-between gap-2 px-4",
        isElectron &&
          "drag-region wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
      ),
    [],
  );

  return (
    <div
      className="cafe-onboarding fixed inset-0 z-50 flex flex-col overflow-hidden bg-background text-foreground"
      data-testid="onboarding-screen"
      role="dialog"
      aria-modal="true"
      aria-label={`Welcome to ${APP_BASE_NAME}`}
    >
      {/* Calm ambient backdrop. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="-translate-x-1/2 absolute top-[-18%] left-1/2 h-[55vh] w-[80vh] rounded-full bg-primary/8 blur-[120px]" />
      </div>

      <header className={headerClassName}>
        <span className="font-medium text-muted-foreground text-xs tabular-nums">
          {step === "intro" ? "Welcome" : "Connect a provider"}
        </span>
        <Button
          className="text-muted-foreground hover:text-foreground"
          onClick={complete}
          size="sm"
          variant="ghost"
        >
          Skip
        </Button>
      </header>

      <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8">
        {/* `key` replays the entrance animation on each step change. */}
        <div className="contents" key={step}>
          {step === "intro" ? <IntroPage /> : <ProvidersPage />}
        </div>
      </main>

      <footer className="relative z-10 flex shrink-0 items-center justify-between gap-3 border-border border-t px-6 py-4">
        <span className="flex items-center gap-1.5" aria-hidden="true">
          <span
            className={cn(
              "h-1.5 rounded-full transition-all duration-300",
              step === "intro" ? "w-6 bg-primary" : "w-1.5 bg-muted-foreground/40",
            )}
          />
          <span
            className={cn(
              "h-1.5 rounded-full transition-all duration-300",
              step === "providers" ? "w-6 bg-primary" : "w-1.5 bg-muted-foreground/40",
            )}
          />
        </span>
        <div className="flex items-center gap-2">
          {step === "providers" ? (
            <Button className="group" onClick={() => setStep("intro")} size="sm" variant="outline">
              <ArrowLeftIcon
                aria-hidden="true"
                className="size-4 transition-transform group-hover:-translate-x-0.5"
              />
              Back
            </Button>
          ) : null}
          {step === "intro" ? (
            <Button className="group" onClick={() => setStep("providers")} size="sm">
              Next
              <ArrowRightIcon
                aria-hidden="true"
                className="size-4 transition-transform group-hover:translate-x-0.5"
              />
            </Button>
          ) : (
            <Button onClick={complete} size="sm" data-testid="onboarding-get-started">
              Get started
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}
