import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { finalizeLnk } from "./stages/psyqLnk.js";
import { readLnk } from "./objectFormats/lnk.js";
import { compareObjectBytes } from "./objectFormats/byteCompare.js";
import { finalizeDmpsx } from "./stages/psyqDmpsx.js";

// Hand-built ECOFF, not a target or a serializer round trip.
function fixture() {
  const data = 260, reloc = data + 0x8010, sym = reloc + 48, strings = sym + 96;
  const names = Buffer.from("nil\0entry\0imported\0common\0small\0"), ext = strings + names.length;
  const b = Buffer.alloc(ext + 80);
  b.writeUInt16LE(0x162); b.writeUInt16LE(6, 2); b.writeUInt32LE(sym, 8);
  for (const [i, name, size, flags] of [[0, ".text", 0x8010, 0x20], [1, ".data", 0, 0x40], [2, ".bss", 12, 0x80], [3, ".rdata", 0, 0x100], [4, ".sdata", 0, 0x200], [5, ".sbss", 8, 0x400]] as const) {
    const at = 20 + i * 40; b.write(name, at); b.writeUInt32LE(size, at + 16); b.writeUInt32LE(flags, at + 36);
    if (i === 0) { b.writeUInt32LE(data, at + 20); b.writeUInt32LE(reloc, at + 24); b.writeUInt16LE(6, at + 32); }
    if ([1, 3, 4].includes(i)) b.writeUInt32LE(data, at + 20);
    if (i === 1) b.writeUInt32LE(0x10000, at + 12);
  }
  const rows = [[0x8000, 2, 2, true], [0, 4, 3, false], [4, 5, 3, false], [8, 3, 2, true], [12, 2, 2, true], [16, 5, 2, true]] as const;
  rows.forEach(([offset, type, index, external], i) => {
    b.writeUInt32LE(offset, reloc + i * 8); b.writeUInt32LE((index | (type << 3 | (external ? 0x80 : 0)) << 24) >>> 0, reloc + i * 8 + 4);
  });
  b.writeUInt32LE(0x3c020002, data); b.writeUInt32LE(0x2442fffc, data + 4);
  b.writeUInt32LE(0x0c000004, data + 8); b.writeUInt32LE(0xfffffffc, data + 12);
  b.writeUInt32LE(0x24420008, data + 16); b.writeUInt32LE(0x7f, data + 20);
  b.writeUInt16LE(0x7009, sym); b.writeUInt32LE(names.length, sym + 64); b.writeUInt32LE(strings, sym + 68); b.writeUInt32LE(5, sym + 88); b.writeUInt32LE(ext, sym + 92); names.copy(b, strings);
  for (const [i, name, value, st, sc] of [[0, 0, 0, 0, 0], [1, 4, 0, 6, 1], [2, 10, 0, 1, 6], [3, 19, 12, 1, 17], [4, 26, 4, 1, 18]]) {
    const at = ext + i! * 16; b.writeUInt32LE(name!, at + 4); b.writeUInt32LE(value!, at + 8); b.writeUInt32LE((st! | sc! << 6 | 0xfffff000) >>> 0, at + 12);
  }
  return { b, data, reloc, sym, ext };
}
// Independent expected LNK wire records: numbers/strings only, no writer calls.
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const str = (s: string) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]);
const record = (...parts: Array<number | Buffer>) => Buffer.concat(parts.map(p => typeof p === "number" ? Buffer.from([p]) : p));
for (const layout of ["standard", "early"] as const) {
  test(`psyq-lnk ${layout}: exact header, external IDs (including nil), section order, chunks, patches and END`, () => {
    const { b, data } = fixture();
    const ids = layout === "standard" ? [0xf001, 0xf002, 0xf003, 0xf004, 0xf005, 0xf006] : [0xf004, 0xf000, 0xf001, 0xf003, 0xf002, 0xf005];
    const [rdata, text, dataId, sdata, sbss, bss] = ids as [number, number, number, number, number, number];
    const declarations = layout === "standard" ? [[".rdata", rdata], [".text", text], [".data", dataId], [".sdata", sdata], [".sbss", sbss], [".bss", bss]] as const : [[".rdata", rdata], [".text", text], [".data", dataId], [".sdata", sdata], [".bss", bss], [".sbss", sbss]] as const;
    const patch = (kind: number, off: number, expression: Buffer) => record(10, kind, u16(off), expression);
    const pair = record(44, 0, u32(65532), 4, u16(dataId));
    const expected = Buffer.concat([Buffer.from("LNK\x02"), record(46, 7), ...declarations.map(([n, id]) => record(16, u16(id), u16(0), 8, str(n))),
      record(12, u16(2), u16(text), u32(0), str("entry")), record(14, u16(3), str("imported")),
      record(48, u16(4), u16(bss), u32(12), str("common")), record(48, u16(5), u16(sbss), u32(4), str("small")),
      record(6, u16(text)), record(2, u16(0x8000), b.subarray(data, data + 0x8000)),
      patch(82, 0, pair), patch(84, 4, pair), patch(74, 8, record(44, 0, u32(16), 2, u16(3))), patch(16, 12, record(46, 0, u32(4), 2, u16(3))), patch(84, 16, record(44, 0, u32(8), 2, u16(3))),
      record(2, u16(16), b.subarray(data + 0x8000, data + 0x8010)), patch(16, 0, record(2, u16(3))),
      ...(layout === "standard" ? [record(6, u16(dataId))] : []), record(6, u16(bss), 8, u32(12)),
      ...(layout === "standard" ? [record(6, u16(rdata)), record(6, u16(sdata))] : []), record(6, u16(sbss), 8, u32(8)), record(0)]);
    const before = Buffer.from(b), output = finalizeLnk(b, layout).output;
    assert.deepEqual(output, expected); assert.deepEqual(b, before);
    assert.equal(readLnk(output).relocations.length, 6);
    assert.equal(compareObjectBytes(expected, output).verdict, "match");
    const changed = Buffer.from(output); changed[9] = changed[9]! ^ 1;
    const diff = compareObjectBytes(expected, changed);
    assert.equal(diff.verdict, "mismatch"); assert.notEqual(diff.originalHash, diff.candidateHash); assert.match(diff.differences.join("\n"), /First differing .OBJ record #1/);
    assert.equal(compareObjectBytes(expected, b).verdict, "mismatch", "ECOFF cannot be accepted as a Sony object");
    const staged = finalizeLnk(finalizeDmpsx(b).output, layout).output;
    assert.equal(readLnk(staged).sections.find(s => s.name === ".text")!.data.readUInt32LE(20), 0x4a180001);
  });
}
test("psyq-lnk rejects a patch crossing a BYTES boundary", () => {
  const { b, reloc } = fixture(); b.writeUInt32LE(0x7ffe, reloc);
  assert.throws(() => finalizeLnk(b), /patch crosses BYTES boundary/);
});
test("psyq-lnk rejects an unknown layout and non-section relocation target", () => {
  const { b, reloc } = fixture();
  assert.throws(() => finalizeLnk(b, "unknown" as never), /unknown layout/);
  b.writeUInt32LE(0x20000000, reloc + 12); /* REFHI against ABS, not a section. */
  assert.throws(() => finalizeLnk(b), /unsupported relocation target ABS@0/);
});
test("psyq-lnk pairs several REFHI with one REFLO in table order", () => {
  const { b, reloc, data } = fixture();
  b.writeUInt32LE(0x20000003, reloc + 20); /* second HI, internal .data */
  b.writeUInt32LE(0x28000003, reloc + 28); /* LO, internal .data */
  b.writeUInt32LE(0x3c030003, data + 4); b.writeUInt32LE(0x2442fffc, data + 8);
  const patches = readLnk(finalizeLnk(b).output).relocations.filter(r => r.offset <= 8);
  assert.deepEqual(patches.map(r => [r.kind, r.expression]), [65532, 131068, 131068].map((value, i) => [i === 2 ? "REFLO" : "REFHI", { op: "add", left: { op: "base", id: 0xf003 }, right: { op: "value", value } }]));
});
test("psyq-lnk subtracts the section base from a lone REFLO", () => {
  const { b, reloc } = fixture(); b.writeUInt32LE(0x28000003, reloc + 44);
  const patch = readLnk(finalizeLnk(b).output).relocations.find(r => r.offset === 16)!;
  assert.deepEqual(patch.expression, { op: "sub", left: { op: "base", id: 0xf003 }, right: { op: "value", value: 65528 } });
});
for (const [name, change, message] of [
  ["section", ({ b }: ReturnType<typeof fixture>) => b.write(".other\0\0", 140), /unsupported section/],
  ["relocation", ({ b, reloc }: ReturnType<typeof fixture>) => b.writeUInt32LE(0xb0000002, reloc + 4), /unsupported relocation/],
  ["symbol class", ({ b, ext }: ReturnType<typeof fixture>) => b.writeUInt32LE(1 | 5 << 6, ext + 16 + 12), /unsupported section ABS/],
  ["symbol type", ({ b, ext }: ReturnType<typeof fixture>) => b.writeUInt32LE(3 | 1 << 6, ext + 16 + 12), /unsupported external symbol type/],
  ["dangling HI", ({ b, reloc }: ReturnType<typeof fixture>) => b.writeUInt32LE(0xa0000002, reloc + 44), /unpaired REFHI/],
  ["truncation", ({ b }: ReturnType<typeof fixture>) => b.writeUInt32LE(b.length, 8), /truncated/],
] as const) test(`psyq-lnk rejects ${name}`, () => { const f = fixture(); change(f); assert.throws(() => finalizeLnk(f.b), message); });
