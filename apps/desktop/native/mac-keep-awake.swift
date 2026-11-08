import Foundation
import CoreGraphics
import IOKit
import IOKit.pwr_mgt
import IOKit.ps
import Darwin
import OSLog

// One exact desktop client's renewable lease. The independent worker retains
// the same native flock description and restores the raw switch on pipe loss.
// No PID catalogue, persistent pmset preference, sudoers rule, provider access,
// persistent display override, login item or privileged installation is involved.
private let heartbeatSeconds: Double = 4
private let assertionSeconds: Double = 8
private let displayLog = Logger(subsystem: "com.cafeai.cafecode", category: "mac-power")
private func leaseNow() -> Double {
    var scale = mach_timebase_info_data_t()
    guard mach_timebase_info(&scale) == KERN_SUCCESS, scale.numer > 0, scale.denom > 0 else { Darwin.exit(3) }
    return Double(mach_continuous_time()) * Double(scale.numer) / Double(scale.denom) / 1e9
}
private func encode(_ value: [String: Any]) -> Data {
    var data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data()
    data.append(10); return data
}
@discardableResult private func writeBytes(_ fd: Int32, _ data: Data) -> Bool {
    data.withUnsafeBytes { raw in
        var offset = 0
        while offset < raw.count {
            let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { return false }; offset += count
        }
        return true
    }
}
private func emit(_ value: [String: Any]) { _ = writeBytes(1, encode(value)) }
private struct Refusal: Error { let reason: String; init(_ reason: String) { self.reason = reason } }
private struct DisplayRefusal: Error {}

#if KEEP_AWAKE_TEST
private let mockRoot: String? = {
    guard let index = CommandLine.arguments.firstIndex(of: "--mock-root"), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}()
private func birth(_ pid: pid_t) -> (UInt64, UInt64)? {
    var info = proc_bsdinfo(); let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard pid > 1, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
          info.pbi_pid == UInt32(pid), info.pbi_uid == getuid(), info.pbi_start_tvsec > 0 else { return nil }
    return (info.pbi_start_tvsec, info.pbi_start_tvusec)
}
private var observation: DispatchSourceProcess?
#endif

private func privateDirectory(_ path: String) throws -> Int32 {
    if mkdir(path, 0o700) != 0 && errno != EEXIST { throw Refusal("native-refused") }
    let descriptor = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard descriptor >= 0 else { throw Refusal("native-refused") }
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
          info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { close(descriptor); throw Refusal("native-refused") }
    return descriptor
}
private func privateFile(_ path: String, relativeTo directory: Int32 = AT_FDCWD) throws -> Int32 {
    let fd = openat(directory, path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, 0o600)
    guard fd >= 0 else { throw Refusal("native-refused") }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
          info.st_uid == getuid(), info.st_nlink == 1, info.st_mode & 0o077 == 0 else { close(fd); throw Refusal("native-refused") }
    return fd
}

private final class Lines {
    let source: DispatchSourceRead
    var bytes = Data()
    var retired = false
    private var readAvailable: (() -> Void)?
    init(_ fd: Int32, line: @escaping ([String: Any]) -> Void, end: @escaping () -> Void) {
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
        readAvailable = { [weak self] in
            guard let self, !self.retired else { return }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while !self.retired {
                let count = Darwin.read(fd, &buffer, buffer.count)
                if count < 0 && errno == EINTR { continue }
                if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { return }
                guard count > 0 else { self.stop(); end(); return }
                self.bytes.append(contentsOf: buffer.prefix(count))
                guard self.bytes.count <= 2048 else { self.stop(); end(); return }
                while let index = self.bytes.firstIndex(of: 10) {
                    let row = self.bytes.prefix(upTo: index); self.bytes.removeSubrange(...index)
                    guard row.count <= 256, let value = try? JSONSerialization.jsonObject(with: row) as? [String: Any] else { self.stop(); end(); return }
                    line(value); if self.retired { return }
                }
                guard self.bytes.count <= 256 else { self.stop(); end(); return }
            }
        }
        source.setEventHandler { [weak self] in self?.drain() }
        source.resume()
    }
    // After an exact child exit, its final ownership messages may still be in
    // the pipe ahead of the queued Dispatch read event. Join and drain before
    // cancelling that reader or deciding which display cleanup we own.
    func drain() { readAvailable?() }
    func stop() { if !retired { retired = true; source.cancel(); readAvailable = nil } }
}

