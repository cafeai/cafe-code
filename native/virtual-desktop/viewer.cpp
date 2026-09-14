#include "common.hpp"
#include "gpu-view.hpp"
#include "viewer-toolbar.hpp"
#include "pointer-input.hpp"
#include <SDL3/SDL.h>
#include <cmath>
#include <deque>
#include <linux/input-event-codes.h>
#include <map>
#include <set>

namespace cafe {
static uint32_t keycode(SDL_Scancode code) {
  static const std::map<SDL_Scancode, uint32_t> codes{
      {SDL_SCANCODE_A, KEY_A},
      {SDL_SCANCODE_B, KEY_B},
      {SDL_SCANCODE_C, KEY_C},
      {SDL_SCANCODE_D, KEY_D},
      {SDL_SCANCODE_E, KEY_E},
      {SDL_SCANCODE_F, KEY_F},
      {SDL_SCANCODE_G, KEY_G},
      {SDL_SCANCODE_H, KEY_H},
      {SDL_SCANCODE_I, KEY_I},
      {SDL_SCANCODE_J, KEY_J},
      {SDL_SCANCODE_K, KEY_K},
      {SDL_SCANCODE_L, KEY_L},
      {SDL_SCANCODE_M, KEY_M},
      {SDL_SCANCODE_N, KEY_N},
      {SDL_SCANCODE_O, KEY_O},
      {SDL_SCANCODE_P, KEY_P},
      {SDL_SCANCODE_Q, KEY_Q},
      {SDL_SCANCODE_R, KEY_R},
      {SDL_SCANCODE_S, KEY_S},
      {SDL_SCANCODE_T, KEY_T},
      {SDL_SCANCODE_U, KEY_U},
      {SDL_SCANCODE_V, KEY_V},
      {SDL_SCANCODE_W, KEY_W},
      {SDL_SCANCODE_X, KEY_X},
      {SDL_SCANCODE_Y, KEY_Y},
      {SDL_SCANCODE_Z, KEY_Z},
      {SDL_SCANCODE_0, KEY_0},
      {SDL_SCANCODE_1, KEY_1},
      {SDL_SCANCODE_2, KEY_2},
      {SDL_SCANCODE_3, KEY_3},
      {SDL_SCANCODE_4, KEY_4},
      {SDL_SCANCODE_5, KEY_5},
      {SDL_SCANCODE_6, KEY_6},
      {SDL_SCANCODE_7, KEY_7},
      {SDL_SCANCODE_8, KEY_8},
      {SDL_SCANCODE_9, KEY_9},
      {SDL_SCANCODE_LCTRL, KEY_LEFTCTRL},
      {SDL_SCANCODE_RCTRL, KEY_RIGHTCTRL},
      {SDL_SCANCODE_LSHIFT, KEY_LEFTSHIFT},
      {SDL_SCANCODE_RSHIFT, KEY_RIGHTSHIFT},
      {SDL_SCANCODE_LALT, KEY_LEFTALT},
      {SDL_SCANCODE_RALT, KEY_RIGHTALT},
      {SDL_SCANCODE_LGUI, KEY_LEFTMETA},
      {SDL_SCANCODE_RGUI, KEY_RIGHTMETA},
      {SDL_SCANCODE_RETURN, KEY_ENTER},
      {SDL_SCANCODE_ESCAPE, KEY_ESC},
      {SDL_SCANCODE_BACKSPACE, KEY_BACKSPACE},
      {SDL_SCANCODE_TAB, KEY_TAB},
      {SDL_SCANCODE_SPACE, KEY_SPACE},
      {SDL_SCANCODE_LEFT, KEY_LEFT},
      {SDL_SCANCODE_RIGHT, KEY_RIGHT},
      {SDL_SCANCODE_UP, KEY_UP},
      {SDL_SCANCODE_DOWN, KEY_DOWN},
      {SDL_SCANCODE_HOME, KEY_HOME},
      {SDL_SCANCODE_END, KEY_END},
      {SDL_SCANCODE_PAGEUP, KEY_PAGEUP},
      {SDL_SCANCODE_PAGEDOWN, KEY_PAGEDOWN},
      {SDL_SCANCODE_INSERT, KEY_INSERT},
      {SDL_SCANCODE_DELETE, KEY_DELETE},
      {SDL_SCANCODE_F1, KEY_F1},
      {SDL_SCANCODE_F2, KEY_F2},
      {SDL_SCANCODE_F3, KEY_F3},
      {SDL_SCANCODE_F4, KEY_F4},
      {SDL_SCANCODE_F5, KEY_F5},
      {SDL_SCANCODE_F6, KEY_F6},
      {SDL_SCANCODE_F7, KEY_F7},
      {SDL_SCANCODE_F8, KEY_F8},
      {SDL_SCANCODE_F9, KEY_F9},
      {SDL_SCANCODE_F10, KEY_F10},
      {SDL_SCANCODE_F11, KEY_F11},
      {SDL_SCANCODE_F12, KEY_F12},
  };
  auto i = codes.find(code);
  return i == codes.end() ? 0 : i->second;
}
struct SDLResources {
  GpuView gpu;
  SDL_Window *window = nullptr;
  SDL_Renderer *renderer = nullptr;
  SDL_Texture *texture = nullptr;
  ~SDLResources() {
    // Restore the host pointer on normal exit and exception unwinding too.
    if (window) {
      SDL_SetWindowRelativeMouseMode(window, false);
      SDL_ShowCursor();
    }
    if (texture)
      SDL_DestroyTexture(texture);
    if (renderer)
      gpu.release(renderer);
    if (renderer)
      SDL_DestroyRenderer(renderer);
    if (window)
      SDL_DestroyWindow(window);
    SDL_Quit();
  }
};
int viewer(const std::string &bootstrap) {
  auto config = parse(private_file(bootstrap));
  auto socket = connect_worker(config.get(), "viewer");
  SDLResources s;
  SDL_SetHint(SDL_HINT_VIDEO_FORCE_EGL, "1");
  // SDL otherwise consumes the click that activates a Wayland/X11 window,
  // making toolbar actions require a second click. Deliver that first click
  // through the normal hit tests and acknowledged guest-ownership checks.
  // https://wiki.libsdl.org/SDL3/SDL_HINT_MOUSE_FOCUS_CLICKTHROUGH
  SDL_SetHint(SDL_HINT_MOUSE_FOCUS_CLICKTHROUGH, "1");
  if (!SDL_Init(SDL_INIT_VIDEO))
    throw std::runtime_error("viewer_unavailable");
  auto name = str(config.get(), "name");
  s.window =
      SDL_CreateWindow(("Cafe - " + name).c_str(), 1280, 844,
                       SDL_WINDOW_RESIZABLE | SDL_WINDOW_HIGH_PIXEL_DENSITY);
  if (!s.window)
    throw std::runtime_error("viewer_unavailable");
  s.renderer = SDL_CreateRenderer(s.window, "opengles2");
  if (!s.renderer)
    s.renderer = SDL_CreateRenderer(s.window, nullptr);
  if (!s.renderer)
    throw std::runtime_error("viewer_unavailable");
  SDL_SetRenderVSync(s.renderer, 1);
  ViewerToolbar toolbar(field(config.get(), "appearance"));
  SDL_StartTextInput(s.window);
  s.gpu.initialize(s.renderer);
  bool gpu_frame = false, inverted = false;
  bool running = true, human = false, live = false, waiting = false, capture_failed = false;
  bool mouse_captured = false, relative_supported = false, mouse_capture_failed = false;
  int width = 0, height = 0;
  int64_t received = 0, requested = 0;
  SDL_FRect destination{};
  int64_t next_request = 0, input_request = 0, frame_request = 0;
  int64_t control_epoch = -1, control_request = 0;
  std::deque<Json> input_queue;
  std::set<uint8_t> pressed_buttons;
  Json current_input = take(nullptr);
  int64_t retry_at = 0, retry_deadline = 0;
  auto send = [&](Json j) {
    auto id = ++next_request;
    put(j.get(), "requestId", id);
    send_packet(socket.value, j.get());
    return id;
  };
  auto action = [&](Json j) {
    if (!live || !human || control_request)
      return false;
    put(j.get(), "method", std::string("act"));
    put(j.get(), "controlEpoch", control_epoch);
    // Keep physical input ordered through its ACK, but collapse redundant
    // pointer motion. A slow compositor cannot create an unbounded input queue.
    if (!input_queue.empty() && str(j.get(), "kind") == "move" &&
        str(input_queue.back().get(), "kind") == "move")
      input_queue.pop_back();
    // Absolute motion can keep just the last position. Relative motion must
    // preserve every displacement and must not merge across buttons/keys.
    if (!input_queue.empty() && coalesce_relative_motion(input_queue.back().get(), j.get()))
      input_queue.pop_back();
    if (input_queue.size() >= 256) {
      input_queue.clear();
      pressed_buttons.clear();
      auto release = object();
      put(release.get(), "method", std::string("act"));
      put(release.get(), "kind", std::string("release"));
      put(release.get(), "controlEpoch", control_epoch);
      input_queue.push_back(std::move(release));
      live = false;
      return false;
    }
    input_queue.push_back(std::move(j));
    return true;
  };
  auto mapped = [&](float x, float y, int &ox, int &oy) {
    int logical_w, logical_h, physical_w, physical_h;
    SDL_GetWindowSize(s.window, &logical_w, &logical_h);
    SDL_GetWindowSizeInPixels(s.window, &physical_w, &physical_h);
    x *= float(physical_w) / std::max(1, logical_w);
    y *= float(physical_h) / std::max(1, logical_h);
    if (destination.w <= 0 || destination.h <= 0 || x < destination.x ||
        y < destination.y || x >= destination.x + destination.w ||
        y >= destination.y + destination.h)
      return false;
    ox = std::clamp(int((x - destination.x) * width / destination.w), 0,
                    width - 1);
    oy = std::clamp(int((y - destination.y) * height / destination.h), 0,
                    height - 1);
    return true;
  };
  std::set<SDL_Scancode> physical_keys;
  auto release_input = [&]() {
    input_queue.clear();
    current_input.reset();
    input_request = 0;
    physical_keys.clear();
    pressed_buttons.clear();
    if (human && control_epoch >= 0) {
      auto j = object();
      put(j.get(), "method", std::string("act"));
      put(j.get(), "kind", std::string("release"));
      put(j.get(), "controlEpoch", control_epoch);
      send(std::move(j));
    }
  };
  auto release_mouse = [&]() {
    if (!mouse_captured) return;
    // SDL flushes pending motion on mode changes. Drop already queued deltas
    // as well; none may leak into another focus/ownership epoch.
    SDL_SetWindowRelativeMouseMode(s.window, false);
    mouse_captured = false;
    release_input();
  };
  auto toggle_mouse = [&]() {
    if (mouse_captured) { release_mouse(); return; }
    if (!live || !human || control_request || !relative_supported ||
        SDL_GetKeyboardFocus() != s.window) return;
    release_input();
    // SDL provides unbounded motion at window edges and confines only this
    // viewer. It does not grab global keyboard shortcuts or change ownership.
    // https://wiki.libsdl.org/SDL3/SDL_SetWindowRelativeMouseMode
    mouse_captured = SDL_SetWindowRelativeMouseMode(s.window, true);
    mouse_capture_failed = !mouse_captured;
  };
  auto fit_window = [&]() {
    if (width <= 0 || height <= 0) return;
    int lw = 0, lh = 0, pw = 0, ph = 0;
    SDL_GetWindowSize(s.window, &lw, &lh);
    SDL_GetWindowSizeInPixels(s.window, &pw, &ph);
    if (lw <= 0 || lh <= 0 || pw <= 0 || ph <= 0) return;
    const double dpi_x = double(pw) / lw, dpi_y = double(ph) / lh;
    const double chrome = toolbar.height() * dpi_x;
    if (ph <= chrome) return;
    const double scale = std::min(double(pw) / width, (ph - chrome) / height);
    // Round the contained image outward to logical window units, so repeat
    // clicks cannot progressively shrink it; neither dimension may grow. Include
    // chrome, since matching the whole window to the guest ratio leaves bars.
    const int target_w = std::clamp(int(SDL_ceil(width * scale / dpi_x)), 1, lw);
    const int target_h = std::clamp(int(SDL_ceil((height * scale + chrome) / dpi_y)), 1, lh);
    if (SDL_GetWindowFlags(s.window) & SDL_WINDOW_FULLSCREEN)
      SDL_SetWindowFullscreen(s.window, false);
    SDL_RestoreWindow(s.window);
    SDL_SetWindowSize(s.window, target_w, target_h);
  };
  auto change_control = [&](bool take) {
    if (!live || control_request || control_epoch < 0) return;
    release_mouse();
    input_queue.clear();
    current_input.reset();
    input_request = 0;
    physical_keys.clear();
    pressed_buttons.clear();
    auto j = object();
    put(j.get(), "method", std::string(take ? "take-control" : "return-control"));
    put(j.get(), "controlEpoch", control_epoch);
    control_request = send(std::move(j));
  };
  while (running) {
    SDL_Event e;
    while (SDL_PollEvent(&e)) {
      if (e.type == SDL_EVENT_QUIT) {
        running = false;
        break;
      }
      if (e.type == SDL_EVENT_WINDOW_FOCUS_LOST && human) {
        if (mouse_captured) release_mouse();
        else release_input();
      }
      if (!mouse_captured && e.type == SDL_EVENT_MOUSE_BUTTON_DOWN && e.button.button == SDL_BUTTON_LEFT && e.button.y < toolbar.height()) {
        int window_width = 0, window_height = 0;
        SDL_GetWindowSize(s.window, &window_width, &window_height);
        if (toolbar.hit(e.button.x, e.button.y, float(window_width)))
          change_control(!human);
        else if (toolbar.hit_fit(e.button.x, e.button.y, float(window_width)))
          fit_window();
        else if (toolbar.hit_mouse(e.button.x, e.button.y, float(window_width)))
          toggle_mouse();
        continue;
      }
      if (e.type == SDL_EVENT_MOUSE_MOTION ||
          e.type == SDL_EVENT_MOUSE_BUTTON_DOWN ||
          e.type == SDL_EVENT_MOUSE_BUTTON_UP) {
        int x = 0, y = 0;
        float mx = e.type == SDL_EVENT_MOUSE_MOTION ? e.motion.x : e.button.x,
              my = e.type == SDL_EVENT_MOUSE_MOTION ? e.motion.y : e.button.y;
        const bool inside = mapped(mx, my, x, y);
        const bool releasing = e.type == SDL_EVENT_MOUSE_BUTTON_UP;
        // A press admitted over the guest must get its matching release even
        // over the toolbar, letterbox, or outside the window. Do not move the
        // guest pointer to invented coordinates, and never forward an orphan
        // release from a toolbar click or an earlier ownership epoch.
        if (releasing && !pressed_buttons.count(e.button.button))
          continue;
        if (!mouse_captured && !inside && !releasing)
          continue;
        auto j = object();
        put(j.get(), "x", int64_t(x));
        put(j.get(), "y", int64_t(y));
        if (e.type == SDL_EVENT_MOUSE_MOTION && mouse_captured) {
          int lw, lh, pw, ph;
          SDL_GetWindowSize(s.window, &lw, &lh);
          SDL_GetWindowSizeInPixels(s.window, &pw, &ph);
          // Match ordinary viewer-to-guest scaling, retaining subpixels.
          const double dx = e.motion.xrel * double(pw) / std::max(1, lw) * width / std::max(1.0f, destination.w) * 256;
          const double dy = e.motion.yrel * double(ph) / std::max(1, lh) * height / std::max(1.0f, destination.h) * 256;
          if (!std::isfinite(dx) || !std::isfinite(dy) || std::abs(dx) > relative_motion_limit || std::abs(dy) > relative_motion_limit) {
            release_mouse();
            mouse_capture_failed = true;
            continue;
          }
          put(j.get(), "kind", std::string("relative-move"));
          put(j.get(), "dx256", int64_t(std::llround(dx)));
          put(j.get(), "dy256", int64_t(std::llround(dy)));
        } else if (e.type == SDL_EVENT_MOUSE_MOTION)
          put(j.get(), "kind", std::string("move"));
        else {
          put(j.get(), "kind", std::string("button"));
          put(j.get(), "relative", mouse_captured || !inside);
          put(j.get(), "down", e.type == SDL_EVENT_MOUSE_BUTTON_DOWN);
          uint32_t button = e.button.button == SDL_BUTTON_RIGHT    ? BTN_RIGHT
                            : e.button.button == SDL_BUTTON_MIDDLE ? BTN_MIDDLE
                                                                   : BTN_LEFT;
          put(j.get(), "button", int64_t(button));
        }
        if (action(std::move(j))) {
          if (e.type == SDL_EVENT_MOUSE_BUTTON_DOWN)
            pressed_buttons.insert(e.button.button);
          else if (releasing)
            pressed_buttons.erase(e.button.button);
        }
      }
      if (e.type == SDL_EVENT_MOUSE_WHEEL) {
        auto j = object();
        put(j.get(), "kind", std::string("scroll"));
        put(j.get(), "horizontal", e.wheel.y == 0);
        put(j.get(), "amount",
            int64_t(std::clamp(-int(e.wheel.y == 0 ? e.wheel.x : e.wheel.y),
                               -100, 100)));
        action(std::move(j));
      }
      if (e.type == SDL_EVENT_TEXT_INPUT) {
        auto j = object();
        put(j.get(), "kind", std::string("text"));
        put(j.get(), "text", std::string(e.text.text));
        action(std::move(j));
      }
      if (e.type == SDL_EVENT_KEY_DOWN || e.type == SDL_EVENT_KEY_UP) {
        auto code = keycode(e.key.scancode);
        bool down = e.type == SDL_EVENT_KEY_DOWN;
        if (down && e.key.scancode == SDL_SCANCODE_M &&
            (e.key.mod & SDL_KMOD_CTRL) && (e.key.mod & SDL_KMOD_ALT)) {
          if (!e.key.repeat) toggle_mouse();
          continue;
        }
        if (down && e.key.scancode == SDL_SCANCODE_RETURN &&
            (e.key.mod & SDL_KMOD_CTRL) && (e.key.mod & SDL_KMOD_ALT)) {
          if (human) change_control(false);
          continue;
        }
        // SDL_TEXTINPUT provides the host layout/IME's Unicode text. Physical
        // key events are reserved for controls and shortcuts to avoid
        // duplicates.
        bool control = code == KEY_ENTER || code == KEY_ESC ||
                       code == KEY_BACKSPACE || code == KEY_TAB ||
                       code >= KEY_F1 || code == KEY_LEFTCTRL ||
                       code == KEY_LEFTSHIFT || code == KEY_RIGHTSHIFT ||
                       code == KEY_LEFTALT;
        if (code &&
            ((down && (control || (e.key.mod & (SDL_KMOD_CTRL | SDL_KMOD_ALT |
                                                SDL_KMOD_GUI)))) ||
             (!down && physical_keys.count(e.key.scancode)))) {
          auto j = object();
          put(j.get(), "kind", std::string("keycode"));
          put(j.get(), "keycode", int64_t(code));
          put(j.get(), "down", down);
          action(std::move(j));
          if (down)
            physical_keys.insert(e.key.scancode);
          else
            physical_keys.erase(e.key.scancode);
        }
      }
    }
    for (unsigned responses = 0; responses < 64; responses++) {
      pollfd ready{socket.value, POLLIN, 0};
      poll(&ready, 1, 0);
      if (ready.revents & (POLLERR | POLLHUP | POLLNVAL)) {
        live = false;
        running = false;
      }
      if (!(ready.revents & POLLIN))
        break;
      if (ready.revents & POLLIN) {
        auto p = receive_packet(socket.value);
        auto j = p.json.get();
        if (str(j, "event") == "show") {
          SDL_RaiseWindow(s.window);
          continue;
        }
        auto response_id = integer(j, "requestId");
        if (response_id == input_request) {
          input_request = 0;
          // A cancelled Xwayland text helper needs a bounded interval to
          // restore its keymap before admitting the human's first input.
          // desktop_busy guarantees no action was applied, unlike a lost ACK;
          // retry only that explicit response, never an uncertain operation.
          if (str(j, "error") == "desktop_busy" && now() < retry_deadline)
            retry_at = now() + 25;
          else
            current_input.reset();
        }
        if (response_id == frame_request)
          waiting = false;
        if (response_id == control_request) control_request = 0;
        // Frames captured before a handoff may arrive later. Only monotonic
        // worker epochs can change the displayed owner or admit human input.
        if (field(j, "humanControl") && integer(j, "controlEpoch", -1) >= control_epoch) {
          const auto incoming_epoch = integer(j, "controlEpoch");
          if (incoming_epoch != control_epoch) {
            live = false;
            received = 0;
            // Release locally before accepting a new authority epoch. Any
            // old-epoch release packet is fenced by the worker as usual.
            release_mouse();
            input_queue.clear();
            current_input.reset();
            input_request = 0;
            physical_keys.clear();
            pressed_buttons.clear();
          }
          control_epoch = incoming_epoch;
          human = boolean(j, "humanControl");
          relative_supported = boolean(j, "relativePointer");
        }
        if (field(j, "error")) {
          if (response_id == frame_request) capture_failed = true;
          if (str(j, "error") != "input_cancelled" && str(j, "error") != "desktop_busy" &&
              str(j, "error") != "viewer_control_required" && str(j, "error") != "observation_required")
            live = false;
        }
        if (p.fd.value >= 0) {
          // A late frame from before a resize must never revive input against
          // stale pixels after the worker published its new geometry epoch.
          if (integer(j, "controlEpoch", -1) < control_epoch) continue;
          capture_failed = false;
          waiting = false;
          const bool incoming_gpu = str(j, "transfer") == "dma-buf";
          if (incoming_gpu || gpu_frame) {
            if (s.texture)
              SDL_DestroyTexture(s.texture);
            s.texture = nullptr;
            s.gpu.release(s.renderer);
          }
          if (incoming_gpu) {
            s.texture = s.gpu.import(s.renderer, p);
            if (!s.texture) {
              s.gpu.formats.clear();
              gpu_frame = false;
              live = false;
              continue;
            }
            width = integer(j, "width");
            height = integer(j, "height");
            inverted = boolean(j, "inverted");
            gpu_frame = true;
            live = true;
            received = now();
            continue;
          }
          gpu_frame = false;
          inverted = false;
          auto w = integer(j, "width"), h = integer(j, "height"),
               stride = integer(j, "stride"),
               bpp = integer(j, "bytesPerPixel", 4);
          struct stat st{};
          if (w < 1 || h < 1 || w > 2048 || h > 2048 ||
              (bpp != 3 && bpp != 4) || stride < w * bpp ||
              stride > int64_t(frame_limit) / h || fstat(p.fd.value, &st) < 0 ||
              st.st_size < stride * h)
            throw std::runtime_error("invalid_frame");
          const auto size = stride * h;
          void *map = mmap(nullptr, size, PROT_READ, MAP_SHARED, p.fd.value, 0);
          if (map == MAP_FAILED)
            throw std::runtime_error("invalid_frame");
          if (width != w || height != h || !s.texture) {
            if (s.texture)
              SDL_DestroyTexture(s.texture);
            width = w;
            height = h;
            s.texture = SDL_CreateTexture(s.renderer, SDL_PIXELFORMAT_ARGB8888,
                                          SDL_TEXTUREACCESS_STREAMING, w, h);
          }
          if (!s.texture) {
            munmap(map, size);
            throw std::runtime_error("viewer_unavailable");
          }
          // Normalize uncommon byte ordering/inversion. The usual wl_shm path
          // uploads directly; SDL owns the texture after UpdateTexture returns.
          if (boolean(j, "inverted") || boolean(j, "rgb") || bpp != 4) {
            std::vector<unsigned char> pixels(w * h * 4);
            for (int y = 0; y < h; y++) {
              auto row = static_cast<unsigned char *>(map) +
                         (boolean(j, "inverted") ? h - 1 - y : y) * stride;
              for (int x = 0; x < w; x++) {
                auto dst = pixels.data() + (y * w + x) * 4;
                dst[0] = row[x * bpp + (boolean(j, "rgb") ? 2 : 0)];
                dst[1] = row[x * bpp + 1];
                dst[2] = row[x * bpp + (boolean(j, "rgb") ? 0 : 2)];
                dst[3] = 255;
              }
            }
            SDL_UpdateTexture(s.texture, nullptr, pixels.data(), w * 4);
          } else
            SDL_UpdateTexture(s.texture, nullptr, map, stride);
          munmap(map, size);
          live = true;
          received = now();
        }
      }
    }
    if (now() - received > 2500) live = false;
    if (mouse_captured && (!running || !live || capture_failed || !human || control_request ||
        SDL_GetKeyboardFocus() != s.window)) release_mouse();
    if ((!live || capture_failed) && !pressed_buttons.empty()) release_input();
    if (!input_request && now() >= retry_at) {
      if (!current_input && !input_queue.empty()) {
        current_input = std::move(input_queue.front());
        input_queue.pop_front();
        retry_deadline = now() + 1000;
      }
      if (current_input)
        input_request = send(take(json_object_get(current_input.get())));
    }
    if (!waiting && now() - requested >= 16) {
      auto j = object();
      put(j.get(), "method", std::string("frame"));
      json_object_object_add(j.get(), "dmaFormats",
                             s.gpu.capabilities().release());
      put(j.get(), "presentedTransfer",
          std::string(gpu_frame ? "dma-buf" : "shared-memory"));
      frame_request = send(std::move(j));
      waiting = true;
      requested = now();
    }
    int pw, ph;
    SDL_GetWindowSizeInPixels(s.window, &pw, &ph);
    int lw, lh;
    SDL_GetWindowSize(s.window, &lw, &lh);
    const double dpi = double(pw) / std::max(1, lw);
    const float toolbar_height = toolbar.height() * dpi;
    float scale = std::min(float(pw) / std::max(1, width),
                           std::max(1.0f, ph - toolbar_height) / std::max(1, height));
    destination = {(pw - width * scale) / 2,
                   toolbar_height + (ph - toolbar_height - height * scale) / 2, width * scale,
                   height * scale};
    // The captured desktop already contains its cursor. Hide our host cursor
    // only over those pixels while human input is active. Re-evaluate after
    // ownership, focus, frame and geometry updates, even without mouse motion;
    // toolbar controls, letterboxing and unavailable frames keep a host cursor.
    float mouse_x = 0, mouse_y = 0;
    SDL_GetMouseState(&mouse_x, &mouse_y);
    int guest_x = 0, guest_y = 0;
    const bool show_cursor =
        !mouse_captured && !(running && live && human && !control_request &&
          SDL_GetMouseFocus() == s.window &&
          mapped(mouse_x, mouse_y, guest_x, guest_y));
    if (SDL_CursorVisible() != show_cursor) {
      if (show_cursor)
        SDL_ShowCursor();
      else
        SDL_HideCursor();
    }
    SDL_SetRenderDrawColor(s.renderer, 16, 18, 23, 255);
    SDL_RenderClear(s.renderer);
    if (s.texture)
      SDL_RenderTextureRotated(s.renderer, s.texture, nullptr, &destination, 0,
                               nullptr,
                               inverted ? SDL_FLIP_VERTICAL : SDL_FLIP_NONE);
    if (!live) {
      SDL_SetRenderDrawBlendMode(s.renderer, SDL_BLENDMODE_BLEND);
      SDL_SetRenderDrawColor(s.renderer, 20, 20, 20, 210);
      SDL_RenderFillRect(s.renderer, &destination);
    }
    toolbar.draw(s.renderer, pw, dpi, name,
                 live ? (mouse_capture_failed ? "Mouse capture unavailable" : mouse_captured ? "Mouse captured · Ctrl+Alt+M to release" : human ? "Human has control" : "Codex has control · Watching")
                      : capture_failed ? "Capture unavailable · Input paused" : received ? "Reconnecting · Input paused" : "Connecting…",
                 control_request ? "Changing control…" : human ? "Return to Codex" : "Take control",
                 human, live && !control_request, width > 0 && height > 0,
                 human && live && relative_supported && !control_request, mouse_captured);
    SDL_RenderPresent(s.renderer);
    SDL_Delay(2);
  }
  return 0;
}
} // namespace cafe
