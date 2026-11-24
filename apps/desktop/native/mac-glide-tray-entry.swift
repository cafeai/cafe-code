import AppKit

// Cafe owns only this status UI. OpenAI owns observation and all native input.
@main private struct Main {
  @MainActor static func main() {
    guard Array(CommandLine.arguments.dropFirst()) == ["--tray"] else { exit(64) }
    runGlideTray()
  }
}
