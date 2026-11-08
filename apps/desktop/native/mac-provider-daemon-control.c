/*
 * Explicit, generation-bound macOS provider-daemon control.
 *
 * The desktop owns profile admission, held recovery-file identities and the
 * native confirmation dialog. This small controller does not discover a
 * target, inspect profiles, authenticate providers, or infer permission from
 * an executable name. It captures one exact kernel task-name audit token and
 * retains it across that dialog. Only the nonce-bound command below can send
 * signals, and every signal uses the kernel's audit-token API rather than a
 * racy PID-only kill. Missing APIs or inconclusive native evidence fail closed.
 */
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <bsm/libbsm.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/proc_info.h>
#include <time.h>
#include <unistd.h>
#include <libproc.h>

#define MAX_EXECUTABLE_BYTES 4096u
#define INITIAL_FRAME_TIMEOUT_MS 5000
#define TERM_WAIT_MS 2000
#define KILL_WAIT_MS 3000

_Static_assert(sizeof(audit_token_t) == 32, "Unexpected native audit token size");
typedef int (*signal_with_token_fn)(audit_token_t *, int);
typedef int (*path_with_token_fn)(audit_token_t *, void *, uint32_t);

static unsigned char nonce[16];
static mach_port_t held_task = MACH_PORT_NULL;

static uint64_t monotonic_milliseconds(void) {
  struct timespec time;
  if (clock_gettime(CLOCK_MONOTONIC, &time) != 0) return 0;
  return (uint64_t)time.tv_sec * 1000u + (uint64_t)time.tv_nsec / 1000000u;
}

/* Input is fixed binary framing, never shell syntax or an unbounded JSON
 * decoder. An incomplete frame or parent pipe loss cannot authorize control.
 * A negative timeout is used only while awaiting the explicit dialog command. */
