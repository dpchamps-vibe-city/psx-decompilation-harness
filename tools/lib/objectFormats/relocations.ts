/** Decode symbolic relocation operands, without linking or rewriting bytes.
 * ECOFF's REL addends are in-place; LNK patch expressions specify them directly.
 * Reference identities stay intact: a defined name is never folded to a section.
 * Binutils: ecoff_slurp_reloc_table, mips_reflo_reloc, mips_adjust_reloc_in. */
import type { NativeObject, NativeRelocation, RelocationKind } from "./model.js";

export type RelocationOperand = { reference: string | null; addend: number } | { unresolved: string };
const signed16 = (value: number) => (value << 16) >> 16;
const width = (r: NativeRelocation) => ["REFWORD", "JMPADDR"].includes(r.kind) ? 4 : 2;
/** Overlapping patch operations cannot be compared as an unordered multiset. */
export function hasOverlappingNativeRelocations(object: NativeObject): boolean {
  const bytes = new Set<string>();
  for (const r of object.relocations) for (let i = 0; i < width(r); i++) {
    const key = `${r.section}:${r.offset + i}`;
    if (bytes.has(key)) return true;
    bytes.add(key);
  }
  return false;
}
function lnkOperand(target: string): RelocationOperand {
  const visit = (node: unknown): RelocationOperand => {
    if (typeof node === "string") {
      if (node.startsWith("expression:")) return visit(JSON.parse(node.slice(11)));
      if (/^value:\d+$/.test(node)) return { reference: null, addend: Number(node.slice(6)) | 0 };
      if (/^(?:named:|import:)/.test(node) || /^\.[^@]+@0$/.test(node)) return { reference: node, addend: 0 };
      return { unresolved: `unsupported symbolic operand ${node}` };
    }
    if (!Array.isArray(node) || node.length !== 3) return { unresolved: "unsupported expression shape" };
    const a = visit(node[1]), b = visit(node[2]);
    if ("unresolved" in a) return a;
    if ("unresolved" in b) return b;
    if (node[0] === "add" && !(a.reference && b.reference))
      return { reference: a.reference ?? b.reference, addend: (a.addend + b.addend) | 0 };
    if (node[0] === "sub" && !b.reference)
      return { reference: a.reference, addend: (a.addend - b.addend) | 0 };
    return { unresolved: "expression is not one unchanged reference plus a constant" };
  };
  return visit(target.startsWith("expression:") ? JSON.parse(target.slice(11)) : target);
}
/** LO16 denotes a low fragment, not a full 32-bit address. Its addend is
 * compared modulo 16 bits; ALL encoded instruction/data bytes remain exact.
 * HI16 uses the complete signed-low pair. GP/halfword overflow constraints are
 * not LO16: their complete decoded addends are retained. */
function operand(kind: RelocationKind, reference: string | null, addend: number): RelocationOperand {
  return { reference, addend: kind === "REFLO" ? signed16(addend) : addend | 0 };
}
export function nativeRelocationOperands(object: NativeObject): RelocationOperand[] {
  if (object.format === "psyq-lnk") return object.relocations.map(r => {
    const value = lnkOperand(r.target);
    return "unresolved" in value ? value : operand(r.kind, value.reference, value.addend);
  });
  const result: RelocationOperand[] = object.relocations.map(() => ({ unresolved: "ECOFF addend unavailable" }));
  const sections = new Map(object.sections.map(s => [s.name, s]));
  const pending: number[] = [];
  const word = (index: number) => {
    const r = object.relocations[index]!;
    return sections.get(r.section)!.data.readUInt32LE(r.offset);
  };
  const base = (r: NativeRelocation): number | undefined => {
    const local = /^(\.[^@]+)@0$/.exec(r.target);
    if (local) return sections.get(local[1]!)?.address;
    return r.target === "ABS@0" || /^(?:named:|import:)/.test(r.target) ? 0 : undefined;
  };
  const set = (index: number, encoded: number) => {
    const r = object.relocations[index]!, address = base(r);
    result[index] = address === undefined ? { unresolved: `unknown reference ${r.target}` } :
      operand(r.kind, r.target === "ABS@0" ? null : r.target, encoded - address);
  };
  let section = "";
  for (let i = 0; i < object.relocations.length; i++) {
    const r = object.relocations[i]!;
    if (section !== r.section) { pending.length = 0; section = r.section; }
    const source = sections.get(r.section);
    if (!source || r.offset < 0 || r.offset + (r.kind === "REFHALF" ? 2 : 4) > source.data.length) {
      result[i] = { unresolved: "relocation field outside available section contents" }; continue;
    }
    if (r.kind === "REFHI") {
      result[i] = { unresolved: "ECOFF REFHI has no following REFLO in its section" };
      pending.push(i); continue;
    }
    if (r.kind === "REFLO") {
      const low = signed16(word(i));
      // ECOFF permits several HIs per LO. Pair in TABLE order, not address
      // order, and use each HI's own reference/section-VMA adjustment.
      for (const hi of pending) set(hi, (word(hi) & 0xffff) * 0x10000 + low);
      pending.length = 0;
      set(i, low); continue;
    }
    if (r.kind === "REFWORD") set(i, word(i));
    else if (r.kind === "REFHALF") set(i, sections.get(r.section)!.data.readUInt16LE(r.offset));
    else if (r.kind === "JMPADDR") {
      const address = base(r), encoded = (word(i) & 0x3ffffff) * 4;
      if (address === undefined || address >= 0x10000000 || encoded >= 0x08000000)
        result[i] = { unresolved: "ECOFF JMPADDR high-region/addend interpretation is not established" };
      else set(i, encoded);
    } else if (r.kind === "GPREL" || r.kind === "LITERAL") {
      const local = r.target === "ABS@0" || /^\.[^@]+@0$/.test(r.target);
      if (local && object.gpValue === undefined)
        result[i] = { unresolved: "ECOFF internal GP-relative addend needs an encoded input gp value" };
      else set(i, signed16(word(i)) + (local ? object.gpValue! : 0));
    }
  }
  return result;
}
