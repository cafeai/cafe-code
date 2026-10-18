import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiFormatDateTime, uiText, type UiLocale } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import {
  ChevronDownIcon,
  DownloadIcon,
  KeyRoundIcon,
  PlusIcon,
  QrCodeIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  type AuthClientSession,
  type AuthPairingLink,
  type AdvertisedEndpoint,
  type DesktopServerExposureState,
} from "@cafecode/contracts";
import { CAFE_CODE_HTTPS_CERTIFICATE_PATH } from "@cafecode/shared/environmentEndpoint";
import * as DateTime from "effect/DateTime";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { cn } from "../../lib/utils";
import { formatElapsedDurationLabel, formatExpiresInLabel } from "../../timestampFormat";
import { resolveDesktopPairingUrl } from "./pairingUrls";
import {
  BusyButtonLabel,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { Badge } from "../ui/badge";
import { InfoTip } from "../ui/info-tip";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogFooter,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { QRCodeSvg } from "../ui/qr-code";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { setPairingTokenOnUrl } from "../../pairingUrl";
import {
  isLoopbackHostname,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "~/environments/primary";
import type { WsRpcClient } from "~/rpc/wsRpcClient";
import {
  getEnvironmentHttpBaseUrl,
  getPrimaryEnvironmentConnection,
  readEnvironmentConnection,
} from "~/environments/runtime";
import { useWorkspaceEnvironmentId } from "~/environments/workspace";
import { readPrimaryEnvironmentDescriptor } from "~/environments/primary";
import { createWorkspaceAuthApi } from "~/environments/workspaceAuth";
import { TwoFactorManagementRow } from "./TwoFactorManagementRow";
import { useUiStateStore } from "~/uiStateStore";
import { resolveServerConfigVersionMismatch } from "~/versionSkew";
import { useServerConfig } from "~/rpc/serverState";
import { SavedEnvironmentsSettings } from "./SavedEnvironmentsSettings";

type ConnectionFeedbackCode =
  | "password-empty"
  | "password-short"
  | "password-mismatch"
  | "password-update-failed"
  | "password-disable-failed"
  | "password-load-failed"
  | "exposure-update-failed"
  | "https-update-failed"
  | "pairing-revoke-failed"
  | "client-revoke-failed"
  | "other-clients-revoke-failed"
  | "exposure-load-failed"
  | "endpoints-load-failed";

type ConnectionFeedback =
  | { readonly kind: "received"; readonly text: string }
  | { readonly kind: "source"; readonly code: ConnectionFeedbackCode };

/**
 * Distinguish finite Cafe fallbacks from received errors before retaining them.
 * A language change can format only our codes; it cannot reinterpret an error
 * message as a catalog key or repeat password/network/auth operations.
 */
function connectionFeedback(error: unknown, fallback: ConnectionFeedbackCode): ConnectionFeedback {
  return error instanceof Error
    ? { kind: "received", text: error.message }
    : { kind: "source", code: fallback };
}

function formatConnectionFeedback(feedback: ConnectionFeedback, locale: UiLocale): string {
  if (feedback.kind === "received") return feedback.text;
  switch (feedback.code) {
    case "password-empty":
      return uiText("Enter an admin password.", undefined, undefined, locale);
    case "password-short":
      return uiText("Admin password must be at least 8 characters.", undefined, undefined, locale);
    case "password-mismatch":
      return uiText("Passwords do not match.", undefined, undefined, locale);
    case "password-update-failed":
      return uiText("Failed to update admin password.", undefined, undefined, locale);
    case "password-disable-failed":
      return uiText("Failed to disable admin password.", undefined, undefined, locale);
    case "password-load-failed":
      return uiText("Failed to load admin password status.", undefined, undefined, locale);
    case "exposure-update-failed":
      return uiText("Failed to update network exposure.", undefined, undefined, locale);
    case "https-update-failed":
      return uiText("Failed to update HTTPS.", undefined, undefined, locale);
    case "pairing-revoke-failed":
      return uiText("Failed to revoke pairing link.", undefined, undefined, locale);
    case "client-revoke-failed":
      return uiText("Failed to revoke client access.", undefined, undefined, locale);
    case "other-clients-revoke-failed":
      return uiText("Failed to revoke other clients.", undefined, undefined, locale);
    case "exposure-load-failed":
      return uiText("Failed to load network exposure state.", undefined, undefined, locale);
    case "endpoints-load-failed":
      return uiText("Failed to load reachable endpoints.", undefined, undefined, locale);
  }
}

function formatAccessTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return uiFormatDateTime(parsed, { dateStyle: "medium", timeStyle: "short" });
}

type ConnectionStatusDotProps = {
  tooltipText?: string | null;
  dotClassName: string;
  pingClassName?: string | null;
};

function ConnectionStatusDot({
  tooltipText,
  dotClassName,
  pingClassName,
}: ConnectionStatusDotProps) {
  const dotContent = (
    <>
      {pingClassName ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full",
            pingClassName,
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", dotClassName)} />
    </>
  );

  if (!tooltipText) {
    return (
      <span className="relative flex size-3 shrink-0 items-center justify-center">
        {dotContent}
      </span>
    );
  }

  const dot = (
    <button
      type="button"
      aria-label={tooltipText}
      className="focus-ring relative flex size-3 shrink-0 cursor-help items-center justify-center rounded-full"
    >
      {dotContent}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={dot} />
      <TooltipPopup side="top" className="max-w-80 whitespace-pre-wrap leading-tight">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Direct row in the card – same pattern as the Provider / ACP-agent list rows. */
const ITEM_ROW_CLASSNAME = "border-t border-border-subtle px-4 py-4 first:border-t-0 sm:px-5";
const ENDPOINT_ROW_CLASSNAME = "border-t border-border-subtle px-4 py-2.5 first:border-t-0 sm:px-5";

const ITEM_ROW_INNER_CLASSNAME =
  "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";

type AccessSectionPresentation = "current" | "endpoint-rail";

function accessRowClassName(_presentation: AccessSectionPresentation) {
  return ITEM_ROW_CLASSNAME;
}

function endpointRowClassName(presentation: AccessSectionPresentation, isAvailable: boolean) {
  if (presentation === "endpoint-rail") {
    return cn(
      "relative border-t border-border-subtle px-4 py-3 first:border-t-0 sm:px-5",
      !isAvailable && "bg-muted/20",
    );
  }

  return cn(ENDPOINT_ROW_CLASSNAME, !isAvailable && "bg-muted/24");
}

function sortDesktopPairingLinks(links: ReadonlyArray<ServerPairingLinkRecord>) {
  return [...links].toSorted(
    (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
  );
}

function sortDesktopClientSessions(sessions: ReadonlyArray<ServerClientSessionRecord>) {
  return [...sessions].toSorted((left, right) => {
    if (left.current !== right.current) {
      return left.current ? -1 : 1;
    }
    if (left.connected !== right.connected) {
      return left.connected ? -1 : 1;
    }
    return new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime();
  });
}

function toDesktopPairingLinkRecord(pairingLink: AuthPairingLink): ServerPairingLinkRecord {
  return {
    ...pairingLink,
    createdAt: DateTime.formatIso(pairingLink.createdAt),
    expiresAt: DateTime.formatIso(pairingLink.expiresAt),
  };
}

function toDesktopClientSessionRecord(clientSession: AuthClientSession): ServerClientSessionRecord {
  return {
    ...clientSession,
    issuedAt: DateTime.formatIso(clientSession.issuedAt),
    expiresAt: DateTime.formatIso(clientSession.expiresAt),
    lastConnectedAt:
      clientSession.lastConnectedAt === null
        ? null
        : DateTime.formatIso(clientSession.lastConnectedAt),
  };
}

function upsertDesktopPairingLink(
  current: ReadonlyArray<ServerPairingLinkRecord>,
  next: ServerPairingLinkRecord,
) {
  const existingIndex = current.findIndex((pairingLink) => pairingLink.id === next.id);
  if (existingIndex === -1) {
    return sortDesktopPairingLinks([...current, next]);
  }
  const updated = [...current];
  updated[existingIndex] = next;
  return sortDesktopPairingLinks(updated);
}

function removeDesktopPairingLink(current: ReadonlyArray<ServerPairingLinkRecord>, id: string) {
  return current.filter((pairingLink) => pairingLink.id !== id);
}

function upsertDesktopClientSession(
  current: ReadonlyArray<ServerClientSessionRecord>,
  next: ServerClientSessionRecord,
) {
  const existingIndex = current.findIndex(
    (clientSession) => clientSession.sessionId === next.sessionId,
  );
  if (existingIndex === -1) {
    return sortDesktopClientSessions([...current, next]);
  }
  const updated = [...current];
  updated[existingIndex] = next;
  return sortDesktopClientSessions(updated);
}

function removeDesktopClientSession(
  current: ReadonlyArray<ServerClientSessionRecord>,
  sessionId: ServerClientSessionRecord["sessionId"],
) {
  return current.filter((clientSession) => clientSession.sessionId !== sessionId);
}

function selectPairingEndpoint(
  endpoints: ReadonlyArray<AdvertisedEndpoint>,
  defaultEndpointKey?: string | null,
): AdvertisedEndpoint | null {
  const availableEndpoints = endpoints.filter((endpoint) => endpoint.status !== "unavailable");
  if (defaultEndpointKey) {
    const selectedEndpoint = availableEndpoints.find(
      (endpoint) => endpointDefaultPreferenceKey(endpoint) === defaultEndpointKey,
    );
    if (selectedEndpoint) {
      return selectedEndpoint;
    }
  }
  return (
    availableEndpoints.find((endpoint) => endpoint.isDefault) ??
    availableEndpoints.find((endpoint) => endpoint.reachability !== "loopback") ??
    null
  );
}

function endpointDefaultPreferenceKey(endpoint: AdvertisedEndpoint): string {
  // Native source-owned display labels may change language. A supplied stable
  // preference receipt preserves their earlier selection independently of
  // translated copy; legacy/addon/user endpoint labels remain opaque below.
  if (endpoint.defaultPreferenceKey) return endpoint.defaultPreferenceKey;
  if (endpoint.id.startsWith("desktop-loopback:")) {
    return "desktop-core:loopback:http";
  }
  if (endpoint.id.startsWith("desktop-lan:")) {
    return "desktop-core:lan:http";
  }

  let scheme = "unknown";
  try {
    scheme = new URL(endpoint.httpBaseUrl).protocol.replace(/:$/u, "");
  } catch {
    // Keep the stored preference stable even if a custom endpoint is malformed.
  }

  return `${endpoint.provider.id}:${endpoint.reachability}:${scheme}:${endpoint.label}`;
}

function resolveAdvertisedEndpointPairingUrl(
  endpoint: AdvertisedEndpoint,
  credential: string,
): string {
  return resolveDesktopPairingUrl(endpoint.httpBaseUrl, credential);
}

function resolveCurrentOriginPairingUrl(credential: string): string {
  const url = new URL("/pair", window.location.href);
  return setPairingTokenOnUrl(url, credential).toString();
}

type PairingLinkListRowProps = {
  pairingLink: ServerPairingLinkRecord;
  endpointUrl: string | null | undefined;
  endpoints: ReadonlyArray<AdvertisedEndpoint>;
  defaultEndpointKey: string | null;
  presentation?: AccessSectionPresentation;
  revokingPairingLinkId: string | null;
  onRevoke: (id: string) => void;
};

const PairingLinkListRow = memo(function PairingLinkListRow({
  pairingLink,
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  presentation = "current",
  revokingPairingLinkId,
  onRevoke,
}: PairingLinkListRowProps) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const nowMs = useRelativeTimeTick(1_000);
  const expiresAtMs = useMemo(
    () => new Date(pairingLink.expiresAt).getTime(),
    [pairingLink.expiresAt],
  );
  const [isRevealDialogOpen, setIsRevealDialogOpen] = useState(false);

  const currentOriginPairingUrl = useMemo(
    () => resolveCurrentOriginPairingUrl(pairingLink.credential),
    [pairingLink.credential],
  );
  const endpointPairingUrl = useMemo(() => {
    const endpoint = selectPairingEndpoint(endpoints, defaultEndpointKey);
    return endpoint ? resolveAdvertisedEndpointPairingUrl(endpoint, pairingLink.credential) : null;
  }, [defaultEndpointKey, endpoints, pairingLink.credential]);
  const endpointCopyOptions = useMemo(
    () =>
      endpoints
        .filter((endpoint) => endpoint.status !== "unavailable")
        .map((endpoint) => {
          const url = resolveAdvertisedEndpointPairingUrl(endpoint, pairingLink.credential);
          return {
            key: endpointDefaultPreferenceKey(endpoint),
            label: endpoint.label,
            url,
            detail: uiText("Pairing URL", undefined, undefined, uiLocale),
          };
        }),
    [endpoints, pairingLink.credential, uiLocale],
  );
  const shareablePairingUrl =
    endpointPairingUrl ??
    (endpointUrl != null && endpointUrl !== ""
      ? resolveDesktopPairingUrl(endpointUrl, pairingLink.credential)
      : isLoopbackHostname(window.location.hostname)
        ? null
        : currentOriginPairingUrl);
  const revealValue = shareablePairingUrl ?? pairingLink.credential;
  const canCopyToClipboard = typeof window !== "undefined";

  const { copyToClipboard } = useCopyToClipboard<"code" | "link">({
    onCopy: (kind) => {
      toastManager.add({
        type: "success",
        title:
          kind === "link"
            ? uiText("Pairing URL copied", undefined, undefined, uiLocale)
            : uiText("Pairing code copied", undefined, undefined, uiLocale),
        description:
          kind === "link"
            ? uiText("Open it on the device you want to pair.", undefined, undefined, uiLocale)
            : uiText("Enter it on the device you want to pair.", undefined, undefined, uiLocale),
      });
    },
    onError: (error, kind) => {
      setIsRevealDialogOpen(true);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: canCopyToClipboard
            ? kind === "link"
              ? uiText("Could not copy pairing URL", undefined, undefined, uiLocale)
              : uiText("Could not copy pairing code", undefined, undefined, uiLocale)
            : uiText("Clipboard copy unavailable", undefined, undefined, uiLocale),
          description: canCopyToClipboard
            ? error.message
            : uiText("Showing the full value instead.", undefined, undefined, uiLocale),
        }),
      );
    },
  });

  const copyPairingValue = useCallback(
    (value: string, kind: "code" | "link") => {
      copyToClipboard(value, kind);
    },
    [copyToClipboard],
  );

  const handleCopyCode = useCallback(() => {
    copyPairingValue(pairingLink.credential, "code");
  }, [copyPairingValue, pairingLink.credential]);

  const handleCopyDefaultLink = useCallback(() => {
    if (!shareablePairingUrl) return;
    copyPairingValue(shareablePairingUrl, "link");
  }, [copyPairingValue, shareablePairingUrl]);

  const expiresAbsolute = formatAccessTimestamp(pairingLink.expiresAt);

  const roleLabel =
    pairingLink.role === "owner"
      ? uiText("Owner", undefined, undefined, uiLocale)
      : uiText("Client", undefined, undefined, uiLocale);
  const primaryLabel =
    pairingLink.label ??
    uiText(
      "{role, select, owner {Owner link} other {Client link}}",
      { role: pairingLink.role },
      undefined,
      uiLocale,
    );
  const defaultEndpointCopyOption =
    endpointCopyOptions.find((option) => option.key === defaultEndpointKey) ??
    endpointCopyOptions[0] ??
    null;
  const defaultEndpointCopyLabel =
    defaultEndpointCopyOption?.label ?? uiText("URL", undefined, undefined, uiLocale);
  const renderEndpointMenuItems = (
    options: typeof endpointCopyOptions = endpointCopyOptions,
    renderDetail = true,
  ) =>
    options.map((option) => (
      <MenuItem key={option.key} onClick={() => copyPairingValue(option.url, "link")}>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{option.label}</span>
          {renderDetail ? (
            <span className="block truncate text-2xs text-muted-foreground">{option.detail}</span>
          ) : null}
        </span>
      </MenuItem>
    ));
  const renderPairingCodeMenuItem = (renderDetail = true) => (
    <MenuItem onClick={handleCopyCode}>
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {uiText("Copy code", undefined, undefined, uiLocale)}
        </span>
        {renderDetail ? (
          <span className="block truncate text-2xs text-muted-foreground">
            {uiText("Code only", undefined, undefined, uiLocale)}
          </span>
        ) : null}
      </span>
    </MenuItem>
  );
  const renderCompactEndpointGroup = (
    label: string,
    options: typeof endpointCopyOptions,
    includeSeparator: boolean,
  ) =>
    options.length > 0 ? (
      <>
        {includeSeparator ? <MenuSeparator /> : null}
        <MenuGroup>
          <MenuGroupLabel>{label}</MenuGroupLabel>
          {renderEndpointMenuItems(options, false)}
        </MenuGroup>
      </>
    ) : null;
  const renderGroupedCopyMenuItems = (options?: { codeFirst?: boolean }) => (
    <>
      {options?.codeFirst ? (
        <>
          <MenuGroup>
            <MenuGroupLabel>
              {uiText("Pairing code", undefined, undefined, uiLocale)}
            </MenuGroupLabel>
            {renderPairingCodeMenuItem(false)}
          </MenuGroup>
          {endpointCopyOptions.length > 0 ? <MenuSeparator /> : null}
        </>
      ) : null}
      {renderCompactEndpointGroup(
        uiText("Pairing URLs", undefined, undefined, uiLocale),
        endpointCopyOptions,
        false,
      )}
      {!options?.codeFirst ? (
        <>
          {endpointCopyOptions.length > 0 ? <MenuSeparator /> : null}
          <MenuGroup>
            <MenuGroupLabel>
              {uiText("Pairing code", undefined, undefined, uiLocale)}
            </MenuGroupLabel>
            {renderPairingCodeMenuItem(false)}
          </MenuGroup>
        </>
      ) : null}
    </>
  );

  if (expiresAtMs <= nowMs) {
    return null;
  }

  return (
    <div className={accessRowClassName(presentation)}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={uiText(
                "Link created at {timestamp}",
                {
                  timestamp: formatAccessTimestamp(pairingLink.createdAt),
                },
                undefined,
                uiLocale,
              )}
              dotClassName="bg-warning"
            />
            <h3 className="text-ui font-medium text-foreground">{primaryLabel}</h3>
            <Popover>
              {shareablePairingUrl ? (
                <>
                  <PopoverTrigger
                    openOnHover
                    delay={250}
                    closeDelay={100}
                    render={
                      <button
                        type="button"
                        className="focus-ring inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-subtle-foreground hover:text-foreground"
                        aria-label={uiText("Show QR code", undefined, undefined, uiLocale)}
                      />
                    }
                  >
                    <QrCodeIcon aria-hidden className="size-3" />
                  </PopoverTrigger>
                  <PopoverPopup side="top" align="start" tooltipStyle className="w-max">
                    <QRCodeSvg
                      value={shareablePairingUrl}
                      size={88}
                      level="M"
                      marginSize={2}
                      title={uiText(
                        "Pairing link — scan to open on another device",
                        undefined,
                        undefined,
                        uiLocale,
                      )}
                    />
                  </PopoverPopup>
                </>
              ) : null}
            </Popover>
          </div>
          <Tooltip>
            <TooltipTrigger
              delay={500}
              render={<p className="w-fit text-xs text-muted-foreground tabular-nums" />}
            >
              {[roleLabel, uiPresentation.formatExpiresInLabel(pairingLink.expiresAt, nowMs)].join(
                " · ",
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              <UiMessage message="Expires <slot1></slot1>" slots={{ slot1: expiresAbsolute }} />
            </TooltipPopup>
          </Tooltip>
          {shareablePairingUrl === null ? (
            <p className="text-2xs text-muted-foreground">
              {uiText(
                "Copy the code and pair using this server''s network address.",
                undefined,
                undefined,
                uiLocale,
              )}
            </p>
          ) : null}
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <Dialog open={isRevealDialogOpen} onOpenChange={setIsRevealDialogOpen}>
            {canCopyToClipboard ? (
              <>
                {shareablePairingUrl ? (
                  <Group
                    aria-label={uiText("Copy selected endpoint", undefined, undefined, uiLocale)}
                  >
                    <Button
                      size="xs"
                      variant="outline"
                      className="max-w-56"
                      onClick={handleCopyDefaultLink}
                    >
                      <span className="truncate">
                        <UiMessage
                          message="Copy pairing URL for: <slot1></slot1>"
                          slots={{ slot1: defaultEndpointCopyLabel }}
                        />
                      </span>
                    </Button>
                    <GroupSeparator />
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="outline"
                            aria-label={uiText(
                              "Choose endpoint to copy",
                              undefined,
                              undefined,
                              uiLocale,
                            )}
                          />
                        }
                      >
                        <ChevronDownIcon className="size-3.5" />
                      </MenuTrigger>
                      <MenuPopup align="end" className="min-w-60">
                        {renderGroupedCopyMenuItems()}
                      </MenuPopup>
                    </Menu>
                  </Group>
                ) : (
                  <Button size="xs" variant="outline" onClick={handleCopyCode}>
                    {uiText("Copy code", undefined, undefined, uiLocale)}
                  </Button>
                )}
              </>
            ) : (
              <DialogTrigger render={<Button size="xs" variant="outline" />}>
                {shareablePairingUrl
                  ? uiText("Show link", undefined, undefined, uiLocale)
                  : uiText("Show code", undefined, undefined, uiLocale)}
              </DialogTrigger>
            )}
            <DialogPopup className="max-w-md">
              <DialogHeader>
                <DialogTitle>
                  {shareablePairingUrl
                    ? uiText("Pairing link", undefined, undefined, uiLocale)
                    : uiText("Pairing code", undefined, undefined, uiLocale)}
                </DialogTitle>
                <DialogDescription>
                  {shareablePairingUrl
                    ? uiText(
                        "Copying isn''t available here, so copy this link by hand or scan the code.",
                        undefined,
                        undefined,
                        uiLocale,
                      )
                    : uiText(
                        "Copying isn''t available here, so copy this code by hand.",
                        undefined,
                        undefined,
                        uiLocale,
                      )}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel className="space-y-4">
                <Textarea
                  readOnly
                  value={revealValue}
                  rows={shareablePairingUrl ? 4 : 3}
                  className="text-xs leading-relaxed"
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
                {shareablePairingUrl ? (
                  <div className="flex justify-center rounded-xl border border-border-subtle bg-muted/30 p-4">
                    <QRCodeSvg
                      value={shareablePairingUrl}
                      size={132}
                      level="M"
                      marginSize={2}
                      title={uiText(
                        "Pairing link — scan to open on another device",
                        undefined,
                        undefined,
                        uiLocale,
                      )}
                    />
                  </div>
                ) : null}
              </DialogPanel>
              <DialogFooter variant="bare">
                <Button variant="outline" onClick={() => setIsRevealDialogOpen(false)}>
                  {uiText("Done", undefined, undefined, uiLocale)}
                </Button>
                {canCopyToClipboard ? (
                  <Button variant="outline" size="xs" onClick={handleCopyCode}>
                    {uiText("Copy code", undefined, undefined, uiLocale)}
                  </Button>
                ) : null}
              </DialogFooter>
            </DialogPopup>
          </Dialog>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={revokingPairingLinkId === pairingLink.id}
            aria-busy={revokingPairingLinkId === pairingLink.id || undefined}
            onClick={() => void onRevoke(pairingLink.id)}
          >
            <BusyButtonLabel busy={revokingPairingLinkId === pairingLink.id}>
              {uiText("Revoke", undefined, undefined, uiLocale)}
            </BusyButtonLabel>
          </Button>
        </div>
      </div>
    </div>
  );
});

type ConnectedClientListRowProps = {
  clientSession: ServerClientSessionRecord;
  presentation?: AccessSectionPresentation;
  revokingClientSessionId: string | null;
  onRevokeSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
};

function clientDeviceTypeLabel(
  deviceType: AuthClientSession["client"]["deviceType"],
): string | null {
  // The authenticated device enum remains unchanged; only its finite display
  // labels are translated. Received OS/browser names are never title-cased.
  switch (deviceType) {
    case "desktop":
      return uiText("Desktop");
    case "mobile":
      return uiText("Mobile");
    case "tablet":
      return uiText("Tablet");
    case "bot":
      return uiText("Bot");
    case "unknown":
      return null;
  }
}

const ConnectedClientListRow = memo(function ConnectedClientListRow({
  clientSession,
  presentation = "current",
  revokingClientSessionId,
  onRevokeSession,
}: ConnectedClientListRowProps) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const nowMs = useRelativeTimeTick(1_000);
  const isLive = clientSession.current || clientSession.connected;
  const lastConnectedAt = clientSession.lastConnectedAt;
  const statusTooltip = isLive
    ? lastConnectedAt
      ? uiText(
          "Connected for {value0}",
          {
            value0: uiPresentation.formatElapsedDurationLabel(lastConnectedAt, nowMs),
          },
          undefined,
          uiLocale,
        )
      : uiText("Connected", undefined, undefined, uiLocale)
    : lastConnectedAt
      ? uiText(
          "Last connected at {value0}",
          { value0: formatAccessTimestamp(lastConnectedAt) },
          undefined,
          uiLocale,
        )
      : uiText("Not connected yet.", undefined, undefined, uiLocale);
  const roleLabel =
    clientSession.role === "owner"
      ? uiText("Owner", undefined, undefined, uiLocale)
      : uiText("Client", undefined, undefined, uiLocale);
  const deviceInfoBits = [
    uiPresentation.clientDeviceTypeLabel(clientSession.client.deviceType),
    clientSession.client.os ?? null,
    clientSession.client.browser ?? null,
    clientSession.client.ipAddress ?? null,
  ].filter((value): value is string => value !== null);
  const primaryLabel =
    clientSession.client.label ??
    ([clientSession.client.os, clientSession.client.browser].filter(Boolean).join(" · ") ||
      clientSession.subject);

  return (
    <div className={accessRowClassName(presentation)}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <ConnectionStatusDot
              tooltipText={statusTooltip}
              dotClassName={isLive ? "bg-success" : "bg-muted-foreground/30"}
              pingClassName={isLive ? "bg-success/60 duration-2000" : null}
            />
            <h3 className="text-ui font-medium text-foreground">{primaryLabel}</h3>
            {clientSession.current ? (
              <Badge variant="secondary">
                {uiText("This device", undefined, undefined, uiLocale)}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {[roleLabel, ...deviceInfoBits].join(" · ")}
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {!clientSession.current ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={revokingClientSessionId === clientSession.sessionId}
              aria-busy={revokingClientSessionId === clientSession.sessionId || undefined}
              onClick={() => void onRevokeSession(clientSession.sessionId)}
            >
              <BusyButtonLabel busy={revokingClientSessionId === clientSession.sessionId}>
                {uiText("Revoke", undefined, undefined, uiLocale)}
              </BusyButtonLabel>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

type AuthorizedClientsHeaderActionProps = {
  createPairingCredential: ReturnType<
    typeof createWorkspaceAuthApi
  >["createServerPairingCredential"];
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  isRevokingOtherClients: boolean;
  onRevokeOtherClients: () => void;
};

const AuthorizedClientsHeaderAction = memo(function AuthorizedClientsHeaderAction({
  createPairingCredential,
  clientSessions,
  isRevokingOtherClients,
  onRevokeOtherClients,
}: AuthorizedClientsHeaderActionProps) {
  const uiLocale = useUiLocale();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [pairingLabel, setPairingLabel] = useState("");
  const [isCreatingPairingLink, setIsCreatingPairingLink] = useState(false);

  const handleCreatePairingLink = useCallback(async () => {
    setIsCreatingPairingLink(true);
    try {
      await createPairingCredential(pairingLabel);
      setPairingLabel("");
      setDialogOpen(false);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : uiText("Failed to create pairing URL.", undefined, undefined, uiLocale);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText("Could not create pairing URL", undefined, undefined, uiLocale),
          description: message,
        }),
      );
    } finally {
      setIsCreatingPairingLink(false);
    }
  }, [pairingLabel, createPairingCredential, uiLocale]);

  return (
    <div className="flex items-center gap-2">
      <Button
        size="xs"
        variant="destructive-outline"
        disabled={
          isRevokingOtherClients || clientSessions.every((clientSession) => clientSession.current)
        }
        aria-busy={isRevokingOtherClients || undefined}
        onClick={() => void onRevokeOtherClients()}
      >
        <BusyButtonLabel busy={isRevokingOtherClients}>
          {uiText("Revoke others", undefined, undefined, uiLocale)}
        </BusyButtonLabel>
      </Button>
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setPairingLabel("");
          }
        }}
      >
        <DialogTrigger
          render={
            <Button size="xs" variant="default">
              <PlusIcon className="size-3" />
              {uiText("Create link", undefined, undefined, uiLocale)}
            </Button>
          }
        />
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {uiText("Create pairing link", undefined, undefined, uiLocale)}
            </DialogTitle>
            <DialogDescription>
              {uiText(
                "Another device can use this one-time link to connect.",
                undefined,
                undefined,
                uiLocale,
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                {uiText("Device name (optional)", undefined, undefined, uiLocale)}
              </span>
              <Input
                value={pairingLabel}
                onChange={(event) => setPairingLabel(event.target.value)}
                placeholder={uiText("e.g. Living room iPad", undefined, undefined, uiLocale)}
                disabled={isCreatingPairingLink}
                autoFocus
              />
            </label>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              disabled={isCreatingPairingLink}
              onClick={() => setDialogOpen(false)}
            >
              {uiText("Cancel", undefined, undefined, uiLocale)}
            </Button>
            <Button
              disabled={isCreatingPairingLink}
              aria-busy={isCreatingPairingLink || undefined}
              onClick={() => void handleCreatePairingLink()}
            >
              <BusyButtonLabel busy={isCreatingPairingLink}>
                {uiText("Create link", undefined, undefined, uiLocale)}
              </BusyButtonLabel>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
});

type AdminPasswordManagementRowProps = {
  configured: boolean | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  onSetPassword: (password: string) => Promise<void>;
  onClearPassword: () => Promise<void>;
};

const AdminPasswordManagementRow = memo(function AdminPasswordManagementRow({
  configured,
  isLoading,
  isSaving,
  error,
  onSetPassword,
  onClearPassword,
}: AdminPasswordManagementRowProps) {
  const uiLocale = useUiLocale();

  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordDialogMode, setPasswordDialogMode] = useState<"enable" | "change">("enable");
  const [disableDialogOpen, setDisableDialogOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [dialogErrorCode, setDialogErrorCode] = useState<ConnectionFeedback | null>(null);
  const resetPasswordDialog = useCallback(() => {
    setPassword("");
    setConfirmPassword("");
    setDialogErrorCode(null);
  }, []);
  const openPasswordDialog = useCallback((mode: "enable" | "change") => {
    setPasswordDialogMode(mode);
    setPasswordDialogOpen(true);
    setDialogErrorCode(null);
  }, []);
  const handleSavePassword = useCallback(async () => {
    const nextPassword = password.trim();
    if (!nextPassword) {
      setDialogErrorCode({ kind: "source", code: "password-empty" });
      return;
    }
    if (nextPassword.length < 8) {
      setDialogErrorCode({ kind: "source", code: "password-short" });
      return;
    }
    if (nextPassword !== confirmPassword.trim()) {
      setDialogErrorCode({ kind: "source", code: "password-mismatch" });
      return;
    }

    setDialogErrorCode(null);
    try {
      await onSetPassword(nextPassword);
      setPasswordDialogOpen(false);
      resetPasswordDialog();
    } catch (caughtError) {
      setDialogErrorCode(connectionFeedback(caughtError, "password-update-failed"));
    }
  }, [confirmPassword, onSetPassword, password, resetPasswordDialog]);
  const handleClearPassword = useCallback(async () => {
    try {
      await onClearPassword();
      setDisableDialogOpen(false);
    } catch (caughtError) {
      setDialogErrorCode(connectionFeedback(caughtError, "password-disable-failed"));
    }
  }, [onClearPassword]);

  const isConfigured = configured === true;
  const dialogErrorText = dialogErrorCode
    ? formatConnectionFeedback(dialogErrorCode, uiLocale)
    : null;
  const controlsDisabled = isLoading || isSaving || configured === null;
  const showLoadingSpinner = useDelayedFlag(isLoading);

  return (
    <>
      <SettingsRow
        title={uiText("Admin password", undefined, undefined, uiLocale)}
        description={uiText(
          "Lets owners sign in from the pairing screen with a password.",
          undefined,
          undefined,
          uiLocale,
        )}
        status={error ? <span className="block text-destructive-foreground">{error}</span> : null}
        control={
          <>
            {showLoadingSpinner ? (
              <Spinner
                aria-label={uiText("Loading password status", undefined, undefined, uiLocale)}
                className="size-3.5 text-muted-foreground"
              />
            ) : null}
            {isConfigured ? (
              <Button
                size="xs"
                variant="outline"
                disabled={controlsDisabled}
                onClick={() => openPasswordDialog("change")}
              >
                <KeyRoundIcon className="size-3" />
                {uiText("Change", undefined, undefined, uiLocale)}
              </Button>
            ) : null}
            <Switch
              checked={isConfigured}
              disabled={controlsDisabled}
              onCheckedChange={(checked) => {
                if (checked) {
                  openPasswordDialog("enable");
                } else {
                  setDisableDialogOpen(true);
                  setDialogErrorCode(null);
                }
              }}
              aria-label={uiText("Enable password authentication", undefined, undefined, uiLocale)}
            />
          </>
        }
      />
      <Dialog
        open={passwordDialogOpen}
        onOpenChange={(open) => {
          if (isSaving) return;
          setPasswordDialogOpen(open);
          if (!open) {
            resetPasswordDialog();
          }
        }}
      >
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {passwordDialogMode === "enable"
                ? uiText("Enable admin password", undefined, undefined, uiLocale)
                : uiText("Change admin password", undefined, undefined, uiLocale)}
            </DialogTitle>
            <DialogDescription>
              {uiText(
                "Set the password used for owner login from the pairing screen.",
                undefined,
                undefined,
                uiLocale,
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                {uiText("Admin password", undefined, undefined, uiLocale)}
              </span>
              <Input
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                autoComplete="new-password"
                disabled={isSaving}
                autoFocus
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                {uiText("Confirm password", undefined, undefined, uiLocale)}
              </span>
              <Input
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                type="password"
                autoComplete="new-password"
                disabled={isSaving}
              />
            </label>
            {dialogErrorText ? (
              <p className="text-xs text-destructive-foreground">{dialogErrorText}</p>
            ) : null}
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              variant="outline"
              disabled={isSaving}
              onClick={() => {
                setPasswordDialogOpen(false);
                resetPasswordDialog();
              }}
            >
              {uiText("Cancel", undefined, undefined, uiLocale)}
            </Button>
            <Button
              disabled={isSaving}
              aria-busy={isSaving || undefined}
              onClick={() => void handleSavePassword()}
            >
              <BusyButtonLabel busy={isSaving}>
                {passwordDialogMode === "enable"
                  ? uiText("Enable", undefined, undefined, uiLocale)
                  : uiText("Save", undefined, undefined, uiLocale)}
              </BusyButtonLabel>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <AlertDialog
        open={disableDialogOpen}
        onOpenChange={(open) => {
          if (isSaving) return;
          setDisableDialogOpen(open);
          if (!open) {
            setDialogErrorCode(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {uiText("Disable password authentication?", undefined, undefined, uiLocale)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {uiText(
                "This clears the saved admin password. Existing sessions stay active until revoked or expired.",
                undefined,
                undefined,
                uiLocale,
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dialogErrorText ? (
            <div className="px-6 pb-2 text-xs text-destructive-foreground">{dialogErrorText}</div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={isSaving}
              render={<Button variant="outline" disabled={isSaving} />}
            >
              {uiText("Cancel", undefined, undefined, uiLocale)}
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={isSaving}
              aria-busy={isSaving || undefined}
              onClick={() => void handleClearPassword()}
            >
              <BusyButtonLabel busy={isSaving}>
                {uiText("Disable", undefined, undefined, uiLocale)}
              </BusyButtonLabel>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
});

type PairingClientsListProps = {
  endpointUrl: string | null | undefined;
  endpoints: ReadonlyArray<AdvertisedEndpoint>;
  defaultEndpointKey: string | null;
  presentation?: AccessSectionPresentation;
  isLoading: boolean;
  pairingLinks: ReadonlyArray<ServerPairingLinkRecord>;
  clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  revokingPairingLinkId: string | null;
  revokingClientSessionId: string | null;
  onRevokePairingLink: (id: string) => void;
  onRevokeClientSession: (sessionId: ServerClientSessionRecord["sessionId"]) => void;
};

const PairingClientsList = memo(function PairingClientsList({
  endpointUrl,
  endpoints,
  defaultEndpointKey,
  presentation = "current",
  isLoading,
  pairingLinks,
  clientSessions,
  revokingPairingLinkId,
  revokingClientSessionId,
  onRevokePairingLink,
  onRevokeClientSession,
}: PairingClientsListProps) {
  const uiLocale = useUiLocale();

  const isEmpty = pairingLinks.length === 0 && clientSessions.length === 0;
  const showSkeleton = useDelayedFlag(isLoading && isEmpty);
  return (
    <>
      {showSkeleton ? <PairingClientRowsSkeleton presentation={presentation} /> : null}
      {pairingLinks.map((pairingLink) => (
        <PairingLinkListRow
          key={pairingLink.id}
          pairingLink={pairingLink}
          endpointUrl={endpointUrl}
          endpoints={endpoints}
          defaultEndpointKey={defaultEndpointKey}
          presentation={presentation}
          revokingPairingLinkId={revokingPairingLinkId}
          onRevoke={onRevokePairingLink}
        />
      ))}

      {clientSessions.map((clientSession) => (
        <ConnectedClientListRow
          key={clientSession.sessionId}
          clientSession={clientSession}
          presentation={presentation}
          revokingClientSessionId={revokingClientSessionId}
          onRevokeSession={onRevokeClientSession}
        />
      ))}

      {isEmpty && !isLoading ? (
        <div className={accessRowClassName(presentation)}>
          <p className="text-xs text-muted-foreground">
            {uiText("No pairing links or devices yet.", undefined, undefined, uiLocale)}
          </p>
        </div>
      ) : null}
    </>
  );
});

/** Layout-matching placeholder rows for the first device/pairing-link read. */
function PairingClientRowsSkeleton({ presentation }: { presentation: AccessSectionPresentation }) {
  return (
    <>
      {[0, 1].map((index) => (
        <div key={index} aria-hidden className={accessRowClassName(presentation)}>
          <div className={ITEM_ROW_INNER_CLASSNAME}>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="size-2 rounded-full" />
                <Skeleton className="h-3.5 w-32" />
              </div>
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-6 w-16 rounded-md" />
          </div>
        </div>
      ))}
    </>
  );
}

type AdvertisedEndpointListRowProps = {
  endpoint: AdvertisedEndpoint;
  isDefault: boolean;
  presentation?: AccessSectionPresentation;
  onSetDefault: (endpoint: AdvertisedEndpoint) => void;
};

const AdvertisedEndpointListRow = memo(function AdvertisedEndpointListRow({
  endpoint,
  isDefault,
  presentation = "current",
  onSetDefault,
}: AdvertisedEndpointListRowProps) {
  const uiLocale = useUiLocale();

  const isAvailable = endpoint.status === "available";
  const isEndpointRail = presentation === "endpoint-rail";
  return (
    <div className={endpointRowClassName(presentation, isAvailable)}>
      {isEndpointRail && isDefault ? (
        <span className="absolute inset-y-2 left-0 w-1 rounded-r-full bg-primary" aria-hidden />
      ) : null}
      <div className="flex min-h-6 min-w-0 flex-col gap-2 sm:-my-0.5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-baseline gap-3">
          <h3 className="shrink-0 text-ui leading-5 font-medium text-foreground">
            {endpoint.label}
          </h3>
          <p className="min-w-0 truncate text-xs leading-5 text-muted-foreground">
            {endpoint.httpBaseUrl}
          </p>
          {!isAvailable ? (
            <Badge variant="outline">{uiText("Unavailable", undefined, undefined, uiLocale)}</Badge>
          ) : null}
        </div>
        <div className="ml-auto flex min-h-6 shrink-0 items-center justify-end gap-2">
          {isDefault ? (
            <Badge className="bg-primary/10 text-primary">
              {uiText("Default", undefined, undefined, uiLocale)}
            </Badge>
          ) : null}
          {isAvailable && !isDefault ? (
            <Button size="xs" variant="outline" onClick={() => onSetDefault(endpoint)}>
              {uiText("Set as default", undefined, undefined, uiLocale)}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

/**
 * A restart takes long enough to deserve a "Restarting…" label (docs/style-guide.md
 * §9), so both labels share one grid cell: the button is as wide as the longer
 * one and never resizes when the state flips. Hidden labels stay out of the
 * accessible name.
 */
function RestartButtonLabel({
  restarting,
  children,
}: {
  restarting: boolean;
  children: ReactNode;
}) {
  return (
    <span className="grid justify-items-center">
      <span className={cn("col-start-1 row-start-1", restarting && "invisible")}>{children}</span>
      <span
        className={cn(
          "col-start-1 row-start-1 inline-flex items-center gap-1.5",
          !restarting && "invisible",
        )}
      >
        <UiMessage
          message={"<slot1></slot1>Restarting…"}
          slots={{ slot1: <Spinner className="size-3.5" /> }}
        />
      </span>
    </span>
  );
}

function NetworkAccessDescription({
  endpoint,
  hiddenEndpointCount,
  expanded,
  onToggleExpanded,
  fallback,
}: {
  endpoint: AdvertisedEndpoint | null;
  hiddenEndpointCount: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  fallback: ReactNode;
}) {
  const uiLocale = useUiLocale();

  if (!endpoint) {
    return fallback;
  }

  const summary = (
    <>
      <span className="min-w-0 truncate">{endpoint.httpBaseUrl}</span>
      {hiddenEndpointCount > 0 ? (
        <span className="shrink-0 text-xs font-medium">
          {expanded ? uiText("Hide", undefined, undefined, uiLocale) : `+${hiddenEndpointCount}`}
        </span>
      ) : null}
    </>
  );

  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline gap-1">
      <span className="shrink-0">{uiText("Reachable at", undefined, undefined, uiLocale)}</span>
      {hiddenEndpointCount > 0 ? (
        <button
          type="button"
          className="focus-ring inline-flex min-w-0 max-w-full items-baseline gap-2 border-b border-dotted border-subtle-foreground text-left text-muted-foreground underline-offset-4 hover:border-foreground hover:text-foreground"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
        >
          {summary}
        </button>
      ) : (
        <span className="inline-flex min-w-0 max-w-full items-baseline gap-2">{summary}</span>
      )}
    </span>
  );
}

export function ConnectionsSettings() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const environmentId = useWorkspaceEnvironmentId();
  const isPrimary =
    !environmentId || environmentId === readPrimaryEnvironmentDescriptor()?.environmentId;
  const auth = useMemo(() => createWorkspaceAuthApi(environmentId), [environmentId]);
  const {
    clearServerAdminPassword,
    createServerPairingCredential,
    fetchServerAdminPasswordStatus,
    fetchSessionState,
    revokeOtherServerClientSessions,
    revokeServerClientSession,
    revokeServerPairingLink,
    setServerAdminPassword,
  } = auth;
  const desktopBridge = isPrimary ? window.desktopBridge : undefined;
  const [currentSessionRole, setCurrentSessionRole] = useState<"owner" | "client" | null>(
    desktopBridge ? "owner" : null,
  );
  const [currentAuthPolicy, setCurrentAuthPolicy] = useState<
    "desktop-managed-local" | "loopback-browser" | "remote-reachable" | "unsafe-no-auth" | null
  >(desktopBridge ? null : null);

  const [desktopServerExposureState, setDesktopServerExposureState] =
    useState<DesktopServerExposureState | null>(null);
  const [desktopAdvertisedEndpoints, setDesktopAdvertisedEndpoints] = useState<
    ReadonlyArray<AdvertisedEndpoint>
  >([]);
  const [desktopServerExposureErrorCode, setDesktopServerExposureErrorCode] =
    useState<ConnectionFeedback | null>(null);
  const [desktopPairingLinks, setDesktopPairingLinks] = useState<
    ReadonlyArray<ServerPairingLinkRecord>
  >([]);
  const [desktopClientSessions, setDesktopClientSessions] = useState<
    ReadonlyArray<ServerClientSessionRecord>
  >([]);
  const [desktopAccessManagementErrorCode, setDesktopAccessManagementErrorCode] =
    useState<ConnectionFeedback | null>(null);
  const [isLoadingDesktopAccessManagement, setIsLoadingDesktopAccessManagement] = useState(false);
  const [adminPasswordConfigured, setAdminPasswordConfigured] = useState<boolean | null>(null);
  const [adminPasswordErrorCode, setAdminPasswordErrorCode] = useState<ConnectionFeedback | null>(
    null,
  );
  const [isLoadingAdminPassword, setIsLoadingAdminPassword] = useState(false);
  const [isSavingAdminPassword, setIsSavingAdminPassword] = useState(false);
  const [revokingDesktopPairingLinkId, setRevokingDesktopPairingLinkId] = useState<string | null>(
    null,
  );
  const [revokingDesktopClientSessionId, setRevokingDesktopClientSessionId] = useState<
    string | null
  >(null);
  const [isRevokingOtherDesktopClients, setIsRevokingOtherDesktopClients] = useState(false);
  const [isUpdatingDesktopServerExposure, setIsUpdatingDesktopServerExposure] = useState(false);
  const [isDesktopServerExposureDialogOpen, setIsDesktopServerExposureDialogOpen] = useState(false);
  const [pendingDesktopServerExposureMode, setPendingDesktopServerExposureMode] = useState<
    DesktopServerExposureState["mode"] | null
  >(null);
  const [isUpdatingDesktopServerHttps, setIsUpdatingDesktopServerHttps] = useState(false);
  const [isDesktopServerHttpsDialogOpen, setIsDesktopServerHttpsDialogOpen] = useState(false);
  const [pendingDesktopServerHttpsEnabled, setPendingDesktopServerHttpsEnabled] = useState<
    boolean | null
  >(null);
  const primaryServerConfig = useServerConfig();
  const primaryVersionMismatch =
    uiPresentation.resolveServerConfigVersionMismatch(primaryServerConfig);
  const [isAdvertisedEndpointListExpanded, setIsAdvertisedEndpointListExpanded] = useState(true);
  const defaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.defaultAdvertisedEndpointKey,
  );
  const setDefaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.setDefaultAdvertisedEndpointKey,
  );
  const canManageLocalBackend = currentSessionRole === "owner";
  const isLocalBackendNetworkAccessible = desktopBridge
    ? desktopServerExposureState?.mode === "network-accessible"
    : currentAuthPolicy === "remote-reachable";

  const handleDesktopServerExposureChange = useCallback(
    async (checked: boolean) => {
      if (!desktopBridge) return;
      setIsUpdatingDesktopServerExposure(true);
      setDesktopServerExposureErrorCode(null);
      try {
        const nextState = await desktopBridge.setServerExposureMode(
          checked ? "network-accessible" : "local-only",
        );
        setDesktopServerExposureState(nextState);
        setIsDesktopServerExposureDialogOpen(false);
        setIsUpdatingDesktopServerExposure(false);
      } catch (error) {
        const feedback = connectionFeedback(error, "exposure-update-failed");
        const message = formatConnectionFeedback(feedback, uiLocale);
        setIsDesktopServerExposureDialogOpen(false);
        setDesktopServerExposureErrorCode(feedback);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not update network access", undefined, undefined, uiLocale),
            description: message,
          }),
        );
        setIsUpdatingDesktopServerExposure(false);
      }
    },
    [desktopBridge, uiLocale],
  );

  const handleConfirmDesktopServerExposureChange = useCallback(() => {
    if (pendingDesktopServerExposureMode === null) return;
    const checked = pendingDesktopServerExposureMode === "network-accessible";
    void handleDesktopServerExposureChange(checked);
  }, [handleDesktopServerExposureChange, pendingDesktopServerExposureMode]);

  const handleDesktopServerHttpsChange = useCallback(
    async (enabled: boolean) => {
      if (!desktopBridge) return;
      setIsUpdatingDesktopServerHttps(true);
      setDesktopServerExposureErrorCode(null);
      try {
        const nextState = await desktopBridge.setServerHttpsEnabled(enabled);
        setDesktopServerExposureState(nextState);
        setIsDesktopServerHttpsDialogOpen(false);
        setIsUpdatingDesktopServerHttps(false);
      } catch (error) {
        const feedback = connectionFeedback(error, "https-update-failed");
        const message = formatConnectionFeedback(feedback, uiLocale);
        setIsDesktopServerHttpsDialogOpen(false);
        setDesktopServerExposureErrorCode(feedback);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not update HTTPS", undefined, undefined, uiLocale),
            description: message,
          }),
        );
        setIsUpdatingDesktopServerHttps(false);
      }
    },
    [desktopBridge, uiLocale],
  );

  const handleConfirmDesktopServerHttpsChange = useCallback(() => {
    if (pendingDesktopServerHttpsEnabled === null) return;
    void handleDesktopServerHttpsChange(pendingDesktopServerHttpsEnabled);
  }, [handleDesktopServerHttpsChange, pendingDesktopServerHttpsEnabled]);

  const handleRevokeDesktopPairingLink = useCallback(
    async (id: string) => {
      setRevokingDesktopPairingLinkId(id);
      setDesktopAccessManagementErrorCode(null);
      try {
        await revokeServerPairingLink(id);
      } catch (error) {
        const feedback = connectionFeedback(error, "pairing-revoke-failed");
        const message = formatConnectionFeedback(feedback, uiLocale);
        setDesktopAccessManagementErrorCode(feedback);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not revoke pairing link", undefined, undefined, uiLocale),
            description: message,
          }),
        );
      } finally {
        setRevokingDesktopPairingLinkId(null);
      }
    },
    [uiLocale],
  );

  const handleRevokeDesktopClientSession = useCallback(
    async (sessionId: ServerClientSessionRecord["sessionId"]) => {
      setRevokingDesktopClientSessionId(sessionId);
      setDesktopAccessManagementErrorCode(null);
      try {
        await revokeServerClientSession(sessionId);
      } catch (error) {
        const feedback = connectionFeedback(error, "client-revoke-failed");
        const message = formatConnectionFeedback(feedback, uiLocale);
        setDesktopAccessManagementErrorCode(feedback);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not revoke client access", undefined, undefined, uiLocale),
            description: message,
          }),
        );
      } finally {
        setRevokingDesktopClientSessionId(null);
      }
    },
    [uiLocale],
  );

  const handleRevokeOtherDesktopClients = useCallback(async () => {
    setIsRevokingOtherDesktopClients(true);
    setDesktopAccessManagementErrorCode(null);
    try {
      const revokedCount = await revokeOtherServerClientSessions();
      toastManager.add({
        type: "success",
        title:
          revokedCount === 1
            ? uiText("Revoked 1 other device", undefined, undefined, uiLocale)
            : uiText("Revoked {value0} devices", { value0: revokedCount }, undefined, uiLocale),
        description: uiText(
          "They need a new pairing link to reconnect.",
          undefined,
          undefined,
          uiLocale,
        ),
      });
    } catch (error) {
      const feedback = connectionFeedback(error, "other-clients-revoke-failed");
      const message = formatConnectionFeedback(feedback, uiLocale);
      setDesktopAccessManagementErrorCode(feedback);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText("Could not revoke other clients", undefined, undefined, uiLocale),
          description: message,
        }),
      );
    } finally {
      setIsRevokingOtherDesktopClients(false);
    }
  }, [uiLocale]);

  const handleSetAdminPassword = useCallback(
    async (password: string) => {
      setIsSavingAdminPassword(true);
      setAdminPasswordErrorCode(null);
      try {
        const result = await setServerAdminPassword(password);
        setAdminPasswordConfigured(result.configured);
        toastManager.add({
          type: "success",
          title: uiText("Admin password updated", undefined, undefined, uiLocale),
          description: uiText(
            "Password login is available from the pairing screen.",
            undefined,
            undefined,
            uiLocale,
          ),
        });
      } catch (error) {
        const feedback = connectionFeedback(error, "password-update-failed");
        const message = formatConnectionFeedback(feedback, uiLocale);
        setAdminPasswordErrorCode(feedback);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not update admin password", undefined, undefined, uiLocale),
            description: message,
          }),
        );
        throw error;
      } finally {
        setIsSavingAdminPassword(false);
      }
    },
    [uiLocale],
  );

  const handleClearAdminPassword = useCallback(async () => {
    setIsSavingAdminPassword(true);
    setAdminPasswordErrorCode(null);
    try {
      const result = await clearServerAdminPassword();
      setAdminPasswordConfigured(result.configured);
      toastManager.add({
        type: "success",
        title: uiText("Password authentication disabled", undefined, undefined, uiLocale),
        description: uiText(
          "New browser logins will need a pairing link.",
          undefined,
          undefined,
          uiLocale,
        ),
      });
    } catch (error) {
      const feedback = connectionFeedback(error, "password-disable-failed");
      const message = formatConnectionFeedback(feedback, uiLocale);
      setAdminPasswordErrorCode(feedback);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText(
            "Could not disable password authentication",
            undefined,
            undefined,
            uiLocale,
          ),
          description: message,
        }),
      );
      throw error;
    } finally {
      setIsSavingAdminPassword(false);
    }
  }, [uiLocale]);

  useEffect(() => {
    if (desktopBridge) {
      setCurrentSessionRole("owner");
      return;
    }

    let cancelled = false;
    void fetchSessionState()
      .then((session) => {
        if (cancelled) return;
        setCurrentSessionRole(session.authenticated ? (session.role ?? null) : null);
        setCurrentAuthPolicy(session.auth.policy);
      })
      .catch(() => {
        if (cancelled) return;
        setCurrentSessionRole(null);
        setCurrentAuthPolicy(null);
      });

    return () => {
      cancelled = true;
    };
  }, [desktopBridge]);

  useEffect(() => {
    if (!canManageLocalBackend) {
      setAdminPasswordConfigured(null);
      setAdminPasswordErrorCode(null);
      setIsLoadingAdminPassword(false);
      return;
    }

    let cancelled = false;
    setIsLoadingAdminPassword(true);
    setAdminPasswordErrorCode(null);
    void fetchServerAdminPasswordStatus()
      .then((status) => {
        if (cancelled) return;
        setAdminPasswordConfigured(status.configured);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setAdminPasswordConfigured(null);
        setAdminPasswordErrorCode(connectionFeedback(error, "password-load-failed"));
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoadingAdminPassword(false);
      });

    return () => {
      cancelled = true;
    };
  }, [canManageLocalBackend]);

  useEffect(() => {
    if (!canManageLocalBackend) return;

    let cancelled = false;
    setIsLoadingDesktopAccessManagement(true);
    type AuthAccessEvent = Parameters<
      Parameters<WsRpcClient["server"]["subscribeAuthAccess"]>[0]
    >[0];
    const unsubscribeAuthAccess = (
      environmentId ? readEnvironmentConnection(environmentId) : getPrimaryEnvironmentConnection()
    )?.client.server.subscribeAuthAccess(
      (event: AuthAccessEvent) => {
        if (cancelled) {
          return;
        }

        switch (event.type) {
          case "snapshot":
            setDesktopPairingLinks(
              sortDesktopPairingLinks(
                event.payload.pairingLinks.map((pairingLink: AuthPairingLink) =>
                  toDesktopPairingLinkRecord(pairingLink),
                ),
              ),
            );
            setDesktopClientSessions(
              sortDesktopClientSessions(
                event.payload.clientSessions.map((clientSession: AuthClientSession) =>
                  toDesktopClientSessionRecord(clientSession),
                ),
              ),
            );
            break;
          case "pairingLinkUpserted":
            setDesktopPairingLinks((current) =>
              upsertDesktopPairingLink(current, toDesktopPairingLinkRecord(event.payload)),
            );
            break;
          case "pairingLinkRemoved":
            setDesktopPairingLinks((current) =>
              removeDesktopPairingLink(current, event.payload.id),
            );
            break;
          case "clientUpserted":
            setDesktopClientSessions((current) =>
              upsertDesktopClientSession(current, toDesktopClientSessionRecord(event.payload)),
            );
            break;
          case "clientRemoved":
            setDesktopClientSessions((current) =>
              removeDesktopClientSession(current, event.payload.sessionId),
            );
            break;
        }

        setDesktopAccessManagementErrorCode(null);
        setIsLoadingDesktopAccessManagement(false);
      },
      {
        onResubscribe: () => {
          if (!cancelled) {
            setIsLoadingDesktopAccessManagement(true);
          }
        },
      },
    );
    if (desktopBridge) {
      void desktopBridge
        .getServerExposureState()
        .then((state) => {
          if (cancelled) return;
          setDesktopServerExposureState(state);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setDesktopServerExposureErrorCode(connectionFeedback(error, "exposure-load-failed"));
        });
    } else {
      setDesktopServerExposureState(null);
      setDesktopAdvertisedEndpoints([]);
      setDesktopServerExposureErrorCode(null);
    }

    return () => {
      cancelled = true;
      unsubscribeAuthAccess?.();
    };
  }, [canManageLocalBackend, desktopBridge]);

  useEffect(() => {
    if (!canManageLocalBackend || !desktopBridge) return;
    let cancelled = false;
    let revision = 0;
    const refreshDisplayMetadata = () => {
      const requestRevision = ++revision;
      void desktopBridge
        .getAdvertisedEndpoints()
        .then((endpoints) => {
          if (cancelled || requestRevision !== revision) return;
          setDesktopAdvertisedEndpoints(endpoints);
        })
        .catch((error: unknown) => {
          if (cancelled || requestRevision !== revision) return;
          setDesktopServerExposureErrorCode(connectionFeedback(error, "endpoints-load-failed"));
        });
    };
    // Main publishes this finite event after admitting its saved language, so
    // the read cannot race a renderer-only optimistic language update. Keep
    // authentication subscriptions, password/exposure reads and actions in
    // their existing effects; a display refresh never recreates them.
    const unsubscribe = desktopBridge.onUiLocaleChanged?.(refreshDisplayMetadata);
    refreshDisplayMetadata();
    return () => {
      cancelled = true;
      revision++;
      unsubscribe?.();
    };
  }, [canManageLocalBackend, desktopBridge]);

  useEffect(() => {
    if (canManageLocalBackend) return;
    setIsLoadingDesktopAccessManagement(false);
    setDesktopPairingLinks([]);
    setDesktopClientSessions([]);
    setDesktopAccessManagementErrorCode(null);
    setDesktopServerExposureState(null);
    setDesktopAdvertisedEndpoints([]);
    setDesktopServerExposureErrorCode(null);
  }, [canManageLocalBackend]);
  const visibleDesktopPairingLinks = useMemo(
    () => desktopPairingLinks.filter((pairingLink) => pairingLink.role === "client"),
    [desktopPairingLinks],
  );
  const visibleDesktopNetworkAdvertisedEndpoints = useMemo(
    () =>
      isLocalBackendNetworkAccessible
        ? desktopAdvertisedEndpoints.filter((endpoint) => endpoint.source === "desktop-core")
        : [],
    [desktopAdvertisedEndpoints, isLocalBackendNetworkAccessible],
  );
  const isLocalBackendRemotelyReachable = isLocalBackendNetworkAccessible;
  const defaultDesktopNetworkAdvertisedEndpoint = useMemo(
    () =>
      selectPairingEndpoint(visibleDesktopNetworkAdvertisedEndpoints, defaultAdvertisedEndpointKey),
    [defaultAdvertisedEndpointKey, visibleDesktopNetworkAdvertisedEndpoints],
  );
  const defaultDesktopAdvertisedEndpointKey = defaultDesktopNetworkAdvertisedEndpoint
    ? endpointDefaultPreferenceKey(defaultDesktopNetworkAdvertisedEndpoint)
    : null;
  const handleSetDefaultAdvertisedEndpoint = useCallback(
    (endpoint: AdvertisedEndpoint) => {
      setDefaultAdvertisedEndpointKey(endpointDefaultPreferenceKey(endpoint));
    },
    [setDefaultAdvertisedEndpointKey],
  );
  // Exposure state arrives over desktop IPC and is normally instant; only a
  // noticeable wait draws a skeleton line in place of the row descriptions.
  const showExposureSkeleton = useDelayedFlag(
    desktopBridge !== undefined &&
      canManageLocalBackend &&
      desktopServerExposureState === null &&
      desktopServerExposureErrorCode === null,
  );
  const exposureSkeleton = showExposureSkeleton ? (
    <Skeleton aria-hidden className="mt-0.5 h-3 w-40" />
  ) : null;
  const renderNetworkAccessToggle = () => (
    <Switch
      checked={desktopServerExposureState?.mode === "network-accessible"}
      disabled={!desktopServerExposureState || isUpdatingDesktopServerExposure}
      onCheckedChange={(checked) => {
        setPendingDesktopServerExposureMode(checked ? "network-accessible" : "local-only");
        setIsDesktopServerExposureDialogOpen(true);
      }}
      aria-label={uiText("Enable network access", undefined, undefined, uiLocale)}
    />
  );
  const renderHttpsToggle = () => (
    <Switch
      checked={desktopServerExposureState?.httpsEnabled ?? false}
      disabled={!desktopServerExposureState || isUpdatingDesktopServerHttps}
      onCheckedChange={(checked) => {
        setPendingDesktopServerHttpsEnabled(checked);
        setIsDesktopServerHttpsDialogOpen(true);
      }}
      aria-label={uiText("Enable HTTPS", undefined, undefined, uiLocale)}
    />
  );
  const renderEndpointRows = (presentation: AccessSectionPresentation) =>
    isAdvertisedEndpointListExpanded
      ? visibleDesktopNetworkAdvertisedEndpoints.map((endpoint) => {
          const endpointKey = endpointDefaultPreferenceKey(endpoint);
          return (
            <AdvertisedEndpointListRow
              key={endpoint.id}
              endpoint={endpoint}
              isDefault={endpointKey === defaultDesktopAdvertisedEndpointKey}
              presentation={presentation}
              onSetDefault={handleSetDefaultAdvertisedEndpoint}
            />
          );
        })
      : null;
  const desktopAccessManagementErrorText = desktopAccessManagementErrorCode
    ? formatConnectionFeedback(desktopAccessManagementErrorCode, uiLocale)
    : null;
  const desktopServerExposureErrorText = desktopServerExposureErrorCode
    ? formatConnectionFeedback(desktopServerExposureErrorCode, uiLocale)
    : null;
  const renderAuthorizedClients = (presentation: AccessSectionPresentation) => (
    <>
      {desktopAccessManagementErrorText ? (
        <div className={accessRowClassName(presentation)}>
          <p className="text-xs text-destructive-foreground">{desktopAccessManagementErrorText}</p>
        </div>
      ) : null}
      <PairingClientsList
        endpointUrl={
          isPrimary
            ? desktopServerExposureState?.endpointUrl
            : environmentId
              ? getEnvironmentHttpBaseUrl(environmentId)
              : null
        }
        endpoints={visibleDesktopNetworkAdvertisedEndpoints}
        defaultEndpointKey={defaultDesktopAdvertisedEndpointKey}
        presentation={presentation}
        isLoading={isLoadingDesktopAccessManagement}
        pairingLinks={visibleDesktopPairingLinks}
        clientSessions={desktopClientSessions}
        revokingPairingLinkId={revokingDesktopPairingLinkId}
        revokingClientSessionId={revokingDesktopClientSessionId}
        onRevokePairingLink={handleRevokeDesktopPairingLink}
        onRevokeClientSession={handleRevokeDesktopClientSession}
      />
    </>
  );
  const renderNetworkAccessRow = () => (
    <SettingsRow
      title={uiText("Network access", undefined, undefined, uiLocale)}
      description={
        isLocalBackendNetworkAccessible ? (
          <NetworkAccessDescription
            endpoint={defaultDesktopNetworkAdvertisedEndpoint}
            hiddenEndpointCount={Math.max(visibleDesktopNetworkAdvertisedEndpoints.length - 1, 0)}
            expanded={isAdvertisedEndpointListExpanded}
            onToggleExpanded={() => setIsAdvertisedEndpointListExpanded((expanded) => !expanded)}
            fallback={
              desktopServerExposureState?.endpointUrl
                ? uiText(
                    "Reachable at {url}",
                    { url: desktopServerExposureState.endpointUrl },
                    undefined,
                    uiLocale,
                  )
                : desktopServerExposureState?.advertisedHost
                  ? uiText(
                      "Reachable on your network; pairing links use {host}.",
                      {
                        host: desktopServerExposureState.advertisedHost,
                      },
                      undefined,
                      uiLocale,
                    )
                  : uiText("Reachable on your network.", undefined, undefined, uiLocale)
            }
          />
        ) : desktopServerExposureState ? null : (
          exposureSkeleton
        )
      }
      status={
        desktopServerExposureErrorText ? (
          <span className="block text-destructive-foreground">
            {desktopServerExposureErrorText}
          </span>
        ) : null
      }
      control={renderNetworkAccessToggle()}
    />
  );
  const renderHttpsRow = () => (
    <SettingsRow
      title={uiText("HTTPS", undefined, undefined, uiLocale)}
      description={
        desktopServerExposureState ? (
          desktopServerExposureState.httpsEnabled ? (
            <span className="inline-flex items-center gap-1.5">
              {/*
               * Phones reject the self-signed certificate until it is installed and
               * trusted. This downloads the public certificate (served by the backend,
               * reachable over HTTP too) so it can be imported on another device.
               */}
              <a
                href={CAFE_CODE_HTTPS_CERTIFICATE_PATH}
                download="cafe-code.crt"
                className="focus-ring inline-flex items-center gap-1 rounded-sm font-medium text-primary hover:underline"
              >
                <DownloadIcon className="size-3.5" />
                {uiText("Download certificate", undefined, undefined, uiLocale)}
              </a>
              <InfoTip label={uiText("About the certificate", undefined, undefined, uiLocale)}>
                {uiText(
                  "Other devices must install and trust this certificate before they can open the WebUI over HTTPS.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
              </InfoTip>
            </span>
          ) : null
        ) : (
          exposureSkeleton
        )
      }
      control={renderHttpsToggle()}
    />
  );
  const renderDisabledNetworkAccessRow = () => (
    <SettingsRow
      title={uiText("Network access", undefined, undefined, uiLocale)}
      description={
        currentAuthPolicy === "remote-reachable"
          ? uiText("Change this where the server is started.", undefined, undefined, uiLocale)
          : uiText(
              "Restart the server so other devices on your network can reach it.",
              undefined,
              undefined,
              uiLocale,
            )
      }
      control={
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex">
                <Switch
                  checked={isLocalBackendNetworkAccessible}
                  disabled
                  aria-label={uiText("Enable network access", undefined, undefined, uiLocale)}
                />
              </span>
            }
          />
          <TooltipPopup side="top">
            {uiText("Set where the server is started.", undefined, undefined, uiLocale)}
          </TooltipPopup>
        </Tooltip>
      }
    />
  );

  return (
    <SettingsPageContainer
      title={uiText("Connections & remote access", undefined, undefined, uiLocale)}
    >
      <SavedEnvironmentsSettings />
      {canManageLocalBackend ? (
        <>
          <SettingsSection
            title={
              isPrimary
                ? uiText("Local server", undefined, undefined, uiLocale)
                : uiText("Selected server", undefined, undefined, uiLocale)
            }
          >
            {primaryVersionMismatch ? (
              <SettingsRow
                title={uiText("Version drift", undefined, undefined, uiLocale)}
                description={
                  <span className="flex items-center gap-1 text-warning-foreground">
                    <UiMessage
                      message={
                        "<slot1></slot1>Client <slot3></slot3> and server<slot5></slot5><slot7></slot7> differ; update both if connections fail."
                      }
                      slots={{
                        slot1: <TriangleAlertIcon className="size-3.5 shrink-0" />,
                        slot3: primaryVersionMismatch.clientVersion,
                        slot5: " ",
                        slot7: primaryVersionMismatch.serverVersion,
                      }}
                    />
                  </span>
                }
              />
            ) : null}
            {desktopBridge ? (
              <>
                {renderNetworkAccessRow()}
                {renderEndpointRows("endpoint-rail")}
                {renderHttpsRow()}
              </>
            ) : (
              renderDisabledNetworkAccessRow()
            )}
            <AdminPasswordManagementRow
              configured={adminPasswordConfigured}
              isLoading={isLoadingAdminPassword}
              isSaving={isSavingAdminPassword}
              error={
                adminPasswordErrorCode
                  ? formatConnectionFeedback(adminPasswordErrorCode, uiLocale)
                  : null
              }
              onSetPassword={handleSetAdminPassword}
              onClearPassword={handleClearAdminPassword}
            />
            <TwoFactorManagementRow
              key={environmentId ?? "primary"}
              environmentId={environmentId}
            />
          </SettingsSection>

          {isLocalBackendRemotelyReachable ? (
            <SettingsSection
              title={uiText("Paired devices", undefined, undefined, uiLocale)}
              headerAction={
                <AuthorizedClientsHeaderAction
                  createPairingCredential={createServerPairingCredential}
                  clientSessions={desktopClientSessions}
                  isRevokingOtherClients={isRevokingOtherDesktopClients}
                  onRevokeOtherClients={handleRevokeOtherDesktopClients}
                />
              }
            >
              {renderAuthorizedClients("current")}
            </SettingsSection>
          ) : null}
          <AlertDialog
            open={isDesktopServerExposureDialogOpen}
            onOpenChange={(open) => {
              if (isUpdatingDesktopServerExposure) return;
              setIsDesktopServerExposureDialogOpen(open);
            }}
            onOpenChangeComplete={(open) => {
              if (!open) setPendingDesktopServerExposureMode(null);
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingDesktopServerExposureMode === "network-accessible"
                    ? uiText("Enable network access?", undefined, undefined, uiLocale)
                    : uiText("Disable network access?", undefined, undefined, uiLocale)}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingDesktopServerExposureMode === "network-accessible"
                    ? uiText(
                        "Cafe Code will restart to expose this environment over the network.",
                        undefined,
                        undefined,
                        uiLocale,
                      )
                    : uiText(
                        "Cafe Code will restart and limit this environment back to this machine.",
                        undefined,
                        undefined,
                        uiLocale,
                      )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingDesktopServerExposure}
                  render={<Button variant="outline" disabled={isUpdatingDesktopServerExposure} />}
                >
                  {uiText("Cancel", undefined, undefined, uiLocale)}
                </AlertDialogClose>
                <Button
                  variant={
                    pendingDesktopServerExposureMode === "local-only" ? "destructive" : "default"
                  }
                  onClick={handleConfirmDesktopServerExposureChange}
                  disabled={
                    pendingDesktopServerExposureMode === null || isUpdatingDesktopServerExposure
                  }
                >
                  <RestartButtonLabel restarting={isUpdatingDesktopServerExposure}>
                    {pendingDesktopServerExposureMode === "network-accessible"
                      ? uiText("Restart and enable", undefined, undefined, uiLocale)
                      : uiText("Restart and disable", undefined, undefined, uiLocale)}
                  </RestartButtonLabel>
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
          <AlertDialog
            open={isDesktopServerHttpsDialogOpen}
            onOpenChange={(open) => {
              if (isUpdatingDesktopServerHttps) return;
              setIsDesktopServerHttpsDialogOpen(open);
            }}
            onOpenChangeComplete={(open) => {
              if (!open) setPendingDesktopServerHttpsEnabled(null);
            }}
          >
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {pendingDesktopServerHttpsEnabled
                    ? uiText("Enable HTTPS?", undefined, undefined, uiLocale)
                    : uiText("Disable HTTPS?", undefined, undefined, uiLocale)}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {uiText("Cafe Code will restart to apply this.", undefined, undefined, uiLocale)}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose
                  disabled={isUpdatingDesktopServerHttps}
                  render={<Button variant="outline" disabled={isUpdatingDesktopServerHttps} />}
                >
                  {uiText("Cancel", undefined, undefined, uiLocale)}
                </AlertDialogClose>
                <Button
                  variant={pendingDesktopServerHttpsEnabled === false ? "destructive" : "default"}
                  onClick={handleConfirmDesktopServerHttpsChange}
                  disabled={
                    pendingDesktopServerHttpsEnabled === null || isUpdatingDesktopServerHttps
                  }
                >
                  <RestartButtonLabel restarting={isUpdatingDesktopServerHttps}>
                    {pendingDesktopServerHttpsEnabled
                      ? uiText("Restart and enable", undefined, undefined, uiLocale)
                      : uiText("Restart and disable", undefined, undefined, uiLocale)}
                  </RestartButtonLabel>
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">
          {uiText(
            "Only the owner can manage pairing and paired devices.",
            undefined,
            undefined,
            uiLocale,
          )}
        </p>
      )}
    </SettingsPageContainer>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = {
  clientDeviceTypeLabel,
  formatElapsedDurationLabel,
  formatExpiresInLabel,
  resolveServerConfigVersionMismatch,
};
