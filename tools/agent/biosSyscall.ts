/** Typed macro draft for a witnessed syscall wrapper. This is a supported
 * platform representation, not a guess about the SDK's historical source. */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import type { LibraryMember } from "../lib/libraryTargets.js";
import { configuredSdkHeader } from "../lib/toolchain.js";
import { BIOS_SYSCALL_HEADER, BIOS_SYSCALL_MACRO, biosSyscallMacroEnabled } from "../lib/biosSyscallMacro.js";
import { extractPrototypesFromSource } from "./sdkTypes.js";
import { classifyLibraryCode } from "./libraryCodeClass.js";

export interface BiosSyscallEvidence {
  macro: string;
  header: string;
  signatureHeader: string;
  signature: string;
  selector: number;
  vector?: number;
  policy?: "allowBiosSyscallMacro" | "allowBiosTailJumpMacro";
}
export function biosSyscallCandidate(member: LibraryMember, fn: LibraryMember["functions"][number], root: string): { source: string; evidence: BiosSyscallEvidence } | undefined {
  const classification = classifyLibraryCode(member.object, fn);
  if (classification?.kind !== "syscall-helper" || !biosSyscallMacroEnabled(root)) return undefined;
  if (member.functions.length !== 1 || [...member.object.sections.values()].some(s => (s.flags & 2) && !(s.flags & 4) && s.size > 0)) return undefined;
  const selector = classification.selector!;
  if (![0, 1, 2].includes(selector)) return undefined;
  const header = configuredSdkHeader("libapi.h", root);
  if (!header) return undefined;
  const type = selector === 1 ? "int" : "void";
  const signature = `${type} ${fn.name}(void);`;
  const prototypes = extractPrototypesFromSource(readFileSync(header, "utf8")).filter(p => p.name === fn.name);
  // The syscall produces v0 implicitly. The frame scan's old never-written-v0
  // inference is not a return-type witness; take the independent SDK declaration.
  if (prototypes.length !== 1 || prototypes[0]!.signature !== signature) return undefined;
  return {
    source: `#include "library/psx_bios.h"\n\n${type} ${fn.name}(void) {\n    ${type === "int" ? "return " : "(void)"}${BIOS_SYSCALL_MACRO}(${selector});\n}\n`,
    evidence: { macro: BIOS_SYSCALL_MACRO, header: BIOS_SYSCALL_HEADER,
      signatureHeader: relative(root, header).replaceAll("\\", "/"), signature, selector },
  };
}
