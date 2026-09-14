import "../../index.css";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

const harness = vi.hoisted(() => ({ supported: undefined as boolean | undefined }));
vi.mock("~/environments/primary", () => ({ usePrimaryEnvironmentId: () => "local" }));
vi.mock("../virtualDesktop/useVirtualDesktops", () => ({
  useVirtualDesktops: () => ({
    data:
      harness.supported === undefined
        ? undefined
        : { supported: harness.supported, available: false },
  }),
}));
let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
});

async function mount() {
  const root = createRootRoute({
    component: () => (
      <SidebarProvider>
        <aside>
          <SettingsSidebarNav pathname="/settings/mcp" />
        </aside>
        <Outlet />
      </SidebarProvider>
    ),
  });
  const mcp = createRoute({
    getParentRoute: () => root,
    path: "/settings/mcp",
    component: () => <h1>MCP settings content</h1>,
  });
  const desktop = createRoute({
    getParentRoute: () => root,
    path: "/settings/desktop-control",
    component: () => <h1>Desktop settings content</h1>,
  });
  const router = createRouter({
    routeTree: root.addChildren([mcp, desktop]),
    history: createMemoryHistory({ initialEntries: ["/settings/mcp"] }),
  });
  return render(<RouterProvider router={router} />);
}

describe("desktop settings navigation", () => {
  it("opens its own tab even when Linux prerequisites are missing", async () => {
    harness.supported = true;
    mounted = await mount();
    await page.getByRole("button", { name: "Desktop control", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "Desktop settings content" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "MCP settings content" }))
      .not.toBeInTheDocument();
  });
  it.each([false, undefined])("hides the tab while Linux support is %s", async (supported) => {
    harness.supported = supported;
    mounted = await mount();
    await expect.element(page.getByRole("heading", { name: "MCP settings content" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Desktop control", exact: true }))
      .not.toBeInTheDocument();
  });
});
