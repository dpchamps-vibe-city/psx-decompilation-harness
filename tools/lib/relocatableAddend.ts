/** Original relocation operands, shared by discovery and diagnostic readers.
 * Kept below the target adapters: discovering entries must not load a project
 * or depend on the function inventory it is in the middle of constructing. */
import type { RelocatableObject, ObjectRelocation } from "./relocatableObject.js";
const signed = (n: number) => (n & 0x8000) ? (n & 0xffff) - 0x10000 : n & 0xffff;

/** Native decoded operand or ELF REL addend. A paired low instruction may
 * recover the full address from its matching register's high instruction. */
export function relocatableAddend(o: RelocatableObject, r: ObjectRelocation): number {
  if (r.addend === null) throw new Error(`Native relocation operand unavailable: ${r.section}+${r.offset} ${r.reference}`);
  if (r.addend !== undefined && r.type !== 6) return r.addend;
  const word = o.sections.get(r.section)!.data.readUInt32LE(r.offset);
  if (r.type === 4) return (word & 0x3ffffff) * 4;
  if (r.type === 2) return word;
  if (r.type === 10) return signed(word) * 4;
  if (r.type === 6) {
    const before = o.relocations.slice(0, o.relocations.indexOf(r));
    const lastLow = before.findLastIndex(l => l.type === 6 && l.section === r.section && l.reference === r.reference);
    const baseRegister = (word >>> 21) & 31;
    const hi = before.slice(lastLow + 1).findLast(h => h.type === 5 && h.section === r.section && h.reference === r.reference &&
      ((o.sections.get(h.section)!.data.readUInt32LE(h.offset) >>> 16) & 31) === baseRegister);
    if (hi) {
      if (r.addend === undefined) return (o.sections.get(hi.section)!.data.readUInt32LE(hi.offset) & 0xffff) * 0x10000 + signed(word);
      if (hi.addend != null && signed(hi.addend) === r.addend) return hi.addend;
    }
  }
  if (r.addend !== undefined) return r.addend;
  if (r.type === 5) {
    const at = o.relocations.indexOf(r), low = o.relocations.slice(at + 1).find(l => l.section === r.section && l.reference === r.reference && l.type === 6);
    return (word & 0xffff) * 0x10000 + (low ? signed(o.sections.get(low.section)!.data.readUInt32LE(low.offset)) : 0);
  }
  return signed(word);
}
