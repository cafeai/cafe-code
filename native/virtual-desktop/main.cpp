#include "common.hpp"
#include "session-services.hpp"
#include <iostream>
#include <png.h>
#include <glib.h>
#include <sys/prctl.h>

namespace cafe {
static std::string base64(const std::vector<unsigned char> &bytes) {
  static constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string output;
  output.reserve((bytes.size() + 2) / 3 * 4);
  for (size_t i = 0; i < bytes.size(); i += 3) {
    unsigned n = unsigned(bytes[i]) << 16;
    if (i + 1 < bytes.size())
      n |= unsigned(bytes[i + 1]) << 8;
    if (i + 2 < bytes.size())
      n |= bytes[i + 2];
    output += alphabet[(n >> 18) & 63];
    output += alphabet[(n >> 12) & 63];
    output += i + 1 < bytes.size() ? alphabet[(n >> 6) & 63] : '=';
    output += i + 2 < bytes.size() ? alphabet[n & 63] : '=';
  }
  return output;
}
int request(const std::string &bootstrap) {
  if (prctl(PR_SET_PDEATHSIG, SIGTERM) < 0 || getppid() == 1)
    throw std::runtime_error("request_owner_unavailable");
  auto config = parse(private_file(bootstrap));
  auto socket = connect_worker(config.get(), "manager");
  std::string line;
  for (char c; std::cin.get(c) && c != '\n';) {
    if (line.size() >= packet_limit)
      throw std::runtime_error("invalid_request");
    line += c;
  }
  auto body = parse(line);
  send_packet(socket.value, body.get());
  auto result = receive_packet(socket.value);
  if (result.fd.value >= 0) {
    auto j = result.json.get();
    auto width = integer(j, "width"), height = integer(j, "height"),
         stride = integer(j, "stride"),
         bpp = integer(j, "bytesPerPixel", 4);
    struct stat st{};
    if (width < 1 || height < 1 || width > 2048 || height > 2048 ||
        (bpp != 3 && bpp != 4) || stride < width * bpp ||
        stride > int64_t(frame_limit) / height || fstat(result.fd.value, &st) < 0 ||
        st.st_size < stride * height)
      throw std::runtime_error("invalid_frame");
    const auto size = stride * height;
    void *map = mmap(nullptr, size, PROT_READ, MAP_SHARED, result.fd.value, 0);
    if (map == MAP_FAILED)
      throw std::runtime_error("invalid_frame");
    // Screencopy wl_shm XRGB/ARGB buffers are native-endian BGRA on Linux x64.
    // Normalize y-inversion and alpha before PNG encoding in this disposable
    // client process, never in the input/capture event loop.
    // Card previews are small, transient captures. Downsample before encoding,
    // outside the worker loop; model observations retain every original pixel.
    const bool preview = boolean(body.get(), "preview");
    auto region = field(body.get(), "region");
    const auto left = region ? integer(region, "x", -1) : 0;
    const auto top = region ? integer(region, "y", -1) : 0;
    const auto crop_width = region ? integer(region, "width") : width;
    const auto crop_height = region ? integer(region, "height") : height;
    if (left < 0 || top < 0 || crop_width < 1 || crop_height < 1 ||
        left + crop_width > width || top + crop_height > height) {
      munmap(map, size);
      throw std::runtime_error("invalid_region");
    }
    const auto edge = std::max(crop_width, crop_height);
    const auto out_width = preview ? std::max<int64_t>(1, crop_width * std::min<int64_t>(480, edge) / edge) : crop_width;
    const auto out_height = preview ? std::max<int64_t>(1, crop_height * std::min<int64_t>(480, edge) / edge) : crop_height;
    std::vector<unsigned char> pixels(out_width * out_height * 3);
    bool inverted = boolean(j, "inverted"), rgb = boolean(j, "rgb");
    for (int y = 0; y < out_height; y++) {
      const auto sy = top + y * crop_height / out_height;
      auto row = static_cast<unsigned char *>(map) +
                 (inverted ? height - 1 - sy : sy) * stride;
      for (int x = 0; x < out_width; x++) {
        const auto sx = left + x * crop_width / out_width;
        auto dst = pixels.data() + (y * out_width + x) * 3;
        dst[0] = row[sx * bpp + (rgb ? 0 : 2)];
        dst[1] = row[sx * bpp + 1];
        dst[2] = row[sx * bpp + (rgb ? 2 : 0)];
      }
    }
    munmap(map, size);
    // Hash normalized pixels before PNG compression. Conditional polls skip
    // encoding and transporting unchanged images; the digest is process-local
    // observation metadata, never a persisted screenshot or model token.
    auto digest = g_compute_checksum_for_data(G_CHECKSUM_SHA256, pixels.data(), pixels.size());
    const std::string pixel_hash(digest);
    g_free(digest);
    put(j, "pixelHash", pixel_hash);
    put(j, "desktopWidth", width);
    put(j, "desktopHeight", height);
    put(j, "width", out_width);
    put(j, "height", out_height);
    if (!preview && str(body.get(), "sinceHash") == pixel_hash &&
        integer(body.get(), "sinceEpoch", -1) == integer(j, "controlEpoch") &&
        integer(body.get(), "sinceWidth", -1) == width &&
        integer(body.get(), "sinceHeight", -1) == height) {
      put(j, "unchanged", true);
      std::cout << encode(result.json.get()) << '\n';
      return 0;
    }
    png_image image{};
    image.version = PNG_IMAGE_VERSION;
    image.width = out_width;
    image.height = out_height;
    image.format = PNG_FORMAT_RGB;
    png_alloc_size_t count = 0;
    if (!png_image_write_to_memory(&image, nullptr, &count, 0, pixels.data(), 0,
                                   nullptr) ||
        count > 8 * 1024 * 1024)
      throw std::runtime_error("image_too_large");
    std::vector<unsigned char> png(count);
    if (!png_image_write_to_memory(&image, png.data(), &count, 0, pixels.data(),
                                   0, nullptr))
      throw std::runtime_error("capture_unavailable");
    png.resize(count);
    put(j, "image", base64(png));
    put(j, "width", out_width);
    put(j, "height", out_height);
  }
  std::cout << encode(result.json.get()) << '\n';
  return 0;
}
} // namespace cafe
int main(int argc, char **argv) {
  signal(SIGPIPE, SIG_IGN);
  umask(0077);
  try {
    if (argc == 2 && std::string(argv[1]) == "--version") {
      std::cout << "cafe-desktop-native 1\n";
      return 0;
    }
    if (argc != 3)
      throw std::runtime_error("invalid_arguments");
    std::string role = argv[1];
    if (role == "worker")
      return cafe::worker(argv[2]);
    if (role == "viewer")
      return cafe::viewer(argv[2]);
    if (role == "request")
      return cafe::request(argv[2]);
    if (role == "session-services")
      return cafe::session_services(argv[2]);
    if (role == "environment") {
      auto env = cafe::object();
      for (const char *name : {"WAYLAND_DISPLAY", "DISPLAY", "SWAYSOCK",
                               "DBUS_SESSION_BUS_ADDRESS"})
        if (auto value = getenv(name))
          cafe::put(env.get(), name, std::string(value));
      cafe::write_private(argv[2], cafe::encode(env.get()));
      return 0;
    }
    throw std::runtime_error("invalid_arguments");
  } catch (const std::exception &error) {
    // Only our fixed classifications may leave this boundary. Native library
    // diagnostics, file contents and command lines are never printed.
    std::cerr << "Cafe desktop operation failed.\n";
    return 1;
  }
}
