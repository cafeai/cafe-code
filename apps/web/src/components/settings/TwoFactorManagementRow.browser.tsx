import "../../index.css";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { TwoFactorManagementRow } from "./TwoFactorManagementRow";
import { TwoFactorApiError } from "../../environments/twoFactorApi";

describe("optional two-factor management", () => {
  let screen: Awaited<ReturnType<typeof render>> | undefined;
  afterEach(async () => {
    await screen?.unmount();
    screen = undefined;
  });
  it("confirms enrollment before enabling and retires the one-time recovery display", async () => {
    const api = {
      status: vi.fn(async () => ({ enabled: false, recoveryCodesRemaining: 0 })),
      begin: vi.fn(async () => ({
        secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        uri: "otpauth://totp/Cafe%20Code?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
      })),
      enable: vi.fn(async (_code: string) => ({ recoveryCodes: ["synthetic-one-time-recovery"] })),
      disable: vi.fn(async (_code: string) => ({ enabled: false, recoveryCodesRemaining: 0 })),
    };
    screen = await render(<TwoFactorManagementRow environmentId={null} api={api} />);
    await expect.element(page.getByRole("button", { name: "Enable", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Enable", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByText("Manual setup key")).toBeVisible();
    expect(api.enable).not.toHaveBeenCalled();
    await dialog.getByLabelText("Authenticator or recovery code").fill("123456");
    await dialog.getByRole("button", { name: "Enable", exact: true }).click();
    await expect.element(dialog.getByText("synthetic-one-time-recovery")).toBeVisible();
    expect(api.enable).toHaveBeenCalledExactlyOnceWith("123456");
    await dialog.getByRole("button", { name: "I saved these codes" }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(page.getByText("synthetic-one-time-recovery")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Disable", exact: true }).click();
    await dialog.getByLabelText("Authenticator or recovery code").fill("recovery-proof");
    await dialog.getByRole("button", { name: "Disable", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(api.disable).toHaveBeenCalledExactlyOnceWith("recovery-proof");
    await expect.element(page.getByRole("button", { name: "Enable", exact: true })).toBeEnabled();
  });

  it("keeps protection enabled after throttled disable and clears the submitted code", async () => {
    const api = {
      status: vi.fn(async () => ({ enabled: true, recoveryCodesRemaining: 10 })),
      begin: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(async () => {
        throw new TwoFactorApiError("limited");
      }),
    };
    screen = await render(<TwoFactorManagementRow environmentId={null} api={api} />);
    await expect.element(page.getByRole("button", { name: "Disable", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Disable", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabelText("Authenticator or recovery code").fill("123456");
    await dialog.getByRole("button", { name: "Disable", exact: true }).click();
    await expect
      .element(dialog.getByRole("alert"))
      .toHaveTextContent(
        "Too many authentication attempts. Wait for the cooldown, then try again.",
      );
    await expect.element(dialog.getByLabelText("Authenticator or recovery code")).toHaveValue("");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Disable", exact: true })).toBeEnabled();
  });
});
