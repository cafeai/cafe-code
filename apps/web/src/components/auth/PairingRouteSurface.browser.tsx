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
});