private final class Power {
    var service: io_service_t = 0
    var connection: io_connect_t = 0
    var assertion: IOPMAssertionID = 0
    var assertionHeld = false
    var touched = false
    #if KEEP_AWAKE_TEST
    var mockState: Int32 = -1
    #endif
    init() throws {
        #if KEEP_AWAKE_TEST
        if let mockRoot { mockState = try privateFile(mockRoot + "/power-state"); return }
        #endif
        service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard service != 0, IOServiceOpen(service, mach_task_self_, 0, &connection) == KERN_SUCCESS else { throw Refusal("native-refused") }
    }
    deinit { if connection != 0 { IOServiceClose(connection) }; if service != 0 { IOObjectRelease(service) } }
    func refusal() -> String? {
        #if KEEP_AWAKE_TEST
        if mockRoot != nil { return nil }
        #endif
        if ProcessInfo.processInfo.thermalState == .serious || ProcessInfo.processInfo.thermalState == .critical { return "thermal-limit" }
        guard let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let source = IOPSGetProvidingPowerSourceType(snapshot)?.takeUnretainedValue() as String? else { return "unknown-power" }
        if source == kIOPSACPowerValue { return nil }
        guard source == kIOPSBatteryPowerValue,
              let sources = IOPSCopyPowerSourcesList(snapshot)?.takeRetainedValue() as? [CFTypeRef] else { return "unknown-power" }
        for item in sources {
            guard let value = IOPSGetPowerSourceDescription(snapshot, item)?.takeUnretainedValue() as? [String: Any],
                  value[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
                  let current = value[kIOPSCurrentCapacityKey] as? NSNumber,
                  let maximum = value[kIOPSMaxCapacityKey] as? NSNumber, maximum.doubleValue > 0 else { continue }
            let percentage = current.doubleValue / maximum.doubleValue * 100
            guard percentage.isFinite, (0...100).contains(percentage) else { return "unknown-power" }
            return percentage > 20 ? nil : "battery-low"
        }
        return "unknown-power"
    }
    func setLid(_ disable: Bool) throws {
        #if KEEP_AWAKE_TEST
        if mockState >= 0 {
            var byte: UInt8 = disable ? 49 : 48
            guard pwrite(mockState, &byte, 1, 0) == 1, fsync(mockState) == 0 else { throw Refusal("native-refused") }
            return
        }
        #endif
        var value: UInt64 = disable ? 1 : 0; var outputCount: UInt32 = 0
        // This raw switch is shared state, not a process-scoped assertion.
        // Amphetamine's published reset uses this same selector. A successful
        // reset ACK is distinct from AppleClamshellCausesSleep: XNU need not
        // republish that advisory property when resetting with the lid open.
        // The physical lab test confirmed normal sleep despite the stale flag.
        // https://github.com/apple-oss-distributions/xnu/blob/main/iokit/Kernel/IOPMrootDomain.cpp
        // https://github.com/x74353/Amphetamine-Enhancer/blob/master/Xcode%20Project/CDMManager/CDMManager/AppDelegate.m
        guard IOConnectCallScalarMethod(connection, UInt32(kPMSetClamshellSleepState), &value, 1, nil, &outputCount) == KERN_SUCCESS else { throw Refusal("native-refused") }
    }
    func renew(current: () -> Bool) throws {
        guard current() else { throw Refusal("native-refused") }
        if let reason = refusal() { throw Refusal(reason) }
        #if KEEP_AWAKE_TEST
        if mockState >= 0 { touched = true; try setLid(true); return }
        #endif
        if assertionHeld {
            guard let properties = IOPMAssertionCopyProperties(assertion)?.takeRetainedValue() as? [String: Any],
                  (properties[kIOPMAssertionLevelKey] as? NSNumber)?.intValue == kIOPMAssertionLevelOn,
                  IOPMAssertionSetProperty(assertion, kIOPMAssertionTimeoutKey as CFString, NSNumber(value: assertionSeconds)) == kIOReturnSuccess else { throw Refusal("native-refused") }
        } else {
            let properties: [String: Any] = [kIOPMAssertionTypeKey: kIOPMAssertPreventUserIdleSystemSleep,
                kIOPMAssertionNameKey: "Cafe Code local work", kIOPMAssertionLevelKey: kIOPMAssertionLevelOn,
                kIOPMAssertionTimeoutKey: assertionSeconds, kIOPMAssertionTimeoutActionKey: kIOPMAssertionTimeoutActionRelease]
            guard IOPMAssertionCreateWithProperties(properties as CFDictionary, &assertion) == kIOReturnSuccess else { throw Refusal("native-refused") }
            assertionHeld = true
        }
        // powerd also owns this shared bit and may rewrite it when display or
        // power policy changes. A successful initial ACK is not a lease. Only
        // admitted fresh work input may reapply it; the watchdog never does.
        guard current() else { throw Refusal("native-refused") }
        touched = true; try setLid(true)
    }
    func stop(recover: Bool = false) -> Bool {
        if assertionHeld { IOPMAssertionRelease(assertion); assertionHeld = false }
        if touched || recover {
            do { try setLid(false); touched = false } catch { return false }
        }
        // This acknowledges our native reset. It does not claim physical sleep
        // or exclusive ownership of another app's shared clamshell policy.
        return true
    }
}

/** Display sleep and system sleep are different native operations. In
 * particular, suppressing clamshell system sleep need not darken the internal
 * panel when no external monitor is connected. Use the same transient request
 * as Apple's `pmset displaysleepnow`, not brightness or display configuration.
 * Those would need persistent restoration and can strand a dark display.
 * https://github.com/apple-oss-distributions/PowerManagement/blob/main/pmset/pmset.m
 */
private final class LidDisplay {
    let power: Power
    var requestedSleep = false
    var inventoryRefused = false
    var framework: UnsafeMutableRawPointer?
    init(_ power: Power) { self.power = power }
    deinit { if let framework { dlclose(framework) } }

