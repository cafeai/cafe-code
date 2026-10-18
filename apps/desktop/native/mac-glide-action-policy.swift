import Foundation

// This receipt records evidence, not authority to replay an operation. In
// particular CGEventPostToPid has no delivery acknowledgment. Keeping the
// counters separate prevents an accepted AX focus write from attesting later
// keyboard delivery in the same operation.
final class GlideActionTrace {
  let actionID = UUID().uuidString
  let method: String
  var stage = "admission"
  var status = "unverified"
  var axAttempted = 0
  var axAccepted = 0
  var eventsPosted = 0
  var textScalarsPosted = 0
  var lifecycleDispatched = false
  var osStatus: Int32?
  var verification: [String: Any] = ["kind": "none", "matched": NSNull()]
  var message: String?
  var interruption: [String: Any]?
  var candidates: [[String: Any]]?
  init(method: String) { self.method = method }
  var dispatched: Bool { axAttempted > 0 || eventsPosted > 0 || lifecycleDispatched }
  func beginAX(_ stage: String) { self.stage = stage; axAttempted += 1 }
  func endAX(_ value: Int32) {
    // Preserve the first rejected status when a compound operation later makes
    // another accepted AX call; successful substeps cannot erase that evidence.
    if osStatus == nil || osStatus == 0 { osStatus = value }
    if value == 0 { axAccepted += 1 }
  }
  func post(_ stage: String) { self.stage = stage; eventsPosted += 1 }
  func verify(_ kind: String, matched: Bool?, before: Any? = nil, after: Any? = nil) {
    verification = ["kind": kind, "matched": matched.map { $0 as Any } ?? NSNull()]
    if let before { verification["before"] = before }
    if let after { verification["after"] = after }
    stage = "verification"
    status = matched == true ? "verified" : matched == false ? "not-observed" : "unverified"
  }
  func fail(_ message: String) {
    self.message = String(message.prefix(2048))
    status = dispatched ? "uncertain" : "refused"
  }
  var result: [String: Any] {
    let acceptance = eventsPosted > 0 || lifecycleDispatched ? "unacknowledged" : axAttempted == 0 ? "unknown" : axAccepted == axAttempted ? "accepted" : "rejected"
    var result: [String: Any] = [
      "actionId": actionID, "method": method, "stage": stage, "status": status,
      "dispatch": dispatched ? "dispatched" : "not-dispatched", "osAcceptance": acceptance,
      "progress": ["axAttempted": axAttempted, "axAccepted": axAccepted, "eventsPosted": eventsPosted, "textScalarsPosted": textScalarsPosted],
      "verification": verification
    ]
    if let osStatus { result["osStatus"] = Int(osStatus) }
    if let message { result["message"] = message }
    if let interruption { result["interruption"] = interruption }
    if let candidates { result["candidates"] = candidates }
    return result
  }
}

enum GlideValueComparison {
  static func supportsTextVerification(_ text: String) -> Bool { text.utf16.count <= 64 * 1024 }
  // AX numbers may be rounded through NSNumber by the application. This allows
  // floating representation error, not slider clamping or a different UI value.
  static func numbersMatch(_ expected: Double, _ observed: Double) -> Bool {
    expected.isFinite && observed.isFinite && abs(expected - observed) <= max(1, abs(expected)) * 1e-9
  }
}
