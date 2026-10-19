#import <AppKit/AppKit.h>
#import <Security/Security.h>
#import <signal.h>

// Versioned, immutable responsible app for source builds. Mutable Electron and
// JavaScript stay outside this signed bundle. Do not edit a published v1 host
// in place: bump the host policy version when changing this native protocol.
static NSString *const RuntimeIdentifier = @"com.cafeai.cafecode.debug";
static const NSUInteger MaximumArgumentBytes = 65536;

@interface CafeSourceHost : NSObject <NSApplicationDelegate>
@property(nonatomic, strong) NSTask *child;
@property(nonatomic, copy) NSString *executable;
@property(nonatomic, copy) NSString *entry;
@property(nonatomic, copy) NSString *configuredHome;
@property(nonatomic, copy) NSArray<NSString *> *arguments;
@property(nonatomic, strong) NSMutableArray *signalSources;
@property(nonatomic) BOOL stopping;
@property(nonatomic) int exitCode;
@end

static BOOL AbsolutePath(NSString *value) {
  return value.length > 0 && value.length <= 16384 && value.isAbsolutePath;
}

static BOOL ValidRuntime(NSString *bundlePath) {
  NSBundle *bundle = [NSBundle bundleWithPath:bundlePath];
  if (![bundle.bundleIdentifier isEqualToString:RuntimeIdentifier]) return NO;
  SecStaticCodeRef code = NULL;
  OSStatus status = SecStaticCodeCreateWithPath((__bridge CFURLRef)bundle.bundleURL,
                                               kSecCSDefaultFlags, &code);
  if (status != errSecSuccess) return NO;
  status = SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures, NULL);
  CFRelease(code);
  return status == errSecSuccess;
}

@implementation CafeSourceHost
- (void)launchChild {
  NSString *bundlePath = [[self.executable stringByDeletingLastPathComponent]
                         stringByDeletingLastPathComponent].stringByDeletingLastPathComponent;
  if (!ValidRuntime(bundlePath)) {
    fprintf(stderr, "Cafe source host refused an invalid Debug runtime signature.\n");
    self.exitCode = 70;
    [NSApp terminate:nil];
    return;
  }
  self.child = [NSTask new];
  self.child.executableURL = [NSURL fileURLWithPath:self.executable];
  self.child.arguments = [@[self.entry] arrayByAddingObjectsFromArray:self.arguments];
  self.child.currentDirectoryURL = [NSURL fileURLWithPath:
      self.entry.stringByDeletingLastPathComponent.stringByDeletingLastPathComponent];
  NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
  [environment removeObjectForKey:@"ELECTRON_RUN_AS_NODE"];
  environment[@"CAFE_CODE_HOME"] = self.configuredHome;
  environment[@"CAFE_CODE_DATA_PROFILE"] = @"debug";
  environment[@"CAFE_CODE_MAC_SOURCE_HOST_VERSION"] = @"1";
  self.child.environment = environment;
  // open(1) supplies the private source launch logs. Keep the same descriptors
  // through native restarts, without a shell, detached proxy, or network service.
  self.child.standardInput = NSFileHandle.fileHandleWithStandardInput;
  self.child.standardOutput = NSFileHandle.fileHandleWithStandardOutput;
  self.child.standardError = NSFileHandle.fileHandleWithStandardError;
  __weak CafeSourceHost *weakSelf = self;
  self.child.terminationHandler = ^(NSTask *finished) {
    dispatch_async(dispatch_get_main_queue(), ^{
      CafeSourceHost *host = weakSelf;
      if (!host) return;
      if (!host.stopping && finished.terminationReason == NSTaskTerminationReasonExit &&
          finished.terminationStatus == 75) {
        // A profile-owned graceful restart has completed. The original native
        // app remains responsible for the new Electron child and its sockets.
        [host launchChild];
      } else {
        host.exitCode = finished.terminationStatus;
        [NSApp terminate:nil];
      }
    });
  };
  NSError *error = nil;
  if (![self.child launchAndReturnError:&error]) {
    fprintf(stderr, "Cafe source host could not launch its Debug runtime (%ld).\n", (long)error.code);
    self.exitCode = 70;
    [NSApp terminate:nil];
  }
  // Control-only launch arguments never belong to a subsequent app generation.
  self.arguments = [self.arguments filteredArrayUsingPredicate:
      [NSPredicate predicateWithBlock:^BOOL(NSString *argument, NSDictionary *bindings) {
        return ![argument isEqualToString:@"--cafe-restart-existing"];
      }]];
}

- (void)stopChild {
  self.stopping = YES;
  if (self.child.running) [self.child terminate];
  else [NSApp terminate:nil];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  NSArray<NSString *> *args = NSProcessInfo.processInfo.arguments;
  NSUInteger bytes = 0;
  for (NSString *argument in args) bytes += [argument lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
  NSString *home = NSProcessInfo.processInfo.environment[@"CAFE_CODE_HOME"];
  if (args.count < 5 || args.count > 128 || bytes > MaximumArgumentBytes ||
      ![args[1] isEqualToString:@"--cafe-source-runtime"] ||
      ![args[3] isEqualToString:@"--cafe-source-entry"] ||
      !AbsolutePath(args[2]) || !AbsolutePath(args[4]) || !AbsolutePath(home)) {
    fprintf(stderr, "Cafe source host refused an invalid source launch request.\n");
    self.exitCode = 64;
    [NSApp terminate:nil];
    return;
  }
  NSBundle *runtime = [NSBundle bundleWithPath:args[2]];
  self.executable = runtime.executableURL.path;
  self.entry = args[4];
  self.configuredHome = home;
  self.arguments = [args subarrayWithRange:NSMakeRange(5, args.count - 5)];
  if (!AbsolutePath(self.executable)) {
    self.exitCode = 64;
    [NSApp terminate:nil];
    return;
  }
  self.signalSources = [NSMutableArray new];
  for (NSNumber *number in @[@(SIGINT), @(SIGTERM), @(SIGHUP)]) {
    int signalNumber = number.intValue;
    signal(signalNumber, SIG_IGN);
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL, signalNumber, 0,
                                                      dispatch_get_main_queue());
    __weak CafeSourceHost *weakSelf = self;
    dispatch_source_set_event_handler(source, ^{ [weakSelf stopChild]; });
    [self.signalSources addObject:source];
    dispatch_resume(source);
  }
  [self launchChild];
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
  if (!self.child.running) return NSTerminateNow;
  [self stopChild];
  return NSTerminateCancel;
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSApplication *app = NSApplication.sharedApplication;
    CafeSourceHost *host = [CafeSourceHost new];
    app.delegate = host;
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [app run];
    return host.exitCode;
  }
}
