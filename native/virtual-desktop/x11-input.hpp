#pragma once
#include "common.hpp"
#include <X11/Xlib.h>
#include <X11/extensions/XTest.h>
#include <sys/prctl.h>
#include <thread>

namespace cafe {
inline volatile sig_atomic_t x11_cancelled = 0;
inline void cancel_x11(int) { x11_cancelled = 1; }

// Xwayland does not consistently propagate a Wayland virtual keyboard's
// temporary Unicode keymap. Isolate the XTEST fallback in a disposable child:
// a stalled X server must never block capture, human takeover, or the worker.
// It connects only to Sway's private DISPLAY, never the host's display. Xlib
// restores the saved mapping before exit/cancellation; ASCII uses normal
// Wayland keycodes and never needs this fallback.
inline int type_x11(const std::string &name,
                    const std::vector<uint32_t> &chars) {
  signal(SIGTERM, cancel_x11);
  signal(SIGINT, cancel_x11);
  prctl(PR_SET_PDEATHSIG, SIGTERM);
  if (getppid() == 1)
    return 1;
  close_range(3, ~0U, 0);
  auto display = XOpenDisplay(name.c_str());
  if (!display)
    return 1;
  int first, last, levels;
  XDisplayKeycodes(display, &first, &last);
  first = std::max(first, 10);
  const int count = std::min(66, last + 1) - first;
  std::vector<int> printable;
  for (int code = first; code < first + count; code++)
    if ((code >= 10 && code <= 21) || (code >= 24 && code <= 35) ||
        (code >= 38 && code <= 48) || (code >= 51 && code <= 61) || code == 65)
      printable.push_back(code);
  auto original = XGetKeyboardMapping(display, first, count, &levels);
  if (!original || count < 1 || levels < 1 || levels > 32)
    return 1;
  int event, error, major, minor;
  if (!XTestQueryExtension(display, &event, &error, &major, &minor))
    return 1;
  // Xwayland creates its XTEST keyboard lazily. Establish that device and its
  // focus before sending text; otherwise its very first printable key can be
  // consumed during the device/focus transition. Balanced Shift is text-free.
  const auto shift = XKeysymToKeycode(display, 0xffe1);
  if (shift) {
    XTestFakeKeyEvent(display, shift, True, 0);
    XTestFakeKeyEvent(display, shift, False, 0);
    XSync(display, False);
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  for (size_t offset = 0; offset < chars.size() && !x11_cancelled;
       offset += printable.size()) {
    const auto size = std::min(printable.size(), chars.size() - offset);
    std::vector<KeySym> symbols(original, original + count * levels);
    for (size_t i = 0; i < size; i++) {
      const auto cp = chars[offset + i];
      KeySym sym = cp == 10 || cp == 13 ? 0xff0d
                   : cp == 9            ? 0xff09
                   : cp <= 255          ? cp
                                        : 0x01000000 | cp;
      for (int level = 0; level < levels; level++)
        symbols[(printable[i] - first) * levels + level] = sym;
    }
    XChangeKeyboardMapping(display, first, levels, symbols.data(), count);
    XSync(display, False);
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    for (size_t i = 0; i < size && !x11_cancelled; i++) {
      XTestFakeKeyEvent(display, printable[i], True, 0);
      XFlush(display);
      std::this_thread::sleep_for(std::chrono::milliseconds(8));
      XTestFakeKeyEvent(display, printable[i], False, 0);
      XFlush(display);
    }
  }
  // Drain key releases before restoring the map. Clients need to consume
  // MappingNotify before each batch, and key events before its restoration.
  XSync(display, False);
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  XChangeKeyboardMapping(display, first, levels, original, count);
  XSync(display, False);
  XFree(original);
  XCloseDisplay(display);
  return x11_cancelled ? 1 : 0;
}
} // namespace cafe
