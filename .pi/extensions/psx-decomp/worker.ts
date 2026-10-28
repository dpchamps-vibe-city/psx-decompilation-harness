import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import psxDecompExtension from "./index.js";
import { registerWorkerControl } from "./autoloop/worker-control.js";

/** Explicit child loadout: matching tools without another controller or the
 * interactive finalizer's follow-up documentation turns. */
export default function psxWorker(pi: ExtensionAPI): void {
  registerWorkerControl(pi);
  psxDecompExtension(pi, { worker: true });
}
