#pragma once
#include "common.hpp"
#include <SDL3/SDL.h>
#include <pango/pangocairo.h>

namespace cafe {
// Rasterize chrome only on status/size changes. Pango handles Unicode desktop
// names and the host sans-serif fallback, keeping shaping off the frame path.
// https://docs.gtk.org/PangoCairo/func.create_layout.html
class ViewerToolbar {
  SDL_Texture *texture = nullptr;
  std::string cached;
public:
  const bool dark;
  const double scale;
  explicit ViewerToolbar(json_object *appearance)
      : dark(!appearance || boolean(appearance, "dark")),
        scale(std::clamp(field(appearance, "scale") ? json_object_get_double(field(appearance, "scale")) : 1.0, 0.5, 3.0)) {}
  ~ViewerToolbar() { if (texture) SDL_DestroyTexture(texture); }
  float height() const { return float(44 * scale); }
  SDL_FRect button(float width) const { return {std::max(float(8 * scale), width - float(196 * scale)), float(6 * scale), std::min(float(184 * scale), width - float(16 * scale)), float(32 * scale)}; }
  bool hit(float x, float y, float width) const { auto b = button(width); return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h; }
  SDL_FRect fit_button(float width) const {
    auto control = button(width);
    const float w = std::min(float(144 * scale), std::max(0.0f, control.x - float(16 * scale)));
    return {control.x - float(8 * scale) - w, control.y, w, control.h};
  }
  bool hit_fit(float x, float y, float width) const { auto b = fit_button(width); return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h; }
  SDL_FRect mouse_button(float width) const {
    auto fit = fit_button(width);
    const float w = std::min(float(152 * scale), std::max(0.0f, fit.x - float(16 * scale)));
    return {fit.x - float(8 * scale) - w, fit.y, w, fit.h};
  }
  bool hit_mouse(float x, float y, float width) const { auto b = mouse_button(width); return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h; }
  void draw(SDL_Renderer *renderer, int width, double dpi, const std::string &name, const std::string &status, const std::string &action, bool human, bool enabled, bool fit_enabled, bool mouse_enabled, bool mouse_captured) {
    auto key = name + status + action + std::to_string(width) + std::to_string(dpi) + (enabled ? "1" : "0") + (fit_enabled ? "1" : "0") + (mouse_enabled ? "1" : "0") + (mouse_captured ? "1" : "0");
    const int h = std::max(1, int(height() * dpi));
    if (key != cached || !texture) {
      cached = key;
      if (texture) SDL_DestroyTexture(texture);
      texture = nullptr;
      auto surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, width, h);
      auto cr = cairo_create(surface);
      cairo_scale(cr, dpi, dpi);
      const double bg = dark ? 0.115 : 0.98;
      const double fg = dark ? 0.93 : 0.16;
      cairo_set_source_rgb(cr, bg, bg, bg); cairo_paint(cr);
      auto button_rect = button(float(width / dpi));
      auto fit_rect = fit_button(float(width / dpi));
      auto mouse_rect = mouse_button(float(width / dpi));
      cairo_set_source_rgb(cr, dark ? 0.21 : 0.90, dark ? 0.21 : 0.90, dark ? 0.23 : 0.92);
      if (!mouse_captured) {
        cairo_rectangle(cr, button_rect.x, button_rect.y, button_rect.w, button_rect.h); cairo_fill(cr);
        if (fit_rect.w > 0) { cairo_rectangle(cr, fit_rect.x, fit_rect.y, fit_rect.w, fit_rect.h); cairo_fill(cr); }
        if (mouse_rect.w > 0) { cairo_rectangle(cr, mouse_rect.x, mouse_rect.y, mouse_rect.w, mouse_rect.h); cairo_fill(cr); }
      }
      auto text = [&](const std::string &value, double x, double y, double font_size, double max_width, bool muted) {
        if (max_width <= 0) return;
        auto layout = pango_cairo_create_layout(cr);
        auto font = pango_font_description_from_string("DM Sans, sans-serif");
        pango_font_description_set_absolute_size(font, font_size * scale * PANGO_SCALE);
        pango_layout_set_font_description(layout, font);
        pango_layout_set_text(layout, value.c_str(), int(value.size()));
        pango_layout_set_width(layout, int(max_width * PANGO_SCALE));
        pango_layout_set_ellipsize(layout, PANGO_ELLIPSIZE_END);
        pango_layout_set_single_paragraph_mode(layout, true);
        cairo_set_source_rgb(cr, muted ? (dark ? 0.65 : 0.43) : fg, muted ? (dark ? 0.65 : 0.43) : fg, muted ? (dark ? 0.68 : 0.46) : fg);
        cairo_move_to(cr, x, y); pango_cairo_show_layout(cr, layout);
        pango_font_description_free(font); g_object_unref(layout);
      };
      // Captured pointer events belong to the guest, so chrome buttons cannot
      // be clicked. Give the release shortcut the full width, even when narrow.
      const float text_end = mouse_captured ? float(width / dpi) : mouse_rect.w > 0 ? mouse_rect.x : fit_rect.w > 0 ? fit_rect.x : button_rect.x;
      text(name, 12 * scale, 3 * scale, 13, text_end - 24 * scale, false);
      if (text_end > 49 * scale) {
        cairo_set_source_rgb(cr, human ? 0.94 : 0.29, human ? 0.66 : 0.72, human ? 0.25 : 0.56);
        cairo_arc(cr, 16 * scale, 31 * scale, 3 * scale, 0, 6.2832); cairo_fill(cr);
        text(status, 25 * scale, 22 * scale, 11, text_end - 37 * scale, true);
      }
      if (!mouse_captured) {
        text("Fit aspect ratio", fit_rect.x + 12 * scale, 13 * scale, 12, fit_rect.w - 24 * scale, !fit_enabled);
        text(mouse_rect.w < 128 * scale ? "Capture" : "Capture mouse", mouse_rect.x + 12 * scale, 13 * scale, 12, mouse_rect.w - 24 * scale, !mouse_enabled);
        text(action, button_rect.x + 12 * scale, 13 * scale, 12, button_rect.w - 24 * scale, !enabled);
      }
      cairo_set_source_rgb(cr, dark ? 0.22 : 0.86, dark ? 0.22 : 0.86, dark ? 0.22 : 0.86);
      cairo_rectangle(cr, 0, height() - 1, width / dpi, 1); cairo_fill(cr);
      cairo_surface_flush(surface);
      auto sdl = SDL_CreateSurfaceFrom(width, h, SDL_PIXELFORMAT_ARGB8888, cairo_image_surface_get_data(surface), cairo_image_surface_get_stride(surface));
      if (sdl) { texture = SDL_CreateTextureFromSurface(renderer, sdl); SDL_DestroySurface(sdl); }
      cairo_destroy(cr); cairo_surface_destroy(surface);
    }
    if (texture) { SDL_FRect bounds{0, 0, float(width), float(h)}; SDL_RenderTexture(renderer, texture, nullptr, &bounds); }
  }
};
}
