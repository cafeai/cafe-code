// Opt-in process fixture. All credentials and both buses are synthetic.
#include "common.hpp"
#include <gio/gio.h>
#include <iostream>
#include <map>
#include <thread>

using namespace cafe;
constexpr auto service = "org.freedesktop.secrets";
constexpr auto root = "/org/freedesktop/secrets";
constexpr auto item = "/org/freedesktop/secrets/collection/login/item";
constexpr auto prompt = "/org/freedesktop/secrets/prompt/test";
std::map<std::string, std::string> sessions;
unsigned next_session = 0;
const char *xml = R"XML(<node>
<interface name="org.freedesktop.Secret.Service">
 <method name="OpenSession"><arg type="s" direction="in"/><arg type="v" direction="in"/><arg type="v" direction="out"/><arg type="o" direction="out"/></method>
 <method name="ReadAlias"><arg type="s" direction="in"/><arg type="o" direction="out"/></method>
 <method name="Unlock"><arg type="ao" direction="in"/><arg type="ao" direction="out"/><arg type="o" direction="out"/></method>
 <method name="SetAlias"><arg type="s" direction="in"/><arg type="o" direction="in"/></method>
 <method name="ActiveSessions"><arg type="u" direction="out"/></method>
 <property name="Collections" type="ao" access="read"/>
</interface>
<interface name="org.freedesktop.Secret.Item">
 <method name="GetSecret"><arg type="o" direction="in"/><arg type="(oayays)" direction="out"/></method>
</interface>
<interface name="org.freedesktop.Secret.Prompt">
 <method name="Prompt"><arg type="s" direction="in"/></method>
 <signal name="Completed"><arg type="b"/><arg type="v"/></signal>
</interface>
</node>)XML";

GDBusConnection *connect(const char *address) {
  auto bus = g_dbus_connection_new_for_address_sync(
      address,
      GDBusConnectionFlags(G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT |
                           G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION),
      nullptr, nullptr, nullptr);
  if (!bus)
    throw std::runtime_error("fixture_connect");
  g_dbus_connection_set_exit_on_close(bus, false);
  return bus;
}
GVariant *call(GDBusConnection *bus, const char *path, const char *interface,
               const char *method, GVariant *args = nullptr,
               bool succeeds = true) {
  GError *error = nullptr;
  auto result = g_dbus_connection_call_sync(
      bus, service, path, interface, method, args, nullptr,
      G_DBUS_CALL_FLAGS_NONE, 5000, nullptr, &error);
  if (bool(result) != succeeds) {
    // These diagnostics contain only synthetic fixture traffic.
    std::cerr << method << ": "
              << (error ? error->message : "unexpected success") << '\n';
    throw std::runtime_error("fixture_call");
  }
  g_clear_error(&error);
  return result;
}
void request_name(GDBusConnection *bus, const char *name) {
  auto reply = g_dbus_connection_call_sync(
      bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
      "org.freedesktop.DBus", "RequestName", g_variant_new("(su)", name, 4u),
      nullptr, G_DBUS_CALL_FLAGS_NONE, 3000, nullptr, nullptr);
  guint32 result = 0;
  if (reply) {
    g_variant_get(reply, "(u)", &result);
    g_variant_unref(reply);
  }
  if (result != 1)
    throw std::runtime_error("fixture_name");
}
int host(const char *address, const char *ready) {
  auto bus = connect(address);
  auto info = g_dbus_node_info_new_for_xml(xml, nullptr);
  static const GDBusInterfaceVTable vtable{
      +[](GDBusConnection *bus, const gchar *sender, const gchar *,
          const gchar *, const gchar *method, GVariant *args,
          GDBusMethodInvocation *invocation, gpointer) {
        GVariant *reply = nullptr;
        if (strcmp(method, "OpenSession") == 0) {
          auto session =
              std::string(root) + "/session/" + std::to_string(++next_session);
          sessions.emplace(session, sender);
          reply =
              g_variant_new("(vo)", g_variant_new_string(""), session.c_str());
        } else if (strcmp(method, "ReadAlias") == 0) {
          reply =
              g_variant_new("(o)", "/org/freedesktop/secrets/collection/login");
        } else if (strcmp(method, "ActiveSessions") == 0) {
          reply = g_variant_new("(u)", unsigned(sessions.size()));
        } else if (strcmp(method, "GetSecret") == 0) {
          const char *session;
          g_variant_get(args, "(&o)", &session);
          if (!sessions.contains(session) || sessions.at(session) != sender) {
            g_dbus_method_invocation_return_dbus_error(
                invocation, "org.freedesktop.Secret.Error.NoSession",
                "Wrong client");
            return;
          }
          const guint8 value[]{11, 22, 33};
          reply = g_variant_new(
              "((o@ay@ays))", session,
              g_variant_new_fixed_array(G_VARIANT_TYPE_BYTE, nullptr, 0, 1),
              g_variant_new_fixed_array(G_VARIANT_TYPE_BYTE, value, 3, 1),
              "text/plain");
        } else if (strcmp(method, "Unlock") == 0) {
          reply =
              g_variant_new("(@aoo)", g_variant_new_objv(nullptr, 0), prompt);
        } else if (strcmp(method, "Prompt") == 0) {
          g_dbus_connection_emit_signal(
              bus, sender, prompt, "org.freedesktop.Secret.Prompt", "Completed",
              g_variant_new("(bv)", false, g_variant_new_string("synthetic")),
              nullptr);
          reply = g_variant_new("()");
        } else if (strcmp(method, "SetAlias") == 0) {
          reply = g_variant_new("()");
        }
        g_dbus_method_invocation_return_value(invocation, reply);
      },
      +[](GDBusConnection *, const gchar *, const gchar *, const gchar *,
          const gchar *, GError **, gpointer) -> GVariant * {
        const char *collections[]{"/org/freedesktop/secrets/collection/login"};
        return g_variant_new_objv(collections, 1);
      },
      nullptr,
      {nullptr}};
  for (int i = 0; i < 3; i++)
    if (!g_dbus_connection_register_object(bus,
                                           i == 0   ? root
                                           : i == 1 ? item
                                                    : prompt,
                                           info->interfaces[i], &vtable,
                                           nullptr, nullptr, nullptr))
      throw std::runtime_error("fixture_register");
  g_dbus_connection_signal_subscribe(
      bus, "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
      "/org/freedesktop/DBus", nullptr, G_DBUS_SIGNAL_FLAGS_NONE,
      [](GDBusConnection *, const gchar *, const gchar *, const gchar *,
         const gchar *, GVariant *args, gpointer) {
        const char *name, *old_owner, *new_owner;
        g_variant_get(args, "(&s&s&s)", &name, &old_owner, &new_owner);
        if (!*new_owner)
          std::erase_if(sessions, [&](const auto &entry) {
            return entry.second == name;
          });
      },
      nullptr, nullptr);
  request_name(bus, service);
  write_private(ready, "ready\n");
  g_main_loop_run(g_main_loop_new(nullptr, false));
  return 0;
}

