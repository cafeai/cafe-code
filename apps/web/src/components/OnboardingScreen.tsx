import { Switch } from "./ui/switch";
import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import {
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  LogInIcon,
  RefreshCwIcon,
  UploadIcon,
} from "lucide-react";

import type { ProviderDriverKind, ServerProvider } from "@cafecode/contracts";
import {
  DEFAULT_APP_ACCENT_COLOR,
  DEFAULT_BRAND_WORDMARK_PREFIX,
  DEFAULT_SIDEBAR_BRAND_IMAGE,
  MAX_BRAND_WORDMARK_PREFIX_LENGTH,
  MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES,
} from "@cafecode/contracts/settings";

import { APP_BASE_NAME } from "../branding";
import {
  DEFAULT_SIDEBAR_BRAND_IMAGE_SIZES,
  DEFAULT_SIDEBAR_BRAND_IMAGE_SRC_SET,
  resolveSidebarBrandImageSrc,
  uploadSidebarBrandImage,
} from "../brandingImages";
import { isElectron } from "~/env";
import { ensureLocalApi } from "~/localApi";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useMacDesktopTitlebar } from "~/hooks/useMacDesktopTitlebar";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { useServerConfig } from "~/rpc/serverState";
import { cn } from "~/lib/utils";
import { ColorWheelPicker } from "./settings/ColorWheelPicker";
import { PROVIDER_CLIENT_DEFINITIONS } from "./settings/providerDriverMeta";
import {
  getProviderSummary,
  getProviderVersionLabel,
  PROVIDER_STATUS_STYLES,
} from "./settings/providerStatus";
import { RedactedSensitiveText } from "./settings/RedactedSensitiveText";
import { Button } from "./ui/button";
import { SegmentedControl } from "./ui/segmented-control";
import { DraftInput } from "./ui/draft-input";
import { Spinner } from "./ui/spinner";
import { stackedThreadToast, toastManager } from "./ui/toast";

const APP_ACCENT_PICKER_FALLBACK = "#2563eb";
const SIDEBAR_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const THEME_CHOICES = [
  {
    value: "system",
    get label() {
      return uiText("System");
    },
  },
  {
    value: "light",
    get label() {
      return uiText("Light");
    },
  },
  {
    value: "dark",
    get label() {
      return uiText("Dark");
    },
  },
] as const;

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

/**
 * Login guidance shown when a provider is installed but signed out: the manual
 * login command plus — on platforms where the server offers it (Windows) — a
 * one-click button that launches the provider's login flow.
 */
function ProviderLoginGuidance({
  provider,
  loginCommand,
}: {
  readonly provider: ServerProvider;
  readonly loginCommand: string;
}) {
  const uiLocale = useUiLocale();

  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const canLogIn = provider.authActions?.login === true;
  const instanceId = provider.instanceId;
  const displayName = provider.displayName ?? String(provider.driver);

  const logIn = useCallback(() => {
    setIsLoggingIn(true);
    ensureLocalApi()
      .server.loginProvider({ instanceId })
      .then(() => {
        toastManager.add({
          type: "success",
          title: uiText("{value0} login opened", { value0: displayName }, undefined, uiLocale),
          description: uiText(
            "Complete the login in the window that opened, then refresh status.",
            undefined,
            undefined,
            uiLocale,
          ),
        });
      })
      .catch((error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText(
              "Could not open {value0} login",
              { value0: displayName },
              undefined,
              uiLocale,
            ),
            description:
              error instanceof Error
                ? error.message
                : uiText(
                    "The provider login command could not be started.",
                    undefined,
                    undefined,
                    uiLocale,
                  ),
          }),
        );
      })
      .finally(() => {
        setIsLoggingIn(false);
      });
  }, [displayName, instanceId, uiLocale]);

  return (
    <div className="mt-2 grid gap-1.5">
      <span className="text-muted-foreground text-xs">
        {uiText("Log in by running", undefined, undefined, uiLocale)}
      </span>
      <LoginCommand command={loginCommand} />
      {canLogIn ? (
        <Button
          className="mt-0.5 h-7 w-fit gap-1.5 px-2 text-xs"
          disabled={isLoggingIn}
          onClick={logIn}
          size="xs"
          variant="outline"
        >
          {isLoggingIn ? (
            <Spinner aria-hidden="true" className="size-3.5" />
          ) : (
            <LogInIcon aria-hidden="true" className="size-3.5" />
          )}
          {uiText("Log in", undefined, undefined, uiLocale)}
        </Button>
      ) : null}
    </div>
  );
}

