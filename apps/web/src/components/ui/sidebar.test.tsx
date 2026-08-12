import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Sidebar,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuSubButton,
  SidebarProvider,
  SidebarTrigger,
} from "./sidebar";

function renderSidebarButton(className?: string) {
  return renderToStaticMarkup(
    <SidebarProvider>
      <SidebarMenuButton className={className}>Projects</SidebarMenuButton>
    </SidebarProvider>,
  );
}

describe("sidebar interactive cursors", () => {
  it("uses a pointer cursor for menu buttons by default", () => {
    const html = renderSidebarButton();

    expect(html).toContain('data-slot="sidebar-menu-button"');
    expect(html).toContain("cursor-pointer");
  });

  it("lets project drag handles override the default pointer cursor", () => {
    const html = renderSidebarButton("cursor-grab");

    expect(html).toContain("cursor-grab");
    expect(html).not.toContain("cursor-pointer");
  });

  it("uses a pointer cursor for menu actions", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuAction aria-label="Create thread">
        <span>+</span>
      </SidebarMenuAction>,
    );

    expect(html).toContain('data-slot="sidebar-menu-action"');
    expect(html).toContain("cursor-pointer");
  });

  it("uses a pointer cursor for submenu buttons", () => {
    const html = renderToStaticMarkup(
      <SidebarMenuSubButton render={<button type="button" />}>Show more</SidebarMenuSubButton>,
    );

    expect(html).toContain('data-slot="sidebar-menu-sub-button"');
    expect(html).toContain("cursor-pointer");
  });
});

describe("sidebar off-canvas controls", () => {
  it("fully removes a collapsed off-canvas sidebar and shows the open-panel icon", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider open={false} onOpenChange={() => {}}>
        <Sidebar collapsible="offcanvas">Navigation</Sidebar>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(html).toContain('data-collapsible="offcanvas"');
    expect(html).toContain("group-data-[collapsible=offcanvas]:w-0");
    expect(html).toContain("lucide-panel-left");
    expect(html).not.toContain("lucide-panel-left-close");
  });

  it("shows the close-panel icon while the sidebar is open", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider open onOpenChange={() => {}}>
        <Sidebar collapsible="offcanvas">Navigation</Sidebar>
        <SidebarTrigger />
      </SidebarProvider>,
    );

    expect(html).toContain('data-collapsible=""');
    expect(html).toContain("lucide-panel-left-close");
  });
});
