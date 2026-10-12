/** Installed diagnostic consumers. Configuration selects a protocol, never a compiler release. */
import type { CompilerAnalysisProfile } from "./compilerAnalysis.js";

export interface CompilerAnalysisProvider {
  families: readonly string[];
  support(profile: CompilerAnalysisProfile): { capabilities: string[]; reason?: string };
}

export const COMPILER_ANALYSIS_PROVIDERS: Readonly<Record<string, CompilerAnalysisProvider>> = {
  "gcc-rtl": {
    families: ["gcc"],
    support(profile) {
      const capabilities: string[] = [];
      // Common GCC diagnostics consume native RTL; availability is not a claim
      // that every reconstructed pass decision has been independently verified.
      if (profile.validated.dumpCapture && profile.validated.rtlParser && profile.evidence.unchangedAssembly)
        capabilities.push("gcc-rtl-dumps", "gcc-pass-models");
      if (profile.validated.implicitDeclarations) capabilities.push("gcc-implicit-declarations");
      if (profile.validated.emissionAttribution) capabilities.push("gcc-emission-attribution");
      if (profile.validated.preDbrReplay && profile.preDbrStage) capabilities.push("gcc-pre-dbr-replay");
      return { capabilities };
    },
  },
};