/** The login command rendered as a copyable code block. */
function LoginCommand({ command }: { readonly command: string }) {
  const uiLocale = useUiLocale();

  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 py-1 pr-1 pl-2.5">
      <code className="min-w-0 flex-1 truncate font-mono text-foreground text-xs">{command}</code>
      <button
        aria-label={uiText("Copy command", undefined, undefined, uiLocale)}
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
  const uiLocale = useUiLocale();

  const guidance = providerGuidance(driver);
  const installed = provider?.installed ?? false;
  const authStatus = provider?.auth.status;
  const email = provider?.auth.email;

  if (installed && authStatus === "authenticated") {
    if (!email?.trim()) return null;
    return (
      <div className="mt-2 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
        <span>{uiText("Signed in as", undefined, undefined, uiLocale)}</span>
        <RedactedSensitiveText
          ariaLabel={uiText("Toggle account email visibility", undefined, undefined, uiLocale)}
          hideTooltip={uiText("Click to hide email", undefined, undefined, uiLocale)}
          revealTooltip={uiText("Click to reveal email", undefined, undefined, uiLocale)}
          value={email}
        />
      </div>
    );
  }

  if (!installed) {
    if (!guidance) return null;
    return (
      <p className="mt-2 text-muted-foreground text-xs leading-5">
        <UiMessage
          message={"You can install it with <slot1></slot1>"}
          slots={{ slot1: <ExternalLink href={guidance.installUrl} /> }}
        />
      </p>
    );
  }

  if (guidance && provider) {
    return <ProviderLoginGuidance loginCommand={guidance.loginCommand} provider={provider} />;
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
        dotClass ?? "bg-status-idle",
      )}
    />
  );
}

function IntroPage() {
  const uiLocale = useUiLocale();

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
          <UiMessage message={"Welcome to <slot1></slot1>"} slots={{ slot1: APP_BASE_NAME }} />
        </h1>
        <p className="text-balance text-sm text-muted-foreground leading-6">
          {uiText(
            "A calm home for long coding sessions with your AI agents.",
            undefined,
            undefined,
            uiLocale,
          )}
        </p>
      </div>
    </div>
  );
}