    func refused(_ phase: String) {
        // Fixed, content-free phases only. Display control is optional; a
        // refusal must not release healthy work's separate system-sleep lease.
        switch phase {
        case "inventory": displayLog.warning("Display inventory unavailable; keeping the work lease")
        case "sleep": displayLog.warning("Display idle request refused; keeping the work lease")
        default: displayLog.warning("Display wake request refused; normal input wake remains available")
        }
        #if KEEP_AWAKE_TEST
        if mockRoot != nil { emit(["event": "test-display-refused", "phase": phase]) }
        #endif
    }

    #if KEEP_AWAKE_TEST
    func mockValue(_ name: String) -> String? {
        guard let mockRoot, let fd = try? privateFile(mockRoot + "/" + name) else { return nil }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_size >= 0, info.st_size <= 16 else { return nil }
        var bytes = [UInt8](repeating: 0, count: 17)
        let count = pread(fd, &bytes, bytes.count, 0)
        guard count >= 0, count <= 16 else { return nil }
        return String(bytes: bytes.prefix(count), encoding: .utf8)
    }
    func mockAction(_ action: String) throws {
        guard let mockRoot else { throw Refusal("native-refused") }
        let fd = try privateFile(mockRoot + "/display-state")
        defer { close(fd) }
        var byte: UInt8 = action == "sleep" ? 48 : 49
        guard pwrite(fd, &byte, 1, 0) == 1 else { throw Refusal("native-refused") }
        emit(["event": "test-display", "action": action])
    }
    #endif

