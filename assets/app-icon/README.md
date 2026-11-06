# Desktop icons

The portrait master is `assets/source/cafe-code-app-icon-master.png`.
Linux and web assets use the existing full-square artwork; Windows uses its existing ICO.

macOS uses `cafe-code-app-icon-macos-1024.png`: the portrait is drawn as an 832 px
rounded tile, centered on a transparent 1024 px canvas. The outer inset keeps the
visible artwork proportional to other Dock icons. This is a traditional PNG/ICNS
asset for Electron, rather than a layered Icon Composer asset.

Run `yarn sync:mac-icons` on macOS after changing the master. The Node script
preserves the artwork, regenerates the Mac PNG and `apps/desktop/resources/icon-macos.png`,
and uses the system `iconutil` to produce `apps/desktop/resources/icon.icns`
with the complete 16–1024 px standard and Retina representations. Commit all three
generated assets together. The PNG is used for source/development Dock overrides;
the ICNS is used by the branded source app bundle. Stable and nightly Mac packages
both use the inset Mac PNG to generate their packaged PNG and ICNS resources.

## Runtime icon choice

Settings → Appearance → App icon changes the icon of the running desktop app on this
computer only: the macOS Dock tile (`app.dock.setIcon`) and Windows/Linux window icons.
Finder, Launchpad, Start menu shortcuts and Linux launchers keep the shipped icon, because
changing a signed bundle would break code signing.

- **Dekai** is an unlockable alternative default (click the row's "Icon" title 10 times
  within 10 seconds; do it again to switch back). Its source is
  `assets/source/cafe-code-app-icon-dekai.png`; `apps/desktop/resources/icon-dekai.png` is
  the full-bleed copy and `yarn sync:mac-icons` renders `icon-dekai-macos.png` with the
  same Dock inset as the default.
- **Custom** icons are rendered to 1024 px PNGs in the renderer, re-admitted by the desktop
  with the strict PNG parser used for image export, and stored as owner-only files in
  `<userdata>/app-icon/`. The choice itself lives in `desktop-settings.json`.