function ProvidersPage() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const config = useServerConfig();
  const providers = config?.providers ?? [];
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
          <h1 className="font-semibold text-2xl tracking-tight">
            {uiText("Connect a provider", undefined, undefined, uiLocale)}
          </h1>
          <p className="text-balance text-sm text-muted-foreground leading-6">
            {uiText(
              "Install or sign in to the agents you use. You can change this later in Settings.",
              undefined,
              undefined,
              uiLocale,
            )}
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
          {uiText("Refresh", undefined, undefined, uiLocale)}
        </Button>
      </div>
      <ul className="grid gap-3">
        {uiPresentation.PROVIDER_CLIENT_DEFINITIONS.map((definition, index) => {
          const provider = selectProviderForDriver(providers, definition.value);
          const summary = uiPresentation.getProviderSummary(provider);
          const Icon = definition.icon;
          const versionLabel = getProviderVersionLabel(provider?.version);
          return (
            <li
              key={definition.value}
              className="cafe-onboarding-item flex items-start gap-3.5 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xs transition-colors duration-(--duration-fast) hover:border-border-strong"
              style={staggerStyle(index + 1)}
            >
              <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg border border-border bg-background">
                <Icon aria-hidden="true" className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-sm">{definition.label}</h2>
                  {versionLabel ? (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
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

function CustomizeRow({
  index,
  title,
  description,
  descriptionError = false,
  control,
}: {
  readonly index: number;
  readonly title: string;
  readonly description: string;
  readonly descriptionError?: boolean;
  readonly control: ReactNode;
}) {
  return (
    <li
      className="cafe-onboarding-item flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xs"
      style={staggerStyle(index)}
    >
      <div className="min-w-0">
        <h2 className="font-semibold text-sm">{title}</h2>
        <p
          className={cn(
            "mt-0.5 text-xs leading-5",
            descriptionError ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {description}
        </p>
      </div>
      <div className="flex shrink-0 items-center">{control}</div>
    </li>
  );
}

/**
 * "Make it yours" — exposes the major personalization knobs (name, accent
 * color, theme, sidebar image) inline so a fresh install can be branded before
 * entering the app. Each control reuses the same setting plumbing as the
 * Appearance settings, so changes persist and stay in sync.
 */
function CustomizePage() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageUploading, setImageUploading] = useState(false);

  const brandPrefix = settings.brandWordmarkPrefix.trim() || DEFAULT_BRAND_WORDMARK_PREFIX;
  const usesDefaultImage = settings.sidebarBrandImage === DEFAULT_SIDEBAR_BRAND_IMAGE;
  const imageSrc = uiPresentation.resolveSidebarBrandImageSrc(settings.sidebarBrandImage);

  const handleImageChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file) return;
      if (!SIDEBAR_IMAGE_MIME_TYPES.has(file.type)) {
        setImageError(
          uiText("Choose a PNG, JPEG, GIF, or WebP image.", undefined, undefined, uiLocale),
        );
        return;
      }
      if (file.size > MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES) {
        setImageError(uiText("Choose an image under 1 MB.", undefined, undefined, uiLocale));
        return;
      }
      setImageUploading(true);
      try {
        const sidebarBrandImage = await uploadSidebarBrandImage(file);
        setImageError(null);
        updateSettings({ sidebarBrandImage, sidebarBrandImageDataUrl: "" });
      } catch (error) {
        setImageError(
          error instanceof Error
            ? error.message
            : uiText("Could not upload that image.", undefined, undefined, uiLocale),
        );
      } finally {
        setImageUploading(false);
      }
    },
    [updateSettings, uiLocale],
  );

  return (
    <div className="cafe-onboarding-step grid w-full max-w-xl gap-6">
      <div className="cafe-onboarding-item grid gap-2" style={staggerStyle(0)}>
        <h1 className="font-semibold text-2xl tracking-tight">
          {uiText("Make it yours", undefined, undefined, uiLocale)}
        </h1>
        <p className="text-balance text-sm text-muted-foreground leading-6">
          {uiText(
            "Optional. You can change any of this later in Settings.",
            undefined,
            undefined,
            uiLocale,
          )}
        </p>
      </div>
      <ul className="grid gap-3">
        <CustomizeRow
          control={
            <DraftInput
              aria-label={uiText("Branding name", undefined, undefined, uiLocale)}
              className="w-40"
              maxLength={MAX_BRAND_WORDMARK_PREFIX_LENGTH}
              placeholder={DEFAULT_BRAND_WORDMARK_PREFIX}
              value={settings.brandWordmarkPrefix}
              onCommit={(value) =>
                updateSettings({
                  brandWordmarkPrefix: value.trim().slice(0, MAX_BRAND_WORDMARK_PREFIX_LENGTH),
                })
              }
            />
          }
          description={uiText(
            "Shown as “{value0} Code” in the sidebar.",
            { value0: brandPrefix },
            undefined,
            uiLocale,
          )}
          index={1}
          title={uiText("Code name", undefined, undefined, uiLocale)}
        />
        <CustomizeRow
          control={
            <ColorWheelPicker
              ariaLabel={uiText("App accent color", undefined, undefined, uiLocale)}
              defaultPickerColor={APP_ACCENT_PICKER_FALLBACK}
              emptyValue={DEFAULT_APP_ACCENT_COLOR}
              onCommit={(value) => updateSettings({ appAccentColor: value })}
              value={settings.appAccentColor}
            />
          }
          description={uiText(
            "Used for buttons, focus rings, and highlights.",
            undefined,
            undefined,
            uiLocale,
          )}
          index={2}
          title={uiText("Accent color", undefined, undefined, uiLocale)}
        />
        <CustomizeRow
          control={
            <SegmentedControl
              aria-label={uiText("Theme", undefined, undefined, uiLocale)}
              onValueChange={setTheme}
              options={uiPresentation.THEME_CHOICES}
              value={theme}
            />
          }
          description={uiText(
            "Match your system, or pick light or dark.",
            undefined,
            undefined,
            uiLocale,
          )}
          index={3}
          title={uiText("Theme", undefined, undefined, uiLocale)}
        />
        <CustomizeRow
          index={4}
          title={uiText("Enable sidebar image", undefined, undefined, uiLocale)}
          description={uiText("Show an image in the sidebar.", undefined, undefined, uiLocale)}
          control={
            <Switch
              checked={settings.showSidebarMascot}
              onCheckedChange={(checked) => updateSettings({ showSidebarMascot: Boolean(checked) })}
              aria-label={uiText("Enable sidebar image", undefined, undefined, uiLocale)}
            />
          }
        />
        <CustomizeRow
          control={
            <div
              className={cn("flex items-center gap-2", !settings.showSidebarMascot && "opacity-50")}
            >
              <img
                alt=""
                aria-hidden="true"
                className="h-10 w-8 rounded-md object-cover ring-1 ring-border"
                draggable={false}
                sizes={usesDefaultImage ? DEFAULT_SIDEBAR_BRAND_IMAGE_SIZES : undefined}
                src={imageSrc}
                srcSet={usesDefaultImage ? DEFAULT_SIDEBAR_BRAND_IMAGE_SRC_SET : undefined}
              />
              <Button
                disabled={!settings.showSidebarMascot || imageUploading}
                onClick={() => fileInputRef.current?.click()}
                size="xs"
                type="button"
                variant="outline"
              >
                {imageUploading ? (
                  <Spinner aria-hidden="true" className="size-3.5" />
                ) : (
                  <UploadIcon aria-hidden="true" className="size-3.5" />
                )}
                {usesDefaultImage
                  ? uiText("Upload", undefined, undefined, uiLocale)
                  : uiText("Replace", undefined, undefined, uiLocale)}
              </Button>
              {usesDefaultImage ? null : (
                <Button
                  disabled={!settings.showSidebarMascot || imageUploading}
                  onClick={() => {
                    setImageError(null);
                    updateSettings({
                      sidebarBrandImage: DEFAULT_SIDEBAR_BRAND_IMAGE,
                      sidebarBrandImageDataUrl: "",
                    });
                  }}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  {uiText("Reset", undefined, undefined, uiLocale)}
                </Button>
              )}
              <input
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="hidden"
                onChange={(event) => void handleImageChange(event)}
                ref={fileInputRef}
                disabled={!settings.showSidebarMascot || imageUploading}
                type="file"
              />
            </div>
          }
          description={
            imageError ??
            uiText("PNG, JPEG, GIF or WebP, under 1 MB.", undefined, undefined, uiLocale)
          }
          descriptionError={Boolean(imageError)}
          index={5}
          title={uiText("Sidebar image", undefined, undefined, uiLocale)}
        />
      </ul>
    </div>
  );
}

const ONBOARDING_STEPS = ["intro", "providers", "customize"] as const;
type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

const STEP_HEADER_LABEL: Record<OnboardingStep, string> = {
  get intro() {
    return uiText("Welcome");
  },
  get providers() {
    return uiText("Connect a provider");
  },
  get customize() {
    return uiText("Make it yours");
  },
};

/**
 * Full-window first-run onboarding. Rendered by {@link OnboardingSurface} only
 * when `onboardingCompleted` is false. Finishing or skipping flips that flag,
 * which removes this surface — there is no route navigation, so the flow can
 * never loop back to itself.
 */
export function OnboardingScreen() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [stepIndex, setStepIndex] = useState(0);
  const { updateSettings } = useUpdateSettings();
  const macTitlebar = useMacDesktopTitlebar({ includeNarrowDesktop: true });

  const step = ONBOARDING_STEPS[stepIndex] ?? "intro";
  const isFirstStep = stepIndex === 0;
  const isLastStep = stepIndex === ONBOARDING_STEPS.length - 1;

  const complete = useCallback(() => {
    updateSettings({ onboardingCompleted: true });
  }, [updateSettings]);

  const goBack = useCallback(() => setStepIndex((index) => Math.max(0, index - 1)), []);
  const goNext = useCallback(
    () => setStepIndex((index) => Math.min(ONBOARDING_STEPS.length - 1, index + 1)),
    [],
  );

  const headerClassName = cn(
    "relative z-10 flex shrink-0 items-center justify-between gap-2 px-4",
    // Desktop shares the native title band so the window buttons stay centred.
    isElectron
      ? "drag-region h-(--app-titlebar-height) wco:h-[env(titlebar-area-height)] wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]"
      : "h-[52px]",
    macTitlebar && "pl-(--app-mac-titlebar-leading-space)",
  );

  return (
    <div
      className="cafe-onboarding fixed inset-0 z-50 flex flex-col overflow-hidden bg-background text-foreground"
      data-testid="onboarding-screen"
      role="dialog"
      aria-modal="true"
      aria-label={uiText("Welcome to {value0}", { value0: APP_BASE_NAME }, undefined, uiLocale)}
    >
      {/* Calm ambient backdrop. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="-translate-x-1/2 absolute top-[-18%] left-1/2 h-[55vh] w-[80vh] rounded-full bg-primary/8 blur-[120px]" />
      </div>

      <header className={headerClassName} data-mac-titlebar={macTitlebar}>
        <span className="font-medium text-muted-foreground text-xs tabular-nums">
          {uiPresentation.STEP_HEADER_LABEL[step]}
        </span>
        <Button
          className="text-muted-foreground hover:text-foreground"
          onClick={complete}
          size="sm"
          variant="ghost"
        >
          {uiText("Skip", undefined, undefined, uiLocale)}
        </Button>
      </header>

      <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8">
        {/* `key` replays the entrance animation on each step change. */}
        <div className="contents" key={step}>
          {step === "intro" ? <IntroPage /> : null}
          {step === "customize" ? <CustomizePage /> : null}
          {step === "providers" ? <ProvidersPage /> : null}
        </div>
      </main>

      <footer className="relative z-10 flex shrink-0 items-center justify-between gap-3 border-border border-t px-6 py-4">
        <span className="flex items-center gap-1.5" aria-hidden="true">
          {ONBOARDING_STEPS.map((stepName, index) => (
            <span
              key={stepName}
              className={cn(
                "h-1.5 rounded-full transition-all duration-300",
                index === stepIndex ? "w-6 bg-primary" : "w-1.5 bg-muted-foreground/40",
              )}
            />
          ))}
        </span>
        <div className="flex items-center gap-2">
          {isFirstStep ? null : (
            <Button className="group" onClick={goBack} size="sm" variant="outline">
              <ArrowLeftIcon
                aria-hidden="true"
                className="size-4 transition-transform group-hover:-translate-x-0.5"
              />
              {uiText("Back", undefined, undefined, uiLocale)}
            </Button>
          )}
          {isLastStep ? (
            <Button onClick={complete} size="sm" data-testid="onboarding-get-started">
              {uiText("Get started", undefined, undefined, uiLocale)}
            </Button>
          ) : (
            <Button className="group" onClick={goNext} size="sm">
              {uiText("Next", undefined, undefined, uiLocale)}
              <ArrowRightIcon
                aria-hidden="true"
                className="size-4 transition-transform group-hover:translate-x-0.5"
              />
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = {
  PROVIDER_CLIENT_DEFINITIONS,
  STEP_HEADER_LABEL,
  THEME_CHOICES,
  getProviderSummary,
  resolveSidebarBrandImageSrc,
};
