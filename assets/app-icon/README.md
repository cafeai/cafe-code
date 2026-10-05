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
