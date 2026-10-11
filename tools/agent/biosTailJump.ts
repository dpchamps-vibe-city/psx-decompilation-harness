/** SDK-typed C for the canonical BIOS tail-transfer operation. No invented
 * prototypes: missing/ambiguous SDK declarations remain unresolved. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { LibraryMember } from "../lib/libraryTargets.js";
import { configuredSdkHeaders } from "../lib/toolchain.js";
import { BIOS_TAILJUMP_HEADER, biosTailJumpMacroEnabled } from "../lib/biosSyscallMacro.js";
import { BIOS_FUNCTION_MACRO } from "../lib/biosFunctionMacro.js";
import { decodeWord } from "./matching-reconstruction/decode.js";
import { recognizeBiosVeneer } from "./matching-reconstruction/bios-veneer.js";
import { declaredFunction, extractPrototypesFromSource, type ExtractedSignature } from "./sdkTypes.js";
import { parseC, field, namedChildren } from "./residual-source-search/tree-sitter-c.js";
import type { BiosSyscallEvidence } from "./biosSyscall.js";

const prototypes = new Map<string, { text: string; signatures: ExtractedSignature[] }>();
function headers(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return /\.h$/i.test(path) ? [path] : [];
  return readdirSync(path).sort().flatMap(name => headers(join(path, name)));
}
function sdkSignature(name: string, root: string): { signature: string; header: string } | undefined {
  const matches: Array<{ signature: string; header: string }> = [];
  for (const header of configuredSdkHeaders(root).flatMap(headers)) {
    const text = readFileSync(header, "utf8");
    if (!new RegExp(`\\b${name}\\s*\\(`).test(text)) continue;
    let cached = prototypes.get(header);
    if (!cached || cached.text !== text) { cached = { text, signatures: extractPrototypesFromSource(text) }; prototypes.set(header, cached); }
    for (const p of cached.signatures.filter(p => p.name === name)) matches.push({ signature: p.signature, header });
  }
  return new Set(matches.map(m => m.signature)).size === 1 ? matches[0] : undefined;
}
/** Name previously unnamed scalar/pointer parameters in the witnessed
 * prototype. Complex abstract declarators and variadics are outside this MVP. */
function definition(signature: string): string | undefined {
  const tree = parseC(signature);
  try {
    const declaration = namedChildren(tree.rootNode).find(n => n.type === "declaration");
    const declarator = declaration && field(declaration, "declarator");
    const fn = declarator && declaredFunction(declarator), params = fn && field(fn, "parameters");
    if (!declaration || !fn || !params || tree.rootNode.hasError || declaration.descendantsOfType("type_identifier").length) return undefined;
    const edits: Array<{ at: number; text: string }> = [];
    for (const [i, p] of namedChildren(params).entries()) {
      if (p.type !== "parameter_declaration") return undefined;
      let d = field(p, "declarator");
      if (!d) { if (p.text.trim() !== "void") edits.push({ at: p.endIndex, text: ` arg${i}` }); continue; }
      while (d && d.type !== "identifier") d = field(d, "declarator") ?? (d.type === "parenthesized_declarator" ? namedChildren(d)[0] : undefined);
      if (d?.type === "identifier") continue;
      const abstract = field(p, "declarator")!;
      if (abstract.type !== "abstract_pointer_declarator" || abstract.descendantsOfType("abstract_function_declarator").length || abstract.descendantsOfType("abstract_array_declarator").length) return undefined;
      edits.push({ at: abstract.endIndex, text: `arg${i}` });
    }
    let result = signature;
    for (const edit of edits.sort((a, b) => b.at - a.at)) result = result.slice(0, edit.at) + edit.text + result.slice(edit.at);
    return result.replace(/;\s*$/, "");
  } finally { tree.delete(); }
}
export function biosTailJumpCandidate(member: LibraryMember, fn: LibraryMember["functions"][number], root: string): { source: string; evidence: BiosSyscallEvidence } | undefined {
  if (!biosTailJumpMacroEnabled(root) || member.functions.length !== 1 || fn.offset !== 0 || fn.size !== 16 ||
      [...member.object.sections.values()].some(s => (s.flags & 2) && !(s.flags & 4) && s.size > 0)) return undefined;
  const text = member.object.sections.get(fn.section)!;
  const instructions = Array.from({ length: fn.size / 4 }, (_, i) => decodeWord(text.data.readUInt32LE(fn.offset + i * 4), fn.offset + i * 4));
  if (member.object.relocations.some(r => r.type !== 0 && r.section === fn.section)) return undefined;
  const bios = recognizeBiosVeneer(instructions), witness = bios && sdkSignature(fn.name, root), header = witness && definition(witness.signature);
  if (!bios || !witness || !header) return undefined;
  const tree = parseC(`${header} {}`);
  const declaration = namedChildren(tree.rootNode)[0]!, core = declaredFunction(field(declaration, "declarator")!);
  const name = core && field(core, "declarator"), parameters = core && field(core, "parameters");
  const result = name ? header.slice(0, name.startIndex).trim() : "";
  const params = parameters?.text, extra = parameters ? header.slice(parameters.endIndex).trim() : "";
  tree.delete();
  if (!params || !result || result.includes("(") || extra) return undefined;
  return {
    source: `#include "library/psx_bios_tailjump.h"\n\n${BIOS_FUNCTION_MACRO}(\n    ${result}, ${fn.name},\n    ${params},\n    0x${bios.vector.toString(16)}, 0x${bios.selector.toString(16)}\n);\n`,
    evidence: { macro: BIOS_FUNCTION_MACRO, header: BIOS_TAILJUMP_HEADER, signatureHeader: relative(root, witness.header).replaceAll("\\", "/"),
      signature: witness.signature, selector: bios.selector, vector: bios.vector, policy: "allowBiosTailJumpMacro" },
  };
}
