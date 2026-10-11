import { harnessRoot, HARNESS_ROOT } from "./runtimeContext.js";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createRuntimeContext, runtimeContext, type RuntimeContext } from "./runtimeContext.js";

/** Resolve declared package dependencies through Node's installed-package
 * resolution, including normal npm hoisting; never a global executable. */
export function installedDependency(name: string, owner = HARNESS_ROOT): string {
  return createRequire(resolve(owner, "package.json")).resolve(name);
}
/** Internal process plumbing, not an agent operation or a compatibility CLI. */
export function installedScriptArgs(script: string, args: readonly string[], project: string | RuntimeContext): string[] {
  const context = typeof project === "string" ? createRuntimeContext(project) : project;
  const entry = resolve(context.harnessRoot, script), rel = relative(context.harnessRoot, entry);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !rel.startsWith(`tools${sep}`) || !entry.endsWith(".ts") || !existsSync(entry)) throw new Error(`Unknown installed internal script: ${script}`);
  return ["--import", installedDependency("tsx", context.harnessRoot), resolve(context.harnessRoot, "tools/lib/scriptHost.ts"), entry, "--project", context.projectRoot, ...args];
}
export function currentScriptArgs(script: string, args: readonly string[] = []): string[] { return installedScriptArgs(script, args, runtimeContext()); }
export function implementationPath(path: string): string { return resolve(harnessRoot(), path); }
