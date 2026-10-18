/** Sony object packaging from the candidate ECOFF alone. No reference input. */
import { readEcoff } from "../objectFormats/ecoff.js";
import { LnkWriter } from "../objectFormats/lnkWriter.js";
import type { Expression } from "../objectFormats/model.js";
export const LNK_VERSION = 1;
export type LnkLayout = "standard" | "early";
// Closed, original-object-witnessed layouts. Adding a layout requires a byte replay.
const layouts = {
  standard: { sections: { ".rdata": 0xf001, ".text": 0xf002, ".data": 0xf003, ".sdata": 0xf004, ".sbss": 0xf005, ".bss": 0xf006 }, omitEmpty: false },
  early: { sections: { ".rdata": 0xf004, ".text": 0xf000, ".data": 0xf001, ".sdata": 0xf003, ".bss": 0xf005, ".sbss": 0xf002 }, omitEmpty: true },
} as const;
const patchKinds = { REFWORD: 16, JMPADDR: 74, REFHI: 82, REFLO: 84 } as const;
export function finalizeLnk(input: Buffer, layout: LnkLayout = "standard") {
  const rules = layouts[layout];
  if (!rules) throw new Error(`psyq-lnk: unknown layout ${layout}`);
  const object = readEcoff(input), w = new LnkWriter();
  const id = (name: string) => {
    const value = (rules.sections as Record<string, number>)[name];
    if (value === undefined) throw new Error(`psyq-lnk: unsupported section ${name}`);
    return value;
  };
  object.sections.forEach(s => id(s.name));
  w.u8(46).u8(7);
  for (const [name, value] of Object.entries(rules.sections)) w.u8(16).u16(value).u16(0).u8(8).text(name);
  for (const s of object.symbols.filter(s => s.binding === "external")) {
    if (s.section === "UND") w.u8(14).u16(s.id!).text(s.name);
    else if (s.section === "COMMON") w.u8(48).u16(s.id!).u16(id(s.storageClass === 18 ? ".sbss" : ".bss")).u32(s.size).text(s.name);
    else w.u8(12).u16(s.id!).u16(id(s.section)).u32(s.offset).text(s.name);
  }
  for (const s of object.sections) {
    if (s.kind === "bss") {
      if (s.size) w.u8(6).u16(id(s.name)).u8(8).u32(s.size);
      continue;
    }
    if (rules.omitEmpty && !s.size) continue;
    // A file-backed section is switched even if it has zero bytes.
    if (!s.size && !s.fileOffset) continue;
    w.u8(6).u16(id(s.name));
    const rows = object.relocations.filter(r => r.section === s.name);
    const addends: number[] = [], pending: number[] = [];
    const word = (i: number) => s.data.readUInt32LE(rows[i]!.offset);
    const base = (i: number) => {
      const r = rows[i]!;
      if (r.symbolId !== undefined) return 0;
      const target = object.sections.find(t => `${t.name}@0` === r.target);
      if (!target) throw new Error(`psyq-lnk: unsupported relocation target ${r.target}`);
      return target.address;
    };
    rows.forEach((r, i) => {
      if (!(r.kind in patchKinds)) throw new Error(`psyq-lnk: unsupported relocation ${r.kind}`);
      if (r.kind === "REFHI") { pending.push(i); return; }
      if (r.kind === "REFLO") {
        const low = (word(i) << 16) >> 16;
        for (const hi of pending) addends[hi] = ((word(hi) & 0xffff) * 0x10000 + low - base(hi)) | 0;
        addends[i] = pending.length ? addends[pending[pending.length - 1]!]! : (low - base(i)) | 0;
        pending.length = 0;
      } else addends[i] = ((r.kind === "JMPADDR" ? (word(i) & 0x3ffffff) * 4 : word(i)) - base(i)) | 0;
    });
    if (pending.length) throw new Error("psyq-lnk: unpaired REFHI");
    for (let start = 0; start < s.size; start += 0x8000) {
      const end = Math.min(s.size, start + 0x8000);
      w.bytes(s.data.subarray(start, end));
      rows.forEach((r, i) => {
        if (r.offset < start || r.offset >= end) return;
        if (r.offset + 4 > end) throw new Error("psyq-lnk: patch crosses BYTES boundary");
        const leaf: Expression = r.symbolId !== undefined ? { op: "symbol", id: r.symbolId } : { op: "base", id: id(r.target.slice(0, -2)) };
        const a = addends[i]!, expression: Expression = a ? { op: a > 0 ? "add" : "sub", left: leaf, right: { op: "value", value: Math.abs(a) } } : leaf;
        w.u8(10).u8(patchKinds[r.kind as keyof typeof patchKinds]).u16(r.offset - start).expression(expression);
      });
    }
  }
  return { output: w.u8(0).finish(), replacements: [], lnkLayout: layout };
}
