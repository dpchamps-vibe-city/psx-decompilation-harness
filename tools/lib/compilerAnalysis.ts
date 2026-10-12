/** Configured diagnostic providers. The core consumes evidence, not compiler-version branches. */
import { existsSync, readFileSync } from "node:fs";
import { fileDigest } from "./contentCache.js";
import { COMPILER_ANALYSIS_PROVIDERS } from "./compilerAnalysisProviders.js";
import { contextForProject, resolveOwnedPath } from "./runtimeContext.js";
import type { ConfiguredPath, ToolchainConfig } from "./toolchain.js";

export interface CompilerAnalysisSelection {
  provider: string;
  profile: ConfiguredPath;
}
export interface CompilerAnalysisProfile {
  schemaVersion: 1;
  provider: string;
  compiler: { family: string; version: string; sha256: string; sourcePinSha256?: string };
  capture: { dumpFlags: string[]; emissionFlags: string[]; implicitFlags: string[] };
  stageOrder: string[];
  preDbrStage: string | null;
  passModel: string | null;
  validated: { dumpCapture: boolean; rtlParser: boolean; implicitDeclarations: boolean; emissionAttribution: boolean; preDbrReplay: boolean };
  evidence: { directory: string; unchangedAssembly: boolean; notes: string[] };
}
export interface CompilerAnalysisSupport {
  provider: string;
  capabilities: string[];
  profile?: CompilerAnalysisProfile;
  reason?: string;
}

const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0);

export function resolveCompilerAnalysis(config: ToolchainConfig, compilerPath: string | null, root: string): CompilerAnalysisSupport {
  const selected = config.compiler.analysis;
  if (!selected) return { provider: "legacy-declarations", capabilities: [...(config.compiler.capabilities ?? [])],
    reason: "Legacy capability declarations; configure compiler.analysis and bootstrap a provider to obtain measured support." };
  const unsupported = (reason: string): CompilerAnalysisSupport => ({ provider: selected.provider, capabilities: [], reason });
  const path = resolveOwnedPath(selected.profile, contextForProject(root));
  if (!existsSync(path)) return unsupported(`Analysis profile missing: ${path}. Run analysis-support bootstrap.`);
  let profile: CompilerAnalysisProfile;
  try { profile = JSON.parse(readFileSync(path, "utf8")); }
  catch { return unsupported(`Invalid analysis profile: ${path}`); }
  if (profile.schemaVersion !== 1 || profile.provider !== selected.provider || !profile.compiler || !profile.validated || !profile.capture ||
      !stringList(profile.stageOrder) || ![profile.capture.dumpFlags, profile.capture.emissionFlags, profile.capture.implicitFlags].every(stringList) ||
      ![profile.validated.dumpCapture, profile.validated.rtlParser, profile.validated.implicitDeclarations, profile.validated.emissionAttribution, profile.validated.preDbrReplay].every(value => typeof value === "boolean") ||
      !profile.evidence || typeof profile.evidence.unchangedAssembly !== "boolean" || !stringList(profile.evidence.notes))
    return unsupported(`Incompatible analysis profile: ${path}`);
  if (profile.compiler.family !== config.compiler.family || profile.compiler.version !== config.compiler.version ||
      !compilerPath || !existsSync(compilerPath) || profile.compiler.sha256 !== fileDigest(compilerPath))
    return unsupported("Analysis profile does not belong to the configured compiler; bootstrap it again.");
  if (profile.compiler.sourcePinSha256) {
    if (!config.compiler.source) return unsupported("Analysis profile requires the configured compiler source pin.");
    const source = resolveOwnedPath(config.compiler.source, contextForProject(root));
    const pin = `${source}/pin.json`;
    if (!existsSync(pin) || fileDigest(pin) !== profile.compiler.sourcePinSha256) return unsupported("Compiler source pin changed; bootstrap analysis again.");
  }
  const consumer = Object.hasOwn(COMPILER_ANALYSIS_PROVIDERS, selected.provider) ? COMPILER_ANALYSIS_PROVIDERS[selected.provider] : undefined;
  if (!consumer) return unsupported(`No installed consumer for analysis provider ${selected.provider}.`);
  if (!consumer.families.includes(config.compiler.family)) return unsupported(`Analysis provider ${selected.provider} does not consume ${config.compiler.family} diagnostics.`);
  return { provider: selected.provider, profile, ...consumer.support(profile) };
}

export function compilerAnalysisSummary(support: CompilerAnalysisSupport): string {
  return `Diagnostic provider: ${support.provider}. Available: ${support.capabilities.join(", ") || "none"}.` +
    (support.capabilities.includes("gcc-pass-models")
      ? " Common GCC pass diagnostics are enabled; dump observations and reconstructed/inferred conclusions are distinguished, with missing inputs reported per analysis." : "") +
    (support.reason ? ` ${support.reason}` : "");
}
