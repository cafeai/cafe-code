#include "session-services.hpp"
#include "common.hpp"
#include <atomic>
#include <deque>
#include <gio/gio.h>
#include <map>

namespace cafe {
namespace {
constexpr auto service = "org.freedesktop.secrets";
constexpr auto root = "/org/freedesktop/secrets";
constexpr size_t message_limit = 1024 * 1024;
constexpr unsigned call_limit = 256, client_limit = 64;
constexpr int call_timeout = 30000, connect_timeout = 3000;

bool secret_path(const char *path) {
  return path && (strcmp(path, root) == 0 ||
                  g_str_has_prefix(path, "/org/freedesktop/secrets/"));
}
bool secret_interface(const char *interface) {
  if (!interface)
    return false;
  for (auto allowed :
       {"org.freedesktop.Secret.Service", "org.freedesktop.Secret.Collection",
        "org.freedesktop.Secret.Item", "org.freedesktop.Secret.Session",
        "org.freedesktop.Secret.Prompt", "org.freedesktop.DBus.Properties",
        "org.freedesktop.DBus.Introspectable", "org.freedesktop.DBus.Peer"})
    if (strcmp(interface, allowed) == 0)
      return true;
  return false;
}
bool bounded(GDBusMessage *message) {
  auto body = g_dbus_message_get_body(message);
  // Secret Service has no file-descriptor arguments. Never proxy arbitrary
  // descriptors or an unbounded credential payload into the host session.
  return g_dbus_message_get_num_unix_fds(message) == 0 &&
         (!body || g_variant_get_size(body) <= message_limit);
}
bool local_bus(const std::string &address) {
  return address.starts_with("unix:") &&
         address.find(';') == std::string::npos &&
         g_dbus_is_address(address.c_str());
}
bool owned_bus(GDBusConnection *connection) {
  auto stream = g_dbus_connection_get_stream(connection);
  return G_IS_SOCKET_CONNECTION(stream) &&
         same_user(g_socket_get_fd(
             g_socket_connection_get_socket(G_SOCKET_CONNECTION(stream))));
}
void send(GDBusConnection *connection, GDBusMessage *message) {
  g_dbus_connection_send_message(
      connection, message, G_DBUS_SEND_MESSAGE_FLAGS_NONE, nullptr, nullptr);
}
void unavailable(GDBusConnection *connection, GDBusMessage *call,
                 const char *name = "org.freedesktop.DBus.Error.Failed") {
  if (g_dbus_message_get_flags(call) & G_DBUS_MESSAGE_FLAGS_NO_REPLY_EXPECTED)
    return;
  auto reply = g_dbus_message_new_method_error_literal(
      call, name, "The host credential service is unavailable.");
  send(connection, reply);
  g_object_unref(reply);
}

// Connection setup must be bounded even if a Unix socket accepts a client but
// never completes authentication. Run GIO's asynchronous handshake under a
// cancellable deadline; never use its unbounded synchronous constructor.
GDBusConnection *connect_bus(const std::string &address) {
  struct Result {
    GDBusConnection *connection = nullptr;
    bool done = false;
  } result;
  auto cancel = g_cancellable_new();
  auto timer = g_timeout_add(
      connect_timeout,
      [](gpointer data) -> gboolean {
        g_cancellable_cancel(G_CANCELLABLE(data));
        return G_SOURCE_CONTINUE;
      },
      cancel);
  g_dbus_connection_new_for_address(
      address.c_str(),
      GDBusConnectionFlags(G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT |
                           G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION),
      nullptr, cancel,
      [](GObject *, GAsyncResult *async, gpointer data) {
        auto result = static_cast<Result *>(data);
        result->connection =
            g_dbus_connection_new_for_address_finish(async, nullptr);
        result->done = true;
      },
      &result);
  while (!result.done)
    g_main_context_iteration(nullptr, true);
  g_source_remove(timer);
  g_object_unref(cancel);
  if (result.connection && !owned_bus(result.connection)) {
    g_object_unref(result.connection);
    result.connection = nullptr;
  }
  if (result.connection)
    g_dbus_connection_set_exit_on_close(result.connection, false);
  return result.connection;
}

class Bridge {
  struct Client;
  struct Call {
    Bridge *bridge;
    GDBusMessage *message;
    explicit Call(Bridge *b, GDBusMessage *m) : bridge(b), message(m) {}
    ~Call() {
      g_object_unref(message);
      bridge->pending--;
    }
  };
  struct Client {
    Bridge *bridge;
    std::string sender;
    GDBusConnection *host = nullptr;
    GCancellable *cancel = g_cancellable_new();
    std::deque<std::unique_ptr<Call>> waiting;
    guint timer = 0, signals = 0, owner_watch = 0;
    bool alive = true;
    Client(Bridge *b, std::string s) : bridge(b), sender(std::move(s)) {}
    ~Client() {
      stop();
      if (host)
        g_object_unref(host);
      g_object_unref(cancel);
    }
    void stop() {
      alive = false;
      if (timer) {
        g_source_remove(timer);
        timer = 0;
      }
      g_cancellable_cancel(cancel);
      waiting.clear();
      if (owner_watch) {
        const auto watch = owner_watch;
        owner_watch = 0;
        g_bus_unwatch_name(watch);
      }
      if (host) {
        if (signals) {
          g_dbus_connection_signal_unsubscribe(host, signals);
          signals = 0;
        }
        // Closing the per-app host connection also closes its Secret Service
        // sessions/prompts. Keeping one shared connection would mix clients.
        g_dbus_connection_close(host, nullptr, nullptr, nullptr);
      }
    }
  };
  struct Pending {
    std::shared_ptr<Client> client;
    std::unique_ptr<Call> call;
  };
  GDBusConnection *bus;
  std::string host_address;
  std::map<std::string, std::shared_ptr<Client>> clients;
  std::atomic<unsigned> pending{0};

