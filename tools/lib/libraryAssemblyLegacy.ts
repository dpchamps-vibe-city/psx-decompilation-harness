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
/** A strong export can be referenced by name: the object oracle folds it to
 * section + value, and the reference survives replacing its stub with C.
 * Non-strong exports still need exact section-relative aliases; they cannot
 * borrow the strong-definition equivalence (e.g. a weak symbol can rebind). */
function preserveSectionReferences(member: LibraryMember, assembly: string): string {
  const exports = member.object.symbols.filter(s => s.binding !== 0 && member.object.sections.has(s.section));
  const aliases = new Map<string, string>();
  const sectionEnds = new Map<string, string>();
  const embedded = new Map<string, { label: string; section: string }>();
  let section = "";
  for (const line of assembly.split("\n")) {
    const directive = /^\.section\s+([^\s,]+)/.exec(line);
    if (directive) section = directive[1]!;
    const label = /^\s*alabel\s+(T_([\da-fA-F]+))(?:,|\s|$)/.exec(line);
    if (label && !member.object.symbols.some(s => s.name === `D_${label[2]}`))
      embedded.set(`D_${label[2]}`, { label: label[1]!, section });
  }
  section = "";
  assembly = assembly.split("\n").map(line => {
    const directive = /^\.section\s+([^\s,]+)/.exec(line);
    if (directive) section = directive[1]!;
    const comment = /^\s*\/\*\s*([\da-fA-F]+)\s+[\da-fA-F]+\s+[\da-fA-F]+\s*\*\//.exec(line);
    const storage = member.object.sections.get(section);
    if (!comment || !storage) return line;
    const offset = parseInt(comment[1]!, 16) - storage.offset;
    const references = member.object.relocations.filter(r => r.section === section && r.offset === offset);
    if (references.length !== 1) return line;
    // A one-past-section pointer has no emitted storage label.
    for (const [target, extent] of member.object.sections) {
      if (references[0]!.reference !== `${target}@0`) continue;
      const name = `D_${(extent.offset + extent.size).toString(16).toUpperCase().padStart(8, "0")}`;
      const alias = `.L__library_section_end_${extent.index}`;
      const rewritten = line.replace(new RegExp(`(?<![\\w.$])${escape(name)}(?![\\w.$])`, "g"), alias);
      if (rewritten !== line) { sectionEnds.set(target, alias); line = rewritten; }
    }
    // Embedded text data is referenced as D_... but emitted as alabel T_...
    // by spimdisasm. Repair only section-relative sites, never named imports.
    for (const [name, target] of embedded) {
      if (references[0]!.reference === `${target.section}@0`)
        line = line.replace(new RegExp(`(?<![\\w.$])${escape(name)}(?![\\w.$])`, "g"), target.label);
    }
    for (const symbol of exports) {
      // Never make a strong export's callers depend on a label defined only
      // in its replaceable INCLUDE_ASM fragment.
      if (symbol.binding === 1 || references[0]!.reference !== `${symbol.section}@0`) continue;
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
  const blocks = [...assembly.matchAll(/^\.section\s+([^\s,]+).*$/gm)];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const alias = sectionEnds.get(blocks[i]![1]!);
    if (!alias) continue;
    const end = blocks[i + 1]?.index ?? assembly.length;
    assembly = assembly.slice(0, end) + `\n${alias}:\n` + assembly.slice(end);
  }
  return assembly;
}
/** Disassembly may choose the wrong label for a HI16, or interpret literal data
 * as a pointer without any original relocation. Preserve encoded immediates and
 * data words; emit their original REL fixups in table order instead of asking
 * GAS to infer them. This is reference-stub fidelity, never a C-output repair. */
function preserveExplicitRelocations(member: LibraryMember, part: LibraryAssemblyPart): void {
  const relocationNames: Record<number, string> = { 0: "NONE", 1: "16", 2: "32", 4: "26", 5: "HI16", 6: "LO16", 7: "GPREL16", 10: "PC16" };
  const sites = new Map<string, string>();
  let section = "";
  part.text = part.text.split("\n").map(line => {
    const directive = /^\.section\s+([^\s,]+)/.exec(line);
    if (directive) section = directive[1]!;
    const comment = /^\s*\/\*\s*([\da-fA-F]+)\s+[\da-fA-F]+\s+[\da-fA-F]+\s*\*\//.exec(line);
    const storage = member.object.sections.get(section);
    if (!comment || !storage) return line;
    const offset = parseInt(comment[1]!, 16) - storage.offset;
    const rows = member.object.relocations.filter(r => r.section === section && r.offset === offset);
    const word = /\.word\s+[^\n]+$/.exec(line);
    // An unpatched literal belongs to the listing. Never replace a malformed
    // listing's value with target bytes just to make its round trip pass.
    if (!rows.length) return line;
    if (!word && !rows.some(r => r.type === 5 || r.type === 6)) return line;
    if (rows.length > 1 || offset < 0 || offset + 4 > storage.size)
      throw new Error(`Unsupported overlapping/out-of-bounds fixup in ${member.id}:${section}+${offset}`);
    const encoded = storage.data.readUInt32LE(offset);
    if (word) line = line.slice(0, word.index) + `.word 0x${encoded.toString(16).padStart(8, "0")}`;
    else {
      const operation = rows[0]!.type === 5 ? "hi" : "lo";
      const operand = new RegExp(`%${operation}\\([^()]*\\)`, "g");
      if ([...line.matchAll(operand)].length !== 1)
        throw new Error(`Missing explicit ${operation} operand in ${member.id}:${section}+${offset}`);
      // Literal load/store offsets must be signed: an unsigned 0xffff spelling
      // asks GAS for an address macro, unlike the original %lo operand.
      const unsigned = operation === "hi" || [12, 13, 14].includes(encoded >>> 26);
      const immediate = unsigned ? `0x${(encoded & 0xffff).toString(16)}` : String((encoded << 16) >> 16);
      line = line.replace(operand, immediate);
    }
    if (!rows.length) return line;
    const label = `.L__library_rel_${storage.index}_${offset.toString(16)}`;
    const key = `${section}:${offset}`;
    if (sites.has(key)) throw new Error(`Repeated relocation site in ${member.id}:${key}`);
    sites.set(key, label);
    return `${label}:\n${line}`;
  }).join("\n");
  for (const name of new Set(member.object.relocations.filter(r => sites.has(`${r.section}:${r.offset}`)).map(r => r.section))) {
    part.text += `\n/* Original relocation order and encoded addends. */\n.pushsection ${name}\n`;
    for (const row of member.object.relocations.filter(r => r.section === name && sites.has(`${r.section}:${r.offset}`))) {
      const local = /^(.*)@0$/.exec(row.reference);
      const reference = local ? local[1]! : /^(?:import|named):(.*)$/.exec(row.reference)?.[1];
      if (!reference || !/^[A-Za-z_.$][\w.$]*$/.test(reference))
        throw new Error(`Unsupported explicit relocation reference ${member.id}:${row.reference}`);
      const kind = relocationNames[row.type];
      if (!kind) throw new Error(`Unsupported explicit relocation kind ${member.id}:${row.type}`);
      part.text += `.reloc ${sites.get(`${name}:${row.offset}`)}, R_MIPS_${kind}, ${reference}\n`;
    }
    part.text += ".popsection\n";
  }
}
export function libraryAssemblyParts(member: LibraryMember, assembly: string): LibraryAssemblyPart[] {
  if (member.functions.some(fn => fn.name === "__library_member_data")) throw new Error("Reserved scaffold symbol __library_member_data conflicts with an original function");
  assembly = preserveSectionReferences(member, assembly);
  const parts: LibraryAssemblyPart[] = [], data: string[] = [];
  const sections = [...assembly.matchAll(/^\.section\s+([^\s,]+).*$/gm)];
  const directives = '.include "macro.inc"\n.set noat\n.set noreorder\n';
  for (let i = 0; i < sections.length; i++) {
    const start = sections[i]!.index!, end = sections[i + 1]?.index ?? assembly.length;
    const section = sections[i]![1]!, original = member.object.sections.get(section);
    let text = assembly.slice(start, end);
    if (original) {
      // GAS does not infer allocation for PSY-Q names such as .rdata.
      const flags = `${original.flags & 2 ? "a" : ""}${original.flags & 1 ? "w" : ""}${original.flags & 4 ? "x" : ""}`;
      text = text.replace(/^\.section[^\n]*/, `.section ${section}, "${flags}", ${original.type === 8 ? "@nobits" : "@progbits"}`);
    }
    if (!(original?.flags! & 4)) {
      if (original) {
        // Word-oriented disassembly can omit the final one to three bytes.
        // Restore only a witnessed partial word, not inferred string padding.
        const words = [...text.matchAll(/^\s*\/\*\s*([\da-fA-F]+)\s+[\da-fA-F]+\s+[\da-fA-F]+\s*\*\/\s*\.word\b[^\n]*$/gm)];
        const last = words[words.length - 1];
        const tail = last ? parseInt(last[1]!, 16) - original.offset + 4 : -1;
        if (original.type !== 8 && original.size % 4 && tail === original.size - original.size % 4 &&
            !/^\s*(?:\/\*[^\n]*\*\/\s*)?\.(?:word|byte|short|half|float|double|ascii|asciz|space|zero|skip)\b/m.test(text.slice(last!.index! + last![0].length)))
          text += `\n.byte ${[...original.data.subarray(tail)].map(b => `0x${b.toString(16)}`).join(", ")}\n`;
        // Some disassemblers miss exports in small-data sections. Preserve
        // their original section/value rather than inventing a public D_ label.
        for (const symbol of member.object.symbols.filter(s => s.binding !== 0 && s.section === section)) {
          const definition = new RegExp(`^\\s*(?:glabel|dlabel|jlabel|alabel|ehlabel)\\s+${escape(symbol.name)}(?:,|\\s|$)`, "m");
          if (definition.test(text)) continue;
          if (!/^[A-Za-z_.$][\w.$]*$/.test(symbol.name) || ![1, 2].includes(symbol.binding) || ![0, 1].includes(symbol.type) || symbol.visibility !== 0)
            throw new Error(`Unsupported missing storage export ${member.id}::${symbol.name}`);
          text += `\n.${symbol.binding === 2 ? "weak" : "globl"} ${symbol.name}\n.set ${symbol.name}, ${section} + ${symbol.value}\n`;
          if (symbol.type === 1) text += `.type ${symbol.name}, @object\n`;
          if (symbol.size) text += `.size ${symbol.name}, ${symbol.size}\n`;
        }
      }
      data.push(text); continue;
    }
    const anchors = member.functions.filter(f => f.section === section).flatMap(fn => {
      const match = new RegExp(`^nonmatching\\s+${escape(fn.name)}(?:,|\\s|$)`, "m").exec(text);
      return match ? [{ fn, at: match.index }] : [];
    }).sort((a, b) => a.at - b.at);
    if (!anchors.length) { data.push(text); continue; }
    const prefix = text.slice(0, anchors[0]!.at);
    // Leading unnamed code belongs to the first fragment, not every fragment.
    const leadingCode = /^\s*(?:nonmatching|glabel)\s+/m.exec(prefix);
    const sectionHeader = leadingCode ? prefix.slice(0, leadingCode.index) : prefix;
    for (let j = 0; j < anchors.length; j++) {
      const a = anchors[j]!, end = anchors[j + 1]?.at ?? text.length;
      // The listing already carries inter-function padding. Repeating the
      // section's initial alignment before every function would add bytes.
      const header = j === 0 ? prefix : sectionHeader.replace(/^\s*\.(?:align|balign|p2align)\b[^\n]*\n/gm, "");
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
    const allocated = [...member.object.sections.values()].some(s => (s.flags & 2) && s.size > 0);
    const publicSymbols = member.object.symbols.some(s => s.binding !== 0 && s.type !== 4);
    if (allocated || publicSymbols || member.object.relocations.length || member.functions.length)
      throw new Error(`No assembly sections found for ${member.id}`);
    parts.push({ symbol: "__library_member_data", functions: [], text: directives +
      "# Metadata-only member; no allocated sections or public symbols.\nnonmatching __library_member_data, 0\n" });
  }
  for (const fn of member.functions) if (!parts.some(p => p.functions.includes(fn.name)))
    throw new Error(`No independent assembly boundary for ${member.id}::${fn.name}; aliases/unsupported listings need review`);
  // spimdisasm invents named labels for private, section-relative storage and
  // its macros export them by default. GAS must keep those labels LOCAL so
  // encoded addends and section-symbol relocations remain the original ones.
  // Backlog markers are diagnostic locals, never new linker-visible exports.
  const exports = new Set(member.object.symbols.filter(s => s.binding !== 0).map(s => s.name));
  for (const part of parts) {
    preserveExplicitRelocations(member, part);
    const locals = new Set<string>();
    part.text = part.text.replace(/^\s*nonmatching\s+[^\n]+$/gm, "");
    for (const match of part.text.matchAll(/^\s*(?:glabel|dlabel|jlabel|alabel|ehlabel)\s+([A-Za-z_.$][\w.$]*)(?:,|\s|$)/gm))
      if (!exports.has(match[1]!)) locals.add(match[1]!);
    if (locals.size) part.text += "\n/* Original binding: private labels and diagnostic markers are local. */\n" + [...locals].map(s => `.local ${s}\n`).join("");
  }
  return parts;
}
