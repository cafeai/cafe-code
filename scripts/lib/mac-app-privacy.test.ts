import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as i18n from "@cafecode/shared/i18n";
import { renderMacPrivacyStrings } from "./mac-app-privacy.ts";
import { stageMacSourcePrivacyLocalizations } from "../../apps/desktop/scripts/electron-launcher.mjs";
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("native privacy localization text", () => {
  it("escapes quotes, backslashes and newlines as data, not plist assignments", () => {
    vi.spyOn(i18n, "uiText").mockReturnValue('quoted";\n"injected" = "value\\path');
    const document = renderMacPrivacyStrings("ja");
    expect(document.split("\n").filter(Boolean)).toHaveLength(2);
    expect(document).toContain('quoted\\";\\n\\"injected\\" = \\"value\\\\path');
    expect(document).not.toContain('\n"injected" = ');
  });
  it("writes only fixed locale resources in a temporary copied-bundle namespace", () => {
    const resources = mkdtempSync(join(tmpdir(), "cafe-source-privacy-"));
    temporary.push(resources);
    stageMacSourcePrivacyLocalizations(resources);
    for (const locale of ["en", "ja", "ko"] as const)
      expect(readFileSync(join(resources, `${locale}.lproj`, "InfoPlist.strings"), "utf8")).toBe(
        renderMacPrivacyStrings(locale),
      );
  });
  it("refuses a redirected locale directory without overwriting unrelated data", () => {
    const resources = mkdtempSync(join(tmpdir(), "cafe-source-privacy-link-"));
    temporary.push(resources);
    const outside = join(resources, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "InfoPlist.strings"), "untouched");
    symlinkSync(outside, join(resources, "en.lproj"), "junction");
    expect(() => stageMacSourcePrivacyLocalizations(resources)).toThrow(
      "Invalid source runtime locale directory.",
    );
    expect(readFileSync(join(outside, "InfoPlist.strings"), "utf8")).toBe("untouched");
  });
});
