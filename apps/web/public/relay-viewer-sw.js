/* Trusted static worker on one isolated renderer origin. The launcher owns
 * authentication and validates every file before this worker can serve it. */
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const frame = "/_relay/frame";

async function serve(event, file) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  if (
    event.clientId &&
    clients.some(
      (client) => client.id === event.clientId && new URL(client.url).pathname === frame,
    ) &&
    event.request.mode !== "navigate"
  ) {
    return fetch(event.request);
  }
  const owners = clients.filter((client) => new URL(client.url).pathname === frame);
  if (owners.length !== 1) return new Response(null, { status: 503 });
  const { port1, port2 } = new MessageChannel();
  try {
    const { promise, resolve } = Promise.withResolvers();
    const deadline = setTimeout(() => resolve(null), 65_000);
    port1.onmessage = ({ data }) => resolve(data);
    port1.onmessageerror = () => resolve(null);
    try {
      owners[0].postMessage({ kind: "cafe-relay-viewer-asset-v1", file }, [port2]);
      const data = await promise;
      if (!(data?.body instanceof ArrayBuffer) || typeof data.contentType !== "string")
        return new Response(null, { status: data?.status === 404 ? 404 : 503 });
      return new Response(data.body, {
        headers: {
          "content-type": data.contentType,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "origin-agent-cluster": "?1",
        },
      });
    } finally {
      clearTimeout(deadline);
    }
  } finally {
    port1.close();
  }
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/_relay/")
  )
    return;
  const file = event.request.mode === "navigate" ? "index.html" : url.pathname.slice(1);
  event.respondWith(serve(event, file));
});
