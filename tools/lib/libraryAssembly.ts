/** Split a member listing into INCLUDE_ASM files, without changing its TU.
 * Unnamed/local code stays with the preceding named function. These files are
 * reference stubs, never proof of reconstruction; the pristine object is the oracle. */
import type { LibraryMember } from "./libraryTargets.js";
export interface LibraryAssemblyPart { symbol: string; text: string; functions: string[] }
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function libraryAssemblyParts(member: LibraryMember, assembly: string): LibraryAssemblyPart[] {
  if (member.functions.some(fn => fn.name === "__library_member_data")) throw new Error("Reserved scaffold symbol __library_member_data conflicts with an original function");
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
  if (!parts.length) throw new Error(`No assembly sections found for ${member.id}`);
  for (const fn of member.functions) if (!parts.some(p => p.functions.includes(fn.name)))
    throw new Error(`No independent assembly boundary for ${member.id}::${fn.name}; aliases/unsupported listings need review`);
  return parts;
}
