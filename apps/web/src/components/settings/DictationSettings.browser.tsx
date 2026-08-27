import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { DictationSettings } from "./DictationSettings";

const PRIMARY_ENVIRONMENT_ID = "environment-primary";

const dictationHarness = vi.hoisted(() => {
  let status = { configured: false, canManage: true };
  const getStatus = vi.fn(async () => ({ ...status }));
  const setApiKey = vi.fn(async (_input: { readonly apiKey: string }) => {
    status = { configured: true, canManage: true };
    return { ...status };
  });
  const clearApiKey = vi.fn(async () => {
    status = { configured: false, canManage: true };
    return { ...status };
  });

  return {
    getStatus,
    setApiKey,
    clearApiKey,
    reset(nextStatus = { configured: false, canManage: true }) {
      status = { ...nextStatus };
      getStatus.mockReset().mockImplementation(async () => ({ ...status }));
      setApiKey.mockReset().mockImplementation(async () => {
        status = { configured: true, canManage: nextStatus.canManage };
        return { ...status };
      });
      clearApiKey.mockReset().mockImplementation(async () => {
        status = { configured: false, canManage: nextStatus.canManage };
        return { ...status };
      });
    },
  };
});

vi.mock("~/environments/primary", () => ({
  usePrimaryEnvironmentId: () => PRIMARY_ENVIRONMENT_ID,
}));

vi.mock("~/environments/runtime", () => ({
  requireEnvironmentConnection: () => ({
    client: {
      dictation: {
        getStatus: dictationHarness.getStatus,
        setApiKey: dictationHarness.setApiKey,
        clearApiKey: dictationHarness.clearApiKey,
      },
    },
  }),
}));

vi.mock("~/lib/dictationReactQuery", () => ({
  dictationQueryKeys: {
    status: (environmentId: string | null) => ["dictation", "status", environmentId] as const,
  },
  dictationStatusQueryOptions: (environmentId: string | null) => ({
    queryKey: ["dictation", "status", environmentId] as const,
    queryFn: dictationHarness.getStatus,
    enabled: environmentId !== null,
    retry: false,
  }),
}));

function getAlertDialogButton(name: string): HTMLButtonElement {
  const alertDialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
  const button = Array.from(alertDialog?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) {
    throw new Error(`Unable to find ${name} in the dictation confirmation dialog.`);
  }
  return button;
}

describe("DictationSettings", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;
  let queryClient: QueryClient | null = null;

  beforeEach(() => {
    dictationHarness.reset();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  afterEach(async () => {
    const teardown = mounted?.cleanup ?? mounted?.unmount;
    await teardown?.call(mounted).catch(() => {});
    mounted = null;
    queryClient?.clear();
    queryClient = null;
    document.body.innerHTML = "";
  });

  async function renderSettings() {
    if (!queryClient) {
      throw new Error("Test query client is unavailable.");
    }
    mounted = await render(
      <QueryClientProvider client={queryClient}>
        <DictationSettings />
      </QueryClientProvider>,
    );
  }

  it("explains the opt-in behavior and renders only an empty new-key password field", async () => {
    await renderSettings();

    await expect
      .element(page.getByRole("heading", { name: "Dictation", exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("Not configured", { exact: true })).toBeVisible();
    await expect
      .element(
        page.getByText("No key is stored, so Dictation does not access the microphone or OpenAI."),
      )
      .toBeVisible();

    const inputLocator = page.getByLabelText("New OpenAI API key");
    await expect.element(inputLocator).toHaveValue("");
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-describedby="dictation-api-key-help"]',
    );
    expect(input?.type).toBe("password");
    expect(input?.autocomplete).toBe("new-password");
    await expect.element(page.getByRole("button", { name: "Save key" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Remove key" })).not.toBeInTheDocument();
    expect(dictationHarness.getStatus).toHaveBeenCalledTimes(1);
  });

  it("saves a newly entered key, immediately clears it, and caches only status", async () => {
    const apiKey = "sk-test-value-that-must-not-remain";
    await renderSettings();
    await expect.element(page.getByText("Not configured", { exact: true })).toBeVisible();

    const input = page.getByLabelText("New OpenAI API key");
    await input.fill(apiKey);
    await page.getByRole("button", { name: "Save key" }).click();

    await vi.waitFor(() => {
      expect(dictationHarness.setApiKey).toHaveBeenCalledWith({ apiKey });
      expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
    });
    await expect.element(page.getByText("Configured", { exact: true })).toBeVisible();
    await expect
      .element(
        page.getByText("OpenAI API key saved. Cafe will verify access when dictation starts.", {
          exact: true,
        }),
      )
      .toBeVisible();
    expect(document.body.textContent).not.toContain(apiKey);
    expect(document.body.innerHTML).not.toContain(apiKey);
    expect(queryClient?.getQueryData(["dictation", "status", PRIMARY_ENVIRONMENT_ID])).toEqual({
      configured: true,
      canManage: true,
    });
  });

  it("keeps management controls disabled for a non-owner session", async () => {
    dictationHarness.reset({ configured: true, canManage: false });
    await renderSettings();

    await expect.element(page.getByText("Configured", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Only an owner session can add, replace, or remove this credential."))
      .toBeVisible();
    await expect.element(page.getByLabelText("New OpenAI API key")).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Replace key" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Remove key" })).toBeDisabled();
    expect(dictationHarness.setApiKey).not.toHaveBeenCalled();
    expect(dictationHarness.clearApiKey).not.toHaveBeenCalled();
  });

  it("requires confirmation before removing the server-side key", async () => {
    dictationHarness.reset({ configured: true, canManage: true });
    await renderSettings();
    await expect.element(page.getByText("Configured", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Remove key" }).click();
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    expect(dictationHarness.clearApiKey).not.toHaveBeenCalled();

    getAlertDialogButton("Remove key").click();

    await vi.waitFor(() => {
      expect(dictationHarness.clearApiKey).toHaveBeenCalledTimes(1);
    });
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    await expect.element(page.getByText("Not configured", { exact: true })).toBeVisible();
    await expect.element(page.getByText("OpenAI API key removed.", { exact: true })).toBeVisible();
  });

  it("does not echo a rejected credential or raw RPC error details", async () => {
    const apiKey = "sk-sensitive-rejected-value";
    dictationHarness.setApiKey.mockRejectedValueOnce({
      code: "secret_store_failed",
      message: `unsafe provider detail containing ${apiKey}`,
    });
    await renderSettings();
    await expect.element(page.getByText("Not configured", { exact: true })).toBeVisible();

    await page.getByLabelText("New OpenAI API key").fill(apiKey);
    await page.getByRole("button", { name: "Save key" }).click();

    await expect
      .element(page.getByText("Cafe Code could not update its private credential store."))
      .toBeVisible();
    await expect.element(page.getByLabelText("New OpenAI API key")).toHaveValue("");
    expect(document.body.textContent).not.toContain(apiKey);
    expect(document.body.textContent).not.toContain("unsafe provider detail");
  });
});
