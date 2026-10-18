import { test } from "../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import { readLnk } from "./objectFormats/lnk.js";
import { readEcoff } from "./objectFormats/ecoff.js";
import { compareOriginalObject } from "./objectFormats/compare.js";
import { nativeObjectView } from "./objectFormats/view.js";
import { nativeRelocationOperands } from "./objectFormats/relocations.js";
import { relocatableFunctionWords } from "./relocatableFunctionOracle.js";
import { validateElfView } from "./libraryOriginals.js";
import { compareRelocatableObjects, renderObjectResidual } from "./relocatableObject.js";
import { dmpsxCommand, dmpsxSource, isDmpsxPlaceholderExpression, finalizeDmpsx } from "./stages/psyqDmpsx.js";
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const str = (s: string) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]);
const symbol = (id: number) => Buffer.concat([Buffer.from([2]), u16(id)]);
const base = (id: number) => Buffer.concat([Buffer.from([4]), u16(id)]);
const plus = (reference: Buffer, value: number) => Buffer.concat([Buffer.from([44, 0]), u32(value), reference]);
function lnk(code = Buffer.alloc(32), patches = [{ offset: 0, type: 16, expression: symbol(2) }]) {
  return Buffer.concat([Buffer.from("4c4e4b02", "hex"), ...[".text", ".data", ".bss"].map((s, i) => Buffer.concat([Buffer.from([16]), u16(i + 1), u16(0), Buffer.from([16]), str(s)])),
    Buffer.from([6]), u16(1), Buffer.from([2]), u16(code.length), code,
    Buffer.from([12]), u16(1), u16(1), u32(0), str("entry"), Buffer.from([14]), u16(2), str("external"),
    Buffer.from([48]), u16(3), u16(3), u32(8), str("common"),
    ...patches.map(p => Buffer.concat([Buffer.from([10, p.type]), u16(p.offset), p.expression])), Buffer.from([0])]);
}
function ecoff(type = 2, placeholder = 0, relocations = [{ offset: 0, type, index: 1, external: true }], gp?: number) {
  const strings = Buffer.from("entry\0external\0common\0"), symptr = 172 + 8 * relocations.length, ss = symptr + 96, ext = ss + strings.length, b = Buffer.alloc(ext + 48);
  b.writeUInt16LE(0x162); b.writeUInt16LE(3, 2); b.writeUInt32LE(symptr, 8); b.writeUInt32LE(96, 12);
  for (const [i, name, flags] of [[0, ".text", 0x20], [1, ".data", 0x40], [2, ".bss", 0x80]] as const) {
    const at = 20 + 40 * i; b.write(name, at); b.writeUInt32LE(flags, at + 36);
    if (i === 0) { b.writeUInt32LE(32, at + 16); b.writeUInt32LE(140, at + 20); b.writeUInt32LE(172, at + 24); b.writeUInt16LE(relocations.length, at + 32); }
  }
  b.writeUInt32LE(placeholder >>> 0, 144);
  relocations.forEach((r, i) => {
    b.writeUInt32LE(r.offset, 172 + i * 8);
    b.writeUInt32LE((r.index | ((r.type << 3 | (r.external ? 0x80 : 0)) << 24)) >>> 0, 176 + i * 8);
  });
  b.writeUInt16LE(0x7009, symptr); b.writeUInt32LE(strings.length, symptr + 64); b.writeUInt32LE(ss, symptr + 68); b.writeUInt32LE(3, symptr + 88); b.writeUInt32LE(ext, symptr + 92); strings.copy(b, ss);
  for (const [i, name, value, st, sc] of [[0, 0, 0, 6, 1], [1, 6, 0, 1, 6], [2, 15, 8, 1, 17]]) {
    const at = ext + i! * 16; b.writeUInt32LE(name!, at + 4); b.writeUInt32LE(value!, at + 8); b.writeUInt32LE((st! | (sc! << 6) | 0xfffff000) >>> 0, at + 12);
  }
  if (gp === undefined) return b;
  const withOptional = Buffer.concat([b.subarray(0, 20), Buffer.alloc(56), b.subarray(20)]);
  withOptional.writeUInt16LE(56, 16); withOptional.writeUInt32LE(symptr + 56, 8); withOptional.writeUInt32LE(gp, 72);
  for (let i = 0; i < 3; i++) for (const field of [20, 24]) {
    const at = 76 + i * 40 + field, value = withOptional.readUInt32LE(at);
    if (value) withOptional.writeUInt32LE(value + 56, at);
  }
  withOptional.writeUInt32LE(ss + 56, symptr + 56 + 68); withOptional.writeUInt32LE(ext + 56, symptr + 56 + 92);
  return withOptional;
}
test("native readers feed one exact comparator; all program-content negative controls fail", () => {
  const a = readLnk(lnk()), b = readEcoff(ecoff());
  assert.equal(compareOriginalObject(a, readLnk(lnk())).verdict, "match");
  assert.equal(b.sections[0]!.alignment, null, "BFD's default is not encoded ECOFF alignment");
  const incomplete = compareRelocatableObjects(lnk(), ecoff());
  assert.equal(incomplete.verdict, "undetermined");
  assert.deepEqual(incomplete.differences, []);
  assert.equal(incomplete.unresolved!.length, 3);
  assert.match(renderObjectResidual(incomplete).join("\n"), /Verification unavailable:.*candidate ecoff has no encoded section alignment/);
  assert.equal(nativeObjectView(b).native!.sections[0]!.alignment, null, "diagnostic adapter does not invent native metadata");
  const eight = lnk(); eight[9] = 8;
  const unknownEight = compareRelocatableObjects(eight, ecoff());
  assert.equal(unknownEight.verdict, "undetermined", "neither original 8 nor 16 is compared with an invented value");
  assert.deepEqual(unknownEight.differences, []);
  assert.equal(compareOriginalObject(a, readLnk(eight)).verdict, "mismatch", "two encoded, different alignments are still a real mismatch");
  const controls = [
    (o: typeof b) => { o.sections[0]!.data[4] = o.sections[0]!.data[4]! ^ 1; },
    (o: typeof b) => { o.sections[0]!.data[0] = o.sections[0]!.data[0]! ^ 1; }, /* relocated field */
    (o: typeof b) => { o.sections.pop(); }, /* empty declarations remain exact */
    (o: typeof b) => { o.sections[0]!.name = ".other"; },
    (o: typeof b) => { o.relocations[0]!.offset = 4; },
    (o: typeof b) => { o.relocations[0]!.kind = "REFLO"; },
    (o: typeof b) => { o.relocations[0]!.target = "named:entry"; },
    (o: typeof b) => { o.symbols.pop(); },
    (o: typeof b) => { o.symbols.push({ name: "extra", section: "UND", offset: 0, size: 0, binding: "external" }); },
    (o: typeof b) => { o.symbols.find(s => s.section === "COMMON")!.size++; },
  ];
  for (const change of controls) {
    const candidate = readEcoff(ecoff()); change(candidate);
    const result = compareOriginalObject(a, candidate);
    assert.equal(result.verdict, "mismatch", "unavailable alignment must not conceal a witnessed difference");
    assert.ok(result.differences.length);
  }
  assert.equal(a.relocations[0]!.target, "import:external");
  // The diagnostic ELF convention may move a constant into a REL field. It
  // must retain the symbolic dependency; native acceptance never folds it.
  const expression = readLnk(Buffer.concat([lnk().subarray(0, -4), Buffer.from([46, 0]), u32(4), Buffer.from([2]), u16(2), Buffer.from([0])]));
  assert.deepEqual(expression.relocations[0]!.expression, { op: "sub", left: { op: "symbol", id: 2 }, right: { op: "value", value: 4 } }, "LNK serializes the right operand first");
  const divided = readLnk(Buffer.concat([lnk().subarray(0, -4), Buffer.from([50, 0]), u32(4), Buffer.from([0]), u32(20), Buffer.from([0])]));
  assert.deepEqual(divided.relocations[0]!.expression, { op: "div", left: { op: "value", value: 20 }, right: { op: "value", value: 4 } });
  const addZeroBytes = Buffer.concat([lnk().subarray(0, -4), Buffer.from([44, 0]), u32(0), Buffer.from([2]), u16(2), Buffer.from([0])]);
  const addZero = readLnk(addZeroBytes);
  assert.deepEqual(addZero.relocations[0]!.expression, { op: "add", left: { op: "symbol", id: 2 }, right: { op: "value", value: 0 } }, "even +0 retains its full tree");
  assert.deepEqual(Buffer.concat(addZero.records!.map(r => r.bytes)), addZeroBytes.subarray(4), "wire records remain unchanged");
  assert.deepEqual(compareOriginalObject(addZero, b).differences, [], "explicit +0 and implicit zero denote the same unchanged reference");
  assert.equal(compareOriginalObject(addZero, b).verdict, "undetermined", "unavailable alignment still prohibits acceptance");
  const view = nativeObjectView(a);
  validateElfView(expression, view);
  const negated = readLnk(Buffer.concat([lnk().subarray(0, -4), Buffer.from([46, 2]), u16(2), Buffer.from([0]), u32(4), Buffer.from([0])]));
  assert.deepEqual(negated.relocations[0]!.expression, { op: "sub", left: { op: "value", value: 4 }, right: { op: "symbol", id: 2 } });
  assert.throws(() => validateElfView(negated, view), /no supported symbolic view/, "constant minus symbol is not a positive ELF symbol relocation");
  assert.equal(compareOriginalObject(expression, b).verdict, "mismatch");
  assert.throws(() => validateElfView(expression, { ...view, relocations: view.relocations.map(r => ({ ...r, reference: "import:wrong" })) }), /relocation targets/);
  for (const type of [1, 2, 3, 4, 5, 6, 7]) assert.equal(readEcoff(ecoff(type)).relocations.length, 1);
  assert.throws(() => readEcoff(ecoff(15)), /unsupported relocation/);
  assert.throws(() => readLnk(Buffer.concat([lnk().subarray(0, -1), Buffer.from([255, 0])])), /unknown record/);
  assert.throws(() => readLnk(lnk().subarray(0, -1)), /missing END/);
  assert.throws(() => readEcoff(ecoff().subarray(0, -1)), /truncated/);
});
test("native relocation operands decode explicit LNK and implicit ECOFF addends without rewriting bytes or references", () => {
  const check = (original: Buffer, candidate: Buffer) => {
    const before = Buffer.from(candidate), a = readLnk(original), b = readEcoff(candidate);
    const result = compareOriginalObject(a, b);
    assert.deepEqual(result.differences, []);
    assert.equal(result.verdict, "undetermined", "alignment remains unavailable");
    assert.deepEqual(nativeRelocationOperands(a), nativeRelocationOperands(b));
    assert.deepEqual(candidate, before, "decoding never changes encoded fields");
    return { a, b };
  };
  const word = ecoff(); word.writeUInt32LE(32, 140);
  check(lnk(word.subarray(140, 172), [{ offset: 0, type: 16, expression: plus(symbol(2), 32) }]), word);
  const jump = ecoff(3, 0, [{ offset: 0, type: 3, index: 1, external: false }]); jump.writeUInt32LE(0x0c000004, 140);
  const call = check(lnk(jump.subarray(140, 172), [{ offset: 0, type: 74, expression: plus(base(1), 16) }]), jump);
  for (const object of [call.a, call.b]) {
    const words = relocatableFunctionWords(nativeObjectView(object), "entry");
    assert.equal(words[0]!.relocations![0]!.addend, 16, "diagnostics do not add the raw jump field twice");
    assert.equal(words[0]!.relocations![0]!.reference, ".text@0");
  }
  const paired = ecoff(4, 0, [{ offset: 0, type: 4, index: 3, external: false }, { offset: 4, type: 5, index: 3, external: false }]);
  paired.writeUInt32LE(0x10000, 72); /* encoded .data VMA */
  paired.writeUInt32LE(0x3c020002, 140); paired.writeUInt32LE(0x2442fffc, 144);
  const patches = [82, 84].map((type, i) => ({ offset: i * 4, type, expression: plus(base(2), 65532) }));
  const pair = check(lnk(paired.subarray(140, 172), patches), paired);
  assert.deepEqual(nativeRelocationOperands(pair.b).map(r => "addend" in r && r.addend), [65532, -4]);
  const multiple = ecoff(4, 0, [{ offset: 8, type: 4, index: 3, external: false }, { offset: 0, type: 4, index: 3, external: false }, { offset: 4, type: 5, index: 3, external: false }]);
  paired.subarray(140, 172).copy(multiple, 140); multiple.writeUInt32LE(0x10000, 72); multiple.writeUInt32LE(0x3c030003, 148);
  check(lnk(multiple.subarray(140, 172), [
    { offset: 8, type: 82, expression: plus(base(2), 131068) }, ...patches,
  ]), multiple); /* Two different HI values, non-address table order, one signed LO. */
  const altered = readLnk(lnk(paired.subarray(140, 172), patches.map(p => ({ ...p, expression: plus(base(2), 65533) }))));
  assert.equal(compareOriginalObject(altered, pair.b).verdict, "mismatch", "same fields with a different symbolic addend are not equal");
  pair.b.sections[0]!.data[0] = pair.b.sections[0]!.data[0]! ^ 1;
  assert.equal(compareOriginalObject(pair.a, pair.b).verdict, "mismatch", "relocated bytes remain exact");
  const defined = readLnk(lnk(Buffer.alloc(32), [{ offset: 0, type: 16, expression: symbol(1) }]));
  assert.equal(compareOriginalObject(defined, readEcoff(ecoff(2, 0, [{ offset: 0, type: 2, index: 1, external: false }]))).verdict,
    "mismatch", "a named definition is never folded into an equivalent section reference");
  for (const type of [4, 6, 7]) {
    const unknown = readEcoff(ecoff(type, 0, [{ offset: 0, type, index: 1, external: false }]));
    assert.ok("unresolved" in nativeRelocationOperands(unknown)[0]!, "dangling HI and internal GP without encoded gp fail closed");
    const words = relocatableFunctionWords(nativeObjectView(unknown), "entry");
    assert.ok(words[0]!.undetermined, "diagnostics retain raw words but do not guess unknown operands");
    assert.equal(words[0]!.raw, 0);
  }
  for (const index of [0, 1]) {
    const gp = ecoff(6, 0, [{ offset: 0, type: 6, index, external: false }], 32768);
    const expression = index ? plus(base(1), 32768) : Buffer.concat([Buffer.from([0]), u32(32768)]);
    const decoded = check(lnk(Buffer.alloc(32), [{ offset: 0, type: 100, expression }]), gp);
    assert.equal(decoded.b.gpValue, 32768, "only the encoded optional-header gp participates");
  }
  const nested = readLnk(lnk(word.subarray(140, 172), [{ offset: 0, type: 16, expression: plus(plus(symbol(2), 30), 2) }]));
  assert.deepEqual(compareOriginalObject(nested, readEcoff(word)).differences, [], "nested expression nodes are decoded without erasing their raw trees");
  const overlap = readLnk(lnk(Buffer.alloc(32), [16, 84].map(type => ({ offset: 0, type, expression: symbol(2) }))));
  assert.equal(compareOriginalObject(overlap, readEcoff(ecoff(2, 0, [{ offset: 0, type: 2, index: 1, external: true }, { offset: 0, type: 5, index: 1, external: true }]))).verdict,
    "undetermined", "overlapping effects are not proven by an unordered multiset");
});
test("DMPSX carries each operand field, refuses unknown/relocated placeholders and preserves data", () => {
  assert.equal(dmpsxCommand(0xbf), 0x4a280030);
  assert.equal(dmpsxSource(0x4a280030), "RTPT");
  assert.equal(dmpsxSource(0x3c020001), undefined);
  assert.equal(isDmpsxPlaceholderExpression("0xbf"), true);
  assert.equal(isDmpsxPlaceholderExpression("0x03e00008"), false);
  assert.equal(isDmpsxPlaceholderExpression("0xbf|1<<32"), false);
  assert.equal(isDmpsxPlaceholderExpression("0xbf; anything()"), false);
  assert.equal(dmpsxCommand(0x027813bf), 0x4a49e012);
  for (let bits = 0; bits < 256; bits++) {
    const sf = bits >>> 7, mx = bits >>> 5 & 3, v = bits >>> 3 & 3, cv = bits >>> 1 & 3, lm = bits & 1;
    const word = 0x13bf | sf << 25 | mx << 23 | v << 21 | cv << 19 | lm << 18;
    const command = (0x4a400012 | sf << 19 | mx << 17 | v << 15 | cv << 13 | lm << 10) >>> 0;
    assert.equal(dmpsxCommand(word), command);
    assert.equal(dmpsxSource(command), `MVMVA(${sf},${mx},${v},${cv},${lm})`);
    assert.equal(isDmpsxPlaceholderExpression(`0x13bf|${sf}<<25|${mx}<<23|${v}<<21|${cv}<<19|${lm}<<18`), true);
  }
  assert.throws(() => dmpsxCommand(0x153f), /unknown placeholder/);
  assert.throws(() => dmpsxCommand(0x400bf), /unknown placeholder/);
  assert.equal(dmpsxCommand(0x040000bf), undefined, "a non-placeholder opcode is untouched");
  const input = ecoff(2, 0xbf), staged = finalizeDmpsx(input);
  assert.equal(staged.replacements.length, 1); assert.equal(staged.output.readUInt32LE(144), 0x4a280030); assert.equal(input.readUInt32LE(144), 0xbf);
  const expected = Buffer.from(input); expected.writeUInt32LE(0x4a280030, 144);
  assert.deepEqual(staged.output, expected, "no metadata or other bytes change");
  for (const value of [0xbf, 0x123f]) {
    const dataAt = (input.length + 15) & ~15, withData = Buffer.concat([input, Buffer.alloc(dataAt - input.length), u32(value)]);
    withData.writeUInt32LE(4, 76); withData.writeUInt32LE(dataAt, 80);
    assert.equal(finalizeDmpsx(withData).output.readUInt32LE(dataAt), value, "even placeholder-shaped non-executable data is untouched");
  }
  input.writeUInt32LE(4, 172); assert.throws(() => finalizeDmpsx(input), /relocated placeholder/);
});
