import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { projectRoot } from "../../../../tools/lib/runtimeContext.js";
import { loadLoopConfig } from "../autoloop/config.ts";
import { readState, recordPark, statePath } from "../autoloop/state.ts";
import { validateFunctionName } from "./shared.ts";

export function registerParkFunctionTool(pi: ExtensionAPI, loopActive = () => false): void {
  pi.registerTool({
    name: "psx_park_function",
    label: "Park PSX Function",
    description: "Persist a witnessed blocker or pending human decision so automatic /decompile selection skips this function. State only: preserves source, grants no policy exception, writes no notes or commits. Explicit /decompile <functionName> still permits a retry. Not for ordinary matching difficulty; an active autoloop handles its own parks.",
    parameters: Type.Object({
      functionName: Type.String({ description: "Exact call-graph key; library functions require member::symbol" }),
      reason: StringEnum(["blocked", "asm-needs-human-approval"], { description: "Build/capability blocker or pending human policy decision" }),
      detail: Type.String({ minLength: 1, description: "Witnessed blocker and its evidence/premises, or the specific human decision needed" }),
    }),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      if (loopActive()) throw new Error("The active autoloop owns parking; report the blocker to it instead.");
      validateFunctionName(params.functionName);
      if (!params.detail.trim()) throw new Error("Parking requires a non-empty evidence-backed detail.");
      const root = projectRoot();
      const graph = JSON.parse(readFileSync(join(root, "build/callGraph.json"), "utf8")) as { functions: Array<{ name: string; decompiled: boolean }> };
      const entries = graph.functions.filter((entry) => entry.name === params.functionName);
      if (entries.length !== 1) throw new Error(`Unknown or ambiguous call-graph key: ${params.functionName}. Use the exact member-qualified key for libraries.`);
      if (entries[0]!.decompiled) throw new Error(`Cannot park an already-decompiled function: ${params.functionName}`);
      const config = loadLoopConfig(root);
      await withFileMutationQueue(statePath(config), async () => {
        signal?.throwIfAborted();
        if (loopActive()) throw new Error("The active autoloop owns parking.");
        recordPark(config, readState(config), {
          functionName: params.functionName,
          skipOnly: true,
          reason: params.reason,
          parkedAt: new Date().toISOString(),
          reachedTier: "interactive",
          lastReport: params.detail.trim(),
          attemptNote: "Source unchanged; selection-only park, no policy exception granted.",
          findings: [],
        });
      });
      return {
        content: [{ type: "text", text: `Parked ${params.functionName} (${params.reason}). Automatic selection will skip it; source and policy unchanged. Explicit /decompile ${params.functionName} can retry it.` }],
        details: { functionName: params.functionName, reason: params.reason, statePath: statePath(config) },
      };
    },
  });
}