  void forward(std::shared_ptr<Client> client, std::unique_ptr<Call> call) {
    if (!client->alive || !client->host ||
        g_dbus_connection_is_closed(client->host)) {
      unavailable(bus, call->message);
      return;
    }
    auto message = g_dbus_message_copy(call->message, nullptr);
    g_dbus_message_set_sender(message, nullptr);
    g_dbus_message_set_destination(message, service);
    g_dbus_message_set_serial(message, 0);
    if (g_dbus_message_get_flags(message) &
        G_DBUS_MESSAGE_FLAGS_NO_REPLY_EXPECTED) {
      send(client->host, message);
    } else {
      auto data = new Pending{client, std::move(call)};
      g_dbus_connection_send_message_with_reply(
          client->host, message, G_DBUS_SEND_MESSAGE_FLAGS_NONE, call_timeout,
          nullptr, client->cancel,
          [](GObject *source, GAsyncResult *async, gpointer value) {
            std::unique_ptr<Pending> data(static_cast<Pending *>(value));
            auto reply = g_dbus_connection_send_message_with_reply_finish(
                G_DBUS_CONNECTION(source), async, nullptr);
            auto client = data->client;
            if (client->alive) {
              if (reply && bounded(reply)) {
                auto copy = g_dbus_message_copy(reply, nullptr);
                g_dbus_message_set_sender(copy, nullptr);
                g_dbus_message_set_destination(copy, client->sender.c_str());
                g_dbus_message_set_serial(copy, 0);
                g_dbus_message_set_reply_serial(
                    copy, g_dbus_message_get_serial(data->call->message));
                send(client->bridge->bus, copy);
                g_object_unref(copy);
              } else {
                unavailable(client->bridge->bus, data->call->message);
              }
            }
            if (reply)
              g_object_unref(reply);
          },
          data);
    }
    g_object_unref(message);
  }