    func lidClosed() -> Bool? {
        #if KEEP_AWAKE_TEST
        if mockRoot != nil {
            switch mockValue("lid-state") { case "closed": return true; case "open": return false; default: return nil }
        }
        #endif
        guard power.service != 0,
              let value = IORegistryEntryCreateCFProperty(power.service, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue(),
              CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
        return value as? Bool
    }

    func internalDisplayOnly() -> Bool {
        #if KEEP_AWAKE_TEST
        if mockRoot != nil {
            if mockValue("external-displays") == "refused" {
                if !inventoryRefused { inventoryRefused = true; refused("inventory") }
                return false
            }
            inventoryRefused = false
            return mockValue("external-displays") == "no"
        }
        #endif
        var ids = [CGDirectDisplayID](repeating: 0, count: 32)
        var count: UInt32 = 0
        guard CGGetOnlineDisplayList(UInt32(ids.count), &ids, &count) == .success,
              count <= ids.count else {
            if !inventoryRefused { inventoryRefused = true; refused("inventory") }
            return false
        }
        inventoryRefused = false
        // RequestDisplaysIdle affects all displays. Admit only an observed
        // built-in-only topology; this snapshot cannot make hotplug atomic.
        // macOS retains its ordinary clamshell handling with other monitors.
        return count > 0 && ids.prefix(Int(count)).allSatisfy { CGDisplayIsBuiltin($0) != 0 }
    }

    func modernDisplayIdle() throws -> Bool {
        #if KEEP_AWAKE_TEST
        if mockRoot != nil {
            if mockValue("display-refused") == "yes" || mockValue("display-primary-refused") == "yes" { return false }
            try mockAction("sleep"); return true
        }
        #endif
        // Newer macOS, including Apple Silicon, uses the display manager.
        // Resolve its one-shot SPI from a fixed OS framework; no PATH command
        // or detached display-control child can outlive this exact worker.
        if framework == nil {
            framework = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_LOCAL)
        }
        if let framework, let symbol = dlsym(framework, "SLSDisplayManagerRequestDisplaysIdle") {
            typealias RequestIdle = @convention(c) () -> Int32
            let request = unsafeBitCast(symbol, to: RequestIdle.self)
            return request() == CGError.success.rawValue
        }
        return false
    }

    func sleepDisplay() throws {
        if try modernDisplayIdle() { return }
        #if KEEP_AWAKE_TEST
        if mockRoot != nil {
            if mockValue("display-refused") == "yes" { throw DisplayRefusal() }
            try mockAction("sleep"); return
        }
        #endif
        // Apple's pmset retains this legacy Intel path. It requests immediate
        // display idle, including over an ordinary idle-display assertion.
        // Also try it after a refused SkyLight request, not just a missing SPI.
        let display = IORegistryEntryFromPath(kIOMainPortDefault, "IOService:/IOResources/IODisplayWrangler")
        guard display != 0 else { throw DisplayRefusal() }
        defer { IOObjectRelease(display) }
        guard IORegistryEntrySetCFProperty(display, "IORequestIdle" as CFString, kCFBooleanTrue) == KERN_SUCCESS else { throw DisplayRefusal() }
    }

    func wakeDisplay() throws {
        #if KEEP_AWAKE_TEST
        if mockRoot != nil {
            if mockValue("display-wake-refused") == "yes" { throw DisplayRefusal() }
            try mockAction("wake")
            if mockValue("display-wake-release-refused") == "yes" { throw Refusal("native-refused") }
            return
        }
        #endif
        // One pulse for our own observed closed -> open transition. Releasing
        // its ID immediately keeps no display-sleep assertion alive. This
        // powers on the screen; it does not unlock the user's session.
        var activity: IOPMAssertionID = 0
        guard IOPMAssertionDeclareUserActivity("Cafe Code lid opened" as CFString, kIOPMUserActiveLocal, &activity) == KERN_SUCCESS else { throw DisplayRefusal() }
        // A failed release differs from an unavailable wake request: retiring
        // this process must release any possibly-held user-activity assertion.
        guard IOPMAssertionRelease(activity) == KERN_SUCCESS else { throw Refusal("native-refused") }
    }

    func publishSleepOwnership(_ pending: Bool) throws {
        // Extend the existing alive envelope so an older supervisor can still
        // host a new worker. A live supervisor receives this reservation before
        // any display mutation, and drains it after a native child exit.
        guard writeBytes(1, encode(["event": "alive", "displaySleepPending": pending])) else { throw Refusal("native-refused") }
    }

