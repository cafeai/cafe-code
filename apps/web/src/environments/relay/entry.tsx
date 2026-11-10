import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../../components/ui/select";
import { useEffect, useRef, useState } from "react";
import { uiText } from "@cafecode/shared/i18n";
import { parseInvitationUrl, type RelayInvitation } from "@cafecode/relay/invitation";
import { concatenate, utf8, opaque, unopaque } from "@cafecode/relay/bytes";
import { createIdentity, sha256 } from "@cafecode/relay/crypto";
import { connectBrowser } from "@cafecode/relay/browserWire";
import { connectViewer } from "@cafecode/relay/client";
import { discoverNetwork } from "@cafecode/relay/discovery";
import { epochNow, Lifetime } from "@cafecode/relay/lifetime";
import { RelayError } from "@cafecode/relay/errors";
import { ActiveRelay, installPrimaryRelay, savedTransportTickets } from "./active";
import { listRelayTargetIds, loadRelayTarget, saveRelayTarget } from "./storage";
import { takeRelayIntent } from "./intent";

type Intent =
  | { readonly invitation: RelayInvitation }
  | { readonly savedId: string }
  | { readonly choose: true }
  | { readonly invalid: true };
function readInitialIntent(): Intent | undefined {
  const captured = takeRelayIntent();
  if (captured && "href" in captured) {
    try {
      return {
        invitation: parseInvitationUrl(
          captured.href,
          new Set([window.location.origin]),
          epochNow(),
        ),
      };
    } catch {
      return { invalid: true };
    }
  }
  return captured;
}
let initial = readInitialIntent();

