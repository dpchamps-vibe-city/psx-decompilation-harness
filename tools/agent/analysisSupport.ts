#!/usr/bin/env npx tsx
/** Configuration-driven diagnostic bootstrap/status. Compiler operations belong to providers. */
import { configuredCompilerAnalysis, loadToolchain, type FlagContext } from "../lib/toolchain.js";
import { compilerAnalysisSummary, type CompilerAnalysisProfile } from "../lib/compilerAnalysis.js";
import { resolveFunctionTarget } from "../lib/targetAdapter.js";
import { bootstrapGccRtl } from "./analysis-providers/gccRtl.js";

const BOOTSTRAP_PROVIDERS: Readonly<Record<string, (context?: FlagContext, ownerStem?: string) => CompilerAnalysisProfile>> = {
  "gcc-rtl": bootstrapGccRtl,
};

export function bootstrapCompilerAnalysis(context?: FlagContext, ownerStem?: string): CompilerAnalysisProfile {
  const selected = loadToolchain().compiler.analysis;
  if (!selected) throw new Error("Configure compiler.analysis.provider and compiler.analysis.profile before bootstrapping.");
  const bootstrap = Object.hasOwn(BOOTSTRAP_PROVIDERS, selected.provider) ? BOOTSTRAP_PROVIDERS[selected.provider] : undefined;
  if (!bootstrap) throw new Error(`No installed bootstrap provider for ${selected.provider}.`);
  return bootstrap(context, ownerStem);
}

function main(): void {
  const args = process.argv.slice(2);
  const command = !args.length || args[0]!.startsWith("--") ? "status" : args.shift()!;
  if (!["status", "bootstrap"].includes(command)) throw new Error("Usage: analysis-support status|bootstrap [--function KEY] [--json]");
  let functionName: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--json") json = true;
    else if (args[index] === "--function" && args[index + 1] && !args[index + 1]!.startsWith("--")) functionName = args[++index];
    else throw new Error(`Invalid analysis-support argument: ${args[index]}`);
  }
  const target = functionName ? resolveFunctionTarget(functionName) : undefined;
  if (command === "bootstrap") bootstrapCompilerAnalysis(target?.flags, target ? (target.owner.kind === "library" ? target.owner.id : target.symbol) : undefined);
  const support = configuredCompilerAnalysis();
  console.log(json ? JSON.stringify(support, null, 2) : compilerAnalysisSummary(support));
}
if (import.meta.url === `file://${process.argv[1]}`) main();
