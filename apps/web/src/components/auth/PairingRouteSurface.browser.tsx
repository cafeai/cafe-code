import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";

const { submitPairingMock, submitPasswordMock } = vi.hoisted(() => ({
  submitPairingMock: vi.fn(async () => undefined),
  submitPasswordMock: vi.fn(async () => undefined),
}));

vi.mock("../../environments/primary", () => ({
  peekPairingTokenFromUrl: vi.fn(() => null),
  stripPairingTokenFromUrl: vi.fn(),
  submitServerAuthCredential: submitPairingMock,
  submitServerPasswordCredential: submitPasswordMock,
  isServerSecondFactorChallenge: (error: unknown) =>
    error instanceof Error && error.name === "SyntheticSecondFactorChallenge",
}));

import { PairingRouteSurface } from "./PairingRouteSurface";

const auth = {
  policy: "remote-reachable" as const,
  bootstrapMethods: ["one-time-token" as const, "password" as const],
  sessionMethods: ["browser-session-cookie" as const, "bearer-session-token" as const],
  sessionCookieName: "t3_session",
};

function ownPairingFixture(test: TestContext) {
  let retired = false,
    cleanupPromise: Promise<void> | undefined;
  let pendingRender: ReturnType<typeof render> | undefined;
  const operations = new Set<Promise<unknown>>();
  const retire = () => {
    retired = true;
    test.signal.removeEventListener("abort", retire);
  };
  const cleanup = () => {
    retire();
    return (cleanupPromise ??= (async () => {
      await Promise.allSettled([...operations]);
      const view = await pendingRender?.catch(() => undefined);
      await view?.unmount();
    })());
  };
  test.onTestFinished(cleanup);
  test.signal.addEventListener("abort", retire, { once: true });
  if (test.signal.aborted) retire();
  const assertActive = () => {
    if (retired || test.signal.aborted) throw new Error("Pairing fixture retired.");
  };
  return {
    cleanup,
    async mount(node: ReactNode) {
      assertActive();
      pendingRender = render(node);
      const view = await pendingRender;
      assertActive();
      return view;
    },
    async native<T>(action: () => Promise<T>): Promise<T> {
      assertActive();
      const operation = action();
      operations.add(operation);
      try {
        const result = await operation;
        assertActive();
        return result;
      } finally {
        operations.delete(operation);
      }
    },
  };
}
let fixture: ReturnType<typeof ownPairingFixture>;

describe("PairingRouteSurface", () => {
  beforeEach((test) => {
    fixture = ownPairingFixture(test);
  });
  afterEach(async () => {
    await fixture.cleanup();
    submitPairingMock.mockClear();
    submitPasswordMock.mockClear();
    document.body.innerHTML = "";
  });

  it("submits password credentials when password auth is advertised", async () => {
    const onAuthenticated = vi.fn();
    await fixture.mount(<PairingRouteSurface auth={auth} onAuthenticated={onAuthenticated} />);

    try {
      await expect.element(page.getByLabelText("Admin password")).toBeInTheDocument();
      await fixture.native(() =>
        page.getByLabelText("Admin password").fill("correct horse battery staple"),
      );
      await fixture.native(() => page.getByRole("button", { name: "Continue" }).click());

      await vi.waitFor(() => {
        expect(submitPasswordMock).toHaveBeenCalledWith({
          password: "correct horse battery staple",
        });
      });
      expect(submitPairingMock).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps pairing-token submission available beside password auth", async () => {
    const onAuthenticated = vi.fn();
    await fixture.mount(<PairingRouteSurface auth={auth} onAuthenticated={onAuthenticated} />);

    try {
      await fixture.native(() => page.getByRole("button", { name: "Pairing token" }).click());
      await expect.element(page.getByLabelText("Pairing token")).toBeInTheDocument();
      await fixture.native(() => page.getByLabelText("Pairing token").fill("PAIRING-TOKEN"));
      await fixture.native(() => page.getByRole("button", { name: "Continue" }).click());

      await vi.waitFor(() => {
        expect(submitPairingMock).toHaveBeenCalledWith("PAIRING-TOKEN");
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("requires and sends an authentication code, then clears a refused code", async () => {
    submitPasswordMock
      .mockRejectedValueOnce(
        Object.assign(new Error("Enter an authenticator code or recovery code."), {
          name: "SyntheticSecondFactorChallenge",
        }),
      )
      .mockRejectedValueOnce(new Error("Check your authentication code."));
    const onAuthenticated = vi.fn();
    await fixture.mount(
      <PairingRouteSurface
        auth={{ ...auth, twoFactorRequired: true }}
        onAuthenticated={onAuthenticated}
      />,
    );
    try {
      await fixture.native(() =>
        page.getByLabelText("Admin password", { exact: true }).fill("correct horse battery staple"),
      );
      await expect
        .element(page.getByLabelText("Authenticator or recovery code"))
        .not.toBeInTheDocument();
      await fixture.native(() =>
        page.getByRole("button", { name: "Continue", exact: true }).click(),
      );
      await expect.element(page.getByLabelText("Authenticator or recovery code")).toBeVisible();
      await fixture.native(() =>
        page.getByLabelText("Authenticator or recovery code").fill("123456"),
      );
      await fixture.native(() =>
        page.getByRole("button", { name: "Continue", exact: true }).click(),
      );
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Check your authentication code.");
      expect(submitPasswordMock.mock.calls).toEqual([
        [{ password: "correct horse battery staple" }],
        [{ password: "correct horse battery staple", secondFactor: "123456" }],
      ]);
      await expect.element(page.getByLabelText("Authenticator or recovery code")).toHaveValue("");
      expect(onAuthenticated).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  it("sends recovery proof together with a pairing credential", async () => {
    submitPairingMock.mockRejectedValueOnce(
      Object.assign(new Error("Enter an authenticator code or recovery code."), {
        name: "SyntheticSecondFactorChallenge",
      }),
    );
    const onAuthenticated = vi.fn();
    await fixture.mount(
      <PairingRouteSurface
        auth={{ ...auth, twoFactorRequired: true }}
        onAuthenticated={onAuthenticated}
      />,
    );
    try {
      await fixture.native(() =>
        page.getByRole("button", { name: "Pairing token", exact: true }).click(),
      );
      await fixture.native(() =>
        page.getByLabelText("Pairing token", { exact: true }).fill("PAIRING-TOKEN"),
      );
      await expect
        .element(page.getByLabelText("Authenticator or recovery code"))
        .not.toBeInTheDocument();
      await fixture.native(() =>
        page.getByRole("button", { name: "Continue", exact: true }).click(),
      );
      await expect.element(page.getByLabelText("Authenticator or recovery code")).toBeVisible();
      await fixture.native(() =>
        page.getByLabelText("Authenticator or recovery code").fill("synthetic-recovery-code"),
      );
      await fixture.native(() =>
        page.getByRole("button", { name: "Continue", exact: true }).click(),
      );
      await vi.waitFor(() => expect(onAuthenticated).toHaveBeenCalledTimes(1));
      expect(submitPairingMock.mock.calls).toEqual([
        ["PAIRING-TOKEN"],
        ["PAIRING-TOKEN", "synthetic-recovery-code"],
      ]);
    } finally {
      await fixture.cleanup();
    }
  });
});
