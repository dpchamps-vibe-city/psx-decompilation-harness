import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { applyScaffold, formatScaffoldReport, planScaffold, provisionScaffoldVendors } from "../../../tools/build/scaffoldProject.js";

/** Loading installed resources writes nothing. Bootstrap creates only project
 * configuration/inputs; matching extensions keep their installed identity. */
export default function psxBootstrap(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "psx_bootstrap_project",
    label: "Bootstrap PSX Project",
    description: "Scaffold the current repository from the installed harness package. Defaults to exe; library selects ELF/ar targets. Preserves project configuration and inputs, merges .gitignore without copying implementation. Obtains missing pinned public tooling sources automatically; no game/SDK downloads or target verification. Reload Pi after scaffolding. Output is a bounded supply checklist.",
    parameters: Type.Object({
      mode: Type.Optional(StringEnum(["exe", "library"] as const)),
      dryRun: Type.Optional(Type.Boolean({ description: "Inspect the scaffold without writing anything" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const plan = planScaffold(ctx.cwd, params.mode ?? "exe");
      await provisionScaffoldVendors(plan, { dryRun: params.dryRun ?? false, ...(signal ? { signal } : {}) });
      const report = await applyScaffold(plan, params.dryRun ?? false, async (path, action) => {
        await withFileMutationQueue(path, async () => { signal?.throwIfAborted(); action(); });
      });
      return { content: [{ type: "text", text: formatScaffoldReport(report) }],
        details: { root: report.root, mode: report.mode, dryRun: report.dryRun,
          created: report.created.length, updated: report.updated.length, preserved: report.preserved.length } };
    },
  });
  pi.registerCommand("psx-bootstrap", {
    description: "Bootstrap a PSX repository (exe by default; library for ELF/ar)",
    getArgumentCompletions: prefix => ["exe", "library"].filter(mode => mode.startsWith(prefix.trim())).map(mode => ({ value: mode, label: mode })),
    handler: async (args, ctx) => {
      const mode = args.trim() || "exe";
      if (mode !== "exe" && mode !== "library") { ctx.ui.notify("Usage: /psx-bootstrap [exe|library]", "warning"); return; }
      // Inline the skill for hosts whose sendUserMessage does not expand slash
      // commands. Include its location so relative references remain package-bound.
      const location = new URL("../../skills/psx-bootstrap-project/SKILL.md", import.meta.url);
      const skill = readFileSync(location, "utf8");
      pi.sendUserMessage(`Skill location: ${fileURLToPath(location)}\n\n${skill}\n\nUser: ${mode}`,
        ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    },
  });
}