    func update(current: () -> Bool) throws {
        guard current(), let closed = lidClosed() else { return }
        if !closed {
            inventoryRefused = false
            guard requestedSleep, current(), lidClosed() == false else { return }
            // Consume before native IPC so failure/retirement cannot replay a
            // wake, or continually reset idle time with an already-open lid.
            requestedSleep = false
            do { try wakeDisplay() } catch is DisplayRefusal { refused("wake"); return }
            try publishSleepOwnership(false)
        } else if !requestedSleep, internalDisplayOnly() {
            // Recheck both native time and the actual lid after display lookup.
            guard current(), lidClosed() == true else { return }
            requestedSleep = true
            try publishSleepOwnership(true)
            do { try sleepDisplay() } catch is DisplayRefusal { refused("sleep") }
            // Display transitions can change powerd's shared clamshell policy.
            // Reapply only after rechecking exact fresh work, never from a
            // stopped/expired worker or an unowned display callback.
            if current() { try power.renew(current: current) }
            // A quick open during synchronous native IPC must not leave a
            // delayed sleep request behind the user's physical open event.
            if current(), lidClosed() == false {
                requestedSleep = false
                do { try wakeDisplay() } catch is DisplayRefusal { refused("wake"); return }
                try publishSleepOwnership(false)
            }
        }
    }

    func stop() {
        // Ending work while closed must never light the closed panel. A
        // transient sleep request leaves normal input/lid wake available even
        // if both processes disappear; there is no display-disable to undo.
        if requestedSleep, lidClosed() == false {
            requestedSleep = false
            do { try wakeDisplay(); try publishSleepOwnership(false) } catch { refused("wake") }
        }
    }
}

private func signals(_ action: @escaping () -> Void) -> [DispatchSourceSignal] {
    [SIGINT, SIGTERM].map { number in
        signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
        source.setEventHandler(handler: action); source.resume(); return source
    }
}
private struct Child { let pid: pid_t; let input: Int32; let output: Int32 }
private func highPipe() throws -> [Int32] {
    var pair: [Int32] = [0, 0]
    guard pipe(&pair) == 0 else { throw Refusal("native-refused") }
    let a = fcntl(pair[0], F_DUPFD_CLOEXEC, 10), b = fcntl(pair[1], F_DUPFD_CLOEXEC, 10)
    close(pair[0]); close(pair[1])
    guard a >= 0, b >= 0 else { if a >= 0 { close(a) }; if b >= 0 { close(b) }; throw Refusal("native-refused") }
    return [a, b]
}
private func spawnWorker(_ lock: Int32) throws -> Child {
    let input = try highPipe()
    let output: [Int32]
    do { output = try highPipe() } catch { input.forEach { close($0) }; throw error }
    var actions: posix_spawn_file_actions_t?; var attributes: posix_spawnattr_t?
    posix_spawn_file_actions_init(&actions); posix_spawnattr_init(&attributes)
    defer { posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes) }
    posix_spawn_file_actions_adddup2(&actions, input[0], 0)
    posix_spawn_file_actions_adddup2(&actions, output[1], 1)
    posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0)
    // The SAME flock description survives either process, preventing a new
    // Cafe owner while an old worker can still apply a late raw override.
    posix_spawn_file_actions_adddup2(&actions, lock, 3)
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETPGROUP))
    posix_spawnattr_setpgroup(&attributes, 0)
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path
    var arguments = [executable, "--worker"]
    #if KEEP_AWAKE_TEST
    if let mockRoot { arguments += ["--mock-root", mockRoot] }
    #endif
    var pointers = arguments.map { strdup($0) } + [nil]
    defer { pointers.forEach { if let pointer = $0 { free(pointer) } } }
    var pid: pid_t = 0
    let result = posix_spawn(&pid, executable, &actions, &attributes, &pointers, environ)
    close(input[0]); close(output[1])
    guard result == 0 else { close(input[1]); close(output[0]); throw Refusal("native-refused") }
    return Child(pid: pid, input: input[1], output: output[0])
}

