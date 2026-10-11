import { discoverProjectRoot } from "../../../tools/lib/runtimeContext.js";
import { projectAPI } from "../shared/project-context.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerResourceCommand } from "./controller.ts";
import { registerResourceTools } from "./tools/index.ts";

export const projectRoot = discoverProjectRoot;
export default function psxResources(pi: ExtensionAPI): void {
  pi = projectAPI(pi);
  const harness = registerResourceCommand(pi, projectRoot);
  registerResourceTools(pi, harness.binding, projectRoot);
}
