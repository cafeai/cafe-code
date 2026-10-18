// Value-policy qualification only. The resolver's AppKit/AX/SPI functions are
// linked but never called; this runner creates no applications or event taps.
import CoreGraphics
private struct RoutingQualificationFailure: Error { let message: String }
private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw RoutingQualificationFailure(message: message) }
}

@main
struct RoutingPolicyQualification {
  static let root = FocusProcess(pid: 101, birth: ProcessIdentity(seconds: 10, microseconds: 1))
  static let hosted = FocusProcess(pid: 202, birth: ProcessIdentity(seconds: 20, microseconds: 2))
  static let foreign = FocusProcess(pid: 303, birth: ProcessIdentity(seconds: 30, microseconds: 3))
  static let replacement = FocusProcess(pid: 101, birth: ProcessIdentity(seconds: 40, microseconds: 4))
  static let hostedReplacement = FocusProcess(pid: 202, birth: ProcessIdentity(seconds: 50, microseconds: 5))
  static func live(_ process: FocusProcess) -> Bool { [root, hosted, foreign].contains(process) }

  static func main() throws {
    let selected = CGRect(x: 0, y: 534, width: 880, height: 448)
    let family = CGRect(x: 0, y: 502, width: 880, height: 480)
    let normalized = WindowCaptureGeometry.crop(window: selected, family: family, width: 1760, height: 960)
    try require(normalized?.pixels == CGRect(x: 0, y: 64, width: 1760, height: 896) && normalized?.width == 1760 && normalized?.height == 896, "Sheet capture included its parent's chrome or changed input coordinate scale.")
    try require(WindowCaptureGeometry.crop(window: selected, family: CGRect(x: 20, y: 534, width: 800, height: 400), width: 1600, height: 800) == nil, "Capture crop admitted a selected window outside its proven family.")
    try require(WindowCaptureGeometry.crop(window: selected, family: family, width: 4096, height: 2048) == nil, "Capture crop exceeded the native pixel bound.")
    try require(WindowCaptureGeometry.crop(window: selected, family: CGRect(x: 0, y: 0, width: Double.infinity, height: 480), width: 1760, height: 960) == nil, "Unbounded capture metadata was admitted.")
    try require(AXRecipientPolicy.processType(finished: false, activationPolicy: 0) == .nonEventHandlingProcess, "Unfinished ordinary application was admitted.")
    try require(AXRecipientPolicy.processType(finished: false, activationPolicy: 2) == .nonEventHandlingProcess, "Unfinished hosted service was admitted.")
    try require(AXRecipientPolicy.processType(finished: true, activationPolicy: nil) == .nonEventHandlingProcess, "Unknown application policy was admitted.")
    try require(AXRecipientPolicy.processType(finished: true, activationPolicy: 2) == .viewService, "Prohibited finished service was not classified.")
    for policy in [0, 1] {
      try require(AXRecipientPolicy.processType(finished: true, activationPolicy: policy) == .regularApp, "Finished event-handling application was not a boundary.")
    }

    let empty = try AXRecipientPolicy.select(root: root, candidates: [])
    try require(empty.recipient == root && empty.hostedAncestorIndex == nil, "Absent AX information changed the approved root recipient.")
    let skipped = try AXRecipientPolicy.select(root: root, candidates: [
      .init(process: nil, type: .nonEventHandlingProcess),
      .init(process: hosted, type: .viewService),
      .init(process: root, type: .regularApp),
    ])
    try require(skipped.recipient == hosted && skipped.hostedAncestorIndex == 1, "Hosted routing did not derive from the first eligible AX ancestor.")

    // An ordinary application stops traversal even if a later ancestor looks
    // like a service. It does not authorize routing to that foreign app either.
    for boundary in [root, foreign] {
      let selected = try AXRecipientPolicy.select(root: root, candidates: [
        .init(process: boundary, type: .regularApp),
        .init(process: hosted, type: .viewService),
      ])
      try require(selected.recipient == root && selected.hostedAncestorIndex == nil, "Routing escaped an ordinary application boundary.")
    }
    let same = try AXRecipientPolicy.select(root: root, candidates: [
      .init(process: root, type: .viewService),
      .init(process: hosted, type: .viewService),
    ])
    try require(same.recipient == root && same.hostedAncestorIndex == nil, "Root service classification escaped to another process.")

    do {
      _ = try AXRecipientPolicy.select(root: root, candidates: [
        .init(process: replacement, type: .regularApp),
        .init(process: hosted, type: .viewService),
      ])
      throw RoutingQualificationFailure(message: "A reused root PID retained old routing authority.")
    } catch AXRecipientPolicy.Refusal.replacedRoot {}
    do {
      _ = try AXRecipientPolicy.select(root: root, candidates: [
        .init(process: nil, type: .viewService),
        .init(process: foreign, type: .viewService),
      ])
      throw RoutingQualificationFailure(message: "Missing recipient birth escaped to a later process.")
    } catch AXRecipientPolicy.Refusal.unavailableIdentity {}

    let menuBounds = CGRect(x: 120, y: 200, width: 240, height: 82)
    let parentWindow = MenuWindowPolicy.Candidate(id: 1, owner: root.pid, layer: 0, bounds: CGRect(x: 100, y: 100, width: 500, height: 400), alpha: 1)
    let nativeMenu = MenuWindowPolicy.Candidate(id: 2, owner: root.pid, layer: 101, bounds: menuBounds, alpha: 1)
    let foreignMenu = MenuWindowPolicy.Candidate(id: 3, owner: foreign.pid, layer: 101, bounds: menuBounds, alpha: 1)
    try require(MenuWindowPolicy.select(recipient: root.pid, reference: 1, bounds: menuBounds, candidates: [parentWindow]) == nil, "An inherited parent window became the menu recipient.")
    try require(MenuWindowPolicy.select(recipient: root.pid, reference: 1, bounds: menuBounds, candidates: [parentWindow, nativeMenu, foreignMenu])?.id == 2, "Exact owned menu geometry did not replace an inherited parent reference.")
    try require(MenuWindowPolicy.select(recipient: root.pid, reference: 3, bounds: menuBounds, candidates: [foreignMenu]) == nil, "A foreign window acquired authority through geometry or AX reference.")
    let duplicateMenu = MenuWindowPolicy.Candidate(id: 4, owner: root.pid, layer: 101, bounds: menuBounds, alpha: 1)
    try require(MenuWindowPolicy.select(recipient: root.pid, reference: 2, bounds: menuBounds, candidates: [nativeMenu, duplicateMenu]) == nil, "An ambiguous native menu inventory selected a window.")
    let hiddenMenu = MenuWindowPolicy.Candidate(id: 2, owner: root.pid, layer: 101, bounds: menuBounds, alpha: 0)
    try require(MenuWindowPolicy.select(recipient: root.pid, reference: 2, bounds: menuBounds, candidates: [hiddenMenu]) == nil, "A transparent retired menu retained input authority.")
    let ordinaryPeer = MenuWindowPolicy.Candidate(id: 5, owner: root.pid, layer: 0, bounds: menuBounds, alpha: 1)
    try require(MenuWindowPolicy.select(recipient: root.pid, reference: 1, bounds: menuBounds, candidates: [ordinaryPeer]) == nil, "An unrelated ordinary window acquired menu authority.")
    try require(MenuWindowPolicy.select(recipient: root.pid, reference: 5, bounds: menuBounds, candidates: [ordinaryPeer])?.id == 5, "An exact AX-bound inline menu window was refused.")

    var menu = MenuDismissalPolicy()
    try require(menu.observe(stream: root, windowOwner: foreign, isLive: live) == .pass, "Unarmed menu policy suppressed input.")
    menu.arm(root: root, menu: hosted)
    for stream in [root, hosted] {
      try require(menu.observe(stream: stream, windowOwner: root, isLive: live) == .pass, "The approved root window was suppressed.")
      try require(menu.observe(stream: stream, windowOwner: hosted, isLive: live) == .pass, "The exact hosted menu window was suppressed.")
      try require(menu.observe(stream: stream, windowOwner: foreign, isLive: live) == .suppress, "An unrelated window event was allowed to dismiss the controlled menu.")
      try require(menu.observe(stream: stream, windowOwner: nil, isLive: live) == .pass, "Unknown native window ownership was suppressed.")
    }
    try require(menu.observe(stream: foreign, windowOwner: foreign, isLive: live) == .pass, "Menu policy acquired another process's input stream.")
    try require(menu.observe(stream: replacement, windowOwner: foreign, isLive: { _ in true }) == .pass, "A replacement root PID acquired the old menu tap.")
    try require(menu.observe(stream: hostedReplacement, windowOwner: foreign, isLive: { _ in true }) == .pass, "A replacement menu PID acquired the old menu tap.")
    for dead in [root, hosted, foreign] {
      try require(menu.observe(stream: root, windowOwner: foreign, isLive: { $0 != dead }) == .pass, "Menu suppression used an uncertain or dead process generation.")
    }
    menu.disarm()
    try require(menu.observe(stream: root, windowOwner: foreign, isLive: live) == .pass, "Menu cleanup retained suppression authority.")
    menu.arm(root: root, menu: nil)
    try require(menu.observe(stream: root, windowOwner: hosted, isLive: live) == .suppress, "An unbound service inherited prior menu ownership.")
    try require(menu.observe(stream: hosted, windowOwner: foreign, isLive: live) == .pass, "Rearming without a menu retained the old recipient stream.")
    print("glide-routing-policy-qualified")
  }
}