private final class Worker {
    let power: Power
    let display: LidDisplay
    var heartbeat = leaseNow()
    var retired = false
    var active = false
    var lines: Lines?
    var timer: DispatchSourceTimer?
    var signalSources: [DispatchSourceSignal] = []
    #if KEEP_AWAKE_TEST
    var displayTicks = 0
    #endif
    init() throws {
        var held = stat()
        guard fstat(3, &held) == 0, held.st_mode & S_IFMT == S_IFREG,
              held.st_uid == getuid(), held.st_nlink == 1 else { throw Refusal("native-refused") }
        power = try Power()
        display = LidDisplay(power)
    }
    func run() {
        lines = Lines(0, line: { [self] value in
            guard !retired, value.count == 1, value["command"] as? String == "renew",
                  leaseNow() - heartbeat < heartbeatSeconds else { stop(); return }
            heartbeat = leaseNow()
            do {
                try power.renew(current: { [self] in !self.retired && leaseNow() - self.heartbeat < heartbeatSeconds })
                #if KEEP_AWAKE_TEST
                if mockRoot != nil { emit(["event": "test-power-renewed"]) }
                #endif
                try display.update(current: { [self] in !self.retired && leaseNow() - self.heartbeat < heartbeatSeconds })
                if !active { active = true; emit(["event": "active"]) }
                emit(["event": "alive"])
            }
            catch { emit(["event": "paused", "reason": (error as? Refusal)?.reason ?? "native-refused"]); stop() }
        }, end: { [self] in stop() })
        timer = DispatchSource.makeTimerSource(queue: .main)
        timer?.schedule(deadline: .now(), repeating: .milliseconds(250))
        timer?.setEventHandler { [self] in
            if leaseNow() - heartbeat >= heartbeatSeconds { stop(); return }
            if active, let reason = power.refusal() { emit(["event": "paused", "reason": reason]); stop() }
            if active {
                do { try display.update(current: { [self] in !self.retired && leaseNow() - self.heartbeat < heartbeatSeconds }) }
                catch { emit(["event": "paused", "reason": "native-refused"]); stop() }
                #if KEEP_AWAKE_TEST
                if mockRoot != nil {
                    displayTicks += 1
                    if displayTicks % 4 == 0 { emit(["event": "test-display-tick", "tick": displayTicks]) }
                }
                #endif
            }
        }
        timer?.resume(); signalSources = signals { [self] in stop() }
        emit(["event": "ready"])
    }
    func stop() {
        guard !retired else { return }; retired = true; lines?.stop(); timer?.cancel()
        display.stop()
        let attempted = power.touched; let accepted = power.stop()
        emit(["event": "worker-stopped", "attempted": attempted, "resetAccepted": accepted])
        Darwin.exit(accepted ? 0 : 2)
    }
}

