import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { submitPairingMock, submitPasswordMock } = vi.hoisted(() => ({
  submitPairingMock: vi.fn(async () => undefined),
  submitPasswordMock: vi.fn(async () => undefined),
}));

vi.mock("../../environments/primary", () => ({
  peekPairingTokenFromUrl: vi.fn(() => null),
  stripPairingTokenFromUrl: vi.fn(),
  submitServerAuthCredential: submitPairingMock,
  submitServerPasswordCredential: submitPasswordMock,
}));

import { PairingRouteSurface } from "./PairingRouteSurface";

const auth = {
  policy: "remote-reachable" as const,
  bootstrapMethods: ["one-time-token" as const, "password" as const],
  sessionMethods: ["browser-session-cookie" as const, "bearer-session-token" as const],
  sessionCookieName: "t3_session",
};

describe("PairingRouteSurface", () => {
  afterEach(() => {
    submitPairingMock.mockClear();
    submitPasswordMock.mockClear();
    document.body.innerHTML = "";
  });

  it("submits password credentials when password auth is advertised", async () => {
    const onAuthenticated = vi.fn();
    const screen = await render(
      <PairingRouteSurface auth={auth} onAuthenticated={onAuthenticated} />,
    );

    try {
      await expect.element(page.getByLabelText("Admin password")).toBeInTheDocument();
      await page.getByLabelText("Admin password").fill("correct horse battery staple");
      await page.getByRole("button", { name: "Continue" }).click();

      await vi.waitFor(() => {
        expect(submitPasswordMock).toHaveBeenCalledWith({
          password: "correct horse battery staple",
        });
      });
      expect(submitPairingMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps pairing-token submission available beside password auth", async () => {
    const onAuthenticated = vi.fn();
    const screen = await render(
      <PairingRouteSurface auth={auth} onAuthenticated={onAuthenticated} />,
    );

    try {
      await page.getByRole("button", { name: "Pairing token" }).click();
      await expect.element(page.getByLabelText("Pairing token")).toBeInTheDocument();
      await page.getByLabelText("Pairing token").fill("PAIRING-TOKEN");
      await page.getByRole("button", { name: "Continue" }).click();

      await vi.waitFor(() => {
        expect(submitPairingMock).toHaveBeenCalledWith("PAIRING-TOKEN");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("requires and sends an authentication code, then clears a refused code", async () => {
    submitPasswordMock.mockRejectedValueOnce(new Error("Check your authentication code."));
    const onAuthenticated = vi.fn();
    const screen = await render(
      <PairingRouteSurface
        auth={{ ...auth, twoFactorRequired: true }}
        onAuthenticated={onAuthenticated}
      />,
    );
    try {
      await page
        .getByLabelText("Admin password", { exact: true })
        .fill("correct horse battery staple");
      await page.getByLabelText("Authenticator or recovery code").fill("123456");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Check your authentication code.");
      expect(submitPasswordMock).toHaveBeenCalledExactlyOnceWith({
        password: "correct horse battery staple",
        secondFactor: "123456",
      });
      await expect.element(page.getByLabelText("Authenticator or recovery code")).toHaveValue("");
      expect(onAuthenticated).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("sends recovery proof together with a pairing credential", async () => {
    const onAuthenticated = vi.fn();
    const screen = await render(
      <PairingRouteSurface
        auth={{ ...auth, twoFactorRequired: true }}
        onAuthenticated={onAuthenticated}
      />,
    );
    try {
      await page.getByRole("button", { name: "Pairing token", exact: true }).click();
      await page.getByLabelText("Pairing token", { exact: true }).fill("PAIRING-TOKEN");
      await page.getByLabelText("Authenticator or recovery code").fill("synthetic-recovery-code");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
      expect(submitPairingMock).toHaveBeenCalledExactlyOnceWith(
        "PAIRING-TOKEN",
        "synthetic-recovery-code",
      );
    } finally {
      await screen.unmount();
    }
  });
});
