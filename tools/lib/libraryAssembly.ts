/** Split a member listing into INCLUDE_ASM files, without changing its TU.
 * Unnamed/local code stays with the preceding named function. These files are
 * reference stubs, never proof of reconstruction; the pristine object is the oracle. */
import type { LibraryMember } from "./libraryTargets.js";
export interface LibraryAssemblyPart { symbol: string; text: string; functions: string[] }
export function librarySourceScaffold(member: LibraryMember, headers: string[], parts: LibraryAssemblyPart[]): string {
  const folder = `build/libraries/nonmatchings/${member.id}`;
  return `/* Original TU: ${member.input}[${member.ordinal}] ${member.member}\n * sha256: ${member.sha256}\n * One original member, one TU. Replace INCLUDE_ASM stubs with C; keep neighboring code/data.\n * Functions: ${member.functions.map(f => f.name).join(", ") || "none identified (data-only or unresolved code)"}\n */\n` +
    [...new Set([...headers, "include_asm.h"])].map(h => `#include "${h}"\n`).join("") + "\n" +
    parts.map(part => `INCLUDE_ASM("${folder}", ${part.symbol});\n`).join("");
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A named export may also be the destination of a section-relative reference.
 * Keep the export, but use a local alias only at sites whose original relocation
 * references the section. Otherwise GAS changes that reference to the export. */
function preserveSectionReferences(member: LibraryMember, assembly: string): string {
  const exports = member.object.symbols.filter(s => s.binding !== 0 && member.object.sections.has(s.section));
  const aliases = new Map<string, string>();
  let section = "";
  assembly = assembly.split("\n").map(line => {
    const directive = /^\.section\s+([^\s,]+)/.exec(line);
    if (directive) section = directive[1]!;
    const comment = /^\s*\/\*\s*([\da-fA-F]+)\s+[\da-fA-F]+\s+[\da-fA-F]+\s*\*\//.exec(line);
    const storage = member.object.sections.get(section);
    if (!comment || !storage) return line;
    const offset = parseInt(comment[1]!, 16) - storage.offset;
    const references = member.object.relocations.filter(r => r.section === section && r.offset === offset);
    if (references.length !== 1) return line;
    for (const symbol of exports) {
      if (references[0]!.reference !== `${symbol.section}@0`) continue;
      const operand = new RegExp(`(?<![\\w.$])${escape(symbol.name)}(?![\\w.$])`, "g");
      const alias = `.L__library_section_ref_${symbol.name}`;
      const rewritten = line.replace(operand, alias);
      if (rewritten !== line) { aliases.set(symbol.name, alias); line = rewritten; }
    }
    return line;
  }).join("\n");
  for (const [name, alias] of aliases) {
    const definition = new RegExp(`^(\\s*(?:glabel|dlabel|jlabel|alabel|ehlabel)\\s+${escape(name)}(?:,|\\s|$)[^\\n]*)$`, "m");
    if (!definition.test(assembly)) throw new Error(`No storage label for section-relative alias ${member.id}::${name}`);
    assembly = assembly.replace(definition, `${alias}:\n$1`);
  }
  return assembly;
}
export function libraryAssemblyParts(member: LibraryMember, assembly: string): LibraryAssemblyPart[] {
  if (member.functions.some(fn => fn.name === "__library_member_data")) throw new Error("Reserved scaffold symbol __library_member_data conflicts with an original function");
  assembly = preserveSectionReferences(member, assembly);
  const parts: LibraryAssemblyPart[] = [], data: string[] = [];
  const sections = [...assembly.matchAll(/^\.section\s+([^\s,]+).*$/gm)];
  const directives = '.include "macro.inc"\n.set noat\n.set noreorder\n';
  for (let i = 0; i < sections.length; i++) {
    const start = sections[i]!.index!, end = sections[i + 1]?.index ?? assembly.length;
    const text = assembly.slice(start, end), section = sections[i]![1]!;
    if (!(member.object.sections.get(section)?.flags! & 4)) { data.push(text); continue; }
    const anchors = member.functions.filter(f => f.section === section).flatMap(fn => {
      const match = new RegExp(`^nonmatching\\s+${escape(fn.name)}(?:,|\\s|$)`, "m").exec(text);
      return match ? [{ fn, at: match.index }] : [];
    }).sort((a, b) => a.at - b.at);
    if (!anchors.length) { data.push(text); continue; }
    const prefix = text.slice(0, anchors[0]!.at);
    for (let j = 0; j < anchors.length; j++) {
      const a = anchors[j]!, end = anchors[j + 1]?.at ?? text.length;
      // The listing already carries inter-function padding. Repeating the
      // section's initial alignment before every function would add bytes.
      const header = j === 0 ? prefix : prefix.replace(/^\s*\.(?:align|balign|p2align)\b[^\n]*\n/gm, "");
      parts.push({ symbol: a.fn.name, functions: [a.fn.name], text: directives + header + text.slice(a.at, end) });
    }
  }
  const common = member.object.symbols.filter(s => s.section === "COMMON");
  for (const s of common) {
    if (!/^[A-Za-z_]\w*$/.test(s.name)) throw new Error(`Cannot scaffold COMMON symbol ${s.name}`);
    data.push(`.comm ${s.name}, ${s.size}, ${s.value}\n`);
  }
  if (data.length) parts.push({ symbol: "__library_member_data", functions: [], text: directives + data.join("\n") });
  if (!parts.length) {
    // Valid runtime-template objects can contain only ELF metadata. Keep an
    // explicit assembly-backed stub rather than rejecting or silently omitting
    // the member. Missing listings for any program state must still fail closed.
    const allocated = [...member.object.sections.values()].some(s => s.flags & 2);
    const publicSymbols = member.object.symbols.some(s => s.binding !== 0 && s.type !== 4);
    if (allocated || publicSymbols || member.object.relocations.length || member.functions.length)
      throw new Error(`No assembly sections found for ${member.id}`);
    parts.push({ symbol: "__library_member_data", functions: [], text: directives +
      "# Metadata-only original member; no allocated sections or public symbols.\nnonmatching __library_member_data, 0\n" });
  }
  for (const fn of member.functions) if (!parts.some(p => p.functions.includes(fn.name)))
    throw new Error(`No independent assembly boundary for ${member.id}::${fn.name}; aliases/unsupported listings need review`);
  return parts;
}
