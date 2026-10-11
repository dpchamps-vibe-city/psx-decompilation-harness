import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runProjectCommand } from "./shared.ts";
import { installedScriptArgs } from "../../../../tools/lib/installedScripts.js";

export function registerVerifyBuildTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "psx_verify_build",
    label: "Verify PSX Build",
    description: "Run the project's executable-only byte-identity verification (120 s timeout). Output is limited to 50 KB or 2000 lines.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: "Verifying the executable..." }], details: {} });
      return runProjectCommand(pi, ctx.cwd, process.execPath, installedScriptArgs("tools/build/pipeline.ts", ["check-exe"], ctx.cwd), signal, 120_000);
    },
  });
}
