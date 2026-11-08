import AppKit
import WebKit

/// A provider-owner child, separate from the short-lived native input lease.
/// Its only authority is fixed UI events over the parent's private stdio pipe.
@MainActor final class GlideTray: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  let browser: WKWebView
  var observe: (([String: Any]) -> Void)?
  private let item: NSStatusItem
  private let popover = NSPopover()
  private var ready = false
  private var applying = false
  private var applicationName = "Cafe Code"
  private var revealed = 0
  var isVisible: Bool { item.isVisible }
  var isOpen: Bool { popover.isShown }
  private var theme: String { NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? "dark" : "light" }

  override init() {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    browser = WKWebView(frame: NSRect(x: 0, y: 0, width: 420, height: 280), configuration: configuration)
    item = NSStatusBar.system.statusItem(withLength: 28)
    item.isVisible = false
    super.init()
    configuration.userContentController.add(self, name: "cafe")
    browser.navigationDelegate = self
    browser.setValue(false, forKey: "drawsBackground")
    let controller = NSViewController()
    controller.view = browser
    popover.contentViewController = controller
    popover.contentSize = NSSize(width: 420, height: 280)
    popover.behavior = .transient
    popover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    item.button?.target = self
    item.button?.action = #selector(toggle)
    updateIcon(state: "unavailable", rows: [])
    browser.loadHTMLString(glideTrayHTML, baseURL: nil)
  }
  @objc private func toggle() {
    guard item.isVisible, let button = item.button else { return }
    if popover.isShown { popover.performClose(nil) }
    else { popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY) }
  }
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.frameInfo.isMainFrame, let body = message.body as? [String: String], let action = body["action"] else { return }
    if action == "ready", !ready {
      ready = true
      emit(["type": "ready"])
    } else if action == "close" { popover.performClose(nil) }
    else if ["stop-all", "settings"].contains(action), body.count == 1 { emit(["type": action]) }
    else if ["stop-chat", "open-chat"].contains(action), body.count == 2, let owner = body["owner"], UUID(uuidString: owner) != nil {
      emit(["type": action, "owner": owner])
    }
  }
  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    decisionHandler(navigationAction.request.url?.absoluteString == "about:blank" && navigationAction.navigationType == .other ? .allow : .cancel)
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { exit(1) }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { observe?(["type": "loaded"]) }
  func apply(_ frame: [String: Any]) {
    guard ready, !applying, frame.count == 2, let id = frame["id"] as? Int, id > 0,
      var snapshot = frame["snapshot"] as? [String: Any], let state = snapshot["state"] as? String,
      ["ready", "stopping", "stopped", "unavailable"].contains(state), let rows = snapshot["rows"] as? [[String: Any]], rows.count <= 64 else { exit(65) }
    applying = true
    if snapshot["theme"] == nil { snapshot["theme"] = theme }
    popover.appearance = NSAppearance(named: snapshot["theme"] as? String == "dark" ? .darkAqua : .aqua)
    applicationName = String((snapshot["applicationName"] as? String ?? "Cafe Code").prefix(128))
    updateIcon(state: state, rows: rows)
    let visible = state != "stopped" && (!rows.isEmpty || state == "unavailable")
    if !visible {
      let animates = popover.animates
      popover.animates = false
      popover.close()
      popover.animates = animates
    }
    item.isVisible = visible
    Task { @MainActor in
      do {
        let value = try await browser.callAsyncJavaScript("return window.renderSnapshot(snapshot)", arguments: ["snapshot": snapshot], in: nil, contentWorld: .page)
        applying = false
        guard let height = value as? Double, height.isFinite, height >= 100, height <= 700 else { exit(65) }
        popover.contentSize = NSSize(width: 420, height: height)
        browser.setFrameSize(NSSize(width: 420, height: height))
        if visible, let reveal = snapshot["reveal"] as? Int, reveal > revealed {
          revealed = reveal
          if !popover.isShown { toggle() }
        }
        emit(["type": "applied", "id": id])
      } catch { exit(65) }
    }
  }
  private func updateIcon(state: String, rows: [[String: Any]]) {
    let active = rows.contains { ["capturing", "acting"].contains($0["state"] as? String ?? "") }
    let reading = rows.contains { $0["state"] as? String == "reading" }
    let image = NSImage(size: NSSize(width: 22, height: 18), flipped: false) { rect in
      NSColor.labelColor.setStroke()
      let cursor = NSBezierPath()
      cursor.move(to: NSPoint(x: 3, y: 16)); cursor.line(to: NSPoint(x: 16, y: 10))
      cursor.line(to: NSPoint(x: 10, y: 8)); cursor.line(to: NSPoint(x: 8, y: 2)); cursor.close()
      cursor.lineJoinStyle = .round; cursor.lineWidth = 1.5; cursor.stroke()
      if state == "stopped" { let slash = NSBezierPath(); slash.move(to: NSPoint(x: 3, y: 2)); slash.line(to: NSPoint(x: 17, y: 16)); slash.lineWidth = 1.5; slash.stroke() }
      else if active || reading || state == "unavailable" || state == "stopping" {
        let color = state == "unavailable" ? NSColor.systemOrange : state == "stopping" ? NSColor.secondaryLabelColor : NSColor.controlAccentColor
        color.setFill(); color.setStroke()
        let dot = NSBezierPath(ovalIn: NSRect(x: 16, y: 2, width: 4.5, height: 4.5))
        if reading && !active && state == "ready" { dot.lineWidth = 1.2; dot.stroke() } else { dot.fill() }
      }
      return true
    }
    image.isTemplate = state == "stopped" || (state == "ready" && !active && !reading)
    item.button?.image = image
    item.button?.setAccessibilityLabel("\(applicationName) — Computer use")
    let status = state == "unavailable" ? "Computer use: status unavailable" : state == "stopped" ? "Computer use off" : "Computer use: \(Set(rows.compactMap { $0["owner"] as? String }).count) chats"
    item.button?.toolTip = applicationName + "\n" + status
  }
  private func emit(_ frame: [String: Any]) {
    if let observe { observe(frame); return }
    guard let data = try? JSONSerialization.data(withJSONObject: frame), data.count <= 4096 else { exit(65) }
    var size = UInt32(data.count).bigEndian
    do { try FileHandle.standardOutput.write(contentsOf: Data(bytes: &size, count: 4) + data) } catch { exit(1) }
  }
}

@MainActor func runGlideTray() {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  let tray = GlideTray()
  // One bounded frame at a time. A second snapshot cannot be admitted until
  // the first WK render has acknowledged; the parent coalesces pending state.
  DispatchQueue.global().async {
    func read(_ count: Int) -> Data? {
      var data = Data()
      while data.count < count {
        guard let part = try? FileHandle.standardInput.read(upToCount: count - data.count), !part.isEmpty else { return nil }
        data.append(part)
      }
      return data
    }
    while let header = read(4) {
      let size = header.reduce(0) { ($0 << 8) | Int($1) }
      guard size > 0, size <= 8 * 1024 * 1024, let data = read(size), let frame = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { exit(65) }
      DispatchQueue.main.async { tray.apply(frame) }
    }
    DispatchQueue.main.async { app.terminate(nil) }
  }
  withExtendedLifetime(tray) { app.run() }
}
