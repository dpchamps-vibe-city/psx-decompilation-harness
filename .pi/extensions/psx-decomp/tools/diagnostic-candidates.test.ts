import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test, ROOT } from "../../../../tools/testing/runtimeTestContext.js";
import { registerCompilerTraceTool } from "./compiler-trace.js";
import { registerAnalyzeTargetScheduleTool } from "./analyze-target-schedule.js";
import { registerExplainDiffTool } from "./explain-diff.js";

test("diagnostic tools forward explicit draft sources and do not impose another compiler's pseudo boundary", async () => {
  const tools = new Map<string, any>(), calls: Array<{ args: string[]; cwd: string }> = [];
  const pi = { registerTool: (tool: any) => tools.set(tool.name, tool),
    exec: async (_command: string, args: string[], options: any) => {
      calls.push({ args, cwd: options.cwd });
      return { code: 0, killed: false, stdout: "fixture diagnostic", stderr: "" };
    } } as unknown as ExtensionAPI;
  registerCompilerTraceTool(pi); registerAnalyzeTargetScheduleTool(pi); registerExplainDiffTool(pi);
  const functionName = "lib_0123456789abcdef_0::StopRCnt", src = "build/explicit draft.c";
  for (const name of ["psx_compiler_trace", "psx_analyze_target_schedule", "psx_explain_diff"]) {
    const tool = tools.get(name)!;
    assert.ok(tool.parameters.properties.src, `${name} has a candidate selector`);
    await tool.execute("fixture", { functionName, src, ...(name === "psx_compiler_trace" ? { pseudo: 73 } : {}) }, undefined, undefined, { cwd: ROOT });
    const call = calls.at(-1)!;
    assert.equal(call.cwd, ROOT);
    assert.equal(call.args[call.args.indexOf("--src") + 1], src);
    assert.ok(call.args.includes(functionName));
  }
  assert.equal(tools.get("psx_compiler_trace").parameters.properties.pseudo.minimum, 0);
  assert.equal(calls[0]!.args[calls[0]!.args.indexOf("--pseudo") + 1], "73");
});