private final class Supervisor {
    let lock: Int32
    let power: Power
    var child: Child?
    var childLines: Lines?
    var parentLines: Lines?
    var timer: DispatchSourceTimer?
    var signalSources: [DispatchSourceSignal] = []
    var heartbeat = leaseNow()
    var renewed = false
    var armed = false
    var retired = false
    var stopAt: Double?
    var pauseReason: String?
    var failed = false
    var childInputClosed = false
    var workerHeartbeat = leaseNow()
    var displaySleepPending = false
    init() throws {
        var root = "/private/tmp/cafe-code-keep-awake-\(getuid())"
        #if KEEP_AWAKE_TEST
        if let mockRoot { root = mockRoot }
        #endif
        let directory = try privateDirectory(root)
        defer { close(directory) }
        let fd = try privateFile("lease.lock", relativeTo: directory)
        lock = fcntl(fd, F_DUPFD_CLOEXEC, 10); close(fd)
        guard lock >= 0 else { throw Refusal("native-refused") }
        guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { close(lock); throw Refusal("lease-busy") }
        do { power = try Power() } catch { close(lock); throw error }
    }
    func run() {
        parentLines = Lines(0, line: { [self] value in
            guard !retired, value.count == 1, let command = value["command"] as? String else { stop(); return }
            #if KEEP_AWAKE_TEST
            if command == "crash-worker", let child { killHeld(child, SIGKILL); return }
            if command == "freeze-worker", let child { killHeld(child, SIGSTOP); return }
            #endif
            // Queued old input cannot revive a lease after this loop stalled.
            guard command == "renew", leaseNow() - heartbeat < heartbeatSeconds else { stop(); return }
            heartbeat = leaseNow(); renewed = true
            if let child, armed, !childInputClosed { _ = writeBytes(child.input, encode(["command": "renew"])) }
            else if pauseReason == nil { startWorker() }
        }, end: { [self] in stop() })
        timer = DispatchSource.makeTimerSource(queue: .main)
        timer?.schedule(deadline: .now(), repeating: .milliseconds(250))
        var lastPolicy = leaseNow() - 1
        timer?.setEventHandler { [self] in
            if let child {
                var status: Int32 = 0
                var waitFlags = WNOHANG
                #if KEEP_AWAKE_TEST
                waitFlags |= WUNTRACED
                #endif
                let result = waitpid(child.pid, &status, waitFlags)
                #if KEEP_AWAKE_TEST
                // Observe the exact child's native stopped state, rather than
                // treating successful signal delivery as completed suspension.
                if result == child.pid, status & 0x7f == 0x7f {
                    emit(["event": "test-worker-frozen"]); return
                }
                #endif
                if result == child.pid { joined(child, status); return }
                if result < 0 && errno != EINTR { Darwin.exit(3) }
                if !retired && leaseNow() - workerHeartbeat >= heartbeatSeconds {
                    failed = true; stop(); return
                }
                if let stopAt, leaseNow() - stopAt >= 1 { killHeld(child, SIGKILL) }
            }
            if leaseNow() - heartbeat >= heartbeatSeconds { stop(); return }
            if leaseNow() - lastPolicy >= 1 {
                lastPolicy = leaseNow()
                let reason = power.refusal()
                if let reason, pauseReason != reason {
                    pauseReason = reason; emit(["event": "paused", "reason": reason])
                    if let child { stopAt = leaseNow(); closeChildInput(child) }
                } else if reason == nil, pauseReason != nil, child == nil, !retired, !failed {
                    pauseReason = nil; startWorker()
                }
            }
        }
        timer?.resume(); signalSources = signals { [self] in stop() }
        emit(["event": "ready"])
    }
    func startWorker() {
        guard !retired, child == nil, renewed, leaseNow() - heartbeat < heartbeatSeconds else { return }
        if let reason = power.refusal() { pauseReason = reason; emit(["event": "paused", "reason": reason]); return }
        do {
            let admitted = try spawnWorker(lock); child = admitted
            childInputClosed = false; workerHeartbeat = leaseNow()
            childLines = Lines(admitted.output, line: { [self] value in
                guard child?.pid == admitted.pid, let event = value["event"] as? String else { return }
                #if KEEP_AWAKE_TEST
                if ["test-display", "test-display-tick", "test-display-refused", "test-power-renewed"].contains(event) { emit(value); return }
                #endif
                workerHeartbeat = leaseNow()
                if event == "ready" && !retired && !armed {
                    armed = true
                    _ = writeBytes(admitted.input, encode(["command": "renew"]))
                } else if event == "active" { emit(["event": "active"]) }
                else if event == "alive" {
                    if let pending = value["displaySleepPending"] as? Bool { displaySleepPending = pending }
                }
                else if event == "worker-stopped" {
                    if value["attempted"] as? Bool == false { armed = false }
                    if value["resetAccepted"] as? Bool == false { failed = true }
                } else if event == "paused", let reason = value["reason"] as? String,
                          ["battery-low", "unknown-power", "thermal-limit"].contains(reason) {
                    pauseReason = reason; emit(["event": "paused", "reason": reason])
                } else { failed = true; stop() }
            }, end: {})
            #if KEEP_AWAKE_TEST
            if let born = birth(admitted.pid) { emit(["event": "test-worker", "pid": admitted.pid, "seconds": born.0, "micros": born.1]) }
            #endif
        } catch { failed = true; emit(["event": "paused", "reason": "native-refused"]); stop() }
    }
    func killHeld(_ admitted: Child, _ signal: Int32) {
        guard child?.pid == admitted.pid else { return }
        var status: Int32 = 0
        // Only an exact, unreaped native child. A foreign/selected Cafe PID is
        // never a control target, and no executable path is process authority.
        let result = waitpid(admitted.pid, &status, WNOHANG)
        if result == 0 { _ = Darwin.kill(admitted.pid, signal) }
        else if result == admitted.pid { joined(admitted, status) }
    }
    func joined(_ admitted: Child, _ status: Int32) {
        guard child?.pid == admitted.pid else { return }
        childLines?.drain()
        childLines?.stop(); childLines = nil
        closeChildInput(admitted); close(admitted.output); child = nil; stopAt = nil
        // Confirmed native exit precedes our reset. A late worker cannot apply
        // true after cleanup, and flock remains held through this handoff.
        if displaySleepPending {
            let recovery = LidDisplay(power)
            // Undo only this child's reserved display request, only after its
            // exact exit and only with the real lid open. Never illuminate a
            // still-closed panel during crash/timeout or low-battery cleanup.
            if recovery.lidClosed() == false {
                do { try recovery.wakeDisplay() }
                catch is DisplayRefusal { recovery.refused("wake") }
                catch { failed = true; recovery.refused("wake") }
            }
            displaySleepPending = false
        }
        let lidReset = power.stop(recover: armed); armed = false
        // A transient wake pulse changes no persistent display configuration.
        // Its refusal is not a refused raw-switch reset or a retained lease.
        let accepted = lidReset
        if !accepted { failed = true; emit(["event": "paused", "reason": "cleanup-failed"]) }
        if retired || failed || pauseReason == nil || status != 0 { finish(accepted); return }
    }
    func stop() {
        guard !retired else { return }; retired = true; parentLines?.stop()
        if let child { stopAt = leaseNow(); closeChildInput(child) }
        else { finish(power.stop(recover: armed)) }
    }
    func closeChildInput(_ admitted: Child) {
        guard child?.pid == admitted.pid, !childInputClosed else { return }
        childInputClosed = true; close(admitted.input)
    }
    func finish(_ accepted: Bool) {
        retired = true; parentLines?.stop(); childLines?.stop(); timer?.cancel()
        emit(["event": "stopped", "resetAccepted": accepted])
        close(lock); Darwin.exit(accepted && !failed ? 0 : 2)
    }
}

