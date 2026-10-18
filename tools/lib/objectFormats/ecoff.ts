/** Little-endian MIPS ECOFF relocatables. Header layouts and packed fields
 * follow binutils include/coff/{mips,ecoff,symconst}.h. No objcopy conversion. */
import type { NativeObject, NativeSection, NativeSymbol, RelocationKind } from "./model.js";
const relocationKinds: Record<number, RelocationKind> = { 1: "REFHALF", 2: "REFWORD", 3: "JMPADDR", 4: "REFHI", 5: "REFLO", 6: "GPREL", 7: "LITERAL" };
const relocationSections = ["ABS", ".text", ".rdata", ".data", ".sdata", ".sbss", ".bss", ".init", ".lit8", ".lit4", ".xdata", ".pdata", ".fini", ".lita", "ABS", ".rconst"];
const storageSections: Record<number, string> = { 1: ".text", 2: ".data", 3: ".bss", 5: "ABS", 6: "UND", 13: ".sdata", 14: ".sbss", 15: ".rdata", 17: "COMMON", 18: "COMMON", 21: "UND", 22: ".init", 24: ".xdata", 25: ".pdata", 26: ".fini", 27: ".rconst" };
export function readEcoff(bytes: Buffer): NativeObject {
  const extent = (offset: number, size: number) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > bytes.length) throw new Error(`ECOFF: truncated extent ${offset}+${size}`);
    return bytes.subarray(offset, offset + size);
  };
  const u16 = (at: number) => extent(at, 2).readUInt16LE(), u32 = (at: number) => extent(at, 4).readUInt32LE();
  extent(0, 20);
  if (![0x162, 0x166, 0x142].includes(u16(0)) || (u16(18) & 2)) throw new Error("ECOFF: expected little-endian MIPS relocatable");
  const count = u16(2), symptr = u32(8), optional = u16(16), header = 20 + optional;
  if (optional !== 0 && optional !== 56) throw new Error(`ECOFF: unsupported optional header size ${optional}`);
  extent(20, optional); extent(header, count * 40);
  const sections: NativeSection[] = [], tables: Array<{ section: NativeSection; pointer: number; count: number }> = [];
  for (let i = 0; i < count; i++) {
    const at = header + i * 40, name = extent(at, 8).toString("latin1").replace(/\0.*$/, ""), size = u32(at + 16), fileOffset = u32(at + 20), flags = u32(at + 36);
    if (!name || sections.some(s => s.name === name)) throw new Error(`ECOFF: missing/duplicate section ${name}`);
    const kind = flags & (0x80 | 0x400) ? "bss" : flags & (0x20 | 0x80000000 | 0x1000000) ? "code" : "data";
    if (size && kind !== "bss" && !fileOffset) throw new Error(`ECOFF: missing contents for ${name}`);
    // MIPS ECOFF has no section-alignment field. BFD initializes its own
    // in-memory sections to 2**4, but that is not a declaration in these bytes.
    const section: NativeSection = { name, kind, size, alignment: null, address: u32(at + 12), fileOffset, data: kind === "bss" ? Buffer.alloc(0) : extent(fileOffset, size) };
    sections.push(section); const n = u16(at + 32), pointer = u32(at + 24); if (n && !pointer) throw new Error("ECOFF: missing relocation table"); extent(pointer, n * 8); tables.push({ section, pointer, count: n });
    if (u16(at + 34) !== 0) throw new Error("ECOFF: unsupported COFF line table");
  }
  const symbols: NativeSymbol[] = [], external: Array<NativeSymbol | undefined> = [], files: string[] = [];
  if (symptr) {
    extent(symptr, 96); if (u16(symptr) !== 0x7009) throw new Error("ECOFF: invalid symbolic header magic");
    const field = (at: number) => u32(symptr + at);
    const string = (offset: number, size: number, index: number) => { const data = extent(offset, size), end = data.indexOf(0, index); if (index >= size || end < 0) throw new Error("ECOFF: invalid string index"); return data.toString("latin1", index, end); };
    // Validate every symbolic table, including the debug tables not used for
    // linker identity. Unsupported/truncated packaging cannot pass silently.
    for (const [n, ptr, width] of [[8, 12, 1], [16, 20, 8], [24, 28, 52], [32, 36, 12], [40, 44, 12], [48, 52, 4], [56, 60, 1], [64, 68, 1], [72, 76, 72], [80, 84, 4], [88, 92, 16]] as const) {
      const size = field(n) * width; if (size) extent(field(ptr), size);
    }
    const decode = (at: number, binding: "external" | "local", strings: number, stringSize: number, stringBase = 0): NativeSymbol | undefined => {
      const st = extent(at + 8, 1)[0]! & 63, sc = ((extent(at + 8, 1)[0]! >>> 6) | ((extent(at + 9, 1)[0]! & 7) << 2));
      const name = string(strings, stringSize, stringBase + u32(at)), value = u32(at + 4);
      if (st === 0 && sc === 0) return undefined; // ECOFF nil/debug annotation, not a linker symbol.
      if (![1, 2, 5, 6, 14].includes(st)) { if (binding === "external") throw new Error(`ECOFF: unsupported external symbol type ${st}`); return undefined; }
      const section = storageSections[sc]; if (!section) { if (binding === "external") throw new Error(`ECOFF: unsupported external storage class ${sc}`); return undefined; }
      const owner = sections.find(s => s.name === section);
      if (!owner && !["ABS", "UND", "COMMON"].includes(section)) throw new Error(`ECOFF: symbol references missing ${section}`);
      return { name, section, offset: section === "COMMON" || section === "UND" ? 0 : value - (owner?.address ?? 0), size: section === "COMMON" ? value : 0, binding, storageClass: sc, symbolType: st };
    };
    const externalCount = field(88), externalOffset = field(92); extent(externalOffset, externalCount * 16);
    for (let i = 0; i < externalCount; i++) {
      const at = externalOffset + i * 16; if (extent(at, 1)[0]! & 4) throw new Error("ECOFF: weak external is not supported by LNK v2 identity");
      const s = decode(at + 4, "external", field(68), field(64)); external.push(s); if (s) { s.id = i + 1; symbols.push(s); }
    }
    // Local FDR ranges carry the string-base needed to decode SYMR names.
    const localCount = field(32), localOffset = field(36), localStringsSize = field(56), localStrings = field(60), fileCount = field(72), fileOffset = field(76);
    extent(localOffset, localCount * 12); extent(localStrings, localStringsSize); extent(fileOffset, fileCount * 72);
    for (let i = 0; i < fileCount; i++) {
      const at = fileOffset + i * 72, stringBase = u32(at + 8), first = u32(at + 16), n = u32(at + 20);
      if (first + n > localCount || stringBase > localStringsSize) throw new Error("ECOFF: invalid FDR range");
      const rss = u32(at + 4); if (rss !== 0xffffffff) files.push(string(localStrings, localStringsSize, stringBase + rss));
      for (let j = first; j < first + n; j++) { const s = decode(localOffset + j * 12, "local", localStrings, localStringsSize, stringBase); if (s) symbols.push(s); }
    }
  } else if (tables.some(t => t.count)) throw new Error("ECOFF: relocations without symbolic header");
  const relocations = tables.flatMap(({ section, pointer, count }) => Array.from({ length: count }, (_, i) => {
    const at = pointer + i * 8, bits = u32(at + 4), index = bits & 0xffffff, raw = bits >>> 24, type = ((raw & 0x78) >>> 3) | ((raw & 4) << 2), kind = relocationKinds[type];
    if (!kind || raw & 3) throw new Error(`ECOFF: unsupported relocation ${type}`);
    const offset = u32(at) - section.address;
    if (offset < 0 || offset + (kind === "REFHALF" ? 2 : 4) > section.size || section.kind === "bss") throw new Error("ECOFF: relocation outside initialized section");
    let target: string;
    if (raw & 0x80) { const s = external[index]; if (!s) throw new Error("ECOFF: relocation external index out of bounds"); target = `${s.section === "UND" ? "import" : "named"}:${s.name}`; }
    else { const name = relocationSections[index]; if (!name || (name !== "ABS" && !sections.some(s => s.name === name))) throw new Error(`ECOFF: invalid relocation section ${index}`); target = `${name}@0`; }
    return { section: section.name, offset, kind, target, ...(raw & 0x80 ? { symbolId: index + 1 } : {}) };
  }));
  return { format: "ecoff", sections, symbols, relocations, files,
    ...(optional === 56 ? { gpValue: u32(20 + 52) } : {}) };
}
