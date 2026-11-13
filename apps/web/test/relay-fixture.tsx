import "../src/index.css";
import { applyInterfaceScalePercent } from "../src/interfaceScale";
// Opt-in native qualification page. This entry is absent from the app build.
import ReactDOM from "react-dom/client";
import { RelayEntry } from "../src/environments/relay/entry";
import { readPrimaryRelay, fetchAppResource } from "../src/environments/relay/active";
import { listRelayTargetIds } from "../src/environments/relay/storage";

let exercised: { readonly active: boolean } | undefined;

declare global {
  interface Window {
    relayQualification: {
      appearance: (dark: boolean, scale: number) => void;
      exercise: () => Promise<{ text: string; length: number; equal: boolean; rpc: boolean }>;
      read: () => Promise<string>;
      retired: () => boolean;
      hasSavedConnection: () => Promise<boolean>;
    };
  }
}
window.relayQualification = {
  hasSavedConnection: async () =>
    (await listRelayTargetIds()).includes(sessionStorage.getItem("cafe-relay-active") ?? ""),
  retired: () => exercised?.active === false,
  appearance: (dark, scale) => {
    document.documentElement.classList.toggle("dark", dark);
    applyInterfaceScalePercent(scale);
  },
  read: async () => await (await readPrimaryRelay()!.request("/api/canary")).text(),
  exercise: async () => {
    const relay = readPrimaryRelay()!;
    exercised = await relay.session();
    const text = await (await fetchAppResource(relay.httpBaseUrl + "api/canary")).text();
    const bytes = new Uint8Array(524_309).map((_, index) => index % 251);
    const response = await fetchAppResource(relay.httpBaseUrl + "api/echo", {
      method: "POST",
      body: new Blob([bytes]),
      headers: { "content-type": "application/octet-stream" },
    });
    const result = new Uint8Array(await response.arrayBuffer());
    const command =
      JSON.stringify({
        message: "café ☕ 🌐\n".repeat(12_000),
        imageDataUrl: "data:image/png;base64," + "A".repeat(300_000),
      }) + "\n";
    const results = [];
    for (const query of ["", "?legacy=1"]) {
      const socket = relay.socket(relay.wsBaseUrl + "ws" + query);
      results.push(
        await new Promise<boolean>((resolve, reject) => {
          let received = "";
          socket.onopen = () => socket.send(command);
          socket.onmessage = (event) => {
            received += String(event.data);
            if (received.endsWith("\n")) {
              resolve(received === command);
              socket.close();
            }
          };
          socket.onerror = () => reject(new Error("rpc-refused"));
        }),
      );
    }
    return {
      text,
      length: result.length,
      equal: result.every((value, index) => value === bytes[index]),
      rpc: results.every(Boolean),
    };
  },
};
ReactDOM.createRoot(document.getElementById("root")!).render(
  <RelayEntry
    ready={() => {
      document.getElementById("root")!.textContent = "Paired";
    }}
  />,
);
