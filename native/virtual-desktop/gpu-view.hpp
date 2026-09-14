#pragma once
#include "common.hpp"
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <GLES2/gl2ext.h>
#include <SDL3/SDL.h>
#include <libdrm/drm_fourcc.h>

namespace cafe {
struct GpuView {
  EGLDisplay display = EGL_NO_DISPLAY;
  EGLImageKHR image = EGL_NO_IMAGE_KHR;
  GLuint texture = 0;
  Fd buffer;
  std::vector<std::pair<uint32_t, uint64_t>> formats;
  PFNEGLCREATEIMAGEKHRPROC create_image = nullptr;
  PFNEGLDESTROYIMAGEKHRPROC destroy_image = nullptr;
  PFNGLEGLIMAGETARGETTEXTURE2DOESPROC bind_image = nullptr;
  void initialize(SDL_Renderer *renderer) {
    if (strcmp(SDL_GetRendererName(renderer), "opengles2"))
      return;
    SDL_FlushRenderer(renderer);
    display = eglGetCurrentDisplay();
    if (display == EGL_NO_DISPLAY)
      return;
    const auto extensions = eglQueryString(display, EGL_EXTENSIONS);
    if (!extensions ||
        !strstr(extensions, "EGL_EXT_image_dma_buf_import_modifiers"))
      return;
    create_image = reinterpret_cast<PFNEGLCREATEIMAGEKHRPROC>(
        eglGetProcAddress("eglCreateImageKHR"));
    destroy_image = reinterpret_cast<PFNEGLDESTROYIMAGEKHRPROC>(
        eglGetProcAddress("eglDestroyImageKHR"));
    bind_image = reinterpret_cast<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>(
        eglGetProcAddress("glEGLImageTargetTexture2DOES"));
    auto query = reinterpret_cast<PFNEGLQUERYDMABUFMODIFIERSEXTPROC>(
        eglGetProcAddress("eglQueryDmaBufModifiersEXT"));
    if (!create_image || !destroy_image || !bind_image || !query)
      return;
    for (uint32_t format : {DRM_FORMAT_XRGB8888, DRM_FORMAT_ARGB8888,
                            DRM_FORMAT_XBGR8888, DRM_FORMAT_ABGR8888}) {
      EGLuint64KHR modifiers[128];
      EGLBoolean external[128];
      EGLint count = 0;
      if (!query(display, format, 128, modifiers, external, &count))
        continue;
      for (int i = 0; i < std::min(128, count) && formats.size() < 128; i++)
        if (!external[i])
          formats.emplace_back(format, modifiers[i]);
    }
  }
  Json capabilities() {
    auto result = take(json_object_new_array());
    for (auto [format, modifier] : formats) {
      auto value = object();
      put(value.get(), "format", int64_t(format));
      put(value.get(), "hi", int64_t(modifier >> 32));
      put(value.get(), "lo", int64_t(modifier & 0xffffffff));
      json_object_array_add(result.get(), value.release());
    }
    return result;
  }
  void release(SDL_Renderer *renderer) {
    if (image == EGL_NO_IMAGE_KHR)
      return;
    // Flush SDL's queued draws and wait for consumer completion before dropping
    // its imported allocation. Unique buffers are never reused by the producer.
    // EGL DMA-BUF import supplies implicit producer synchronization; glFinish
    // supplies the consumer fence. No guessed sleeps or fd numbers as handles.
    SDL_FlushRenderer(renderer);
    glFinish();
    if (texture)
      glDeleteTextures(1, &texture);
    destroy_image(display, image);
    texture = 0;
    image = EGL_NO_IMAGE_KHR;
    buffer = Fd();
  }
  SDL_Texture *import(SDL_Renderer *renderer, Packet &packet) {
    auto j = packet.json.get();
    auto width = integer(j, "width"), height = integer(j, "height"),
         stride = integer(j, "stride"), offset = integer(j, "offset");
    auto format = uint32_t(integer(j, "format"));
    auto hi = uint32_t(integer(j, "modifierHi")),
         lo = uint32_t(integer(j, "modifierLo"));
    if (width <= 0 || height <= 0 || width > 2048 || height > 2048 ||
        stride < width * 4 || offset < 0 || offset > int64_t(frame_limit) ||
        stride > (int64_t(frame_limit) - offset) / height ||
        std::find(formats.begin(), formats.end(),
                  std::pair{format, (uint64_t(hi) << 32) | lo}) ==
            formats.end())
      return nullptr;
    EGLint attributes[] = {EGL_WIDTH,
                           EGLint(width),
                           EGL_HEIGHT,
                           EGLint(height),
                           EGL_LINUX_DRM_FOURCC_EXT,
                           EGLint(format),
                           EGL_DMA_BUF_PLANE0_FD_EXT,
                           packet.fd.value,
                           EGL_DMA_BUF_PLANE0_OFFSET_EXT,
                           EGLint(offset),
                           EGL_DMA_BUF_PLANE0_PITCH_EXT,
                           EGLint(stride),
                           EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT,
                           EGLint(hi),
                           EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT,
                           EGLint(lo),
                           EGL_NONE};
    SDL_FlushRenderer(renderer);
    image = create_image(display, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT,
                         nullptr, attributes);
    if (image == EGL_NO_IMAGE_KHR)
      return nullptr;
    while (glGetError() != GL_NO_ERROR) {
    }
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    bind_image(GL_TEXTURE_2D, image);
    if (glGetError() != GL_NO_ERROR) {
      release(renderer);
      return nullptr;
    }
    const auto props = SDL_CreateProperties();
    SDL_SetNumberProperty(props, SDL_PROP_TEXTURE_CREATE_WIDTH_NUMBER, width);
    SDL_SetNumberProperty(props, SDL_PROP_TEXTURE_CREATE_HEIGHT_NUMBER, height);
    SDL_SetNumberProperty(props, SDL_PROP_TEXTURE_CREATE_FORMAT_NUMBER,
                          SDL_PIXELFORMAT_ABGR8888);
    SDL_SetNumberProperty(
        props, SDL_PROP_TEXTURE_CREATE_OPENGLES2_TEXTURE_NUMBER, texture);
    auto result = SDL_CreateTextureWithProperties(renderer, props);
    SDL_DestroyProperties(props);
    if (!result) {
      release(renderer);
      return nullptr;
    }
    // SDL 3.4.14's GLES2 texture wrapper calls glTexImage2D even for a
    // borrowed texture name, replacing its storage. Attach the EGL image
    // after the SDL wrapper is initialized, or every frame renders black.
    // See SDL_render_gles2.c::GLES2_CreateTexture in the pinned SDL source.
    glBindTexture(GL_TEXTURE_2D, texture);
    bind_image(GL_TEXTURE_2D, image);
    if (glGetError() != GL_NO_ERROR) {
      SDL_DestroyTexture(result); release(renderer); return nullptr;
    }
    SDL_SetTextureBlendMode(result, SDL_BLENDMODE_NONE);
    buffer = std::move(packet.fd);
    return result;
  }
};
} // namespace cafe