  void dispatch(std::unique_ptr<Call> call) {
    auto message = call->message;
    const char *sender = g_dbus_message_get_sender(message);
    if (!sender || !g_dbus_is_unique_name(sender) ||
        !secret_path(g_dbus_message_get_path(message)) ||
        !secret_interface(g_dbus_message_get_interface(message)) ||
        !bounded(message)) {
      unavailable(bus, message, "org.freedesktop.DBus.Error.AccessDenied");
      return;
    }
    auto it = clients.find(sender);
    if (it != clients.end() && it->second->host &&
        g_dbus_connection_is_closed(it->second->host)) {
      // The host bus may restart while apps remain open. In-flight calls on
      // the old connection finish with errors; a subsequent call can reconnect.
      // Session object paths still belong to their original host connection.
      const auto watch = it->second->owner_watch;
      it->second->owner_watch = 0;
      if (watch)
        g_bus_unwatch_name(watch);
      clients.erase(it);
      it = clients.end();
    }
    if (it != clients.end()) {
      if (it->second->host)
        forward(it->second, std::move(call));
      else
        it->second->waiting.push_back(std::move(call));
      return;
    }
    if (clients.size() >= client_limit || !local_bus(host_address)) {
      unavailable(bus, message);
      return;
    }
    auto client = std::make_shared<Client>(this, sender);
    clients.emplace(sender, client);
    client->waiting.push_back(std::move(call));
    // Watching also checks current ownership. A client may have disappeared
    // before its queued filter callback ran, in which case a signal-only
    // NameOwnerChanged listener would miss cleanup and leak a host connection.
    client->owner_watch = g_bus_watch_name_on_connection(
        bus, sender, G_BUS_NAME_WATCHER_FLAGS_NONE, nullptr,
        [](GDBusConnection *, const gchar *, gpointer value) {
          auto client = *static_cast<std::shared_ptr<Client> *>(value);
          auto bridge = client->bridge;
          client->stop();
          const auto it = bridge->clients.find(client->sender);
          if (it != bridge->clients.end() && it->second == client)
            bridge->clients.erase(it);
        },
        new std::shared_ptr<Client>(client),
        [](gpointer value) {
          delete static_cast<std::shared_ptr<Client> *>(value);
        });
    client->timer = g_timeout_add(
        connect_timeout,
        [](gpointer value) -> gboolean {
          auto client = static_cast<Client *>(value);
          client->timer = 0;
          g_cancellable_cancel(client->cancel);
          return G_SOURCE_REMOVE;
        },
        client.get());
    g_dbus_connection_new_for_address(
        host_address.c_str(),
        GDBusConnectionFlags(G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT |
                             G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION),
        nullptr, client->cancel,
        [](GObject *, GAsyncResult *async, gpointer value) {
          std::unique_ptr<std::shared_ptr<Client>> holder(
              static_cast<std::shared_ptr<Client> *>(value));
          auto client = *holder;
          auto bridge = client->bridge;
          client->host =
              g_dbus_connection_new_for_address_finish(async, nullptr);
          if (client->timer) {
            g_source_remove(client->timer);
            client->timer = 0;
          }
          if (!client->alive)
            return;
          if (!client->host || !owned_bus(client->host) ||
              g_strcmp0(g_dbus_connection_get_guid(client->host),
                        g_dbus_connection_get_guid(bridge->bus)) == 0) {
            for (auto &call : client->waiting)
              unavailable(bridge->bus, call->message);
            client->stop();
            bridge->clients.erase(client->sender);
            return;
          }
          g_dbus_connection_set_exit_on_close(client->host, false);
          // GIO tracks the current owner of this well-known name; unrelated
          // host signals never cross the bridge. Deliver even public collection
          // signals only to this client, avoiding duplicate broadcast fan-out.
          client->signals = g_dbus_connection_signal_subscribe(
              client->host, service, nullptr, nullptr, nullptr, nullptr,
              G_DBUS_SIGNAL_FLAGS_NONE,
              [](GDBusConnection *, const gchar *, const gchar *path,
                 const gchar *interface, const gchar *member, GVariant *body,
                 gpointer value) {
                auto client = static_cast<Client *>(value);
                if (!client->alive || !secret_path(path) ||
                    !secret_interface(interface) ||
                    g_variant_get_size(body) > message_limit)
                  return;
                g_dbus_connection_emit_signal(client->bridge->bus,
                                              client->sender.c_str(), path,
                                              interface, member, body, nullptr);
              },
              client.get(), nullptr);
          auto waiting = std::move(client->waiting);
          for (auto &call : waiting)
            bridge->forward(client, std::move(call));
        },
        new std::shared_ptr<Client>(client));
  }

public:
  Bridge(GDBusConnection *connection, std::string host)
      : bus(connection), host_address(std::move(host)) {}

