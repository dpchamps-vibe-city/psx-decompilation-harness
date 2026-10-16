/** Conservative private entry discovery from ORIGINAL section-relative call
 * and published-code-address relocations. Fields are REL addends, never RAM
 * addresses. An address alone is not a function: require independent control
 * flow and a real callback use, not a load from text, switch label or literal.
 * Unknown code stays in its original fragment; the byte oracle is unchanged. */
import type { ObjectRelocation, RelocatableObject } from "./relocatableObject.js";
import { decodeWord, definedRegister, isBranch, type DecodedInsn } from "../agent/matching-reconstruction/decode.js";

export interface ObjectFunction {
  name: string; section: string; offset: number; size: number; inferredSize: boolean;
  discovery?: { kind: "call-relocation" | "address-relocation"; sites: Array<{ section: string; offset: number }> };
}
const transfer = (word: number) => word >>> 26 === 2 || (word >>> 26 === 0 && (word & 63) === 8);
const control = (i: DecodedInsn) => isBranch(i.op) || ["j", "jal", "jr", "jalr", "break"].includes(i.op);
const localReference = (r: ObjectRelocation) => /^(.*)@(\d+)$/.exec(r.reference);
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
      const local = relocation && localReference(relocation);
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
/** Follow the exact address through straight-line copies to a store, argument,
 * return or indirect call. Arithmetic/indexing kills it. Inspect a transfer's
 * delay slot before stopping: FIRST.OBJ publishes its hook in a J delay slot. */
function publishedAddress(data: Buffer, low: number): boolean {
  const registers = new Set([decodeWord(data.readUInt32LE(low), low).rt]);
  const use = (i: DecodedInsn): boolean => {
    if (i.op === "unknown") { registers.clear(); return false; }
    if (i.op === "sw" && registers.has(i.rt) && !registers.has(i.rs)) return true;
    const copy = ["addu", "or"].includes(i.op) &&
      ((i.rs === 0 && registers.has(i.rt)) || (i.rt === 0 && registers.has(i.rs)));
    const written = definedRegister(i);
    if (typeof written === "number") {
      registers.delete(written);
      if (copy) registers.add(written);
    }
    return false;
  };
  for (let at = low + 4; at + 4 <= data.length && registers.size; at += 4) {
    const i = decodeWord(data.readUInt32LE(at), at);
    if (!control(i)) { if (use(i)) return true; continue; }
    if (at + 8 > data.length) return false;
    const indirectCall = i.op === "jalr" && i.rd === 31 && registers.has(i.rs);
    // The target is read before the delay slot, but the link register has
    // already been written when that slot executes.
    const linked = definedRegister(i);
    if (typeof linked === "number") registers.delete(linked);
    const slot = decodeWord(data.readUInt32LE(at + 4), at + 4);
    if (slot.op === "unknown" || control(slot)) return false;
    if (use(slot) || indirectCall) return true;
    if (["jal", "jalr"].includes(i.op) && [4, 5, 6, 7].some(r => registers.has(r))) return true;
    return i.op === "jr" && i.rs === 31 && registers.has(2);
  }
  return false;
}
/** A published pointer must lead to code that is independently enterable and
 * exits without falling through into the next fragment. Unknown instructions,
 * unresolved computed jumps and text literals are not silently called C functions.
 * Calls return after their delay slots; local branches stay inside the bound. */
function independentAddressEntry(object: RelocatableObject, section: string, start: number, end: number, entries: Set<number>): boolean {
  const data = object.sections.get(section)!.data, pending = [start], visited = new Set<number>();
  let exits = false;
  while (pending.length) {
    const at = pending.pop()!;
    if (visited.has(at)) continue;
    if (at < start || at + 4 > end || at % 4) return false;
    visited.add(at);
    const i = decodeWord(data.readUInt32LE(at), at);
    if (i.op === "unknown") return false;
    if (!control(i)) { pending.push(at + 4); continue; }
    if (i.op === "break") continue;
    if (at + 8 > end) return false;
    const slot = decodeWord(data.readUInt32LE(at + 4), at + 4);
    if (slot.op === "unknown" || control(slot)) return false;
    if (i.op === "jr") {
      if (i.rs !== 31) return false;
      exits = true;
    } else if (i.op === "j") {
      const r = object.relocations.find(r => r.section === section && r.offset === at && r.type === 4);
      if (!r) return false; // An unrelocated J field is not a section coordinate.
      if (r.reference.startsWith("import:")) { exits = true; continue; }
      const local = localReference(r), named = object.symbols.find(s => `named:${s.name}` === r.reference && s.binding === 1);
      const targetSection = local?.[1] ?? named?.section;
      const target = Number(local?.[2] ?? named?.value) + (i.word & 0x3ffffff) * 4;
      if (targetSection === section && target >= start && target < end) pending.push(target);
      else if (targetSection && object.sections.get(targetSection)?.flags! & 4 &&
        (targetSection === section ? entries.has(target) : object.symbols.some(s => s.section === targetSection && s.value === target && s.type === 2))) exits = true;
      else return false;
    } else if (i.op === "jal" || (i.op === "jalr" && i.rd === 31)) pending.push(at + 8);
    else if (isBranch(i.op)) pending.push(i.target!, at + 8);
    else return false;
  }
  return exits;
}

