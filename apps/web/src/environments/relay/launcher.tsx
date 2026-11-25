import { createRoot } from "react-dom/client";
import "../../index.css";
import { initializeApplicationLanguage } from "../../uiLocaleStartup";
import { RelayEntry } from "./entry";
import { readPrimaryRelay } from "./active";
import { openHostViewer } from "./viewerHost";
import { RelayError } from "@cafecode/relay/errors";

const root = createRoot(document.getElementById("root")!);
void initializeApplicationLanguage(document).then(() => {
  root.render(
    <RelayEntry
      ready={async () => {
        const relay = readPrimaryRelay();
        if (!relay) throw new RelayError("UNAVAILABLE");
        await openHostViewer(relay);
      }}
    />,
  );
});