  void start() {
    // Filters run on GIO's I/O thread. Bound admission there, then transfer
    // ownership to the main loop before touching the client/session map.
    g_dbus_connection_add_filter(
        bus,
        [](GDBusConnection *bus, GDBusMessage *message, gboolean incoming,
           gpointer value) -> GDBusMessage * {
          if (!incoming || g_dbus_message_get_message_type(message) !=
                               G_DBUS_MESSAGE_TYPE_METHOD_CALL)
            return message;
          auto bridge = static_cast<Bridge *>(value);
          if (!bounded(message) ||
              !secret_path(g_dbus_message_get_path(message)) ||
              !secret_interface(g_dbus_message_get_interface(message))) {
            unavailable(bus, message,
                        "org.freedesktop.DBus.Error.AccessDenied");
            g_object_unref(message);
            return nullptr;
          }
          if (bridge->pending.fetch_add(1) >= call_limit) {
            bridge->pending--;
            unavailable(bus, message,
                        "org.freedesktop.DBus.Error.LimitsExceeded");
            g_object_unref(message);
            return nullptr;
          }
          auto call = new Call(bridge, message);
          g_idle_add_full(
              G_PRIORITY_DEFAULT,
              [](gpointer value) -> gboolean {
                auto call = static_cast<Call *>(value);
                call->bridge->dispatch(std::unique_ptr<Call>(call));
                return G_SOURCE_REMOVE;
              },
              call, nullptr);
          return nullptr;
        },
        this, nullptr);
  }
};
} // namespace

void prepare_session_services(const std::string &directory,
                              const std::string &helper,
                              const std::string &host_bus) {
  auto configuration = object();
  put(configuration.get(), "directory", directory);
  put(configuration.get(), "hostBus", host_bus);
  const auto file = directory + "/session-services.json";
  write_private(file, encode(configuration.get()));
  const auto services = directory + "/dbus-1/services";
  if (g_mkdir_with_parents(services.c_str(), 0700) < 0)
    throw std::runtime_error("session_services_unavailable");
  auto executable = g_shell_quote(helper.c_str());
  auto argument = g_shell_quote(file.c_str());
  // The transient runtime directory has precedence over installed .service
  // files. Even after a bridge crash, activation must restart this bridge and
  // must never start a second host-profile keyring on the private bus.
  write_private(services + "/org.freedesktop.secrets.service",
                "[D-BUS Service]\nName=org.freedesktop.secrets\nExec=" +
                    std::string(executable) + " session-services " + argument +
                    "\n");
  g_free(executable);
  g_free(argument);
}

int session_services(const std::string &file) {
  // GIO's opt-in wire tracing prints complete message bodies. An inherited
  // debugging setting must never turn credential forwarding into a log sink.
  unsetenv("G_DBUS_DEBUG");
  const auto config = parse(private_file(file));
  const auto directory = str(config.get(), "directory");
  const auto address = "unix:path=" + directory + "/bus";
  auto bus = connect_bus(address);
  if (!bus)
    throw std::runtime_error("session_services_unavailable");
  const auto environment = parse(private_file(directory + "/environment.json"));
  GVariantBuilder values;
  g_variant_builder_init(&values, G_VARIANT_TYPE("a{ss}"));
  for (auto name : {"DISPLAY", "WAYLAND_DISPLAY", "SWAYSOCK"}) {
    auto value = str(environment.get(), name);
    if (!value.empty())
      g_variant_builder_add(&values, "{ss}", name, value.c_str());
  }
  g_variant_builder_add(&values, "{ss}", "XDG_RUNTIME_DIR", directory.c_str());
  g_variant_builder_add(&values, "{ss}", "XDG_CURRENT_DESKTOP", "sway");
  g_variant_builder_add(&values, "{ss}", "XDG_SESSION_TYPE", "wayland");
  // Update only this bus. In particular, never import the private display into
  // the host systemd user manager's environment (--systemd/--all would do so).
  auto updated = g_dbus_connection_call_sync(
      bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
      "org.freedesktop.DBus", "UpdateActivationEnvironment",
      g_variant_new("(a{ss})", &values), nullptr, G_DBUS_CALL_FLAGS_NONE,
      connect_timeout, nullptr, nullptr);
  if (!updated)
    throw std::runtime_error("session_services_unavailable");
  g_variant_unref(updated);
  auto host = str(config.get(), "hostBus");
  if (host == address)
    host.clear();
  // This process has no credential persistence or diagnostics. The Secret
  // Service wire bodies pass through unchanged, including encrypted sessions.
  // https://specifications.freedesktop.org/secret-service/latest/sessions.html
  Bridge bridge(bus, host);
  bridge.start();
  auto acquired = g_dbus_connection_call_sync(
      bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
      "org.freedesktop.DBus", "RequestName", g_variant_new("(su)", service, 4u),
      G_VARIANT_TYPE("(u)"), G_DBUS_CALL_FLAGS_NONE, connect_timeout, nullptr,
      nullptr);
  guint32 result = 0;
  if (acquired) {
    g_variant_get(acquired, "(u)", &result);
    g_variant_unref(acquired);
  }
  if (result != 1)
    throw std::runtime_error("credential_bridge_unavailable");
  const auto ready = directory + "/session-services.ready";
  if (access(ready.c_str(), F_OK) != 0)
    write_private(ready, "ready\n");
  auto loop = g_main_loop_new(nullptr, false);
  g_signal_connect(
      bus, "closed",
      G_CALLBACK(+[](GDBusConnection *, gboolean, GError *, gpointer loop) {
        g_main_loop_quit(static_cast<GMainLoop *>(loop));
      }),
      loop);
  g_main_loop_run(loop);
  // No callbacks may outlive Bridge. Exit the disposable service process rather
  // than unwinding it while GIO's I/O thread still has queued filter callbacks.
  _exit(0);
}
} // namespace cafe
