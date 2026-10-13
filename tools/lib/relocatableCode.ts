/** Conservative private entry discovery from ORIGINAL section-relative JAL
 * relocations. Raw J fields are addends, never absolute listing addresses.
 * A call alone is not a boundary: reject interior sized entries, fallthrough
 * and conditional branches crossing the proposed partition. Unknown/uncalled
 * code stays in its original fragment; this never modifies the byte oracle. */
import type { RelocatableObject } from "./relocatableObject.js";

export interface ObjectFunction {
  name: string; section: string; offset: number; size: number; inferredSize: boolean;
  discovery?: { kind: "call-relocation"; sites: Array<{ section: string; offset: number }> };
}
const transfer = (word: number) => word >>> 26 === 2 || (word >>> 26 === 0 && (word & 63) === 8);
function endsBefore(data: Buffer, offset: number): boolean {
  if (offset === 0) return true;
  let last = offset - 4;
  while (last >= 0 && data.readUInt32LE(last) === 0) last -= 4;
  if (last < 0) return false;
  // The final nonzero word is either a transfer with a nop slot, or its slot.
  return (transfer(data.readUInt32LE(last)) && last + 8 <= offset) ||
    (last >= 4 && transfer(data.readUInt32LE(last - 4)));
}
function crossedByBranch(object: RelocatableObject, section: string, boundary: number, entries: Set<number>): boolean {
  const data = object.sections.get(section)!.data;
  for (let at = 0; at + 4 <= data.length; at += 4) {
    const word = data.readUInt32LE(at), op = word >>> 26, rt = (word >>> 16) & 31;
    let target: number;
    if (op === 2) {
      const relocation = object.relocations.find(r => r.section === section && r.offset === at && r.type === 4);
      const local = relocation && /^(.*)@(\d+)$/.exec(relocation.reference);
      if (relocation && (!local || local[1] !== section)) continue;
      target = (local ? Number(local[2]) : 0) + (word & 0x3ffffff) * 4;
      // A tail transfer to another witnessed entry is allowed; jumping into
      // its interior is a shared-block edge, not an independent function.
      if (entries.has(target)) continue;
    } else {
      if (![4, 5, 6, 7].includes(op) && !(op === 1 && [0, 1, 16, 17].includes(rt))) continue;
      target = at + 4 + ((word << 16) >> 16) * 4;
    }
    if (target >= 0 && target < data.length && (at < boundary) !== (target < boundary)) return true;
  }
  return false;
}
export function discoverPrivateFunctions(object: RelocatableObject, named: ObjectFunction[]): ObjectFunction[] {
  const entries = new Map<string, { section: string; offset: number; sites: Array<{ section: string; offset: number }> }>();
  for (const relocation of object.relocations) {
    const caller = object.sections.get(relocation.section);
    if (relocation.type !== 4 || !(caller?.flags! & 4) || relocation.offset % 4) continue;
    const word = caller!.data.readUInt32LE(relocation.offset);
    if (word >>> 26 !== 3) continue; // J is a branch/tail transfer, NOT an entry witness.
    const local = /^(.*)@(\d+)$/.exec(relocation.reference);
    if (!local) continue; // Imports and exported-symbol + addend are not private entries.
    const section = local[1]!, offset = Number(local[2]) + (word & 0x3ffffff) * 4;
    const code = object.sections.get(section);
    if (!(code?.flags! & 4) || offset % 4 || offset + 8 > code!.data.length ||
        named.some(f => f.section === section && (f.offset === offset || (!f.inferredSize && offset > f.offset && offset < f.offset + f.size)))) continue;
    const key = `${section}@${offset}`, entry = entries.get(key) ?? { section, offset, sites: [] };
    entry.sites.push({ section: relocation.section, offset: relocation.offset }); entries.set(key, entry);
  }
  const names = new Set(object.symbols.map(s => s.name));
  const candidates = [...entries.values()].filter(e => endsBefore(object.sections.get(e.section)!.data, e.offset));
  // Removing an entry can turn a formerly admissible tail jump into an
  // interior jump. Recheck until every remaining partition is independent.
  let survivors = candidates;
  while (true) {
    const next = survivors.filter(e => {
      const targets = new Set([...named, ...survivors].filter(f => f.section === e.section).map(f => f.offset));
      return !crossedByBranch(object, e.section, e.offset, targets);
    });
    if (next.length === survivors.length) break;
    survivors = next;
  }
  return survivors.map(e => {
    const labels = object.symbols.filter(s => s.binding === 0 && s.type === 0 && s.section === e.section && s.value === e.offset && /^[A-Za-z_]\w*$/.test(s.name));
    if (labels.length > 1) throw new Error(`Private function aliases need review: ${e.section}+${e.offset}`);
    // Keep the disassembler's established local function spelling: existing
    // matched C can call it. This is an original listing coordinate, not VRAM;
    // section/offset remain the function's authoritative coordinates.
    const section = object.sections.get(e.section)!;
    const coordinate = (section.address || section.offset) + e.offset;
    const name = labels[0]?.name ?? `func_${coordinate.toString(16).toUpperCase().padStart(8, "0")}`;
    if (!labels.length && names.has(name)) throw new Error(`Private function identity collides with an original symbol: ${name}`);
    names.add(name);
    return { name, section: e.section, offset: e.offset, size: 0, inferredSize: true,
      discovery: { kind: "call-relocation" as const, sites: e.sites } };
  });
}
