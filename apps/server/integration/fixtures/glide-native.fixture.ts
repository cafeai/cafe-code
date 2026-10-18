// Synthetic peer only: no application, provider, credentials or native input.
import { writeFile } from "node:fs/promises";
import { readGlideFrames, writeGlideFrame } from "../../src/glide/framing.ts";
import {
  glideRequestSchema,
  isGlideAction,
  type GlideActionReceipt,
} from "../../src/glide/protocol.ts";

const receipt = process.argv[2];
let inputMode: string | undefined;
const arguments_ = process.argv.slice(3);
for (let index = 0; index < arguments_.length; index += 2) {
  const option = arguments_[index],
    value = arguments_[index + 1];
  if (
    option === "--input-mode" &&
    inputMode === undefined &&
    (value === "background" || value === "foreground")
  ) {
    inputMode = value;
  } else if (option !== "--allow-app" || value !== "fixture.app") {
    throw new Error("Synthetic Glide peer received invalid connection arguments.");
  }
}
if (inputMode === undefined)
  throw new Error("Synthetic Glide peer requires an explicit input mode.");
let text = "initial",
  operations: string[] = [];
for await (const raw of readGlideFrames(process.stdin)) {
  const envelope = raw as { id: number; method: string; input: unknown };
  const request = glideRequestSchema.parse({ method: envelope.method, input: envelope.input });
  let result: unknown = null;
  const action: GlideActionReceipt = {
    actionId: `synthetic:${envelope.id}`,
    method: request.method,
    status: "unverified",
    dispatch: "dispatched",
    osAcceptance: "unacknowledged",
    stage: "input-posted",
    progress: { axAttempted: 0, axAccepted: 0, eventsPosted: 2, textScalarsPosted: 0 },
    verification: { kind: "none", matched: null },
  };
  if (
    request.method !== "list_apps" &&
    request.input.app !== "Fixture" &&
    request.input.app !== "fixture.app" &&
    request.input.app !== "/fixture/Fixture.app"
  ) {
    await writeGlideFrame(process.stdout, {
      id: envelope.id,
      error: "Application is not allowed.",
    });
    continue;
  }
  operations.push(request.method);
  switch (request.method) {
    case "list_apps":
      result = [
        { name: "Fixture", bundleId: "fixture.app", path: "/fixture/Fixture.app", pid: 42 },
      ];
      break;
    case "resolve_app":
      result = { name: "Fixture", bundleId: "fixture.app", path: "/fixture/Fixture.app" };
      break;
    case "get_app_state":
      result = {
        app: "/fixture/Fixture.app",
        text: JSON.stringify({ text, operations, inputMode }),
        screenshot: null,
        revision: operations.length,
        pid: 42,
        windowId: 7,
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        screenshotWidth: 100,
        screenshotHeight: 100,
        capturedAt: "2026-10-16T00:00:00.000Z",
      };
      break;
    case "set_value":
      action.osAcceptance = "accepted";
      action.progress = { axAttempted: 1, axAccepted: 1, eventsPosted: 0, textScalarsPosted: 0 };
      action.verification = {
        kind: "value",
        matched: request.input.value !== "fixture-no-op",
        before: text,
      };
      if (request.input.value !== "fixture-no-op") text = request.input.value;
      action.verification.after = text;
      action.status = request.input.value === "fixture-no-op" ? "not-observed" : "verified";
      break;
    case "type_into":
      text = request.input.replace ? request.input.text : text + request.input.text;
      action.status = "verified";
      action.verification = { kind: "text", matched: true, after: text };
      action.progress.textScalarsPosted = [...request.input.text].length;
      break;
    case "perform_secondary_action":
      text = "opened";
      action.status = "uncertain";
      action.osAcceptance = "rejected";
      action.osStatus = -25205;
      action.progress = { axAttempted: 1, axAccepted: 0, eventsPosted: 0, textScalarsPosted: 0 };
      action.message = "AXOpen may have taken effect; inspect fresh state.";
      break;
    case "type_text":
      text += request.input.text;
      break;
    case "press_key":
      if (request.input.key === "hold") {
        if (receipt && receipt !== "-") await writeFile(receipt, "received");
        await new Promise(() => undefined);
      }
      if (request.input.key === "crash") process.exit(1);
      if (request.input.key === "interrupt") {
        text += "selected";
        action.status = "uncertain";
        action.progress.eventsPosted = 1;
        action.interruption = { event: "scroll", source: "unattributed" };
      }
      break;
  }
  if (isGlideAction(request.method)) result = action;
  await writeGlideFrame(process.stdout, { id: envelope.id, result });
}
