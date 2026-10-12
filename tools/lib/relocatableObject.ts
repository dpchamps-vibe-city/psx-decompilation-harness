/** ET_REL program oracle: exact code/data bytes, storage sizes, symbols and
 * symbolic relocations, not identical ELF packaging. No invented addresses or
 * relocation masks; encoded addends and MIPS HI16/LO16 pairing remain exact.
 * ELF header flags, section alignment/entry sizes, empty sections and assembler
 * ABI bookkeeping are not emitted program content. Unsupported objects never
 * produce MATCH. Debug/file/local-symbol names are not program identity. */
import { elf32Sections, type Elf32Section } from "./elfSections.js";
export interface ObjectSymbol {
  name: string; value: number; size: number; binding: number; type: number; visibility: number; section: string;
}
export interface ObjectRelocation { section: string; offset: number; type: number; reference: string }
export interface RelocatableObject {
  flags: number;
  sections: Map<string, Elf32Section>;
  symbols: ObjectSymbol[];
  relocations: ObjectRelocation[];
}
// SHT_MIPS_REGINFO / SHT_MIPS_ABIFLAGS describe assembler ABI bookkeeping,
// not instructions or C storage. Executable sections are never discarded.
const assemblerMetadata = (s: Elf32Section) => !(s.flags & 4) && [0x70000006, 0x7000002a].includes(s.type);
const programSection = (s: Elf32Section) => !!(s.flags & 2) && !assemblerMetadata(s);
const programSections = (o: RelocatableObject) => [...o.sections].filter(([, s]) => programSection(s) && s.size > 0);
const storageKind = (s: Elf32Section) => `${s.flags & 4 ? "code" : "data"}:${s.type === 8 ? "zero-fill" : "initialized"}`;

export function readRelocatableObject(bytes: Buffer): RelocatableObject {
  const sections = elf32Sections(bytes);
  if (bytes[5] !== 1 || bytes.readUInt16LE(16) !== 1 || bytes.readUInt16LE(18) !== 8) throw new Error("Expected ELF32 little-endian MIPS ET_REL");
  const byIndex = new Map([...sections].map(([name, s]) => [s.index, name]));
  const symtab = sections.get(".symtab");
  if (!symtab || symtab.entsize !== 16 || symtab.size % 16) throw new Error("Missing/invalid ELF symbol table");
  const strings = [...sections.values()].find(s => s.index === symtab.link);
  if (!strings || strings.type !== 3) throw new Error("Missing ELF symbol strings");
  const symbols: ObjectSymbol[] = [];
  for (let i = 0; i < symtab.size; i += 16) {
    const s = symtab.data.subarray(i, i + 16), at = s.readUInt32LE(0), end = strings.data.indexOf(0, at);
    if (at >= strings.size || end < 0) throw new Error("Invalid ELF symbol name");
    const index = s.readUInt16LE(14), section = index === 0 ? "UND" : index === 0xfff1 ? "ABS" : index === 0xfff2 ? "COMMON" : byIndex.get(index);
    if (!section) throw new Error(`Unsupported symbol section index ${index}`);
    symbols.push({ name: strings.data.toString("utf8", at, end), value: s.readUInt32LE(4), size: s.readUInt32LE(8), binding: s[12]! >> 4,
      type: s[12]! & 15, visibility: s[13]!, section });
  }
  const relocations: ObjectRelocation[] = [];
  for (const r of sections.values()) {
    if (![4, 9].includes(r.type)) continue;
    const name = byIndex.get(r.info), target = name ? sections.get(name) : undefined;
    if (!target) throw new Error("Relocation target section missing");
    if (!programSection(target)) continue; // Debug/assembler metadata is not program content.
    if (r.type !== 9 || r.entsize !== 8 || r.size % 8 || r.link !== symtab.index) throw new Error("Unsupported relocation table (only MIPS REL supported)");
    for (let i = 0; i < r.size; i += 8) {
      const offset = r.data.readUInt32LE(i), info = r.data.readUInt32LE(i + 4), type = info & 255, s = symbols[info >>> 8];
      if (!s || ![0, 1, 2, 4, 5, 6, 7, 10].includes(type) || offset + 4 > target.size) throw new Error(`Unsupported/out-of-bounds relocation ${type} in ${name}`);
      // Export/import names are meaningful. Local names and symbol-table indices are not.
      const reference = s.binding !== 0 ? `${s.section === "UND" ? "import" : "named"}:${s.name}` : `${s.section}@${s.value}`;
      relocations.push({ section: name!, offset, type, reference });
    }
  }
  return { flags: bytes.readUInt32LE(36), sections, symbols, relocations };
}
/** Candidate-output identity for the experiment ledger: include all TU program
 * state, excluding debug/file/local-label naming and symbol-table indices. */
export function relocatableOutputIdentity(object: RelocatableObject): string {
  return JSON.stringify({
    sections: programSections(object).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, s]) => [name, storageKind(s), s.size, s.data.toString("hex")]),
    symbols: object.symbols.filter(s => s.binding !== 0 && s.type !== 4).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    relocations: [...new Set(object.relocations.map(r => r.section))].sort().map(section => object.relocations.filter(r => r.section === section)) });
}

