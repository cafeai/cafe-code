import { useEffect, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import { RelayNetworkSettings } from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import { CAFE_RELAY_NETWORK } from "@cafecode/relay/cafeNetwork";
import { Id16, Id32 } from "@cafecode/relay/protocol";
import { fetchAppResource } from "../../environments/relay/active";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { readPrimaryEnvironmentDescriptor } from "../../environments/primary";
import {
  getSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken,
} from "../../environments/runtime/catalog";
import { useWorkspaceEnvironmentId } from "../../environments/workspace";
import { copyTextToClipboard } from "../../lib/copyToClipboard";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Input } from "../ui/input";

const Status = Schema.Struct({
  enabled: Schema.Boolean,
  phase: Schema.optionalKey(Schema.String),
  networkSettings: Schema.optionalKey(Schema.Array(RelayNetworkSettings)),
  networks: Schema.Array(Schema.Struct({ networkId: Id32, serving: Schema.Number })),
});
const Invitation = Schema.Struct({
  id: Id16,
  url: Schema.String.check(Schema.isMaxLength(2304)),
  expiresAt: Schema.Number,
});
const Networks = Schema.Array(RelayNetworkSettings).check(Schema.isMaxLength(4));
export type RelaySettingsRequest = (path: string, init: RequestInit) => Promise<unknown>;

