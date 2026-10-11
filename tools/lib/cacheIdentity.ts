/** Semantic equality and component compatibility, independent of distribution
 * version, installation path, Git revision and producer provenance. */
import { relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { configuredCppFrontend, configuredFlags, configuredFileFlags, loadToolchain, toolchainExecutables, type FlagContext } from "./toolchain.js";
import { contextForProject, projectRoot, runtimeContext, type RuntimeContext } from "./runtimeContext.js";
import { fileDigest } from "./contentCache.js";

export const COMPONENT_CONTRACTS = Object.freeze({ preparation: "preparation-v2", context: "declaration-context-v3", preprocess: "preprocess-v1", residual: "residual-waypoints-v2", compilation: "production-compile-v1" });
export function stableHash(value: unknown): string {
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
export function semanticPath(path: string, context: RuntimeContext = runtimeContext()): string {
  if (!isAbsolute(path)) return path.replaceAll("\\", "/");
  for (const [owner, root] of [["runtime", context.runtimeRoot], ["project", context.projectRoot], ["harness", context.harnessRoot]] as const) {
    const rel = relative(root, path).replaceAll("\\", "/");
    if (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) return `${owner}:${rel}`;
  }
  // Configured external tool identity is its bytes, never its location. Target
  // inputs outside the project still need their independently recorded hashes.
  return `external:${path.split(/[\\/]/).at(-1)}`;
}
export function semanticFlags(flags: readonly string[], context: RuntimeContext): string[] {
  return flags.map(flag => {
    let value = flag;
    for (const [owner, root] of [["$runtime", context.runtimeRoot], ["$project", context.projectRoot], ["$harness", context.harnessRoot]] as const) value = value.split(root + "/").join(owner + "/");
    return value;
  });
}
export function compilationIdentity(root = projectRoot(), flags?: FlagContext, stem?: string): Record<string, unknown> {
  const context = contextForProject(root), config = loadToolchain(root), tools = toolchainExecutables(root), frontend = configuredCppFrontend(root);
  return { compatibility: COMPONENT_CONTRACTS.compilation, compiler: { family: config.compiler.family, version: config.compiler.version },
    tools: { ...Object.fromEntries(["cc1", "cpp", "as", "maspsx", "objdump"].map(name => [name, tools[name]?.sha256 ?? "unavailable"])), cppFrontend: frontend ? fileDigest(frontend) : "unavailable" },
    flags: Object.fromEntries(["cpp", "cc1", "as", "maspsx"].map(name => [name, semanticFlags(configuredFlags(name as "cc1", flags, root).concat(name === "cc1" && stem ? configuredFileFlags(stem, root) : []), context)])),
  };
}
export interface ComparisonDomain { schema: "compiled-comparison-v1"; interpretation: string; target: string; context: string; compilation: string }
export function comparisonDomain(target: string, inputs: unknown, compilation: unknown, interpretation = COMPONENT_CONTRACTS.residual): ComparisonDomain {
  return { schema: "compiled-comparison-v1", interpretation, target, context: stableHash(inputs), compilation: stableHash(compilation) };
}
export function compatibleDomains(a: ComparisonDomain | undefined, b: ComparisonDomain | undefined): boolean {
  return !!a && !!b && stableHash(a) === stableHash(b);
}
