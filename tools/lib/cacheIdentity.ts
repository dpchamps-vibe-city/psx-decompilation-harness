/** Semantic equality and component compatibility, independent of distribution
 * version, installation path, Git revision and producer provenance. */
import { relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { configuredAssembler, configuredAssemblerConfig, configuredCppFrontend, configuredCompilerSource, configuredFlags, configuredFileFlags, loadToolchain, toolchainExecutables, type FlagContext } from "./toolchain.js";
import { contextForProject, projectRoot, runtimeContext, type RuntimeContext } from "./runtimeContext.js";
import { fileDigest } from "./contentCache.js";
import { executedToolIdentity } from "./toolProvenance.js";
import { assemblerIdentity } from "./assembler.js";

export const COMPONENT_CONTRACTS = Object.freeze({ preparation: "preparation-v3", context: "declaration-context-v4", preprocess: "preprocess-v1", residual: "residual-waypoints-v2", compilation: "production-compile-v2" });
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
  const context = contextForProject(root), config = loadToolchain(root), assembler = configuredAssembler(flags, root),
    tools = toolchainExecutables(root, assembler.kind === "gas" ? ["maspsx"] : []), frontend = configuredCppFrontend(root);
  return { compatibility: COMPONENT_CONTRACTS.compilation, compiler: { family: config.compiler.family, version: config.compiler.version },
    // Explicit selections and declared stages join the executed-tool identity.
    ...(configuredAssemblerConfig(flags, root) ? { assembler: { ...assembler, stages: assemblerIdentity(flags, root).stages } } : {}),
    tools: { ...Object.fromEntries(["cc1", "cpp", "as", ...(assembler.kind === "maspsx" ? ["maspsx"] : []), "objdump"].map(name => [name, tools[name]?.sha256 ?? "unavailable"])),
      ...(assembler.kind === "gas" ? { assemblerImplementation: fileDigest(`${context.harnessRoot}/tools/lib/assembler.ts`) } : { maspsxPackage: (assemblerIdentity(flags, root) as any).maspsx.packageSha256 }), cppFrontend: frontend ? fileDigest(frontend) : "unavailable" },
    toolPins: config.toolPins ?? {},
    compilerSourcePin: configuredCompilerSource(root) ? fileDigest(`${configuredCompilerSource(root)}/pin.json`) : null,
    linkedLibraries: Object.fromEntries(["cpp", "cc1", "as"].map(name => [name, tools[name]?.path ? executedToolIdentity(name as "as", root).dependencies.map(d => [d.path.split("/").pop(), d.sha256]) : "unavailable"])),
    flags: Object.fromEntries(["cpp", "cc1", "as", ...(assembler.kind === "maspsx" ? ["maspsx"] : [])].map(name => [name, semanticFlags(configuredFlags(name as "cc1", flags, root).concat(name === "cc1" && stem ? configuredFileFlags(stem, root) : []), context)])),
  };
}
export interface ComparisonDomain { schema: "compiled-comparison-v1"; interpretation: string; target: string; context: string; compilation: string }
export function comparisonDomain(target: string, inputs: unknown, compilation: unknown, interpretation = COMPONENT_CONTRACTS.residual): ComparisonDomain {
  return { schema: "compiled-comparison-v1", interpretation, target, context: stableHash(inputs), compilation: stableHash(compilation) };
}
export function compatibleDomains(a: ComparisonDomain | undefined, b: ComparisonDomain | undefined): boolean {
  return !!a && !!b && stableHash(a) === stableHash(b);
}