export interface ObjectComparison {
  verdict: "match" | "mismatch" | "undetermined" | "stub";
  matchedWords: number; totalWords: number; candidateWords: number;
  differences: string[];
}
const json = (v: unknown) => JSON.stringify(v);
export function compareRelocatableObjects(original: Buffer, candidate: Buffer): ObjectComparison {
  try {
    const a = readRelocatableObject(original), b = readRelocatableObject(candidate), differences: string[] = [];
    const targetSections = new Map(programSections(a)), candidateSections = new Map(programSections(b));
    const targetText = [...a.sections].filter(([, s]) => s.flags & 4);
    let totalWords = 0, matchedWords = 0, candidateWords = 0;
    for (const [name, s] of targetText) {
      const c = b.sections.get(name); totalWords += Math.ceil(s.size / 4);
      for (let off = 0; off < s.size; off += 4) {
        if (c && s.data.subarray(off, off + 4).equals(c.data.subarray(off, off + 4)) &&
          json(a.relocations.filter(r => r.section === name && r.offset >= off && r.offset < off + 4)) ===
          json(b.relocations.filter(r => r.section === name && r.offset >= off && r.offset < off + 4))) matchedWords++;
      }
    }
    for (const s of b.sections.values()) if (s.flags & 4) candidateWords += Math.ceil(s.size / 4);
    for (const name of new Set([...targetSections.keys(), ...candidateSections.keys()])) {
      const s = targetSections.get(name), c = candidateSections.get(name);
      if (!s || !c || storageKind(s) !== storageKind(c) || s.size !== c.size)
        differences.push(`${name}: program storage kind/size differs or section missing`);
      if (s && c && !s.data.equals(c.data)) differences.push(`${name}: initialized bytes (including encoded relocation addends) differ`);
    }
    // REL HI16s remain pending until their following LO16. Preserve that
    // complete group, including its internal order, rather than sorting its
    // individual entries. Closed groups at distinct offsets are independent:
    // LNK converters emit local groups before imported-symbol groups, whereas
    // GAS emits both in instruction order. Neither changes the pairing/addend.
    // Cross-symbol pending groups, orphan HIs and overlapping fixups retain
    // strict table order; they are not licensed by this normalization.
    const relocs = (o: RelocatableObject) => [...new Set(o.relocations.map(r => r.section))].sort().map(section => {
      const rows = o.relocations.filter(r => r.section === section);
      if (new Set(rows.map(r => r.offset)).size !== rows.length) return { section, ordered: rows };
      const groups: ObjectRelocation[][] = [], pending: ObjectRelocation[] = [];
      for (const row of rows) {
        if (row.type === 5) pending.push(row);
        else if (row.type === 6) {
          if (pending.some(hi => hi.reference !== row.reference)) return { section, ordered: rows };
          groups.push([...pending, row]); pending.length = 0;
        } else groups.push([row]);
      }
      if (pending.length) return { section, ordered: rows };
      return { section, groups: groups.sort((x, y) => Math.min(...x.map(r => r.offset)) - Math.min(...y.map(r => r.offset))) };
    });
    if (json(relocs(a)) !== json(relocs(b))) differences.push("Symbolic relocations differ (offset, kind, target, or HI16/LO16 pairing)");
    const publicSymbols = (o: RelocatableObject) => o.symbols.filter(s => s.binding !== 0 && s.type !== 4).sort((x, y) => json([x.name, x.section, x.value]).localeCompare(json([y.name, y.section, y.value])));
    const aa = publicSymbols(a), bb = publicSymbols(b);
    if (aa.length !== bb.length) differences.push("Export/import/common symbol population differs");
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
      const s = aa[i], c = bb[i];
      if (!s || !c) continue;
      // Converted SDK objects often expose NOTYPE, size-zero labels. Those are
      // unknown annotations, not zero-length functions; COMMON is never unknown.
      if (s.name !== c.name || s.section !== c.section || s.value !== c.value || s.binding !== c.binding || s.visibility !== c.visibility ||
        (s.type !== 0 && s.type !== c.type) || ((s.size > 0 || s.section === "COMMON") && s.size !== c.size)) differences.push(`Linker-visible symbol differs: ${s.name}`);
    }
    return { verdict: differences.length ? "mismatch" : "match", matchedWords, totalWords, candidateWords, differences };
  } catch (error) {
    return { verdict: "undetermined", matchedWords: 0, totalWords: 0, candidateWords: 0, differences: [String(error)] };
  }
}
/** Symbol extents are only bounds when the original has no size annotation.
 * Include local FUNC labels, but never treat every local branch label as a function. */
export function objectFunctions(object: RelocatableObject): { name: string; section: string; offset: number; size: number; inferredSize: boolean }[] {
  const code = object.symbols.filter(s => object.sections.get(s.section)?.flags! & 4 && (s.type === 2 || (s.binding !== 0 && s.type === 0)));
  return code.filter(s => /^[A-Za-z_]\w*$/.test(s.name)).map(s => {
    const next = Math.min(object.sections.get(s.section)!.size, ...code.filter(n => n.section === s.section && n.value > s.value).map(n => n.value));
    if (s.value >= object.sections.get(s.section)!.size || s.value + s.size > object.sections.get(s.section)!.size) throw new Error(`Invalid code symbol extent: ${s.name}`);
    return { name: s.name, section: s.section, offset: s.value, size: s.size || next - s.value, inferredSize: s.size === 0 };
  });
}