std::string session(GDBusConnection *bus) {
  auto reply = call(bus, root, "org.freedesktop.Secret.Service", "OpenSession",
                    g_variant_new("(sv)", "plain", g_variant_new_string("")));
  auto value = g_variant_get_child_value(reply, 1);
  std::string result = g_variant_get_string(value, nullptr);
  g_variant_unref(value);
  g_variant_unref(reply);
  return result;
}
unsigned active(GDBusConnection *bus) {
  auto reply =
      call(bus, root, "org.freedesktop.Secret.Service", "ActiveSessions");
  guint32 count;
  g_variant_get(reply, "(u)", &count);
  g_variant_unref(reply);
  return count;
}
int client(const char *address) {
  auto first = connect(address), second = connect(address);
  auto a = session(first), b = session(second);
  if (a == b || active(first) != 2)
    throw std::runtime_error("fixture_sessions");
  for (auto pair : {std::pair{first, a}, std::pair{second, b}}) {
    auto reply = call(pair.first, item, "org.freedesktop.Secret.Item",
                      "GetSecret", g_variant_new("(o)", pair.second.c_str()));
    if (!g_variant_is_of_type(reply, G_VARIANT_TYPE("((oayays))")))
      throw std::runtime_error("fixture_secret");
    g_variant_unref(reply);
  }
  call(second, item, "org.freedesktop.Secret.Item", "GetSecret",
       g_variant_new("(o)", a.c_str()), false);
  auto properties =
      call(first, root, "org.freedesktop.DBus.Properties", "GetAll",
           g_variant_new("(s)", "org.freedesktop.Secret.Service"));
  g_variant_unref(properties);
  auto introspection =
      call(first, root, "org.freedesktop.DBus.Introspectable", "Introspect");
  g_variant_unref(introspection);
  auto alias = call(first, root, "org.freedesktop.Secret.Service", "ReadAlias",
                    g_variant_new("(s)", "default"));
  g_variant_unref(alias);
  call(first, "/unrelated", "org.freedesktop.Secret.Service", "ReadAlias",
       g_variant_new("(s)", "default"), false);
  call(first, root, "org.cafe.Unrelated", "ReadAlias",
       g_variant_new("(s)", "default"), false);
  std::string oversized(1024 * 1024 + 1, 'x');
  call(first, root, "org.freedesktop.Secret.Service", "SetAlias",
       g_variant_new("(so)", oversized.c_str(), "/"), false);
  auto with_fd = g_dbus_message_new_method_call(
      service, root, "org.freedesktop.Secret.Service", "OpenSession");
  auto descriptors = g_unix_fd_list_new();
  Fd descriptor(open("/dev/null", O_RDONLY | O_CLOEXEC));
  g_unix_fd_list_append(descriptors, descriptor.value, nullptr);
  g_dbus_message_set_unix_fd_list(with_fd, descriptors);
  g_dbus_message_set_body(
      with_fd, g_variant_new("(sv)", "plain", g_variant_new_handle(0)));
  auto rejected = g_dbus_connection_send_message_with_reply_sync(
      first, with_fd, G_DBUS_SEND_MESSAGE_FLAGS_NONE, 3000, nullptr, nullptr,
      nullptr);
  if (!rejected || g_strcmp0(g_dbus_message_get_error_name(rejected),
                             "org.freedesktop.DBus.Error.AccessDenied") != 0)
    throw std::runtime_error("fixture_descriptor_rejection");
  g_object_unref(rejected);
  g_object_unref(descriptors);
  g_object_unref(with_fd);
  unsigned signals[2]{0, 0};
  auto callback = +[](GDBusConnection *, const gchar *, const gchar *,
                      const gchar *, const gchar *, GVariant *,
                      gpointer count) { ++*static_cast<unsigned *>(count); };
  g_dbus_connection_signal_subscribe(
      first, service, "org.freedesktop.Secret.Prompt", "Completed", prompt,
      nullptr, G_DBUS_SIGNAL_FLAGS_NONE, callback, &signals[0], nullptr);
  g_dbus_connection_signal_subscribe(
      second, service, "org.freedesktop.Secret.Prompt", "Completed", prompt,
      nullptr, G_DBUS_SIGNAL_FLAGS_NONE, callback, &signals[1], nullptr);
  auto completed = call(first, prompt, "org.freedesktop.Secret.Prompt",
                        "Prompt", g_variant_new("(s)", ""));
  g_variant_unref(completed);
  const auto deadline = now() + 1000;
  while (now() < deadline) {
    while (g_main_context_iteration(nullptr, false)) {
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  if (signals[0] != 1 || signals[1] != 0)
    throw std::runtime_error("fixture_prompt_routing");
  // Exercise disappearance before the bridge's queued method/connection
  // callbacks run. No-reply sessions must not leave upstream clients behind.
  for (int i = 0; i < 20; i++) {
    auto transient = connect(address);
    auto message = g_dbus_message_new_method_call(
        service, root, "org.freedesktop.Secret.Service", "OpenSession");
    g_dbus_message_set_flags(message, G_DBUS_MESSAGE_FLAGS_NO_REPLY_EXPECTED);
    g_dbus_message_set_body(
        message, g_variant_new("(sv)", "plain", g_variant_new_string("")));
    g_dbus_connection_send_message(
        transient, message, G_DBUS_SEND_MESSAGE_FLAGS_NONE, nullptr, nullptr);
    g_dbus_connection_flush_sync(transient, nullptr, nullptr);
    g_dbus_connection_close_sync(transient, nullptr, nullptr);
    g_object_unref(message);
    g_object_unref(transient);
  }
  g_dbus_connection_close_sync(first, nullptr, nullptr);
  g_object_unref(first);
  const auto cleanup_deadline = now() + 3000;
  while (active(second) != 1 && now() < cleanup_deadline)
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  if (active(second) != 1)
    throw std::runtime_error("fixture_disconnect_cleanup");
  g_dbus_connection_close_sync(second, nullptr, nullptr);
  g_object_unref(second);
  std::cout << "sessions, secrets, properties, errors, limits, prompts and "
               "disconnects verified\n";
  return 0;
}
int main(int argc, char **argv) {
  try {
    if (argc == 4 && std::string(argv[1]) == "host")
      return host(argv[2], argv[3]);
    if (argc == 3 && std::string(argv[1]) == "client")
      return client(argv[2]);
    if (argc == 3 && std::string(argv[1]) == "activation") {
      auto bus = connect(getenv("DBUS_SESSION_BUS_ADDRESS"));
      auto env = object();
      for (auto name : {"WAYLAND_DISPLAY", "DISPLAY", "XDG_RUNTIME_DIR",
                        "DBUS_SESSION_BUS_ADDRESS"})
        if (auto value = getenv(name))
          put(env.get(), name, std::string(value));
      write_private(argv[2], encode(env.get()));
      request_name(bus, "org.cafe.Test.Activation");
      g_main_loop_run(g_main_loop_new(nullptr, false));
      return 0;
    }
    if (argc == 3 && std::string(argv[1]) == "unavailable") {
      auto bus = connect(argv[2]);
      call(bus, root, "org.freedesktop.Secret.Service", "ReadAlias",
           g_variant_new("(s)", "default"), false);
      return 0;
    }
    throw std::runtime_error("fixture_arguments");
  } catch (const std::exception &error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