export function RelayEntry({ ready }: { readonly ready: () => void }) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(() =>
      initial && "invalid" in initial
        ? uiText(
            "This pairing link is invalid or expired. Create a new invitation in Cafe on your computer.",
          )
        : "",
    ),
    [secondFactor, setSecondFactor] = useState("");
  const [savedIds, setSavedIds] = useState<readonly string[]>([]),
    [selectedId, setSelectedId] = useState("");
  const [choosing] = useState(() => initial !== undefined && "choose" in initial);
  const [savedState, setSavedState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [needsInvitation, setNeedsInvitation] = useState(
    () => initial === undefined || "invalid" in initial,
  );
  const [pairing] = useState(() => initial !== undefined && "invitation" in initial);
  const owner = useRef<Lifetime | undefined>(undefined);
  const connection = useRef<Awaited<ReturnType<typeof connectViewer>> | undefined>(undefined);
  const complete = useRef(false);
  const intent = useRef(initial);
  useEffect(() => {
    const lifetime = new Lifetime();
    owner.current = lifetime;
    const pending = intent.current;
    if (pending && "invitation" in pending)
      lifetime.later(Math.max(1, pending.invitation.expiresAt - epochNow()), () => {
        if (!complete.current) {
          intent.current = undefined;
          initial = undefined;
          void connection.current?.close();
          setNeedsInvitation(true);
          setSecondFactor("");
          setMessage(
            uiText(
              "This invitation has expired. Create a new pairing link in Cafe on your computer.",
            ),
          );
        }
      });
    if (intent.current && "choose" in intent.current)
      void listRelayTargetIds()
        .then((ids) => {
          if (lifetime.active) {
            setSavedIds(ids);
            setSelectedId(ids[0] ?? "");
            setSavedState("ready");
          }
        })
        .catch(() => {
          if (lifetime.active) {
            setSavedState("unavailable");
            setMessage(
              uiText(
                "Saved connections could not be read. Open a new pairing link from Cafe on your computer.",
              ),
            );
          }
        });
    return () => {
      if (owner.current === lifetime) owner.current = undefined;
      if (!complete.current) {
        lifetime.retire();
        void connection.current?.close();
      }
    };
  }, []);
  const connect = async () => {
    const lifetime = owner.current;
    if (!lifetime?.active || busy) return;
    const submittedSecondFactor = secondFactor;
    setSecondFactor("");
    setBusy(true);
    setMessage("");
    try {
      const current =
        intent.current && "choose" in intent.current ? { savedId: selectedId } : intent.current;
      if (!current || "invalid" in current) throw new RelayError("AUTH_REQUIRED");
      if ("savedId" in current) {
        const saved = await loadRelayTarget(current.savedId).catch(() => {
          if (lifetime.active) setNeedsInvitation(true);
          throw new RelayError("AUTH_REQUIRED");
        });
        if (!lifetime.active) return;
        const active = new ActiveRelay(saved.target, saved.identity);
        try {
          await active.session();
          if (!lifetime.active) throw new RelayError("UNAVAILABLE");
          sessionStorage.setItem("cafe-relay-active", current.savedId);
          await installPrimaryRelay(active);
        } catch (error) {
          await active.close();
          throw error;
        }
      } else {
        const invitation = current.invitation;
        let identity = pairIdentity.current;
        if (!identity) {
          identity = await createIdentity();
          pairIdentity.current = identity;
        }
        if (!connection.current?.session.active) {
          const network = await discoverNetwork({
            bootstrapUrls: invitation.bootstrapUrls,
            rootPublicKey: invitation.networkRootPublicKey,
            minimumRevision: invitation.minimumRevision,
            lifetime,
          });
          const admission = await createIdentity();
          connection.current = await connectViewer({
            lifetime,
            target: {
              network,
              hostPublicKey: invitation.hostPublicKey,
              environmentId: invitation.environmentId,
              locator: invitation.locator,
              preferredNodeId: invitation.nodeId,
              deviceIdentity: identity,
              tickets: [
                {
                  nodeId: invitation.nodeId,
                  registrationId: invitation.registrationId,
                  token: invitation.inviteTicket,
                  expiresAt: invitation.expiresAt,
                  admissionIdentity: admission,
                },
              ],
              paired: false,
            },
            dial: (node, resources) => connectBrowser(node.url, resources),
          });
          pairNetwork.current = network;
        }
        const held = connection.current,
          network = pairNetwork.current;
        if (!held || !network) throw new RelayError("UNAVAILABLE");
        const auth = await held.session.authenticate({
          environmentId: invitation.environmentId,
          operation: "pair",
          credential: invitation.pairingSecret,
          ...(submittedSecondFactor ? { secondFactor: submittedSecondFactor } : {}),
        });
        if (!lifetime.active) throw new RelayError("UNAVAILABLE");
        const id = opaque(
          sha256(
            concatenate(
              utf8.encode("CafeCode/relay/browser-target/v1\0"),
              unopaque(invitation.networkId, 32),
              unopaque(invitation.hostPublicKey, 32),
            ),
          ),
        );
        const target = {
          id,
          networkId: invitation.networkId,
          rootPublicKey: invitation.networkRootPublicKey,
          bootstrapUrls: invitation.bootstrapUrls,
          minimumRevision: network.revision,
          hostPublicKey: invitation.hostPublicKey,
          environmentId: invitation.environmentId,
          locator: invitation.locator,
          preferredNodeId: held.nodeId,
          bearerToken: auth.bearerToken,
          tickets: savedTransportTickets(held),
        };
        try {
          await saveRelayTarget(target, identity, lifetime.signal);
          sessionStorage.setItem("cafe-relay-active", id);
        } catch {
          await held.close();
          throw new RelayError("AUTH_INDETERMINATE");
        }
        if (!lifetime.active) throw new RelayError("UNAVAILABLE");
        await installPrimaryRelay(new ActiveRelay(target, identity, held, lifetime));
      }
      if (!lifetime.active) return;
      complete.current = true;
      intent.current = undefined;
      initial = undefined;
      setSecondFactor("");
      window.history.replaceState(null, "", "/");
      ready();
    } catch (error) {
      if (!lifetime.active) return;
      if (error instanceof RelayError && error.code === "SECOND_FACTOR_REQUIRED")
        setMessage(uiText("Enter an authenticator code or recovery code, then connect again."));
      else if (error instanceof RelayError && error.code === "AUTH_INDETERMINATE") {
        intent.current = undefined;
        initial = undefined;
        void connection.current?.close();
        connection.current = undefined;
        setNeedsInvitation(true);
        setMessage(
          uiText(
            "The sign-in response was lost. Ask the host for a new invitation; this credential will not be retried automatically.",
          ),
        );
      } else if (error instanceof RelayError && error.code === "AUTH_REQUIRED")
        setMessage(
          uiText(
            "This browser session cannot reconnect. Create a fresh invitation in Cafe on your computer.",
          ),
        );
      else
        setMessage(
          uiText(
            "The relay connection could not be completed. Check connectivity or ask the host for a fresh invitation.",
          ),
        );
    } finally {
      if (lifetime.active) setBusy(false);
    }
  };
  const pairIdentity = useRef<Awaited<ReturnType<typeof createIdentity>> | undefined>(undefined);
  const pairNetwork = useRef<Awaited<ReturnType<typeof discoverNetwork>> | undefined>(undefined);
  const checkingSaved = choosing && savedState === "loading";
  const showSetup = needsInvitation || (choosing && !checkingSaved && savedIds.length === 0);
  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-lg flex-col justify-center gap-6 p-6 sm:p-8">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-muted-foreground">{uiText("Relay preview")}</p>
          <h1 className="text-2xl font-semibold">
            {showSetup
              ? uiText("Start in Cafe on your computer")
              : pairing
                ? uiText("Pair this browser with Cafe")
                : uiText("Reconnect to your Cafe computer")}
          </h1>
          <p className="text-muted-foreground">
            {showSetup
              ? uiText(
                  "You need a pairing link from the computer running Cafe. There is no code to enter on this page yet.",
                )
              : pairing
                ? uiText(
                    "Your invitation is ready. Connect to open Cafe from the computer that sent you this link.",
                  )
                : uiText("Reconnect using the connection saved in this browser tab.")}
          </p>
        </div>
        {checkingSaved ? (
          <p role="status">{uiText("Checking this browser for paired computers…")}</p>
        ) : null}
        {showSetup ? (
          <>
            <ol className="list-decimal space-y-3 pl-5">
              <li>{uiText("Open a relay-enabled Cafe build on your computer.")}</li>
              <li>
                {uiText(
                  "Go to Settings → Connections → Manage relays and create a pairing invitation.",
                )}
              </li>
              <li>
                {uiText(
                  "Open the complete invitation link in this browser. It expires after five minutes.",
                )}
              </li>
            </ol>
            <div className="rounded-xl border bg-muted/30 p-4">
              <h2 className="mb-2 font-medium">{uiText("Don't see Manage relays?")}</h2>
              <p className="text-sm text-muted-foreground">
                {uiText(
                  "Your Cafe build needs relay support, and the computer must be enrolled in a relay network. If that setup is missing, this browser page cannot connect yet.",
                )}
              </p>
            </div>
          </>
        ) : !checkingSaved ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            {choosing ? (
              <label className="flex flex-col gap-2">
                {uiText("Paired computer")}
                <Select
                  value={selectedId}
                  onValueChange={(value) => setSelectedId(value ?? "")}
                  disabled={busy}
                  items={savedIds.map((id) => ({ value: id, label: id.slice(0, 12) }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {savedIds.map((id) => (
                      <SelectItem key={id} value={id}>
                        {id.slice(0, 12)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ) : null}
            {pairing ? (
              <label className="flex flex-col gap-2">
                {uiText("Two-factor code, only if enabled in Cafe")}
                <Input
                  value={secondFactor}
                  onChange={(event) => setSecondFactor(event.target.value)}
                  autoComplete="one-time-code"
                  maxLength={128}
                  disabled={busy}
                  aria-describedby="relay-two-factor-help"
                />
                <span id="relay-two-factor-help" className="text-sm text-muted-foreground">
                  {uiText(
                    "Use your authenticator app or a Cafe recovery code. This is separate from the pairing link.",
                  )}
                </span>
              </label>
            ) : null}
            <Button type="submit" disabled={busy || (choosing && !selectedId)} className="w-full">
              {busy ? uiText("Connecting…") : uiText("Connect")}
            </Button>
          </form>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
        <details className="border-t pt-4 text-sm text-muted-foreground">
          <summary className="cursor-pointer">{uiText("How this connection is protected")}</summary>
          <p className="mt-3">
            {uiText(
              "Your trusted Cafe host authenticates this device. Relays carry encrypted traffic and can observe connection addresses, timing and volume.",
            )}
          </p>
        </details>
      </div>
    </main>
  );
}
