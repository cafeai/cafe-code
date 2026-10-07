import type { AuthSessionState } from "@cafecode/contracts";
import React, { startTransition, useEffect, useRef, useState, useCallback } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import {
  peekPairingTokenFromUrl,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
  submitServerPasswordCredential,
} from "../../environments/primary";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SegmentedControl } from "../ui/segmented-control";
import { Spinner } from "../ui/spinner";

export function PairingPendingSurface() {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      {/* A quiet accent glow; the user's accent colour, never a fixed hue. */}
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--primary)_12%,transparent),transparent)]" />
      </div>

      <section className="relative w-full max-w-xl animate-enter-rise rounded-2xl border border-border bg-card p-6 shadow-lg/5 sm:p-8">
        <p className="label-overline">{APP_DISPLAY_NAME}</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Pairing with this environment
        </h1>
        <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" className="size-3.5" />
          Checking the pairing link…
        </p>
      </section>
    </div>
  );
}

export function PairingRouteSurface({
  auth,
  initialErrorMessage,
  onAuthenticated,
}: {
  auth: AuthSessionState["auth"];
  initialErrorMessage?: string;
  onAuthenticated: () => void;
}) {
  const autoPairTokenRef = useRef<string | null>(peekPairingTokenFromUrl());
  const supportsPassword = auth.bootstrapMethods.includes("password");
  const supportsPairingToken = auth.bootstrapMethods.includes("one-time-token");
  const [credential, setCredential] = useState(() => autoPairTokenRef.current ?? "");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"password" | "pairing-token">(() =>
    supportsPassword && !autoPairTokenRef.current ? "password" : "pairing-token",
  );
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const autoSubmitAttemptedRef = useRef(false);

  const submitCredential = useCallback(
    async (nextCredential: string) => {
      setIsSubmitting(true);
      setErrorMessage("");

      const submitError = await submitServerAuthCredential(nextCredential).then(
        () => null,
        (error) => errorMessageFromUnknown(error),
      );

      setIsSubmitting(false);

      if (submitError) {
        setErrorMessage(submitError);
        return;
      }

      startTransition(() => {
        onAuthenticated();
      });
    },
    [onAuthenticated],
  );

  const submitPassword = useCallback(
    async (nextPassword: string) => {
      setIsSubmitting(true);
      setErrorMessage("");

      const submitError = await submitServerPasswordCredential({ password: nextPassword }).then(
        () => null,
        (error) => errorMessageFromUnknown(error),
      );

      setIsSubmitting(false);

      if (submitError) {
        setErrorMessage(submitError);
        return;
      }

      startTransition(() => {
        onAuthenticated();
      });
    },
    [onAuthenticated],
  );

  const handleSubmit = useCallback(
    async (event?: React.SubmitEvent<HTMLFormElement>) => {
      event?.preventDefault();
      if (authMode === "password") {
        await submitPassword(password);
        return;
      }
      await submitCredential(credential);
    },
    [authMode, submitCredential, credential, submitPassword, password],
  );

  useEffect(() => {
    const token = autoPairTokenRef.current;
    if (!token || autoSubmitAttemptedRef.current) {
      return;
    }

    autoSubmitAttemptedRef.current = true;
    stripPairingTokenFromUrl();
    void submitCredential(token);
  }, [submitCredential]);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      {/* A quiet accent glow; the user's accent colour, never a fixed hue. */}
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--primary)_12%,transparent),transparent)]" />
      </div>

      <section className="relative w-full max-w-xl animate-enter-rise rounded-2xl border border-border bg-card p-6 shadow-lg/5 sm:p-8">
        <p className="label-overline">{APP_DISPLAY_NAME}</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Pair with this environment
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {describeAuthGate(auth.bootstrapMethods)}
        </p>

        <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          {supportsPassword && supportsPairingToken ? (
            <SegmentedControl
              aria-label="Sign-in method"
              value={authMode}
              onValueChange={setAuthMode}
              options={[
                { value: "password", label: "Password", disabled: isSubmitting },
                { value: "pairing-token", label: "Pairing token", disabled: isSubmitting },
              ]}
            />
          ) : null}

          {authMode === "password" && supportsPassword ? (
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="admin-password">
                Admin password
              </label>
              <Input
                id="admin-password"
                autoComplete="current-password"
                disabled={isSubmitting}
                nativeInput
                onChange={(event) => setPassword(event.currentTarget.value)}
                placeholder="Enter the admin password"
                type="password"
                value={password}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="pairing-token">
                Pairing token
              </label>
              <Input
                id="pairing-token"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect="off"
                disabled={isSubmitting}
                nativeInput
                onChange={(event) => setCredential(event.currentTarget.value)}
                placeholder="Paste a one-time token or pairing secret"
                spellCheck={false}
                value={credential}
              />
            </div>
          )}

          {errorMessage ? (
            <div
              role="alert"
              className="rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground"
            >
              {errorMessage}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {/* Keep the label and width while signing in. */}
            <Button className="min-w-24" disabled={isSubmitting} size="sm" type="submit">
              {isSubmitting ? <Spinner aria-hidden="true" className="size-3.5" /> : null}
              Continue
            </Button>
            <Button
              disabled={isSubmitting}
              onClick={() => window.location.reload()}
              size="sm"
              variant="outline"
            >
              Reload app
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Couldn't sign in. Check the password or token, then try again.";
}

/** One line saying how to get in; the form below shows the matching field. */
function describeAuthGate(bootstrapMethods: ReadonlyArray<string>): string {
  if (bootstrapMethods.includes("password")) {
    return bootstrapMethods.includes("one-time-token")
      ? "Sign in with the admin password or a one-time pairing token."
      : "Sign in with the admin password.";
  }

  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "Open this from the Cafe desktop app, or paste a pairing credential.";
  }

  return "Open a pairing link, or paste a one-time pairing token.";
}
