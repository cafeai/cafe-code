#pragma once

// Local-only protocol. Every packet is bounded JSON plus at most one immutable
// frame fd. SOCK_SEQPACKET preserves boundaries; an fd number in JSON is never
// treated as a transferable handle. Both peers also verify SO_PEERCRED.
#include <algorithm>
#include <chrono>
#include <cstring>
#include <fcntl.h>
#include <json-c/json.h>
#include <memory>
#include <signal.h>
#include <stdexcept>
#include <string>
#include <sys/mman.h>
#include <sys/poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <vector>

namespace cafe {
constexpr size_t packet_limit = 65536;
constexpr size_t frame_limit = 32 * 1024 * 1024;
inline int64_t now() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch())
      .count();
}
struct Fd {
  int value = -1;
  explicit Fd(int n = -1) : value(n) {}
  ~Fd() {
    if (value >= 0)
      close(value);
  }
  Fd(const Fd &) = delete;
  Fd &operator=(const Fd &) = delete;
  Fd(Fd &&other) noexcept : value(other.value) { other.value = -1; }
  Fd &operator=(Fd &&other) noexcept {
    if (value >= 0)
      close(value);
    value = other.value;
    other.value = -1;
    return *this;
  }
  int release() {
    int n = value;
    value = -1;
    return n;
  }
};
using Json = std::unique_ptr<json_object, decltype(&json_object_put)>;
inline Json take(json_object *obj) { return Json(obj, json_object_put); }
inline Json object() { return take(json_object_new_object()); }
inline Json parse(const std::string &text) {
  json_tokener *parser = json_tokener_new_ex(32);
  json_object *obj = json_tokener_parse_ex(parser, text.data(), text.size());
  const bool valid = json_tokener_get_error(parser) == json_tokener_success &&
                     json_tokener_get_parse_end(parser) == text.size() && obj &&
                     json_object_is_type(obj, json_type_object);
  json_tokener_free(parser);
  if (!valid) {
    if (obj)
      json_object_put(obj);
    throw std::runtime_error("invalid_request");
  }
  return take(obj);
}
inline json_object *field(json_object *j, const char *key) {
  json_object *result = nullptr;
  json_object_object_get_ex(j, key, &result);
  return result;
}
inline std::string str(json_object *j, const char *key) {
  auto v = field(j, key);
  return v && json_object_is_type(v, json_type_string)
             ? std::string(json_object_get_string(v),
                           json_object_get_string_len(v))
             : "";
}
inline int64_t integer(json_object *j, const char *key, int64_t fallback = 0) {
  auto v = field(j, key);
  return v && json_object_is_type(v, json_type_int) ? json_object_get_int64(v)
                                                    : fallback;
}
inline bool boolean(json_object *j, const char *key) {
  auto v = field(j, key);
  return v && json_object_is_type(v, json_type_boolean) &&
         json_object_get_boolean(v);
}
inline void put(json_object *j, const char *key, const std::string &value) {
  json_object_object_add(
      j, key, json_object_new_string_len(value.data(), value.size()));
}
inline void put(json_object *j, const char *key, int64_t value) {
  json_object_object_add(j, key, json_object_new_int64(value));
}
inline void put(json_object *j, const char *key, bool value) {
  json_object_object_add(j, key, json_object_new_boolean(value));
}
inline std::string encode(json_object *j) {
  return json_object_to_json_string_ext(j, JSON_C_TO_STRING_PLAIN);
}
inline Json error(const std::string &code) {
  auto j = object();
  put(j.get(), "error", code);
  return j;
}
inline bool equal_secret(const std::string &a, const std::string &b) {
  if (a.size() != b.size() || a.size() < 32)
    return false;
  unsigned diff = 0;
  for (size_t i = 0; i < a.size(); ++i)
    diff |= a[i] ^ b[i];
  return diff == 0;
}
inline std::string private_file(const std::string &file) {
  Fd fd(open(file.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW));
  struct stat st{};
  if (fd.value < 0 || fstat(fd.value, &st) < 0 || !S_ISREG(st.st_mode) ||
      st.st_uid != getuid() || st.st_nlink != 1 || (st.st_mode & 077) != 0 ||
      st.st_size < 0 || st.st_size > int64_t(packet_limit))
    throw std::runtime_error("private_file_unavailable");
  std::string data(st.st_size, '\0');
  size_t offset = 0;
  while (offset < data.size()) {
    auto n = read(fd.value, data.data() + offset, data.size() - offset);
    if (n <= 0)
      throw std::runtime_error("private_file_unavailable");
    offset += n;
  }
  return data;
}
inline void write_private(const std::string &file, const std::string &data) {
  Fd fd(open(file.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW,
             0600));
  if (fd.value < 0)
    throw std::runtime_error("private_file_unavailable");
  size_t off = 0;
  while (off < data.size()) {
    auto n = write(fd.value, data.data() + off, data.size() - off);
    if (n <= 0)
      throw std::runtime_error("private_file_unavailable");
    off += n;
  }
  fsync(fd.value);
}
inline sockaddr_un address(const std::string &path) {
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  if (path.empty() || path.size() >= sizeof(addr.sun_path))
    throw std::runtime_error("invalid_socket");
  memcpy(addr.sun_path, path.c_str(), path.size() + 1);
  return addr;
}
inline bool same_user(int fd) {
  ucred credentials{};
  socklen_t size = sizeof(credentials);
  return getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &size) == 0 &&
         credentials.uid == getuid();
}
inline void send_packet(int socket, json_object *message, int frame_fd = -1) {
  auto text = encode(message);
  if (text.size() > packet_limit)
    throw std::runtime_error("response_too_large");
  iovec io{text.data(), text.size()};
  msghdr msg{};
  msg.msg_iov = &io;
  msg.msg_iovlen = 1;
  alignas(cmsghdr) char control[CMSG_SPACE(sizeof(int))]{};
  if (frame_fd >= 0) {
    msg.msg_control = control;
    msg.msg_controllen = sizeof(control);
    auto c = CMSG_FIRSTHDR(&msg);
    c->cmsg_level = SOL_SOCKET;
    c->cmsg_type = SCM_RIGHTS;
    c->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(c), &frame_fd, sizeof(int));
  }
  if (sendmsg(socket, &msg, MSG_NOSIGNAL) != ssize_t(text.size()))
    throw std::runtime_error("connection_lost");
}
struct Packet {
  Json json = object();
  Fd fd;
};
inline Packet receive_packet(int socket) {
  std::vector<char> buffer(packet_limit);
  iovec io{buffer.data(), buffer.size()};
  alignas(cmsghdr) char control[CMSG_SPACE(sizeof(int) * 8)]{};
  msghdr msg{};
  msg.msg_iov = &io;
  msg.msg_iovlen = 1;
  msg.msg_control = control;
  msg.msg_controllen = sizeof(control);
  auto n = recvmsg(socket, &msg, MSG_CMSG_CLOEXEC);
  Packet packet;
  unsigned descriptors = 0;
  for (auto c = CMSG_FIRSTHDR(&msg); c; c = CMSG_NXTHDR(&msg, c)) {
    if (c->cmsg_level != SOL_SOCKET || c->cmsg_type != SCM_RIGHTS ||
        c->cmsg_len < CMSG_LEN(0))
      continue;
    auto count = (c->cmsg_len - CMSG_LEN(0)) / sizeof(int);
    auto values = reinterpret_cast<int *>(CMSG_DATA(c));
    for (size_t i = 0; i < count; i++) {
      Fd fd(values[i]);
      if (++descriptors == 1)
        packet.fd = std::move(fd);
    }
  }
  if (n <= 0 || (msg.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) || descriptors > 1)
    throw std::runtime_error("connection_lost");
  packet.json = parse(std::string(buffer.data(), n));
  return packet;
}
inline Fd connect_worker(json_object *config, const std::string &role) {
  Fd fd(socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0));
  auto addr = address(str(config, "socket"));
  timeval timeout{45, 0};
  setsockopt(fd.value, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  setsockopt(fd.value, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
  if (connect(fd.value, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) <
          0 ||
      !same_user(fd.value))
    throw std::runtime_error("worker_unavailable");
  auto hello = object();
  put(hello.get(), "method", std::string("hello"));
  put(hello.get(), "role", role);
  put(hello.get(), "protocol", int64_t(1));
  put(hello.get(), "token", str(config, "token"));
  send_packet(fd.value, hello.get());
  auto response = receive_packet(fd.value);
  if (!boolean(response.json.get(), "ok"))
    throw std::runtime_error("not_authorized");
  return fd;
}
inline Json ok() {
  auto j = object();
  put(j.get(), "ok", true);
  return j;
}
int worker(const std::string &bootstrap);
int viewer(const std::string &bootstrap);
int request(const std::string &bootstrap);
} // namespace cafe