export function RelayConnectionsSettings({
  request,
}: { readonly request?: RelaySettingsRequest } = {}) {
  const environmentId = useWorkspaceEnvironmentId();
  const [status, setStatus] = useState<typeof Status.Type>();
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string>();
  const [error, setError] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const copyAttempt = useRef<object | undefined>(undefined);
  const [grantOwner, setGrantOwner] = useState(false);
  const [networksText, setNetworksText] = useState("");
  const networkEdited = useRef(false);
  const invitationId = useRef<string | undefined>(undefined);
  const owner = useRef<
    { controller: AbortController; revision: number; request: RelaySettingsRequest } | undefined
  >(undefined);

  useEffect(() => {
    const controller = new AbortController();
    const send: RelaySettingsRequest =
      request ??
      (async (path, init) => {
        const isRemote =
          environmentId && environmentId !== readPrimaryEnvironmentDescriptor()?.environmentId;
        const remote = isRemote ? getSavedEnvironmentRecord(environmentId) : null;
        if (isRemote && !remote) throw Error("relay-management-unavailable");
        const bearer = remote ? await readSavedEnvironmentBearerToken(remote.environmentId) : null;
        if (remote && !bearer) throw Error("relay-management-unavailable");
        const response = await fetchAppResource(
          remote ? new URL(path, remote.httpBaseUrl).href : resolvePrimaryEnvironmentHttpUrl(path),
          {
            ...init,
            credentials: remote ? "omit" : "include",
            redirect: "error",
            signal: controller.signal,
            headers: {
              "content-type": "application/json",
              ...(bearer ? { authorization: "Bearer " + bearer } : {}),
            },
          },
        );
        if (!response.ok) throw Error("relay-management-unavailable");
        return response.status === 204 ? {} : response.json();
      });
    const held = { controller, revision: 0, request: send };
    owner.current = held;
    invitationId.current = undefined;
    networkEdited.current = false;
    setStatus(undefined);
    setLink(undefined);
    setError(false);
    copyAttempt.current = undefined;
    setCopyStatus(null);
    setBusy(false);
    let polling = false;
    const refresh = async () => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      const revision = held.revision;
      try {
        const value = Schema.decodeUnknownSync(Status)(await send("/api/relay", {}));
        if (owner.current !== held || held.revision !== revision || controller.signal.aborted)
          return;
        setStatus(value);
        if (!networkEdited.current)
          setNetworksText(
            value.networkSettings?.length ? JSON.stringify(value.networkSettings, null, 2) : "",
          );
      } catch {
        if (owner.current === held && held.revision === revision && !controller.signal.aborted)
          setError(true);
      } finally {
        polling = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    return () => {
      clearInterval(timer);
      controller.abort();
      if (owner.current === held) owner.current = undefined;
    };
  }, [environmentId, request]);

  const mutate = async (path: string, body: unknown, action: "status" | "invite" | "revoke") => {
    const held = owner.current;
    if (!held || busy) return;
    const revision = ++held.revision;
    copyAttempt.current = undefined;
    setCopyStatus(null);
    setBusy(true);
    setError(false);
    if (action === "status") {
      setLink(undefined);
      invitationId.current = undefined;
    }
    try {
      const result = await held.request(path, { method: "POST", body: JSON.stringify(body) });
      if (owner.current !== held || held.controller.signal.aborted || held.revision !== revision)
        return;
      if (action === "invite") {
        const invitation = Schema.decodeUnknownSync(Invitation)(result);
        invitationId.current = invitation.id;
        setLink(invitation.url);
      } else if (action === "revoke") {
        invitationId.current = undefined;
        setLink(undefined);
      } else setStatus(Schema.decodeUnknownSync(Status)(result));
    } catch {
      if (owner.current === held && !held.controller.signal.aborted) setError(true);
    } finally {
      if (owner.current === held && !held.controller.signal.aborted && held.revision === revision)
        setBusy(false);
    }
  };
  const copyInvitation = async () => {
    const held = owner.current;
    const id = invitationId.current;
    if (!held || held.controller.signal.aborted || busy || !id || !link) return;
    const attempt = {};
    copyAttempt.current = attempt;
    const revision = held.revision;
    const isCurrent = () =>
      owner.current === held &&
      !held.controller.signal.aborted &&
      held.revision === revision &&
      invitationId.current === id &&
      copyAttempt.current === attempt;
    setCopyStatus(null);
    try {
      await copyTextToClipboard(link);
      if (isCurrent()) setCopyStatus("copied");
    } catch {
      if (isCurrent()) setCopyStatus("failed");
    }
  };
  const connected =
    status?.enabled === true && status.networks.some((network) => network.serving > 0);
  const phase = !status?.enabled
    ? uiText("Off")
    : connected
      ? uiText("Connected")
      : status.phase === "unavailable" || status.phase === "reconnecting"
        ? uiText("Reconnecting")
        : uiText("Connecting");
  return (
    <SettingsSection title={uiText("Relay access")} searchId="connections.relay">
      <SettingsRow
        title={uiText("Relay")}
        description={uiText("Let paired devices reach this Cafe environment without a tunnel.")}
        status={status ? phase : undefined}
        control={
          <Switch
            aria-label={uiText("Relay")}
            checked={status?.enabled ?? false}
            disabled={!status || busy}
            onCheckedChange={(enabled) => void mutate("/api/relay", { enabled }, "status")}
          />
        }
      />
      {status?.enabled ? (
        <div className="space-y-3 border-t border-border-subtle px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {connected
                ? uiText("Ready for a relay connection from another device.")
                : uiText("Cafe will keep trying to connect automatically.")}
            </p>
            <Button
              variant="outline"
              disabled={busy || !connected}
              onClick={() =>
                void mutate(
                  "/api/relay/invitations",
                  {
                    networkId: status.networks.find((network) => network.serving > 0)!.networkId,
                    role: grantOwner ? "owner" : "client",
                  },
                  "invite",
                )
              }
            >
              {uiText("Create relay invitation")}
            </Button>
          </div>
          {link ? (
            <div className="space-y-2">
              <Input
                aria-label={uiText("Relay invitation link")}
                readOnly
                value={link}
                className="w-full text-xs"
              />
              <p className="text-xs text-muted-foreground">
                {uiText(
                  "On the other device, add a saved environment and choose Relay host. This private one-use link expires within five minutes.",
                )}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" disabled={busy} onClick={() => void copyInvitation()}>
                  {copyStatus === "copied" ? uiText("Copied") : uiText("Copy invitation")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      "/api/relay/invitations/revoke",
                      { id: invitationId.current },
                      "revoke",
                    )
                  }
                >
                  {uiText("Revoke invitation")}
                </Button>
              </div>
              {copyStatus === "failed" ? (
                <p role="status" className="text-xs text-destructive-foreground">
                  {uiText(
                    "Could not copy the relay invitation. Select the link and copy it manually.",
                  )}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <details className="group border-t border-border-subtle px-4 py-3 sm:px-5">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
          {uiText("Advanced relay settings")}
        </summary>
        <div className="space-y-4 pt-4">
          <p className="text-xs text-muted-foreground">
            {uiText(
              "Cafe relays are configured automatically. Use a custom network only when you trust its operator.",
            )}
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {CAFE_RELAY_NETWORK.bootstrapUrls.map((url) => (
              <li key={url}>{new URL(url).hostname}</li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={grantOwner} onCheckedChange={setGrantOwner} />
            {uiText("Grant owner access to this device")}
          </label>
          <label className="block space-y-2 text-sm">
            <span>{uiText("Custom relay networks")}</span>
            <Textarea
              aria-label={uiText("Custom relay networks")}
              value={networksText}
              onChange={(event) => {
                networkEdited.current = true;
                setNetworksText(event.target.value);
              }}
              className="min-h-32 font-mono text-xs"
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {uiText(
              "Paste a public network configuration, or leave empty to use Cafe relays. Host keys and invitations do not belong here.",
            )}
          </p>
          <Button
            variant="outline"
            disabled={busy || !status}
            onClick={() => {
              try {
                const networks = Schema.decodeUnknownSync(Networks)(
                  networksText.trim() ? JSON.parse(networksText) : [],
                );
                void mutate("/api/relay/networks", { networks }, "status");
              } catch {
                setError(true);
              }
            }}
          >
            {uiText("Save relay network")}
          </Button>
        </div>
      </details>
      {error ? (
        <p
          role="status"
          className="border-t border-border-subtle px-4 py-3 text-sm text-destructive-foreground sm:px-5"
        >
          {uiText(
            "Relay settings could not be updated. Owner access and a reachable Cafe server are required.",
          )}
        </p>
      ) : null}
    </SettingsSection>
  );
}