signal(SIGPIPE, SIG_IGN); signal(SIGHUP, SIG_IGN); umask(0o077)
guard getuid() != 0, getuid() == geteuid() else { emit(["event": "paused", "reason": "native-refused"]); Darwin.exit(1) }
do {
    #if KEEP_AWAKE_TEST
    if CommandLine.arguments.count == 5, CommandLine.arguments[1] == "--observe",
       let pid = Int32(CommandLine.arguments[2]), let seconds = UInt64(CommandLine.arguments[3]), let micros = UInt64(CommandLine.arguments[4]) {
        func live() -> Bool { guard let actual = birth(pid) else { return false }; return actual.0 == seconds && actual.1 == micros }
        if !live() { emit(["event": "retired"]); Darwin.exit(0) }
        observation = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        observation?.setEventHandler { emit(["event": "retired"]); Darwin.exit(0) }; observation?.resume()
        if !live() { emit(["event": "retired"]); Darwin.exit(0) }
        emit(["event": "observing"]); dispatchMain()
    }
    if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--inspect" {
        var copied: Unmanaged<CFDictionary>?
        guard IOPMCopyAssertionsByProcess(&copied) == kIOReturnSuccess,
              let dictionary = copied?.takeRetainedValue() as? [NSNumber: [[String: Any]]] else { throw Refusal("native-refused") }
        let active = dictionary.values.flatMap { $0 }.filter {
            $0[kIOPMAssertionNameKey] as? String == "Cafe Code local work" && ($0[kIOPMAssertionLevelKey] as? NSNumber)?.intValue == kIOPMAssertionLevelOn
        }
        emit(["event": "inspection", "count": active.count, "displayCount": active.filter { $0[kIOPMAssertionTypeKey] as? String == kIOPMAssertPreventUserIdleDisplaySleep }.count])
        Darwin.exit(0)
    }
    #else
    guard CommandLine.arguments.count == 1 || (CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--worker") else { throw Refusal("native-refused") }
    #endif
    if CommandLine.arguments.dropFirst().first == "--worker" {
        let worker = try Worker(); worker.run(); withExtendedLifetime(worker) { dispatchMain() }
    } else {
        #if !KEEP_AWAKE_TEST
        guard CommandLine.arguments.count == 1 else { throw Refusal("native-refused") }
        #endif
        _ = setpgid(0, 0)
        let supervisor = try Supervisor(); supervisor.run(); withExtendedLifetime(supervisor) { dispatchMain() }
    }
} catch { emit(["event": "paused", "reason": (error as? Refusal)?.reason ?? "native-refused"]); Darwin.exit(1) }
