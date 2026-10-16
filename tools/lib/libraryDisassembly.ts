/** Feed section-relative bounds to spimdisasm BEFORE its call-discovery pass.
 * ET_REL listings use a section's ELF file offset when sh_addr is zero. These
 * are diagnostic coordinates only, never invented runtime addresses. The
 * pristine object remains the sole acceptance oracle. */
import type { LibraryMember } from "./libraryTargets.js";
import { objectFunctions } from "./relocatableObject.js";

/** Byte-fidelity alone cannot certify a one-function partition: a compound
 * assembly stub also round-trips exactly. Recheck the original entry census
 * before supplying inferred sizes as disassembler facts or accepting a listing. */
function validatePartition(member: LibraryMember): void {
  const recovered = objectFunctions(member.object);
  for (const fn of recovered) {
    const assigned = member.functions.find(f => f.section === fn.section && f.offset === fn.offset && f.name === fn.name);
    if (!assigned || assigned.size !== fn.size)
      throw new Error(`${member.id}: stale/compound function partition at ${fn.section}+0x${fn.offset.toString(16)} (${fn.name}); regenerate original splits before single-function preparation`);
  }
}
export function libraryDisassemblySymbols(member: LibraryMember): string {
  validatePartition(member);
  const table = member.bytes.readUInt32LE(32), stride = member.bytes.readUInt16LE(46);
  return "// Original symbols and conservative call/address-relocation bounds; not RAM.\n" + member.functions.map(fn => {
    const section = member.object.sections.get(fn.section)!;
    const address = member.bytes.readUInt32LE(table + section.index * stride + 12);
    const coordinate = (address || section.offset) + fn.offset, vrom = section.offset + fn.offset;
    if (fn.size < 8 || fn.offset % 4 || fn.size % 4) throw new Error(`Unsupported code bound: ${member.id}::${fn.name}`);
    return `${fn.name} = 0x${coordinate.toString(16)}; // type:func size:0x${fn.size.toString(16)} vrom:0x${vrom.toString(16)}`;
  }).join("\n") + "\n";
}
/** A malformed/truncated listing must not publish a plausible-looking split. */
export function validateLibraryDisassembly(member: LibraryMember, listing: string): void {
  validatePartition(member);
  const blocks = [...listing.matchAll(/^\.section\s+([^\s,]+).*$/gm)];
  for (const [name, section] of member.object.sections) {
    if (!(section.flags & 4) || !section.size) continue;
    const index = blocks.findIndex(b => b[1] === name);
    if (index < 0) throw new Error(`${member.id}: missing code section ${name}`);
    const text = listing.slice(blocks[index]!.index!, blocks[index + 1]?.index ?? listing.length);
    const words = new Map<number, string>();
    for (const m of text.matchAll(/\/\*\s*([\da-fA-F]+)\s+[\da-fA-F]+\s+([\da-fA-F]{8})\s*\*\//g)) {
      const offset = parseInt(m[1]!, 16) - section.offset;
      if (offset < 0 || offset % 4 || offset + 4 > section.size) throw new Error(`${member.id}: listing word outside ${name}+${offset}`);
      if (words.has(offset)) throw new Error(`${member.id}: duplicate listing word ${name}+${offset}`);
      words.set(offset, m[2]!.toLowerCase());
    }
    for (let offset = 0; offset < section.size; offset += 4) {
      if (offset + 4 > section.size || words.get(offset) !== section.data.subarray(offset, offset + 4).toString("hex"))
        throw new Error(`${member.id}: missing/changed listing word ${name}+0x${offset.toString(16)}`);
    }
    for (const fn of member.functions.filter(f => f.section === name)) {
      const escaped = fn.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = [...text.matchAll(new RegExp(`^nonmatching\\s+${escaped}(?:,\\s*(0x[\\da-fA-F]+|\\d+))?\\s*$`, "gm"))];
      const emittedSize = matches.length === 1 && matches[0]![1] ? Number(matches[0]![1]) : -1;
      const firstWord = matches.length === 1 && /\/\*\s*([\da-fA-F]+)\s+[\da-fA-F]+\s+[\da-fA-F]{8}\s*\*\//.exec(text.slice(matches[0]!.index!));
      const startsAtBound = firstWord && parseInt(firstWord[1]!, 16) - section.offset === fn.offset;
      // A size-zero symbol's inferred fragment can include trailing literal
      // data in .text (e.g. a return stub followed by its name). Admit only
      // witnessed .word storage, never extra instructions or missing bytes.
      const wordLines = [...text.matchAll(/\/\*\s*([\da-fA-F]+)\s+[\da-fA-F]+\s+[\da-fA-F]{8}\s*\*\/\s*(\S+)/g)]
        .map(m => ({ offset: parseInt(m[1]!, 16) - section.offset, operation: m[2] }));
      const literalTail = fn.inferredSize && emittedSize >= 8 && emittedSize % 4 === 0 && emittedSize < fn.size &&
        wordLines.filter(m => m.offset >= fn.offset + emittedSize && m.offset < fn.offset + fn.size).every(m => m.operation === ".word");
      // spimdisasm renders a bounded mixed instruction/literal fragment wholly
      // as data and omits its size annotation. All original words and the
      // original entry must still be present, and no instruction is admitted.
      const literalFragment = emittedSize === -1 &&
        wordLines.filter(m => m.offset >= fn.offset && m.offset < fn.offset + fn.size).every(m => m.operation === ".word");
      if (matches.length !== 1 || !startsAtBound || (emittedSize !== fn.size && !literalTail && !literalFragment))
        throw new Error(`${member.id}: listing boundary disagrees with ${fn.name} (${fn.size} bytes); observed: ${text.split("\n").filter(l => l.startsWith("nonmatching ")).join("; ")}`);
    }
  }
}
