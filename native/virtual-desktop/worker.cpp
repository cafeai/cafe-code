#include "common.hpp"
#include "pointer-input.hpp"
#include "session-services.hpp"
#include "linux-dmabuf-v1-client-protocol.h"
#include "virtual-keyboard-unstable-v1-client-protocol.h"
#include "wlr-screencopy-unstable-v1-client-protocol.h"
#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"
#include "x11-input.hpp"
#include <deque>
#include <fstream>
#include <functional>
#include <gbm.h>
#include <libdrm/drm_fourcc.h>
#include <linux/input-event-codes.h>
#include <map>
#include <set>
#include <sstream>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <thread>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>

namespace cafe {
static volatile sig_atomic_t stopping = 0;
static void stop_signal(int) { stopping = 1; }
static std::string quote(const std::string &s) {
  std::string result = "'";
  for (char c : s)
    result += c == '\'' ? "'\\''" : std::string(1, c);
  return result + "'";
}
static pid_t spawn(const std::vector<std::string> &args) {
  pid_t pid = fork();
  if (pid < 0)
    throw std::runtime_error("app_launch_failed");
  if (pid == 0) {
    setsid();
    Fd null(open("/dev/null", O_RDWR));
    for (int i = 0; i < 3; i++)
      dup2(null.value, i);
    std::vector<char *> argv;
    for (auto &arg : args)
      argv.push_back(const_cast<char *>(arg.c_str()));
    argv.push_back(nullptr);
    execvp(argv[0], argv.data());
    _exit(127);
  }
  return pid;
}
static std::vector<pid_t> children(pid_t root) {
  std::vector<pid_t> result;
  std::ifstream in("/proc/" + std::to_string(root) + "/task/" +
                   std::to_string(root) + "/children");
  for (pid_t pid; in >> pid && result.size() < 4096;)
    if (pid > 1)
      result.push_back(pid);
  return result;
}
struct ProcessOwner {
  ProcessOwner() {
    if (prctl(PR_SET_CHILD_SUBREAPER, 1) < 0)
      throw std::runtime_error("process_owner_unavailable");
  }
  ~ProcessOwner() {
    // A subreaper retains even double-forked app helpers. Re-discover only our
    // descendants; never kill by an app name or an unverified persisted PID.
    auto signal_tree = [&](auto &&self, pid_t parent, int signal,
                           int depth) -> void {
      if (depth > 64)
        return;
      for (auto pid : children(parent)) {
        self(self, pid, signal, depth + 1);
        kill(pid, signal);
      }
    };
    signal_tree(signal_tree, getpid(), SIGTERM, 0);
    auto deadline = now() + 1500;
    while (now() < deadline && !children(getpid()).empty()) {
      while (waitpid(-1, nullptr, WNOHANG) > 0) {
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    signal_tree(signal_tree, getpid(), SIGKILL, 0);
    deadline = now() + 1500;
    while (now() < deadline && !children(getpid()).empty()) {
      while (waitpid(-1, nullptr, WNOHANG) > 0) {
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
  }
};
struct Frame {
  Fd fd;
  wl_buffer *buffer = nullptr;
  void *map = MAP_FAILED;
  uint32_t width = 0, height = 0, stride = 0, format = 0;
  bool inverted = false;
  gbm_bo *bo = nullptr;
  uint64_t modifier = 0;
  uint32_t offset = 0;
  int64_t sequence = 0, captured = 0;
  ~Frame() {
    if (buffer)
      wl_buffer_destroy(buffer);
    if (map != MAP_FAILED)
      munmap(map, size_t(stride) * height);
    if (bo)
      gbm_bo_destroy(bo);
  }
};
struct Peer {
  Fd socket;
  std::string role;
  explicit Peer(Fd fd) : socket(std::move(fd)) {}
  int64_t accepted = now();
  bool waiting = false;
  int64_t request_id = 0, frame_request = 0;
  std::set<std::pair<uint32_t, uint64_t>> dma_formats;
  Json observation_guard = object();
};
struct Step {
  int64_t delay;
  std::function<void()> execute;
};

class Worker {
  Json config;
  wl_display *display = nullptr;
  wl_registry *registry = nullptr;
  wl_shm *shm = nullptr;
  zwp_linux_dmabuf_v1 *dmabuf = nullptr;
  gbm_device *gbm = nullptr;
  Fd render_fd;
  zwp_linux_buffer_params_v1 *dma_params = nullptr;
  std::set<std::pair<uint32_t, uint64_t>> compositor_formats;
  uint32_t dma_format = 0, dma_width = 0, dma_height = 0;
  bool dma_disabled = false;
  std::string viewer_transfer = "shared-memory";
  wl_seat *seat = nullptr;
  wl_output *output = nullptr;
  zwlr_screencopy_manager_v1 *capture = nullptr;
  zwlr_virtual_pointer_manager_v1 *pointers = nullptr;
  zwp_virtual_keyboard_manager_v1 *keyboards = nullptr;
  zwlr_virtual_pointer_v1 *pointer = nullptr;
  zwp_virtual_keyboard_v1 *keyboard = nullptr, *physical_keyboard = nullptr;
  zwlr_screencopy_frame_v1 *copying = nullptr;
  std::unique_ptr<Frame> incoming, latest;
  xkb_context *xkb = nullptr;
  xkb_keymap *base_map = nullptr;
  std::map<int, Peer> peers;
  std::set<uint32_t> keys, buttons;
  std::deque<Step> steps;
  int action_peer = -1, viewer_peer = -1;
  int64_t action_request = 0;
  int64_t next_step = 0, capture_started = 0, last_capture = 0, sequence = 0;
  bool human = false, capture_failed = false, viewer_enabled = true,
       control_enabled = true;
  int capture_stage = 0;
  uint32_t capture_format = 0, capture_width = 0, capture_height = 0,
           capture_stride = 0;
  std::string directory, environment_path;
  pid_t sway_pid = -1;
  pid_t text_pid = -1;
  int64_t text_started = 0, control_epoch = 0;
  struct LaunchState { pid_t pid; bool exited = false; int status = 0; };
  std::map<int64_t, LaunchState> launches;
  int64_t launch_sequence = 0;
  int screen_width = 1280, screen_height = 800, screen_scale = 1,
      screen_transform = WL_OUTPUT_TRANSFORM_NORMAL;

  bool supported_display() const {
    return screen_width >= 320 && screen_height >= 320 && screen_width <= 2048 &&
           screen_height <= 2048 && screen_scale == 1 &&
           screen_transform == WL_OUTPUT_TRANSFORM_NORMAL;
  }
  void invalidate_display() {
    // A geometry change invalidates every queued coordinate, including a human
    // drag and frames already in flight. Preserve ownership but require a new
    // frame under a new epoch before either client can send more input.
    if (keyboard && pointer) cancel_action("display_changed");
    ++control_epoch;
    if (dma_params) { zwp_linux_buffer_params_v1_destroy(dma_params); dma_params = nullptr; }
    if (copying) { zwlr_screencopy_frame_v1_destroy(copying); copying = nullptr; }
    incoming.reset();
    latest.reset();
    capture_failed = false;
    if (viewer_peer >= 0) {
      auto update = status();
      put(update.get(), "event", std::string("display-changed"));
      reply(viewer_peer, std::move(update), -1, 0);
    }
  }
  void display_mode(int width, int height) {
    if (width == screen_width && height == screen_height) return;
    screen_width = width;
    screen_height = height;
    invalidate_display();
  }
  void sync_display() {
    // Sway command replies precede Wayland output events. Read the authoritative
    // mode before accepting another peer's queued action in this same loop.
    // This also covers mode changes made through unrestricted sway_command.
    auto result = sway(3);
    auto outputs = field(result.get(), "result");
    if (!outputs || !json_object_is_type(outputs, json_type_array)) throw std::runtime_error("compositor_unavailable");
    for (size_t i = 0; i < json_object_array_length(outputs); ++i) {
      auto out = json_object_array_get_idx(outputs, i);
      if (!boolean(out, "active")) continue;
      auto mode = field(out, "current_mode");
      const auto scale = json_object_get_double(field(out, "scale"));
      const auto transform = str(out, "transform");
      const int next_scale = scale == 1 ? 1 : 0;
      const int next_transform = transform == "normal" ? WL_OUTPUT_TRANSFORM_NORMAL : -1;
      if (screen_scale != next_scale || screen_transform != next_transform) {
        screen_scale = next_scale;
        screen_transform = next_transform;
        invalidate_display();
      }
      display_mode(integer(mode, "width"), integer(mode, "height"));
      return;
    }
    throw std::runtime_error("display_unavailable");
  }
  void configure_display(json_object *j, bool model) {
    // Sway's output command changes the live headless mode without restarting
    // apps: https://github.com/swaywm/sway/blob/1.12/sway/sway-output.5.scd
    if (model) require_model_control(j);
    else if (!viewer_enabled) throw std::runtime_error("control_disabled");
    const auto width = integer(j, "width"), height = integer(j, "height");
    if (width < 320 || height < 320 || width > 2048 || height > 2048)
      throw std::runtime_error("invalid_resolution");
    // Invalidate before dispatch even if acknowledgement is lost. Width/height
    // are validated integers, never raw command syntax. Scale stays at one so
    // screenshots and the virtual pointer share the same coordinate space.
    invalidate_display();
    auto result = sway(0, "output * mode " + std::to_string(width) + "x" +
                             std::to_string(height) + " scale 1 transform normal");
    auto replies = field(result.get(), "result");
    if (!replies || !json_object_is_type(replies, json_type_array) || !json_object_array_length(replies))
      throw std::runtime_error("display_unavailable");
    for (size_t i = 0; i < json_object_array_length(replies); ++i)
      if (!boolean(json_object_array_get_idx(replies, i), "success")) throw std::runtime_error("display_unavailable");
    sync_display();
    if (screen_width != width || screen_height != height || !supported_display())
      throw std::runtime_error("display_unavailable");
  }

  Json sway(uint32_t type, const std::string &command = "") {
    auto env = parse(private_file(environment_path));
    const auto socket_path = str(env.get(), "SWAYSOCK");
    // Never accept a caller's/host's socket. Even a modified environment file
    // must stay inside this incarnation and connect to our exact compositor.
    const auto prefix = directory + "/";
    if (!socket_path.starts_with(prefix) ||
        socket_path.substr(prefix.size()).find('/') != std::string::npos)
      throw std::runtime_error("invalid_socket");
    struct stat socket_info{};
    if (lstat(socket_path.c_str(), &socket_info) < 0 ||
        !S_ISSOCK(socket_info.st_mode) || socket_info.st_uid != getuid())
      throw std::runtime_error("invalid_socket");
    auto addr = address(socket_path);
    Fd ipc(socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0));
    const auto deadline = now() + 500;
    timeval timeout{0, 500000};
    setsockopt(ipc.value, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(ipc.value, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    if (connect(ipc.value, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) <
        0)
      throw std::runtime_error("compositor_unavailable");
    ucred credentials{};
    socklen_t credential_size = sizeof(credentials);
    if (getsockopt(ipc.value, SOL_SOCKET, SO_PEERCRED, &credentials, &credential_size) < 0 ||
        credentials.uid != getuid() || credentials.pid != sway_pid)
      throw std::runtime_error("invalid_socket");
    std::string message = "i3-ipc";
    uint32_t length = command.size();
    message.append(reinterpret_cast<char *>(&length), 4);
    message.append(reinterpret_cast<char *>(&type), 4);
    message += command;
    if (send(ipc.value, message.data(), message.size(), MSG_NOSIGNAL) !=
        ssize_t(message.size()))
      throw std::runtime_error("compositor_unavailable");
    auto read = [&](void *data, size_t size) {
      size_t received = 0;
      while (received < size) {
        // One absolute deadline bounds fragmented replies as well as silence;
        // per-recv timeouts alone let a trickling peer block human input forever.
        auto remaining = deadline - now();
        pollfd ready{ipc.value, POLLIN, 0};
        if (remaining <= 0 || poll(&ready, 1, int(remaining)) <= 0)
          throw std::runtime_error("compositor_unavailable");
        auto count = recv(ipc.value, static_cast<char *>(data) + received,
                          size - received, MSG_DONTWAIT);
        if (count <= 0)
          throw std::runtime_error("compositor_unavailable");
        received += count;
      }
    };
    char header[14];
    read(header, sizeof(header));
    memcpy(&length, header + 6, 4);
    uint32_t reply_type;
    memcpy(&reply_type, header + 10, 4);
    if (memcmp(header, "i3-ipc", 6) || reply_type != type || length > 2 * 1024 * 1024)
      throw std::runtime_error("compositor_unavailable");
    std::string body(length, '\0');
    read(body.data(), body.size());
    // Wrap the IPC array/object so all parsing keeps the same bounded parser.
    return parse("{\"result\":" + body + "}");
  }
  void require_model_control(json_object *j) {
    if (!control_enabled || human)
      throw std::runtime_error(human ? "human_control_active" : "control_disabled");
    if (integer(j, "controlEpoch", control_epoch) != control_epoch)
      throw std::runtime_error("observation_required");
    if (text_pid > 0 || action_peer >= 0)
      throw std::runtime_error("desktop_busy");
  }
  json_object *window_node(json_object *node, int64_t id, int depth = 0) {
    if (!node || depth > 32) return nullptr;
    if (integer(node, "id") == id) return node;
    for (const auto name : {"nodes", "floating_nodes"}) {
      auto nodes = field(node, name);
      if (!nodes || !json_object_is_type(nodes, json_type_array)) continue;
      for (size_t i = 0; i < json_object_array_length(nodes); ++i)
        if (auto found = window_node(json_object_array_get_idx(nodes, i), id, depth + 1)) return found;
    }
    return nullptr;
  }
  void check_observation_guard(json_object *guard) {
    if (!guard || !field(guard, "width")) return;
    if (integer(guard, "width") != screen_width || integer(guard, "height") != screen_height ||
        integer(guard, "controlEpoch", -1) != control_epoch)
      throw std::runtime_error("observation_required");
    if (!field(guard, "windowId")) return;
    auto tree = sway(4);
    auto node = window_node(field(tree.get(), "result"), integer(guard, "windowId"));
    if (!node || !boolean(node, "visible")) throw std::runtime_error("observation_required");
    for (const auto key : {"x", "y", "width", "height"})
      if (integer(field(node, "rect"), key, -1) != integer(field(guard, "rect"), key, -2))
        throw std::runtime_error("observation_required");
  }
  std::vector<uint32_t> key_codes(json_object *array) {
    if (!array || !json_object_is_type(array, json_type_array) ||
        !json_object_array_length(array) || json_object_array_length(array) > 8)
      throw std::runtime_error("invalid_key");
    std::vector<uint32_t> codes;
    for (size_t i = 0; i < json_object_array_length(array); ++i) {
      auto value = json_object_array_get_idx(array, i);
      if (!json_object_is_type(value, json_type_string)) throw std::runtime_error("invalid_key");
      auto symbol = xkb_keysym_from_name(json_object_get_string(value), XKB_KEYSYM_CASE_INSENSITIVE);
      uint32_t found = 0;
      for (uint32_t code = xkb_keymap_min_keycode(base_map); code <= xkb_keymap_max_keycode(base_map) && !found; ++code) {
        const xkb_keysym_t *symbols;
        auto count = xkb_keymap_key_get_syms_by_level(base_map, code, 0, 0, &symbols);
        for (int n = 0; n < count; ++n)
          if (symbols[n] == symbol && symbol != XKB_KEY_NoSymbol) found = code - 8;
      }
      if (!found) throw std::runtime_error("invalid_key");
      codes.push_back(found);
    }
    return codes;
  }
  int scratchpad_location(json_object *node, int64_t id, bool hidden = false, int depth = 0) {
    if (!node || depth > 32) return 0;
    if (str(node, "type") == "workspace") hidden = str(node, "name") == "__i3_scratch";
    if (integer(node, "id") == id) return hidden ? 2 : 1;
    for (const auto name : {"nodes", "floating_nodes"}) {
      auto children = field(node, name);
      if (!children || !json_object_is_type(children, json_type_array)) continue;
      for (size_t i = 0; i < json_object_array_length(children); ++i) {
        auto found = scratchpad_location(json_object_array_get_idx(children, i), id, hidden, depth + 1);
        if (found) return found;
      }
    }
    return 0;
  }
  bool focused_x11(json_object *node, int depth = 0) {
    if (!node || depth > 32)
      return false;
    if (boolean(node, "focused") && integer(node, "window") > 0)
      return true;
    for (const char *key : {"nodes", "floating_nodes"}) {
      auto nodes = field(node, key);
      if (!nodes || !json_object_is_type(nodes, json_type_array))
        continue;
      for (size_t i = 0; i < json_object_array_length(nodes); i++)
        if (focused_x11(json_object_array_get_idx(nodes, i), depth + 1))
          return true;
    }
    return false;
  }

  static void global(void *data, wl_registry *registry, uint32_t name,
                     const char *interface, uint32_t version) {
    auto &w = *static_cast<Worker *>(data);
    if (!strcmp(interface, "wl_shm"))
      w.shm = static_cast<wl_shm *>(
          wl_registry_bind(registry, name, &wl_shm_interface, 1));
    else if (!strcmp(interface, "zwp_linux_dmabuf_v1") && version >= 3) {
      w.dmabuf = static_cast<zwp_linux_dmabuf_v1 *>(
          wl_registry_bind(registry, name, &zwp_linux_dmabuf_v1_interface, 3));
      static const zwp_linux_dmabuf_v1_listener listener{
          [](void *data, zwp_linux_dmabuf_v1 *, uint32_t format) {
            static_cast<Worker *>(data)->compositor_formats.insert(
                {format, DRM_FORMAT_MOD_INVALID});
          },
          [](void *data, zwp_linux_dmabuf_v1 *, uint32_t format, uint32_t hi,
             uint32_t lo) {
            static_cast<Worker *>(data)->compositor_formats.insert(
                {format, (uint64_t(hi) << 32) | lo});
          }};
      zwp_linux_dmabuf_v1_add_listener(w.dmabuf, &listener, &w);
    } else if (!strcmp(interface, "wl_seat") && !w.seat)
      w.seat = static_cast<wl_seat *>(
          wl_registry_bind(registry, name, &wl_seat_interface, 1));
    else if (!strcmp(interface, "wl_output") && !w.output) {
      w.output = static_cast<wl_output *>(
          wl_registry_bind(registry, name, &wl_output_interface, std::min(version, 2u)));
      static const wl_output_listener listener{
        [](void *data, wl_output *, int32_t, int32_t, int32_t, int32_t, int32_t, const char *, const char *, int32_t transform) {
          auto &w = *static_cast<Worker *>(data);
          if (w.screen_transform != transform) { w.screen_transform = transform; w.invalidate_display(); }
        },
        [](void *data, wl_output *, uint32_t flags, int32_t width, int32_t height, int32_t) {
          if (flags & WL_OUTPUT_MODE_CURRENT) static_cast<Worker *>(data)->display_mode(width, height);
        },
        [](void *, wl_output *) {},
        [](void *data, wl_output *, int32_t scale) {
          auto &w = *static_cast<Worker *>(data);
          if (w.screen_scale != scale) { w.screen_scale = scale; w.invalidate_display(); }
        }, nullptr, nullptr
      };
      wl_output_add_listener(w.output, &listener, &w);
    }
    else if (!strcmp(interface, "zwlr_screencopy_manager_v1"))
      w.capture = static_cast<zwlr_screencopy_manager_v1 *>(wl_registry_bind(
          registry, name, &zwlr_screencopy_manager_v1_interface,
          std::min(version, 3u)));
    else if (!strcmp(interface, "zwlr_virtual_pointer_manager_v1"))
      w.pointers =
          static_cast<zwlr_virtual_pointer_manager_v1 *>(wl_registry_bind(
              registry, name, &zwlr_virtual_pointer_manager_v1_interface,
              std::min(version, 2u)));
    else if (!strcmp(interface, "zwp_virtual_keyboard_manager_v1"))
      w.keyboards =
          static_cast<zwp_virtual_keyboard_manager_v1 *>(wl_registry_bind(
              registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1));
  }
  static void removed(void *, wl_registry *, uint32_t) {}
  static void buffer(void *data, zwlr_screencopy_frame_v1 *, uint32_t format,
                     uint32_t width, uint32_t height, uint32_t stride) {
    auto &w = *static_cast<Worker *>(data);
    w.capture_format = format;
    w.capture_width = width;
    w.capture_height = height;
    w.capture_stride = stride;
    if (width < 1 || height < 1 || width > 2048 || height > 2048 ||
        stride < width * ((format == WL_SHM_FORMAT_RGB888 ||
                           format == WL_SHM_FORMAT_BGR888)
                              ? 3
                              : 4) ||
        uint64_t(stride) * height > frame_limit ||
        (format != WL_SHM_FORMAT_XRGB8888 && format != WL_SHM_FORMAT_ARGB8888 &&
         format != WL_SHM_FORMAT_XBGR8888 && format != WL_SHM_FORMAT_ABGR8888 &&
         format != WL_SHM_FORMAT_RGB888 && format != WL_SHM_FORMAT_BGR888)) {
      w.capture_failed = true;
      w.capture_stage = 1;
      return;
    }
    w.incoming = std::make_unique<Frame>();
    auto &f = *w.incoming;
    f.width = width;
    f.height = height;
    f.stride = stride;
    f.format = format;
    f.fd =
        Fd(memfd_create("cafe-desktop-frame", MFD_CLOEXEC | MFD_ALLOW_SEALING));
    auto size = size_t(stride) * height;
    if (f.fd.value < 0 || ftruncate(f.fd.value, size) < 0) {
      w.capture_failed = true;
      w.capture_stage = 2;
      return;
    }
    f.map =
        mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_SHARED, f.fd.value, 0);
    if (f.map == MAP_FAILED) {
      w.capture_failed = true;
      w.capture_stage = 3;
      return;
    }
    auto pool = wl_shm_create_pool(w.shm, f.fd.value, size);
    f.buffer =
        wl_shm_pool_create_buffer(pool, 0, width, height, stride, format);
    wl_shm_pool_destroy(pool);
    if (zwlr_screencopy_manager_v1_get_version(w.capture) < 3)
      w.copy_buffer();
  }
  static void flags(void *data, zwlr_screencopy_frame_v1 *, uint32_t flags) {
    auto &w = *static_cast<Worker *>(data);
    if (w.incoming)
      w.incoming->inverted = flags & 1;
  }
  static void ready(void *data, zwlr_screencopy_frame_v1 *frame, uint32_t,
                    uint32_t, uint32_t) {
    auto &w = *static_cast<Worker *>(data);
    zwlr_screencopy_frame_v1_destroy(frame);
    w.copying = nullptr;
    if (!w.incoming || w.capture_failed)
      return;
    auto &f = *w.incoming;
    f.sequence = ++w.sequence;
    f.captured = now();
    // Producer ownership ends at screencopy.ready. No compositor writes may
    // overlap viewer reads; every published memfd is sealed against resizing
    // and future writes, and is never recycled under a consumer.
    wl_buffer_destroy(f.buffer);
    f.buffer = nullptr;
    if (!f.bo) {
      munmap(f.map, size_t(f.stride) * f.height);
      f.map = MAP_FAILED;
      // wl_shm's producer mapping can outlive ready until destroy is
      // dispatched. FUTURE_WRITE blocks new mappings/pwrite while allowing that
      // already-owned mapping to drain. This buffer is never submitted for
      // another capture.
      if (fcntl(f.fd.value, F_ADD_SEALS,
                F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_FUTURE_WRITE |
                    F_SEAL_SEAL) < 0) {
        w.capture_failed = true;
        w.capture_stage = 5;
        return;
      }
    }
    // DMA-BUF ready carries the compositor's implicit producer fence. Never
    // recycle a buffer under a consumer; exported fd/import references keep
    // its allocation alive after our gbm_bo and wl_buffer are released.
    w.latest = std::move(w.incoming);
  }
  static void failed(void *data, zwlr_screencopy_frame_v1 *frame) {
    auto &w = *static_cast<Worker *>(data);
    zwlr_screencopy_frame_v1_destroy(frame);
    w.copying = nullptr;
    if (w.incoming && w.incoming->bo)
      w.dma_disabled = true;
    w.incoming.reset();
    w.capture_failed = true;
    w.capture_stage = 4;
  }
  static void damage(void *, zwlr_screencopy_frame_v1 *, uint32_t, uint32_t,
                     uint32_t, uint32_t) {}
  static void dma(void *data, zwlr_screencopy_frame_v1 *, uint32_t format,
                  uint32_t width, uint32_t height) {
    auto &w = *static_cast<Worker *>(data);
    w.dma_format = format;
    w.dma_width = width;
    w.dma_height = height;
  }
  static void buffer_done(void *data, zwlr_screencopy_frame_v1 *) {
    static_cast<Worker *>(data)->copy_buffer();
  }
  void copy_buffer() {
    bool passive = true;
    for (auto &[fd, peer] : peers)
      if (peer.waiting && peer.role != "viewer")
        passive = false;
    // Observations always use the independent PNG/shared-memory path. Viewers
    // negotiate only one-plane RGB modifiers both EGL and Sway can import.
    if (passive && !dma_disabled && dmabuf && gbm && viewer_peer >= 0 &&
        dma_format && dma_width > 0 && dma_width <= 2048 && dma_height > 0 &&
        dma_height <= 2048) {
      auto &formats = peers.at(viewer_peer).dma_formats;
      std::vector<uint64_t> modifiers;
      for (auto [format, modifier] : formats)
        if (format == dma_format && modifier != DRM_FORMAT_MOD_INVALID &&
            compositor_formats.count({format, modifier}))
          modifiers.push_back(modifier);
      if (!modifiers.empty()) {
        auto bo = gbm_bo_create_with_modifiers2(
            gbm, dma_width, dma_height, dma_format, modifiers.data(),
            modifiers.size(), GBM_BO_USE_RENDERING);
        if (bo && gbm_bo_get_plane_count(bo) == 1) {
          auto frame = std::make_unique<Frame>();
          frame->bo = bo;
          frame->fd = Fd(gbm_bo_get_fd(bo));
          frame->width = dma_width;
          frame->height = dma_height;
          frame->format = dma_format;
          frame->modifier = gbm_bo_get_modifier(bo);
          frame->stride = gbm_bo_get_stride_for_plane(bo, 0);
          frame->offset = gbm_bo_get_offset(bo, 0);
          if (frame->fd.value >= 0 && frame->stride >= frame->width * 4 &&
              uint64_t(frame->stride) * frame->height + frame->offset <=
                  frame_limit) {
            incoming = std::move(frame);
            dma_params = zwp_linux_dmabuf_v1_create_params(dmabuf);
            static const zwp_linux_buffer_params_v1_listener listener{
                [](void *data, zwp_linux_buffer_params_v1 *params,
                   wl_buffer *buffer) {
                  auto &w = *static_cast<Worker *>(data);
                  w.dma_params = nullptr;
                  zwp_linux_buffer_params_v1_destroy(params);
                  w.incoming->buffer = buffer;
                  zwlr_screencopy_frame_v1_copy(w.copying, buffer);
                },
                [](void *data, zwp_linux_buffer_params_v1 *params) {
                  auto &w = *static_cast<Worker *>(data);
                  w.dma_params = nullptr;
                  zwp_linux_buffer_params_v1_destroy(params);
                  w.dma_disabled = true;
                  failed(&w, w.copying);
                }};
            zwp_linux_buffer_params_v1_add_listener(dma_params, &listener,
                                                    this);
            zwp_linux_buffer_params_v1_add(dma_params, incoming->fd.value, 0,
                                           incoming->offset, incoming->stride,
                                           incoming->modifier >> 32,
                                           incoming->modifier & 0xffffffff);
            zwp_linux_buffer_params_v1_create(dma_params, incoming->width,
                                              incoming->height,
                                              incoming->format, 0);
            return;
          }
        } else if (bo)
          gbm_bo_destroy(bo);
      }
    }
    if (incoming && !capture_failed)
      zwlr_screencopy_frame_v1_copy(copying, incoming->buffer);
  }
  void begin_capture() {
    if (copying)
      return;
    capture_failed = false;
    capture_stage = 0;
    dma_format = 0;
    capture_started = last_capture = now();
    copying = zwlr_screencopy_manager_v1_capture_output(capture, 1, output);
    static const zwlr_screencopy_frame_v1_listener listener{
        buffer, flags, ready, failed, damage, dma, buffer_done};
    zwlr_screencopy_frame_v1_add_listener(copying, &listener, this);
  }
  void install_keymap(const std::string &text) {
    Fd fd(memfd_create("cafe-desktop-keymap", MFD_CLOEXEC));
    std::string map = text;
    map += '\0';
    if (fd.value < 0 || ftruncate(fd.value, map.size()) < 0 ||
        write(fd.value, map.data(), map.size()) != ssize_t(map.size()))
      throw std::runtime_error("input_unavailable");
    zwp_virtual_keyboard_v1_keymap(keyboard, 1, fd.value, map.size());
  }
  void default_keymap() {
    if (physical_keyboard && keyboard != physical_keyboard) {
      zwp_virtual_keyboard_v1_destroy(keyboard);
      keyboard = physical_keyboard;
    }
    char *text = xkb_keymap_get_as_string(base_map, XKB_KEYMAP_FORMAT_TEXT_V1);
    if (!text)
      throw std::runtime_error("input_unavailable");
    std::string map(text);
    free(text);
    install_keymap(map);
  }
  void key(uint32_t code, bool down) {
    if (code > 247)
      throw std::runtime_error("invalid_key");
    zwp_virtual_keyboard_v1_key(keyboard, now(), code, down ? 1 : 0);
    if (down)
      keys.insert(code);
    else
      keys.erase(code);
    uint32_t modifiers = 0;
    if (keys.count(KEY_LEFTSHIFT) || keys.count(KEY_RIGHTSHIFT))
      modifiers |= 1u << xkb_keymap_mod_get_index(base_map, XKB_MOD_NAME_SHIFT);
    if (keys.count(KEY_LEFTCTRL) || keys.count(KEY_RIGHTCTRL))
      modifiers |= 1u << xkb_keymap_mod_get_index(base_map, XKB_MOD_NAME_CTRL);
    if (keys.count(KEY_LEFTALT) || keys.count(KEY_RIGHTALT))
      modifiers |= 1u << xkb_keymap_mod_get_index(base_map, XKB_MOD_NAME_ALT);
    if (keys.count(KEY_LEFTMETA) || keys.count(KEY_RIGHTMETA))
      modifiers |= 1u << xkb_keymap_mod_get_index(base_map, XKB_MOD_NAME_LOGO);
    zwp_virtual_keyboard_v1_modifiers(keyboard, modifiers, 0, 0, 0);
  }
  void button(uint32_t code, bool down) {
    if (code < BTN_LEFT || code > BTN_TASK)
      throw std::runtime_error("invalid_button");
    zwlr_virtual_pointer_v1_button(pointer, now(), code, down ? 1 : 0);
    zwlr_virtual_pointer_v1_frame(pointer);
    if (down)
      buttons.insert(code);
    else
      buttons.erase(code);
  }
  void release() {
    for (auto code : std::set<uint32_t>(keys))
      key(code, false);
    for (auto code : std::set<uint32_t>(buttons))
      button(code, false);
    if (display)
      wl_display_flush(display);
  }
  void cancel_action(const std::string &reason) {
    steps.clear();
    if (text_pid > 0) {
      kill(text_pid, SIGTERM);
      // A child normally restores its XKB map within 100 ms. Do not wait on
      // the capture loop; run() reaps it and applies a bounded kill backstop.
      text_started = now() - 39800;
    }
    release();
    default_keymap();
    if (action_peer >= 0)
      reply(action_peer, error(reason), -1, action_request);
    action_peer = -1;
  }
  void reply(int peer, Json response, int fd = -1, int64_t request = -1) {
    put(response.get(), "requestId",
        request >= 0 ? request
                     : (peers.count(peer) ? peers.at(peer).request_id : 0));
    try {
      send_packet(peer, response.get(), fd);
    } catch (...) {
      shutdown(peer,
               SHUT_RDWR); /* close on next poll; no payload diagnostics */
    }
  }
  Json status() {
    auto j = ok();
    put(j.get(), "displayConfiguration", true);
    put(j.get(), "observationGuards", true);
    put(j.get(), "actionValidation", true);
    put(j.get(), "launchTracking", true);
    put(j.get(), "width", int64_t(screen_width));
    put(j.get(), "height", int64_t(screen_height));
    put(j.get(), "relativePointer", true);
    put(j.get(), "humanControl", human);
    put(j.get(), "controlEpoch", control_epoch);
    put(j.get(), "viewerOpen", viewer_peer >= 0);
    put(j.get(), "transfer", viewer_transfer);
    put(j.get(), "renderer", str(config.get(), "renderer"));
    put(j.get(), "frame", sequence);
    put(j.get(), "pid", int64_t(getpid()));
    put(j.get(), "swayPid", int64_t(sway_pid));
    return j;
  }
  void change_control(bool human_owner) {
    cancel_action("input_cancelled");
    human = human_owner;
    ++control_epoch;
    // Publish immediately, independent of frame capture. Viewer input already
    // queued under the old epoch cannot reacquire control or release new keys.
    if (viewer_peer >= 0) {
      auto update = status();
      put(update.get(), "event", std::string("control-changed"));
      reply(viewer_peer, std::move(update), -1, 0);
    }
  }
  void position(json_object *j) {
    auto x = integer(j, "x", -1), y = integer(j, "y", -1);
    if (!supported_display() || !latest) throw std::runtime_error("observation_required");
    auto width = screen_width, height = screen_height;
    if (x < 0 || y < 0 || x >= width || y >= height)
      throw std::runtime_error("invalid_coordinates");
    zwlr_virtual_pointer_v1_motion_absolute(pointer, now(), x, y, width,
                                            height);
    zwlr_virtual_pointer_v1_frame(pointer);
  }
  void type(const std::string &text) {
    if (text.size() > 16384)
      throw std::runtime_error("text_too_large");
    std::vector<uint32_t> chars;
    for (size_t i = 0; i < text.size();) {
      unsigned char c = text[i++];
      uint32_t value = c;
      int more = 0;
      if (c >= 0xf0) {
        value = c & 7;
        more = 3;
      } else if (c >= 0xe0) {
        value = c & 15;
        more = 2;
      } else if (c >= 0xc0) {
        value = c & 31;
        more = 1;
      } else if (c >= 128)
        throw std::runtime_error("invalid_text");
      for (int k = 0; k < more; k++) {
        if (i >= text.size() ||
            (static_cast<unsigned char>(text[i]) & 0xc0) != 0x80)
          throw std::runtime_error("invalid_text");
        value = (value << 6) | (text[i++] & 63);
      }
      if ((more == 1 && value < 0x80) || (more == 2 && value < 0x800) ||
          (more == 3 && (value < 0x10000 || c > 0xf4)) ||
          (value < 32 && value != 9 && value != 10 && value != 13) ||
          value == 127 || value > 0x10ffff ||
          (value >= 0xd800 && value <= 0xdfff) || chars.size() >= 4096)
        throw std::runtime_error("invalid_text");
      chars.push_back(value);
    }
    if (chars.empty()) {
      steps.push_back({0, [] {}});
      return;
    }
    const bool ascii = std::all_of(chars.begin(), chars.end(),
                                   [](uint32_t c) { return c < 128; });
    if (ascii) {
      default_keymap();
      release();
      for (auto cp : chars) {
        auto symbol = cp == 10 || cp == 13 ? XKB_KEY_Return
                      : cp == 9            ? XKB_KEY_Tab
                                           : xkb_utf32_to_keysym(cp);
        uint32_t found = 0;
        bool shifted = false;
        for (uint32_t code = xkb_keymap_min_keycode(base_map);
             code <= xkb_keymap_max_keycode(base_map) && !found; code++) {
          for (uint32_t level = 0; level < 2 && !found; level++) {
            const xkb_keysym_t *symbols;
            auto count = xkb_keymap_key_get_syms_by_level(base_map, code, 0,
                                                          level, &symbols);
            for (int n = 0; n < count; n++)
              if (symbols[n] == symbol) {
                found = code - 8;
                shifted = level == 1;
              }
          }
        }
        if (!found)
          throw std::runtime_error("invalid_text");
        steps.push_back({0, [this, found, shifted] {
                           if (shifted)
                             key(KEY_LEFTSHIFT, true);
                           key(found, true);
                         }});
        steps.push_back({8, [this, found, shifted] {
                           key(found, false);
                           if (shifted)
                             key(KEY_LEFTSHIFT, false);
                         }});
      }
      return;
    }
    auto tree = sway(4);
    if (focused_x11(field(tree.get(), "result"))) {
      if (text_pid > 0)
        throw std::runtime_error("desktop_busy");
      release();
      default_keymap();
      wl_display_roundtrip(display);
      auto env = parse(private_file(environment_path));
      const auto name = str(env.get(), "DISPLAY");
      if (name.empty())
        throw std::runtime_error("input_unavailable");
      text_pid = fork();
      if (text_pid < 0)
        throw std::runtime_error("input_unavailable");
      if (text_pid == 0)
        _exit(type_x11(name, chars));
      text_started = now();
      return;
    }
    // A bounded batch keymap follows the virtual-keyboard protocol used by
    // wtype. Keep it installed until the final key release; replacing a map
    // for every character races Xwayland's asynchronous XKB propagation.
    // https://github.com/atx/wtype/blob/master/main.c
    for (size_t offset = 0; offset < chars.size(); offset += 200) {
      const auto count = std::min(size_t(200), chars.size() - offset);
      std::string codes =
                      "xkb_keymap { xkb_keycodes { minimum=8; maximum=255; ",
                  symbols = "xkb_symbols { ";
      for (size_t i = 0; i < count; i++) {
        auto cp = chars[offset + i];
        char symbol[64];
        auto sym = (cp == 10 || cp == 13) ? XKB_KEY_Return
                   : cp == 9              ? XKB_KEY_Tab
                                          : xkb_utf32_to_keysym(cp);
        if (sym == XKB_KEY_NoSymbol ||
            xkb_keysym_get_name(sym, symbol, sizeof(symbol)) <= 0)
          throw std::runtime_error("invalid_text");
        auto name = "K" + std::to_string(i + 1);
        codes += "<" + name + ">=" + std::to_string(i + 9) + ";";
        symbols += "key <" + name + "> { [ " + symbol + " ] };";
      }
      auto map = codes +
                 "};xkb_types { include \"complete\" };xkb_compatibility { "
                 "include \"complete\" };" +
                 symbols + "};};";
      steps.push_back(
          {0, [this, map] {
             release();
             if (keyboard != physical_keyboard)
               zwp_virtual_keyboard_v1_destroy(keyboard);
             keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(
                 keyboards, seat);
             install_keymap(map);
           }});
      for (size_t i = 0; i < count; i++) {
        auto code = uint32_t(i + 1);
        steps.push_back({i == 0 ? 50 : 0, [this, code] {
                           zwp_virtual_keyboard_v1_key(keyboard, now(), code,
                                                       1);
                           keys.insert(code);
                         }});
        steps.push_back({8, [this, code] {
                           zwp_virtual_keyboard_v1_key(keyboard, now(), code,
                                                       0);
                           keys.erase(code);
                         }});
      }
    }
    steps.push_back({50, [this] { default_keymap(); }});
  }

  void action(int fd, json_object *j, bool is_viewer) {
    if (!(is_viewer ? viewer_enabled : control_enabled))
      throw std::runtime_error("control_disabled");
    auto kind = str(j, "kind");
    if (is_viewer && (!human || integer(j, "controlEpoch", -1) != control_epoch)) {
      reply(fd, error("viewer_control_required"));
      return;
    }
    if (is_viewer && kind == "release") {
      // A passive viewer losing focus must not release keys held by Codex.
      // Human focus loss, however, cancels queued typing immediately.
      if (human)
        cancel_action("input_cancelled");
      reply(fd, ok());
      return;
    }
    if (!is_viewer && human) {
      reply(fd, error("human_control_active"));
      return;
    }
    if (!is_viewer &&
        integer(j, "controlEpoch", control_epoch) != control_epoch)
      throw std::runtime_error("observation_required");
    if (!is_viewer) check_observation_guard(field(j, "observationGuard"));
    if (text_pid > 0) {
      reply(fd, error("desktop_busy"));
      return;
    }
    if (!is_viewer && action_peer >= 0) {
      reply(fd, error("desktop_busy"));
      return;
    }
    if (kind == "release") {
      release();
      reply(fd, ok());
      return;
    }
    if (!supported_display() || !latest) throw std::runtime_error("observation_required");
    if (kind == "move") {
      position(j);
      reply(fd, ok());
      return;
    }
    if (kind == "relative-move" && is_viewer) {
      const auto dx = relative_motion(j, "dx256"), dy = relative_motion(j, "dy256");
      // Sway converts absolute positions to deltas from its cursor location.
      // A captured app holds that location fixed, so absolute viewer positions
      // produce cumulative/drifting input (Looking Glass B7/Xwayland). Send
      // actual displacement instead, independent of pointer lock or warping.
      // https://github.com/swaywm/sway/blob/1.12/sway/input/cursor.c
      zwlr_virtual_pointer_v1_motion(pointer, now(), dx, dy);
      zwlr_virtual_pointer_v1_frame(pointer);
      reply(fd, ok());
      return;
    }
    if (kind == "button" && is_viewer) {
      if (!boolean(j, "relative")) position(j);
      button(integer(j, "button", BTN_LEFT), boolean(j, "down"));
      reply(fd, ok());
      return;
    }
    if (kind == "keycode" && is_viewer) {
      key(integer(j, "keycode"), boolean(j, "down"));
      reply(fd, ok());
      return;
    }
    if (kind == "scroll") {
      auto amount = integer(j, "amount");
      if (amount < -100 || amount > 100)
        throw std::runtime_error("invalid_scroll");
      zwlr_virtual_pointer_v1_axis_source(pointer,
                                          WL_POINTER_AXIS_SOURCE_WHEEL);
      zwlr_virtual_pointer_v1_axis_discrete(
          pointer, now(), boolean(j, "horizontal") ? 1 : 0,
          wl_fixed_from_double(amount * 15), amount);
      zwlr_virtual_pointer_v1_frame(pointer);
      reply(fd, ok());
      return;
    }
    if (action_peer >= 0)
      cancel_action("input_cancelled");
    action_peer = fd;
    action_request = peers.at(fd).request_id;
    next_step = now();
    if (kind == "click") {
      position(j);
      auto code = integer(j, "button", BTN_LEFT);
      if (code < BTN_LEFT || code > BTN_TASK)
        throw std::runtime_error("invalid_button");
      steps.push_back({0, [this, code] { button(code, true); }});
      steps.push_back({30, [this, code] { button(code, false); }});
    } else if (kind == "drag") {
      auto x = integer(j, "toX", -1), y = integer(j, "toY", -1);
      position(j);
      if (x < 0 || y < 0 || x >= screen_width || y >= screen_height)
        throw std::runtime_error("invalid_coordinates");
      steps.push_back({0, [this] { button(BTN_LEFT, true); }});
      steps.push_back({40, [this, x, y] {
                         auto p = object();
                         put(p.get(), "x", x);
                         put(p.get(), "y", y);
                         position(p.get());
                       }});
      steps.push_back({40, [this] { button(BTN_LEFT, false); }});
    } else if (kind == "text") {
      type(str(j, "text"));
    } else if (kind == "key") {
      auto codes = key_codes(field(j, "keys"));
      steps.push_back({0, [this, codes] {
                         for (auto code : codes)
                           key(code, true);
                       }});
      steps.push_back({30, [this, codes] {
                         for (auto i = codes.rbegin(); i != codes.rend(); ++i)
                           key(*i, false);
                       }});
    } else
      throw std::runtime_error("invalid_action");
  }
  void handle(int fd) {
    auto p = receive_packet(fd);
    if (p.fd.value >= 0)
      throw std::runtime_error("invalid_request");
    auto j = p.json.get();
    auto method = str(j, "method");
    auto &peer = peers.at(fd);
    peer.request_id = integer(j, "requestId", 0);
    if (peer.role.empty()) {
      auto role = str(j, "role");
      if (method != "hello" || integer(j, "protocol") != 1 ||
          (role != "manager" && role != "viewer") ||
          !equal_secret(
              str(j, "token"),
              str(config.get(), role == "viewer" ? "viewerToken" : "token")))
        throw std::runtime_error("not_authorized");
      if (role == "viewer" && viewer_peer >= 0) {
        reply(fd, error("viewer_already_connected"));
        return;
      }
      peer.role = role;
      if (role == "viewer")
        viewer_peer = fd;
      reply(fd, ok());
      return;
    }
    bool viewer = peer.role == "viewer";
    if (method == "status") {
      reply(fd, status());
      return;
    }
    if (viewer && !viewer_enabled)
      throw std::runtime_error("control_disabled");
    if (method == "frame" || (!viewer && method == "observe")) {
      if (!viewer) {
        auto guard = field(j, "observationGuard");
        check_observation_guard(guard);
        peer.observation_guard = guard ? take(json_object_get(guard)) : object();
      }
      if (viewer) {
        peer.dma_formats.clear();
        auto formats = field(j, "dmaFormats");
        if (formats && json_object_is_type(formats, json_type_array) &&
            json_object_array_length(formats) <= 128)
          for (size_t i = 0; i < json_object_array_length(formats); i++) {
            auto value = json_object_array_get_idx(formats, i);
            peer.dma_formats.insert(
                {uint32_t(integer(value, "format")),
                 (uint64_t(uint32_t(integer(value, "hi"))) << 32) |
                     uint32_t(integer(value, "lo"))});
          }
        viewer_transfer = str(j, "presentedTransfer") == "dma-buf"
                              ? "dma-buf"
                              : "shared-memory";
      }
      peer.waiting = true;
      peer.frame_request = peer.request_id;
      begin_capture();
      return;
    }
    if (method == "act") {
      action(fd, j, viewer);
      return;
    }
    if (!viewer && method == "validate_actions") {
      require_model_control(j);
      check_observation_guard(field(j, "observationGuard"));
      auto actions = field(j, "actions");
      if (!actions || !json_object_is_type(actions, json_type_array) ||
          !json_object_array_length(actions) || json_object_array_length(actions) > 24)
        throw std::runtime_error("invalid_action");
      // Resolve every key before step one. Schema/byte/coordinate validation
      // also happens in the manager; this catches valid-looking unknown XKB
      // names before an earlier click can have an effect.
      for (size_t i = 0; i < json_object_array_length(actions); ++i) {
        auto step = json_object_array_get_idx(actions, i);
        if (str(step, "kind") == "key") key_codes(field(step, "keys"));
      }
      reply(fd, ok());
      return;
    }
    if (!viewer && method == "launch_status") {
      auto entry = launches.find(integer(j, "launchId"));
      auto response = ok();
      if (entry == launches.end()) put(response.get(), "state", std::string("unknown"));
      else {
        auto &launch = entry->second;
        put(response.get(), "state", std::string(launch.exited ? "exited" : "running"));
        if (launch.exited && WIFEXITED(launch.status)) put(response.get(), "exitCode", int64_t(WEXITSTATUS(launch.status)));
        if (launch.exited && WIFSIGNALED(launch.status)) put(response.get(), "signal", int64_t(WTERMSIG(launch.status)));
      }
      reply(fd, std::move(response));
      return;
    }
    if (method == "take-control" || method == "return-control") {
      if (viewer && integer(j, "controlEpoch", -1) != control_epoch)
        throw std::runtime_error("observation_required");
      if (!viewer && !control_enabled)
        throw std::runtime_error("control_disabled");
      // Only a named ownership request changes the owner. Motion, focus,
      // releases and all ordinary input remain powerless to claim the desktop.
      change_control(viewer && method == "take-control");
      reply(fd, status());
      return;
    }
    if (viewer)
      throw std::runtime_error("not_authorized");
    if (method == "policy") {
      viewer_enabled = boolean(j, "viewerEnabled");
      control_enabled = boolean(j, "controlEnabled");
      if (!control_enabled && !human)
        cancel_action("control_disabled");
      if (!viewer_enabled && viewer_peer >= 0) {
        auto m = error("control_disabled");
        reply(viewer_peer, std::move(m));
        close_peer(viewer_peer);
      }
      reply(fd, ok());
      return;
    }
    if (method == "cancel") {
      if (!human)
        cancel_action("input_cancelled");
      reply(fd, ok());
      return;
    }
    if (method == "show") {
      if (viewer_peer >= 0) {
        auto m = object();
        put(m.get(), "event", std::string("show"));
        reply(viewer_peer, std::move(m));
      }
      reply(fd, status());
      return;
    }
    if (method == "terminate") {
      reply(fd, ok());
      stopping = 1;
      return;
    }
    if (method == "set-display" || method == "configure-display") {
      configure_display(j, method == "set-display");
      auto result = status();
      put(result.get(), "observeBeforeActing", true);
      reply(fd, std::move(result));
      return;
    }
    if (method == "focus") {
      require_model_control(j);
      auto id = integer(j, "windowId");
      if (id <= 0)
        throw std::runtime_error("invalid_window");
      auto response = sway(0, "[con_id=" + std::to_string(id) + "] focus");
      auto results = field(response.get(), "result");
      if (!results || !json_object_is_type(results, json_type_array) ||
          !json_object_array_length(results) ||
          !boolean(json_object_array_get_idx(results, 0), "success"))
        throw std::runtime_error("invalid_window");
      reply(fd, ok());
      return;
    }
    if (method == "sway_command") {
      require_model_control(j);
      const auto command = str(j, "command");
      if (command.empty() || command.size() > 8192 || command.find('\0') != std::string::npos)
        throw std::runtime_error("invalid_command");
      if (field(j, "restoreWindowId")) {
        auto id = integer(j, "restoreWindowId");
        if (id <= 0 || command != "[con_id=" + std::to_string(id) + "] scratchpad show")
          throw std::runtime_error("invalid_command");
        // GET_TREE's __i3_scratch workspace is synthetic; criteria workspace=
        // cannot match it. Make dedicated restore safe to repeat without turning
        // a visible window back into a hidden one. Raw syntax retains Sway semantics.
        auto tree = sway(4);
        auto location = scratchpad_location(field(tree.get(), "result"), id);
        if (!location) throw std::runtime_error("invalid_window");
        if (location == 1) {
          auto out = ok();
          put(out.get(), "success", true);
          put(out.get(), "unchanged", true);
          json_object_object_add(out.get(), "results", json_object_new_array());
          reply(fd, std::move(out));
          return;
        }
      }
      // RUN_COMMAND is intentionally unrestricted, including exec/exit. The
      // session's full desktop capability authorizes this; no shell wrapper,
      // caller-selected socket, hidden retry, or inferred success is involved.
      // Sway's array describes partial execution (sway-ipc(7), RUN_COMMAND).
      auto response = sway(0, command);
      sync_display();
      auto results = field(response.get(), "result");
      if (!results || !json_object_is_type(results, json_type_array) || !json_object_array_length(results))
        throw std::runtime_error("compositor_unavailable");
      auto out = ok();
      auto retained = json_object_new_array();
      json_object_object_add(out.get(), "results", retained);
      bool success = true, any_success = false, truncated = false;
      size_t bytes = 0, total = json_object_array_length(results);
      for (size_t i = 0; i < total; ++i) {
        auto result = json_object_array_get_idx(results, i);
        const bool completed = boolean(result, "success");
        success = success && completed;
        any_success = any_success || completed;
        bytes += encode(result).size();
        if (i >= 128 || bytes > 60 * 1024) { truncated = true; continue; }
        json_object_array_add(retained, json_object_get(result));
      }
      put(out.get(), "success", success);
      put(out.get(), "partialFailure", !success && any_success);
      put(out.get(), "truncated", truncated);
      put(out.get(), "totalResults", int64_t(total));
      put(out.get(), "observeBeforeRetry", !success || truncated);
      reply(fd, std::move(out));
      return;
    }
    if (method == "launch") {
      require_model_control(j);
      auto command = str(j, "command");
      auto args = field(j, "args");
      if (command.empty() || command.size() > 4096 ||
          command.find('\0') != std::string::npos || !args ||
          !json_object_is_type(args, json_type_array) ||
          json_object_array_length(args) > 64)
        throw std::runtime_error("invalid_command");
      std::vector<std::string> argv{command};
      for (size_t i = 0; i < json_object_array_length(args); i++) {
        auto arg = json_object_array_get_idx(args, i);
        if (!json_object_is_type(arg, json_type_string) ||
            json_object_get_string_len(arg) > 8192)
          throw std::runtime_error("invalid_command");
        std::string value(json_object_get_string(arg), json_object_get_string_len(arg));
        if (value.find('\0') != std::string::npos)
          throw std::runtime_error("invalid_command");
        argv.push_back(std::move(value));
      }
      auto env = parse(private_file(environment_path));
      json_object_object_foreach(env.get(), key, value) {
        setenv(key, json_object_get_string(value), 1);
      }
      pid_t child = spawn(argv);
      // Track only our direct child and its waitpid result, never by process
      // name or a recycled PID. A launcher may fork, so exit alone does not
      // prove that its application failed. The manager also waits for windows.
      const auto launch_id = ++launch_sequence;
      launches.emplace(launch_id, LaunchState{child});
      while (launches.size() > 64) launches.erase(launches.begin());
      auto response = ok();
      put(response.get(), "pid", int64_t(child));
      put(response.get(), "launchId", launch_id);
      reply(fd, std::move(response));
      return;
    }
    throw std::runtime_error("unknown_method");
  }
  void close_peer(int fd) {
    if (action_peer == fd)
      cancel_action("input_cancelled");
    if (viewer_peer == fd) {
      if (human) {
        release();
        ++control_epoch;
      }
      human = false;
      viewer_peer = -1;
    }
    peers.erase(fd);
  }

public:
  explicit Worker(Json c)
      : config(std::move(c)), directory(str(config.get(), "directory")),
        environment_path(directory + "/environment.json") {}
  ~Worker() {
    if (keyboard && pointer)
      release();
    if (dma_params)
      zwp_linux_buffer_params_v1_destroy(dma_params);
    incoming.reset();
    latest.reset();
    if (gbm)
      gbm_device_destroy(gbm);
    if (copying)
      zwlr_screencopy_frame_v1_destroy(copying);
    incoming.reset();
    latest.reset();
    if (base_map)
      xkb_keymap_unref(base_map);
    if (xkb)
      xkb_context_unref(xkb);
    if (display)
      wl_display_disconnect(display);
  }
  int run() {
    const auto helper = str(config.get(), "helper");
    const auto sway = str(config.get(), "sway");
    if (directory.empty() || helper.empty() || sway.empty())
      throw std::runtime_error("invalid_bootstrap");
    screen_width = integer(config.get(), "width", 1280);
    screen_height = integer(config.get(), "height", 800);
    if (!supported_display()) throw std::runtime_error("invalid_resolution");
    auto host_runtime = getenv("XDG_RUNTIME_DIR");
    std::string audio = host_runtime ? host_runtime : "";
    const auto host_bus_env = getenv("DBUS_SESSION_BUS_ADDRESS");
    const std::string host_bus = host_bus_env ? host_bus_env : "";
    prepare_session_services(directory, helper, host_bus);
    setenv("XDG_RUNTIME_DIR", directory.c_str(), 1);
    setenv("WLR_BACKENDS", "headless", 1);
    setenv("WLR_HEADLESS_OUTPUTS", "1", 1);
    auto renderer = str(config.get(), "renderer");
    if (renderer != "gles2" && renderer != "pixman")
      throw std::runtime_error("invalid_renderer");
    setenv("WLR_RENDERER", renderer.c_str(), 1);
    auto device = str(config.get(), "renderDevice");
    if (!device.empty())
      setenv("WLR_RENDER_DRM_DEVICE", device.c_str(), 1);
    unsetenv("WAYLAND_DISPLAY");
    unsetenv("DISPLAY");
    unsetenv("SWAYSOCK");
    if (!audio.empty()) {
      setenv("PULSE_SERVER", ("unix:" + audio + "/pulse/native").c_str(), 1);
      setenv("PIPEWIRE_RUNTIME_DIR", audio.c_str(), 1);
    }
    setenv("XDG_CURRENT_DESKTOP", "sway", 1);
    setenv("XDG_SESSION_TYPE", "wayland", 1);
    auto bus = "unix:path=" + directory + "/bus";
    setenv("DBUS_SESSION_BUS_ADDRESS", bus.c_str(), 1);
    spawn({"dbus-daemon", "--session", "--nofork", "--address=" + bus});
    std::string sway_config = "xwayland force\noutput * mode " + std::to_string(screen_width) + "x" + std::to_string(screen_height) + " scale "
                              "1\nseat * fallback true\nfocus_follows_mouse "
                              "no\ndefault_border pixel 1\nfont monospace 11\n";
    // Alt avoids the host's usual Super bindings; the viewer's independent
    // Ctrl+Alt+Enter remains reserved for returning model control. Host-global
    // shortcuts can still intercept keys, so every operation also has an MCP.
    sway_config += "set $mod Mod1\n"
                   "bindsym $mod+f fullscreen toggle\n"
                   "bindsym $mod+w layout tabbed\n"
                   "bindsym $mod+s layout stacking\n"
                   "bindsym $mod+e layout toggle split\n"
                   "bindsym $mod+h split horizontal\n"
                   "bindsym $mod+v split vertical\n"
                   "bindsym $mod+Shift+space floating toggle\n"
                   "bindsym $mod+space focus mode_toggle\n"
                   "bindsym $mod+a focus parent\n"
                   "bindsym $mod+Shift+q kill\n"
                   "bindsym $mod+minus scratchpad show\n"
                   "bindsym $mod+Shift+minus move scratchpad\n";
    for (const auto &direction : {"Left", "Right", "Up", "Down"}) {
      std::string lower = direction;
      lower[0] = char(tolower(lower[0]));
      sway_config += "bindsym $mod+" + std::string(direction) + " focus " + lower + "\n";
      sway_config += "bindsym $mod+Shift+" + std::string(direction) + " move " + lower + "\n";
    }
    for (int i = 1; i <= 9; ++i) {
      auto n = std::to_string(i);
      sway_config += "bindsym $mod+" + n + " workspace number " + n + "\n";
      sway_config += "bindsym $mod+Shift+" + n + " move container to workspace number " + n + "\n";
    }
    // Sway owns the actual private Xwayland display number. This one controlled
    // startup exec exports only four display/bus fields through our helper;
    // application launches themselves always use execvp with structured argv.
    sway_config += "exec " + quote(helper) + " environment " +
                   quote(environment_path) + "\n";
    write_private(directory + "/sway.conf", sway_config);
    sway_pid = spawn(
        {sway, "--unsupported-gpu", "--config", directory + "/sway.conf"});
    auto deadline = now() + 15000;
    Json environment = object();
    while (now() < deadline && !stopping) {
      int state = 0;
      if (waitpid(sway_pid, &state, WNOHANG) == sway_pid)
        throw std::runtime_error("compositor_failed");
      try {
        environment = parse(private_file(environment_path));
        break;
      } catch (...) {
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(30));
    }
    auto wayland = str(environment.get(), "WAYLAND_DISPLAY");
    if (wayland.empty())
      throw std::runtime_error("compositor_timeout");
    // Publish display addresses to private D-Bus activation and reserve Secret
    // Service before accepting app launches. The bridge owns host credential
    // connections; all other session services keep the private bus/display.
    auto services = spawn({helper, "session-services", directory + "/session-services.json"});
    deadline = now() + 10000;
    while (access((directory + "/session-services.ready").c_str(), F_OK) != 0) {
      if (stopping || now() >= deadline || waitpid(services, nullptr, WNOHANG) == services)
        throw std::runtime_error("session_services_unavailable");
      std::this_thread::sleep_for(std::chrono::milliseconds(30));
    }
    display = wl_display_connect(wayland.c_str());
    if (!display)
      throw std::runtime_error("compositor_unavailable");
    registry = wl_display_get_registry(display);
    static const wl_registry_listener registry_listener{global, removed};
    wl_registry_add_listener(registry, &registry_listener, this);
    if (wl_display_roundtrip(display) < 0 || wl_display_roundtrip(display) < 0 || !shm || !seat || !output ||
        !capture || !pointers || !keyboards)
      throw std::runtime_error("protocol_unavailable");
    pointer =
        zwlr_virtual_pointer_manager_v1_get_version(pointers) >= 2
            ? zwlr_virtual_pointer_manager_v1_create_virtual_pointer_with_output(
                  pointers, seat, output)
            : zwlr_virtual_pointer_manager_v1_create_virtual_pointer(pointers,
                                                                     seat);
    keyboard = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(
        keyboards, seat);
    xkb = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
    xkb_rule_names names{};
    names.layout = "us";
    base_map =
        xkb_keymap_new_from_names(xkb, &names, XKB_KEYMAP_COMPILE_NO_FLAGS);
    if (!base_map)
      throw std::runtime_error("input_unavailable");
    physical_keyboard = keyboard;
    default_keymap();
    Fd server(
        socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0));
    auto addr = address(str(config.get(), "socket"));
    if (bind(server.value, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) <
            0 ||
        listen(server.value, 16) < 0)
      throw std::runtime_error("worker_socket_unavailable");
    if (str(config.get(), "renderer") == "gles2") {
      render_fd = Fd(
          open(str(config.get(), "renderDevice").c_str(), O_RDWR | O_CLOEXEC));
      if (render_fd.value >= 0)
        gbm = gbm_create_device(render_fd.value);
    }
    while (!stopping) {
      int child_status;
      pid_t child;
      while ((child = waitpid(-1, &child_status, WNOHANG)) > 0) {
        for (auto &[id, launch] : launches)
          if (!launch.exited && launch.pid == child) { launch.exited = true; launch.status = child_status; }
        if (child == text_pid) {
          text_pid = -1;
          if (action_peer >= 0) {
            reply(action_peer,
                  WIFEXITED(child_status) && WEXITSTATUS(child_status) == 0
                      ? status()
                      : error("input_cancelled"),
                  -1, action_request);
            action_peer = -1;
          }
        }
      }
      if (text_pid > 0 && now() - text_started > 40000)
        kill(text_pid, SIGKILL);
      if (kill(sway_pid, 0) < 0)
        break;
      if (wl_display_dispatch_pending(display) < 0 ||
          wl_display_flush(display) < 0)
        break;
      std::vector<pollfd> fds{{server.value, POLLIN, 0},
                              {wl_display_get_fd(display), POLLIN, 0}};
      for (auto &[fd, p] : peers)
        fds.push_back({fd, short(POLLIN | POLLHUP), 0});
      poll(fds.data(), fds.size(), 5);
      if (fds[1].revents & POLLIN)
        if (wl_display_dispatch(display) < 0)
          break;
      if (fds[1].revents & (POLLERR | POLLHUP))
        break;
      if (fds[0].revents & POLLIN) {
        Fd fd(accept4(server.value, nullptr, nullptr,
                      SOCK_CLOEXEC | SOCK_NONBLOCK));
        if (fd.value >= 0 && peers.size() < 16 && same_user(fd.value)) {
          int n = fd.value;
          peers.emplace(n, Peer{std::move(fd)});
        }
      }
      for (size_t i = 2; i < fds.size(); i++) {
        int fd = fds[i].fd;
        if (!peers.count(fd))
          continue;
        if (fds[i].revents & (POLLERR | POLLHUP | POLLNVAL)) {
          close_peer(fd);
          continue;
        }
        if (fds[i].revents & POLLIN)
          try {
            handle(fd);
          } catch (const std::exception &e) {
            reply(fd, error(e.what()));
            close_peer(fd);
          }
      }
      if (!steps.empty() && now() >= next_step) {
        auto step = std::move(steps.front());
        steps.pop_front();
        step.execute();
        next_step = now() + (steps.empty() ? 0 : steps.front().delay);
        if (steps.empty() && action_peer >= 0) {
          reply(action_peer, status(), -1, action_request);
          action_peer = -1;
        }
      }
      if (copying && now() - capture_started > 2000) {
        if (dma_params) {
          zwp_linux_buffer_params_v1_destroy(dma_params);
          dma_params = nullptr;
          dma_disabled = true;
        }
        zwlr_screencopy_frame_v1_destroy(copying);
        copying = nullptr;
        incoming.reset();
        capture_failed = true;
        capture_stage = 6;
      }
      // Output events can invalidate an in-flight capture. Pending frame reads
      // remain pending until a new capture completes with the current geometry.
      if (!copying && !latest && !capture_failed) {
        for (auto &[fd, p] : peers) if (p.waiting) { begin_capture(); break; }
      }
      std::vector<int> expired;
      for (auto &[fd, p] : peers) {
        if (p.role.empty() && now() - p.accepted > 3000)
          expired.push_back(fd);
        if (!p.waiting)
          continue;
        if (capture_failed) {
          auto failure = error("capture_unavailable");
          put(failure.get(), "stage", int64_t(capture_stage));
          put(failure.get(), "format", int64_t(capture_format));
          put(failure.get(), "width", int64_t(capture_width));
          put(failure.get(), "height", int64_t(capture_height));
          put(failure.get(), "stride", int64_t(capture_stride));
          reply(fd, std::move(failure), -1, p.frame_request);
          p.waiting = false;
          continue;
        }
        if (latest && latest->captured >= last_capture) {
          if (p.role != "viewer") {
            try { check_observation_guard(p.observation_guard.get()); }
            catch (...) {
              reply(fd, error("observation_required"), -1, p.frame_request);
              p.waiting = false;
              continue;
            }
          }
          if (latest->bo && p.role != "viewer") {
            begin_capture();
            continue;
          }
          auto response = status();
          auto &f = *latest;
          put(response.get(), "transfer",
              std::string(f.bo ? "dma-buf" : "shared-memory"));
          if (f.bo) {
            put(response.get(), "format", int64_t(f.format));
            put(response.get(), "modifierHi", int64_t(f.modifier >> 32));
            put(response.get(), "modifierLo", int64_t(f.modifier & 0xffffffff));
            put(response.get(), "offset", int64_t(f.offset));
          }
          put(response.get(), "width", int64_t(f.width));
          put(response.get(), "height", int64_t(f.height));
          put(response.get(), "stride", int64_t(f.stride));
          put(response.get(), "inverted", f.inverted);
          put(response.get(), "rgb",
              f.format == WL_SHM_FORMAT_XBGR8888 ||
                  f.format == WL_SHM_FORMAT_ABGR8888 ||
                  f.format == WL_SHM_FORMAT_BGR888);
          put(response.get(), "bytesPerPixel",
              int64_t(f.format == WL_SHM_FORMAT_RGB888 ||
                              f.format == WL_SHM_FORMAT_BGR888
                          ? 3
                          : 4));
          put(response.get(), "captured", f.captured);
          reply(fd, std::move(response), f.fd.value, p.frame_request);
          p.waiting = false;
        }
      }
      for (auto fd : expired)
        close_peer(fd);
    }
    if (keyboard && pointer)
      cancel_action("desktop_stopped");
    return 0;
  }
};
int worker(const std::string &bootstrap) {
  signal(SIGTERM, stop_signal);
  signal(SIGINT, stop_signal);
  ProcessOwner owner;
  Worker runtime(parse(private_file(bootstrap)));
  return runtime.run();
}
} // namespace cafe