static bool read_exact(void *destination, size_t length, int timeout_ms) {
  unsigned char *bytes = destination;
  size_t offset = 0;
  uint64_t start = monotonic_milliseconds();
  if (start == 0) return false;
  while (offset < length) {
    int remaining = -1;
    if (timeout_ms >= 0) {
      uint64_t now = monotonic_milliseconds();
      if (now == 0 || now - start >= (uint64_t)timeout_ms) return false;
      remaining = timeout_ms - (int)(now - start);
    }
    struct pollfd input = {.fd = STDIN_FILENO, .events = POLLIN};
    int available;
    do { available = poll(&input, 1, remaining); } while (available < 0 && errno == EINTR);
    if (available <= 0 || (input.revents & (POLLERR | POLLNVAL)) != 0) return false;
    ssize_t count = read(STDIN_FILENO, bytes + offset, length - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    offset += (size_t)count;
  }
  return true;
}

static uint32_t big_endian_u32(const unsigned char *bytes) {
  return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
         ((uint32_t)bytes[2] << 8) | (uint32_t)bytes[3];
}

static uint64_t big_endian_u64(const unsigned char *bytes) {
  return ((uint64_t)big_endian_u32(bytes) << 32) | big_endian_u32(bytes + 4);
}

/* Native paths are opaque UTF-8 bytes. Reject malformed encoding rather than
 * normalize it, truncate it, or let a decoder substitute another pathname. */
static bool valid_utf8(const unsigned char *bytes, size_t length) {
  for (size_t i = 0; i < length;) {
    unsigned char first = bytes[i++];
    if (first == 0) return false;
    if (first < 0x80) continue;
    size_t count;
    uint32_t value;
    uint32_t minimum;
    if (first >= 0xc2 && first <= 0xdf) { count = 1; value = first & 0x1f; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { count = 2; value = first & 0x0f; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { count = 3; value = first & 0x07; minimum = 0x10000; }
    else return false;
    if (count > length - i) return false;
    for (size_t n = 0; n < count; n++) {
      unsigned char next = bytes[i++];
      if ((next & 0xc0) != 0x80) return false;
      value = (value << 6) | (next & 0x3f);
    }
    if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return false;
  }
  return true;
}

/* At most ready plus one terminal frame is ever emitted. All strings below
 * are fixed protocol enums, and nonce is encoded from exactly sixteen bytes.
 * No token, process ID, path, credential, native error or environment escapes. */
static bool emit(const char *phase, const char *reason) {
  static const char hexadecimal[] = "0123456789abcdef";
  char encoded_nonce[33];
  for (size_t i = 0; i < sizeof(nonce); i++) {
    encoded_nonce[i * 2] = hexadecimal[nonce[i] >> 4];
    encoded_nonce[i * 2 + 1] = hexadecimal[nonce[i] & 15];
  }
  encoded_nonce[32] = 0;
  char output[256];
  int size = reason == NULL
    ? snprintf(output, sizeof(output), "{\"version\":1,\"phase\":\"%s\",\"nonce\":\"%s\"}\n", phase, encoded_nonce)
    : snprintf(output, sizeof(output), "{\"version\":1,\"phase\":\"%s\",\"nonce\":\"%s\",\"reason\":\"%s\"}\n", phase, encoded_nonce, reason);
  if (size <= 0 || (size_t)size >= sizeof(output)) return false;
  size_t offset = 0;
  while (offset < (size_t)size) {
    ssize_t count = write(STDOUT_FILENO, output + offset, (size_t)size - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    offset += (size_t)count;
  }
  return true;
}

static int finish(const char *phase, const char *reason, int status) {
  (void)emit(phase, reason);
  if (held_task != MACH_PORT_NULL) {
    (void)mach_port_deallocate(mach_task_self(), held_task);
    held_task = MACH_PORT_NULL;
  }
  return status;
}

static bool read_bsd_identity(pid_t pid, struct proc_bsdinfo *identity) {
  memset(identity, 0, sizeof(*identity));
  int size = (int)sizeof(*identity);
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, identity, size) == size &&
    identity->pbi_pid == (uint32_t)pid && identity->pbi_uid == getuid() &&
    identity->pbi_ruid == getuid() && identity->pbi_start_tvsec > 0 &&
    identity->pbi_start_tvusec < 1000000;
}

static bool same_bsd_identity(const struct proc_bsdinfo *left, const struct proc_bsdinfo *right) {
  return left->pbi_pid == right->pbi_pid && left->pbi_uid == right->pbi_uid &&
    left->pbi_ruid == right->pbi_ruid && left->pbi_start_tvsec == right->pbi_start_tvsec &&
    left->pbi_start_tvusec == right->pbi_start_tvusec;
}

static bool read_audit_token(audit_token_t *token, pid_t expected_pid) {
  mach_msg_type_number_t words = TASK_AUDIT_TOKEN_COUNT;
  memset(token, 0, sizeof(*token));
  return task_info(held_task, TASK_AUDIT_TOKEN, (task_info_t)token, &words) == KERN_SUCCESS &&
    words == TASK_AUDIT_TOKEN_COUNT && audit_token_to_pid(*token) == expected_pid &&
    audit_token_to_euid(*token) == getuid() && audit_token_to_ruid(*token) == getuid();
}

static bool exact_path(const char *actual, int size, const unsigned char *expected, size_t length) {
  return size > 0 && (size_t)size == length && length < MAX_EXECUTABLE_BYTES &&
    actual[length] == 0 && memcmp(actual, expected, length) == 0;
}

enum generation_state { GENERATION_PRESENT, GENERATION_EXITED, GENERATION_UNKNOWN };

/* This public libproc call performs a PID-version-qualified kernel lookup.
 * Its pathname is only discarded scratch output; text never grants signal
 * authority. Only exact ESRCH proves the captured generation has disappeared.
 * proc_signal_with_audittoken deliberately cannot be polled with signal zero. */
static enum generation_state observe_generation(path_with_token_fn path_for_token, audit_token_t *token) {
  char scratch[MAX_EXECUTABLE_BYTES];
  memset(scratch, 0, sizeof(scratch));
  errno = 0;
  int size = path_for_token(token, scratch, sizeof(scratch));
  int error = errno;
  memset(scratch, 0, sizeof(scratch));
  if (size > 0 && size < (int)sizeof(scratch)) return GENERATION_PRESENT;
  return size == 0 && error == ESRCH ? GENERATION_EXITED : GENERATION_UNKNOWN;
}

static enum generation_state await_exit(path_with_token_fn path_for_token, audit_token_t *token, int allowance_ms) {
  uint64_t started = monotonic_milliseconds();
  if (started == 0) return GENERATION_UNKNOWN;
  for (;;) {
    enum generation_state state = observe_generation(path_for_token, token);
    if (state != GENERATION_PRESENT) return state;
    uint64_t now = monotonic_milliseconds();
    if (now == 0) return GENERATION_UNKNOWN;
    if (now - started >= (uint64_t)allowance_ms) return GENERATION_PRESENT;
    struct timespec pause = {.tv_sec = 0, .tv_nsec = 20000000};
    while (nanosleep(&pause, &pause) != 0 && errno == EINTR) {}
  }
}

int main(int argc, char **argv) {
  (void)argv;
  pid_t controller_parent = getppid();
  /* Losing stdout must never turn an observation-only controller into a
   * signal source through a default SIGPIPE crash or a recovery retry. */
  (void)signal(SIGPIPE, SIG_IGN);
  if (argc != 1) return finish("refused", "input-invalid", 1);
  unsigned char header[24];
  if (!read_exact(header, sizeof(header), INITIAL_FRAME_TIMEOUT_MS)) return finish("refused", "cancelled", 1);
  uint32_t raw_pid = big_endian_u32(header + 8);
  uint64_t created_micros = big_endian_u64(header + 12);
  uint32_t executable_length = big_endian_u32(header + 20);
  if (memcmp(header, "CAFEFD01", 8) != 0 || raw_pid <= 1 || raw_pid > INT_MAX ||
      raw_pid == (uint32_t)getpid() || raw_pid == (uint32_t)getppid() || created_micros == 0 ||
      executable_length == 0 || executable_length > MAX_EXECUTABLE_BYTES)
    return finish("refused", "input-invalid", 1);
  unsigned char expected_executable[MAX_EXECUTABLE_BYTES];
  if (!read_exact(expected_executable, executable_length, INITIAL_FRAME_TIMEOUT_MS) ||
      !read_exact(nonce, sizeof(nonce), INITIAL_FRAME_TIMEOUT_MS)) return finish("refused", "cancelled", 1);
  if (!valid_utf8(expected_executable, executable_length) || expected_executable[0] != '/')
    return finish("refused", "input-invalid", 1);

  signal_with_token_fn send_signal = (signal_with_token_fn)dlsym(RTLD_DEFAULT, "proc_signal_with_audittoken");
  path_with_token_fn path_for_token = (path_with_token_fn)dlsym(RTLD_DEFAULT, "proc_pidpath_audittoken");
  if (send_signal == NULL || path_for_token == NULL) return finish("refused", "unsupported", 1);
  pid_t pid = (pid_t)raw_pid;
  struct proc_bsdinfo before, after;
  if (!read_bsd_identity(pid, &before) || before.pbi_start_tvsec != created_micros / 1000000u)
    return finish("refused", "identity-mismatch", 1);
  if (task_name_for_pid(mach_task_self(), pid, &held_task) != KERN_SUCCESS || held_task == MACH_PORT_NULL)
    return finish("refused", "owner-unknown", 1);
  audit_token_t token, second_token;
  char executable[MAX_EXECUTABLE_BYTES];
  memset(executable, 0, sizeof(executable));
  if (!read_audit_token(&token, pid) ||
      !exact_path(executable, proc_pidpath(pid, executable, sizeof(executable)), expected_executable, executable_length) ||
      !read_bsd_identity(pid, &after) || !same_bsd_identity(&before, &after) ||
      !read_audit_token(&second_token, pid) || memcmp(&token, &second_token, sizeof(token)) != 0)
    return finish("refused", "identity-mismatch", 1);
  memset(executable, 0, sizeof(executable));
  if (!exact_path(executable, path_for_token(&token, executable, sizeof(executable)), expected_executable, executable_length))
    return finish("refused", "identity-mismatch", 1);
  memset(executable, 0, sizeof(executable));
  if (!emit("ready", NULL)) {
    (void)mach_port_deallocate(mach_task_self(), held_task);
    return 1;
  }

  unsigned char command[17];
  if (!read_exact(command, sizeof(command), -1)) return finish("refused", "cancelled", 1);
  unsigned char difference = 0;
  for (size_t i = 0; i < sizeof(nonce); i++) difference |= command[i + 1] ^ nonce[i];
  if (command[0] != 1 || difference != 0) return finish("refused", "input-invalid", 1);
  struct pollfd parent_input = {.fd = STDIN_FILENO, .events = POLLIN};
  if (getppid() != controller_parent ||
      (poll(&parent_input, 1, 0) > 0 && (parent_input.revents & (POLLHUP | POLLERR | POLLNVAL)) != 0))
    return finish("refused", "cancelled", 1);
  enum generation_state state = observe_generation(path_for_token, &token);
  if (state == GENERATION_EXITED) return finish("stopped", NULL, 0);
  if (state != GENERATION_PRESENT) return finish("refused", "owner-unknown", 1);
  /* The retained token is the control guarantee. Recheck native birth, UID and
   * the same task-name port after the human await; never replace this token
   * with a newer process merely because its numeric PID has been reused. */
  if (!read_bsd_identity(pid, &after) || !same_bsd_identity(&before, &after) ||
      !read_audit_token(&second_token, pid) || memcmp(&token, &second_token, sizeof(token)) != 0)
    return finish("refused", "identity-mismatch", 1);
  /* libproc returns an errno VALUE, not -1 with errno. Both operations resolve
   * and signal the same held kernel generation atomically. No kill(pid),
   * process-group signal, executable scan or privileged task-control port is
   * an acceptable fallback if this operation is refused. */
  int outcome = send_signal(&token, SIGTERM);
  if (outcome == ESRCH) return finish("stopped", NULL, 0);
  if (outcome != 0) return finish("refused", "signal-refused", 1);
  state = await_exit(path_for_token, &token, TERM_WAIT_MS);
  if (state == GENERATION_EXITED) return finish("stopped", NULL, 0);
  if (state != GENERATION_PRESENT) return finish("refused", "owner-unknown", 1);
  outcome = send_signal(&token, SIGKILL);
  if (outcome == ESRCH) return finish("stopped", NULL, 0);
  if (outcome != 0) return finish("refused", "signal-refused", 1);
  state = await_exit(path_for_token, &token, KILL_WAIT_MS);
  return state == GENERATION_EXITED ? finish("stopped", NULL, 0) : finish("refused", "exit-unconfirmed", 1);
}
