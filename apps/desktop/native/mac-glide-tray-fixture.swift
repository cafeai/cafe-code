// Explicit opt-in AppKit/WebKit qualification. No provider, accessibility,
// ScreenCaptureKit, clipboard or user-window input is used by this fixture.
import AppKit
import WebKit

@main private struct TrayFixture {
  @MainActor static func main() {
    guard CommandLine.arguments.count == 2 else { exit(64) }
    let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    NSApplication.shared.setActivationPolicy(.accessory)
    let tray = GlideTray()
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
    window.contentView = tray.browser
    var acknowledgment: CheckedContinuation<Void, Never>?
    var actionReceipt: CheckedContinuation<Void, Never>?
    var expectedAction = ""
    var sequence = 0
    var started = false
    var receipts: [[String: Any]] = []
    func render(_ snapshot: [String: Any]) async {
      sequence += 1
      await withCheckedContinuation { continuation in
        acknowledgment = continuation
        tray.apply(["id": sequence, "snapshot": snapshot])
      }
    }
    func click(_ selector: String, expecting action: String) async throws {
      expectedAction = action
      async let sent: Any? = tray.browser.callAsyncJavaScript("document.querySelector(selector).click(); return true", arguments: ["selector": selector], in: nil, contentWorld: .page)
      await withCheckedContinuation { actionReceipt = $0 }
      _ = try await sent
    }
    func save(_ filename: String) async throws {
      _ = try await tray.browser.callAsyncJavaScript("await document.fonts.ready; return true", in: nil, contentWorld: .page)
      let configuration = WKSnapshotConfiguration()
      configuration.afterScreenUpdates = true
      let image = try await tray.browser.takeSnapshot(configuration: configuration)
      guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
      try png.write(to: output.appendingPathComponent(filename), options: .atomic)
    }
    tray.observe = { frame in
      fputs("tray.fixture=\(frame["type"] as? String ?? "invalid")\n", stderr)
      if frame["type"] as? String == "applied" {
        guard frame["id"] as? Int == sequence else { exit(1) }
        acknowledgment?.resume(); acknowledgment = nil
      } else if frame["type"] as? String == expectedAction {
        receipts.append(frame); actionReceipt?.resume(); actionReceipt = nil
      } else if frame["type"] as? String == "ready", !started {
        started = true
        Task { @MainActor in
          do {
            let owners = [UUID().uuidString, UUID().uuidString, UUID().uuidString]
            // A test-owned image, never a desktop capture. It exercises the
            // actual bounded preview DOM and timestamp without private pixels.
            let preview = NSImage(size: NSSize(width: 240, height: 150))
            preview.lockFocus()
            NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 240, height: 150).fill()
            NSColor(white: 0.92, alpha: 1).setFill(); NSRect(x: 0, y: 130, width: 240, height: 20).fill()
            ("Order summary" as NSString).draw(at: NSPoint(x: 14, y: 100), withAttributes: [.font: NSFont.systemFont(ofSize: 15, weight: .semibold), .foregroundColor: NSColor.black])
            NSColor(white: 0.84, alpha: 1).setFill(); NSRect(x: 14, y: 48, width: 50, height: 42).fill()
            for (y, width) in [(80, 120), (66, 90), (52, 60)] { NSRect(x: 76, y: y, width: width, height: 5).fill() }
            NSColor(white: 0.15, alpha: 1).setFill(); NSBezierPath(roundedRect: NSRect(x: 14, y: 15, width: 120, height: 18), xRadius: 3, yRadius: 3).fill()
            preview.unlockFocus()
            guard let tiff = preview.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.65]) else { exit(1) }
            let rows: [[String: Any]] = [
              ["owner": owners[0], "chat": "Checkout smoke test", "provider": "Codex", "appName": "Chrome", "windowTitle": "Checkout", "state": "capturing", "preview": "data:image/jpeg;base64," + jpeg.base64EncodedString(), "capturedAt": "2026-10-21T12:00:00.000Z"],
              ["owner": owners[1], "chat": "Release notes", "provider": "Claude", "appName": "TextEdit", "windowTitle": "Release notes.rtf", "state": "reading"],
              ["owner": owners[2], "chat": "Fix onboarding flow", "provider": "Codex", "appName": "Simulator", "windowTitle": "iPhone 17", "state": "ready"],
            ]
            await render(["state": "ready", "theme": "dark", "rows": []])
            guard !tray.isVisible, !tray.isOpen else { exit(1) }
            let available = try await tray.browser.callAsyncJavaScript("return !document.querySelector('#stop-all').disabled", in: nil, contentWorld: .page) as? Bool
            guard available == true else { exit(1) }
            await render(["state": "ready", "theme": "dark", "rows": rows])
            guard tray.isVisible else { exit(1) }
            try await save("tray-dark.png")
            try await click("[data-action='open-chat']", expecting: "open-chat")
            guard receipts.last?["owner"] as? String == owners[0] else { exit(1) }
            try await click("[data-action='stop-chat']", expecting: "stop-chat")
            guard receipts.last?["owner"] as? String == owners[0] else { exit(1) }
            await render(["state": "ready", "theme": "light", "rows": rows])
            try await save("tray-light.png")
            await render(["state": "unavailable", "theme": "dark", "rows": rows])
            try await click("#stop-all", expecting: "stop-all")
            let waiting = try await tray.browser.callAsyncJavaScript("return document.querySelector('#stop-all-label').textContent", in: nil, contentWorld: .page) as? String
            guard waiting == "Stop requested · waiting for this Mac" else { exit(1) }
            try await save("tray-unavailable.png")
            await render(["state": "stopped", "theme": "dark", "rows": []])
            guard !tray.isVisible, !tray.isOpen else { exit(1) }
            let disabled = try await tray.browser.callAsyncJavaScript("return document.querySelector('#stop-all').disabled && document.querySelector('#roster').hidden", in: nil, contentWorld: .page) as? Bool
            guard disabled == true else { exit(1) }
            try await save("tray-stopped.png")
            await render(["state": "ready", "theme": "dark", "rows": [["owner": owners[0], "chat": "Research Computer Use Capture Tray", "provider": "Codex", "appName": "Computer use", "windowTitle": "", "state": "ready"]]])
            try await save("tray-ready.png")
            // Explicit enable opens once. Ordinary snapshots and the next
            // turn restore the item without reopening a dismissed popover.
            await render(["state": "ready", "theme": "dark", "rows": rows, "reveal": 1])
            guard tray.isVisible, tray.isOpen else { exit(1) }
            await render(["state": "ready", "theme": "dark", "rows": []])
            guard !tray.isVisible, !tray.isOpen else { exit(1) }
            await render(["state": "ready", "theme": "dark", "rows": rows, "reveal": 1])
            guard tray.isVisible, !tray.isOpen else { exit(1) }
            await render(["state": "ready", "theme": "dark", "rows": rows, "reveal": 2])
            guard tray.isVisible, tray.isOpen else { exit(1) }
            await render(["state": "stopped", "theme": "dark", "rows": []])
            guard !tray.isVisible, !tray.isOpen else { exit(1) }
            let report: [String: Any] = ["passed": true, "native": "AppKit + WKWebView", "data": "synthetic; no live captures", "receipts": receipts]
            try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: output.appendingPathComponent("native-verification.json"), options: .atomic)
            NSApp.terminate(nil)
          } catch { fputs("Native tray fixture failed.\n", stderr); exit(1) }
        }
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
      Task { @MainActor in
        let value = try? await tray.browser.callAsyncJavaScript("return { ready: document.readyState, render: typeof window.renderSnapshot, handler: typeof window.webkit?.messageHandlers?.cafe, scripts: document.scripts.length }", in: nil, contentWorld: .page)
        fputs("tray.fixture.deadline=\(String(describing: value))\n", stderr)
        exit(1)
      }
    }
    withExtendedLifetime((tray, window)) { NSApplication.shared.run() }
  }
}
