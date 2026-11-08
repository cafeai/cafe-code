import { useEffect, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import { uiText } from "@cafecode/shared/i18n";
import { Id16, Id32 } from "@cafecode/relay/protocol";
import { fetchAppResource } from "../../environments/relay/active";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Textarea } from "../ui/textarea";

const Status = Schema.Struct({
  enabled: Schema.Boolean,
  networks: Schema.Array(Schema.Struct({ networkId: Id32, serving: Schema.Number })),
});
const Invitation = Schema.Struct({
  id: Id16,
  url: Schema.String.check(Schema.isMaxLength(2304)),
  expiresAt: Schema.Number,
});
export function RelayConnectionsSettings() {
  const [status, setStatus] = useState<typeof Status.Type | undefined>(undefined),
    [busy, setBusy] = useState(false),
    [link, setLink] = useState<string | undefined>(undefined),
    [error, setError] = useState(false);
  const [grantOwner, setGrantOwner] = useState(false);
  const owner = useRef<AbortController | undefined>(undefined);
  const invitationId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    return () => {
      owner.current = undefined;
      controller.abort();
    };
  }, []);
  const manage = async () => {
    const controller = owner.current;
    if (!controller || busy) return;
    setBusy(true);
    setError(false);
    try {
      const response = await fetchAppResource(resolvePrimaryEnvironmentHttpUrl("/api/relay"), {
        credentials: "include",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("unavailable");
      const value = Schema.decodeUnknownSync(Status)(await response.json());
      if (owner.current === controller && !controller.signal.aborted) setStatus(value);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const invite = async (networkId: string) => {
    const controller = owner.current;
    if (!controller || busy) return;
    setBusy(true);
    setError(false);
    setLink(undefined);
    try {
      const response = await fetchAppResource(
        resolvePrimaryEnvironmentHttpUrl("/api/relay/invitations"),
        {
          method: "POST",
          credentials: "include",
          redirect: "error",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ networkId, role: grantOwner ? "owner" : "client" }),
        },
      );
      if (!response.ok) throw new Error("unavailable");
      const value = Schema.decodeUnknownSync(Invitation)(await response.json());
      if (owner.current === controller && !controller.signal.aborted) {
        invitationId.current = value.id;
        setLink(value.url);
      }
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const revoke = async () => {
    const controller = owner.current,
      id = invitationId.current;
    if (!controller || !id || busy) return;
    setBusy(true);
    setError(false);
    try {
      const response = await fetchAppResource(
        resolvePrimaryEnvironmentHttpUrl("/api/relay/invitations/revoke"),
        {
          method: "POST",
          credentials: "include",
          redirect: "error",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        },
      );
      if (!response.ok) throw new Error("unavailable");
      if (owner.current === controller && !controller.signal.aborted) {
        invitationId.current = undefined;
        setLink(undefined);
      }
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <SettingsSection title={uiText("Relay access")} searchId="connections.relay">
      <p className="text-sm text-muted-foreground">
        {uiText("Connect another device without setting up a tunnel.")}
      </p>
      <Button variant="outline" disabled={busy} onClick={() => void manage()}>
        {uiText("Manage relays")}
      </Button>
      {status && !status.enabled ? (
        <p className="text-sm">{uiText("Relay access is not configured for this Cafe host.")}</p>
      ) : null}
      {status?.enabled ? (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={grantOwner} onCheckedChange={setGrantOwner} />
          {uiText("Grant owner access to this device")}
        </label>
      ) : null}
      {status?.networks.map((network) => (
        <div key={network.networkId} className="flex items-center gap-3">
          <span className="text-sm">
            {network.serving > 0 ? uiText("Relay connected") : uiText("Relay unavailable")}
          </span>
          <Button
            variant="outline"
            disabled={busy || network.serving === 0}
            onClick={() => void invite(network.networkId)}
          >
            {uiText("Create relay invitation")}
          </Button>
        </div>
      ))}
      {link ? (
        <div className="space-y-2">
          <Textarea
            aria-label={uiText("Relay invitation link")}
            readOnly
            value={link}
            className="w-full text-xs"
          />
          <p className="text-sm text-muted-foreground">
            {uiText(
              "Share this private one-use link with the other device. It expires within five minutes.",
            )}
          </p>
          <Button variant="outline" disabled={busy} onClick={() => void revoke()}>
            {uiText("Revoke invitation")}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="status" className="text-sm">
          {uiText(
            "Relay access could not be loaded. Owner access and a connected relay are required.",
          )}
        </p>
      ) : null}
    </SettingsSection>
  );
}
