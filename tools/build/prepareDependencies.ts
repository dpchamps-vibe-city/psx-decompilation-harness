import { projectRoot } from "../lib/runtimeContext.js";
import { applyScaffold, provisionScaffoldVendors, type ScaffoldPlan } from "./scaffoldProject.js";

/** Prepare only pinned public dependency caches. No project configuration,
 * sources, instructions, SDK inputs or package implementation are changed. */
export async function prepareDependencies(root: string): Promise<void> {
  const plan: ScaffoldPlan = { root, mode: "exe", directories: [], files: [], preserved: [], unchanged: 0, conflicts: [], requirements: [] };
  await provisionScaffoldVendors(plan);
  await applyScaffold(plan);
}
if (process.argv[1]?.endsWith("prepareDependencies.ts")) await prepareDependencies(projectRoot());