export function discoverPrivateFunctions(object: RelocatableObject, named: ObjectFunction[]): ObjectFunction[] {
  type Entry = { section: string; offset: number; kind: NonNullable<ObjectFunction["discovery"]>["kind"]; sites: Array<{ section: string; offset: number }> };
  const entries = new Map<string, Entry>();
  const add = (section: string, offset: number, kind: Entry["kind"], sites: Entry["sites"]) => {
    const code = object.sections.get(section);
    if (!(code?.flags! & 4) || offset < 0 || offset % 4 || offset + 8 > code!.data.length ||
        named.some(f => f.section === section && (f.offset === offset || (!f.inferredSize && offset > f.offset && offset < f.offset + f.size)))) return;
    const key = `${section}@${offset}`, entry = entries.get(key) ?? { section, offset, kind, sites: [] };
    // A call witness is stronger; its sites must remain actual JAL sites,
    // not a mixture of calls and address fixups under a call-only label.
    if (entry.kind !== kind && kind === "call-relocation") { entry.kind = kind; entry.sites = []; }
    if (entry.kind !== kind) return;
    for (const site of sites) if (!entry.sites.some(s => s.section === site.section && s.offset === site.offset)) entry.sites.push(site);
    entries.set(key, entry);
  };
  for (const relocation of object.relocations) {
    const caller = object.sections.get(relocation.section);
    if (relocation.type !== 4 || !(caller?.flags! & 4) || relocation.offset % 4) continue;
    const word = caller!.data.readUInt32LE(relocation.offset);
    if (word >>> 26 !== 3) continue; // J is a branch/tail transfer, NOT an entry witness.
    const local = localReference(relocation);
    if (local) add(local[1]!, Number(local[2]) + (word & 0x3ffffff) * 4, "call-relocation", [{ section: relocation.section, offset: relocation.offset }]);
  }
  // REL HI16(s) bind to their following LO16, in table order. Do not pair by
  // instruction adjacency, sort relocations, or guess through mixed/overlapping
  // groups. Memory-address low halves (LW/SW) are not function-pointer formation.
  for (const [section, code] of object.sections) {
    if (!(code.flags & 4)) continue;
    const rows = object.relocations.filter(r => r.section === section);
    if (new Set(rows.map(r => r.offset)).size !== rows.length) continue;
    let pending: ObjectRelocation[] = [];
    for (const r of rows) {
      if (r.type === 5) { pending.push(r); continue; }
      if (r.type !== 6) continue;
      const group = pending; pending = [];
      const local = localReference(r), low = decodeWord(code.data.readUInt32LE(r.offset), r.offset);
      if (!local || !group.length || group.some(h => h.reference !== r.reference) || low.op !== "addiu" || !low.rt || r.offset % 4 ||
          !publishedAddress(code.data, r.offset)) continue;
      for (const h of group) {
        if (h.offset >= r.offset || h.offset % 4) continue;
        const high = decodeWord(code.data.readUInt32LE(h.offset), h.offset);
        if (high.op !== "lui" || high.rs || !high.rt || high.rt !== low.rs) continue;
        let clobbered = false;
        for (let at = h.offset + 4; at < r.offset; at += 4) {
          const i = decodeWord(code.data.readUInt32LE(at), at), written = definedRegister(i);
          if (control(i) || written === "unknown" || written === high.rt) { clobbered = true; break; }
        }
        if (!clobbered) add(local[1]!, Number(local[2]) + high.uimm * 0x10000 + low.simm, "address-relocation",
          [{ section, offset: h.offset }, { section, offset: r.offset }]);
      }
    }
  }
  const names = new Set(object.symbols.map(s => s.name));
  const candidates = [...entries.values()].filter(e => endsBefore(object.sections.get(e.section)!.data, e.offset));
  // Removing an entry can turn an admissible tail jump into an interior jump
  // or change a neighbor's bound. Recheck until every partition is independent.
  let survivors = candidates;
  while (true) {
    const next = survivors.filter(e => {
      const targets = new Set([...named, ...survivors].filter(f => f.section === e.section).map(f => f.offset));
      const end = Math.min(object.sections.get(e.section)!.size, ...[...targets].filter(at => at > e.offset));
      return !crossedByBranch(object, e.section, e.offset, targets) && (e.kind === "call-relocation" || independentAddressEntry(object, e.section, e.offset, end, targets));
    });
    if (next.length === survivors.length) break;
    survivors = next;
  }
  return survivors.map(e => {
    const labels = object.symbols.filter(s => s.binding === 0 && s.type === 0 && s.section === e.section && s.value === e.offset && /^[A-Za-z_]\w*$/.test(s.name));
    if (labels.length > 1) throw new Error(`Private function aliases need review: ${e.section}+${e.offset}`);
    // Keep the disassembler's established local spelling. These coordinates
    // are original listing positions, not VRAM or guessed runtime addresses.
    const section = object.sections.get(e.section)!;
    const coordinate = (section.address || section.offset) + e.offset;
    const name = labels[0]?.name ?? `func_${coordinate.toString(16).toUpperCase().padStart(8, "0")}`;
    if (!labels.length && names.has(name)) throw new Error(`Private function identity collides with an original symbol: ${name}`);
    names.add(name);
    return { name, section: e.section, offset: e.offset, size: 0, inferredSize: true, discovery: { kind: e.kind, sites: e.sites } };
  });
}
