import Foundation

private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw NSError(domain: "GlideActionPolicy", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}

@main
struct ActionPolicyQualification {
  static func main() throws {
    let refused = GlideActionTrace(method: "click")
    refused.fail("Ambiguous target")
    try require(refused.result["dispatch"] as? String == "not-dispatched", "Refusal manufactured dispatch")
    try require(refused.status == "refused", "Refusal manufactured completion")

    let ignored = GlideActionTrace(method: "set_value")
    ignored.beginAX("ax-write"); ignored.endAX(0)
    ignored.verify("value", matched: false, before: "old", after: "old")
    try require(ignored.result["osAcceptance"] as? String == "accepted", "Accepted no-op lost its OS acknowledgment")
    try require(ignored.status == "not-observed", "Accepted no-op was called verified")
    try require(ignored.axAttempted == 1 && ignored.axAccepted == 1, "Verification repeated a write")

    let uncertain = GlideActionTrace(method: "perform_secondary_action")
    uncertain.beginAX("ax-action"); uncertain.endAX(-25205)
    uncertain.fail("May have taken effect")
    try require(uncertain.status == "uncertain" && uncertain.dispatched, "Unconfirmed action was called unattempted")
    try require(uncertain.result["osAcceptance"] as? String == "rejected", "OS error was called acceptance")
    try require(uncertain.osStatus == -25205, "OS status was erased")
    let reconciled = GlideActionTrace(method: "set_value")
    reconciled.beginAX("ax-write"); reconciled.endAX(-25205)
    reconciled.verify("value", matched: true, after: "observed")
    try require(reconciled.status == "verified" && reconciled.result["osAcceptance"] as? String == "rejected", "Observed state was conflated with the OS acknowledgment")
    reconciled.beginAX("ax-write"); reconciled.endAX(0)
    try require(reconciled.osStatus == -25205 && reconciled.axAccepted == 1 && reconciled.axAttempted == 2, "A later accepted substep erased an earlier rejected acknowledgment")

    let partial = GlideActionTrace(method: "type_into")
    partial.beginAX("focus"); partial.endAX(0)
    partial.verify("text", matched: nil)
    partial.post("text-input"); partial.textScalarsPosted += 1
    partial.fail("Outside input interrupted")
    try require(partial.status == "uncertain" && partial.textScalarsPosted == 1, "Partial progress was erased")
    try require(partial.result["osAcceptance"] as? String == "unacknowledged", "AX focus acknowledgment attested later keyboard delivery")
    try require(partial.verification["matched"] is NSNull, "Posted text was called observed")

    let matched = GlideActionTrace(method: "set_value")
    matched.beginAX("ax-write"); matched.endAX(0); matched.verify("value", matched: true, before: 1, after: 2)
    try require(matched.status == "verified" && matched.verification["kind"] as? String == "value", "Exact postcondition was lost")
    matched.fail("Owner changed after readback")
    try require(matched.status == "uncertain", "Old readback overrode later ownership loss")

    let launched = GlideActionTrace(method: "launch_app")
    launched.lifecycleDispatched = true; launched.verify("application", matched: true)
    try require(launched.result["osAcceptance"] as? String == "unacknowledged", "Process observation manufactured a launch acknowledgment")

    try require(GlideValueComparison.numbersMatch(0.1, 0.10000000001), "Floating representation noise was rejected")
    try require(GlideValueComparison.supportsTextVerification(String(repeating: "😀", count: 32768)), "Exact UTF-16 text allowance was refused")
    try require(!GlideValueComparison.supportsTextVerification(String(repeating: "😀", count: 32769)), "Unicode grapheme count bypassed the verification memory bound")
    for pair in [(1.0, 0.9), (0.1, 0.11), (0.0, Double.nan), (Double.infinity, Double.infinity)] {
      try require(!GlideValueComparison.numbersMatch(pair.0, pair.1), "Clamping, a different value or non-finite value matched")
    }
    for trace in [refused, ignored, uncertain, partial, matched, launched] {
      try require(JSONSerialization.isValidJSONObject(trace.result), "Receipt was not JSON serializable")
    }
    print("action-policy-qualified")
  }
}
