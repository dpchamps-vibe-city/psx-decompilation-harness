/** Conservative ET_REL oracle. No linking to invented addresses, no relocation
 * masks. Encoded addends remain in section bytes; relocation references are
 * compared symbolically, in order (MIPS HI16/LO16 pairing is order-sensitive).
 * Equivalent but differently encoded objects may fail; unsupported objects
 * never produce MATCH. Debug/file/local-symbol names are not program identity. */
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
    if (!(target.flags & 2)) continue; // Non-allocated debug relocations are not linker-visible output.
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
  return JSON.stringify({ flags: object.flags,
    sections: [...object.sections].filter(([, s]) => s.flags & 2).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, s]) => [name, s.type, s.flags, s.size, s.alignment, s.entsize, s.data.toString("hex")]),
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
    const allocated = (o: RelocatableObject) => [...o.sections].filter(([, s]) => s.flags & 2);
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
    if (a.flags !== b.flags) differences.push(`ELF architecture/ABI flags: ${a.flags.toString(16)} != ${b.flags.toString(16)}`);
    for (const name of new Set([...allocated(a), ...allocated(b)].map(([name]) => name))) {
      const s = a.sections.get(name), c = b.sections.get(name);
      if (!s || !c || s.type !== c.type || s.flags !== c.flags || s.size !== c.size || s.alignment !== c.alignment || s.entsize !== c.entsize)
        differences.push(`${name}: section type/flags/size/alignment/entry-size differ`);
      if (s && c && !s.data.equals(c.data)) differences.push(`${name}: initialized bytes (including encoded relocation addends) differ`);
    }
    // Keep table order within each target section, but not unrelated section-table ordering.
    const relocs = (o: RelocatableObject) => [...new Set(o.relocations.map(r => r.section))].sort().map(s => o.relocations.filter(r => r.section === s));
    if (json(relocs(a)) !== json(relocs(b))) differences.push("Symbolic relocations differ (offset, kind, target, or HI16/LO16 order)");
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
