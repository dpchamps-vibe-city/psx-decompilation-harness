import assert from "node:assert/strict";
import { test } from "../testing/runtimeTestContext.js";
import { analyzeHandwrittenFunction, type HandwrittenFunction } from "./handwrittenAssembly.js";

const I = (op: number, rt: number, rs: number, imm: number) => ((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff)) >>> 0;
const lui = (rt: number, hi: number) => I(15, rt, 0, hi);
const sw = (rt: number, offset: number, rs: number) => I(43, rt, rs, offset);
const lw = (rt: number, offset: number, rs: number) => I(35, rt, rs, offset);
const addiu = (rt: number, rs: number, imm: number) => I(9, rt, rs, imm);
const move = (rd: number, rs: number) => ((rs << 21) | (rd << 11) | 0x21) >>> 0;
const jr = (rs: number) => ((rs << 21) | 8) >>> 0;
const jal = 0x0c001000, nop = 0, rfe = 0x42000010;
const mfc0 = (rt: number, rd: number) => (0x40000000 | (rt << 16) | (rd << 11)) >>> 0;
const make = (words: number[], name = "arbitrary_name", vram = 0x80010000): HandwrittenFunction => {
  const bytes = Buffer.alloc(words.length * 4); words.forEach((w, n) => bytes.writeUInt32LE(w >>> 0, n * 4));
  return { name, container: "unrelated_owner", vram, bytes };
};
const read = (words: number[]) => analyzeHandwrittenFunction(make(words));
const has = (r: ReturnType<typeof read>, id: string) => r.signals.some(s => s.id === id);

function patch(): HandwrittenFunction {
  const fn = make([
    lui(1, 0), sw(31, 0, 1), jal, nop,
    addiu(9, 0, 0x57), addiu(10, 0, 0xb0), 0x0140f809, nop,
    lw(2, 0x16c, 2), addiu(9, 0, 11), I(8, 3, 2, 0x884), lui(1, 0), sw(3, 8, 1),
    I(8, 3, 2, 0x894), lui(1, 0), sw(3, 12, 1), sw(0, 0x594, 2), addiu(2, 2, 4), addiu(9, 9, -1),
    I(5, 0, 9, -4), nop, jal, nop, lui(31, 0), lw(31, 0, 31), nop, jr(31), nop, nop, nop,
  ], "unimportant_identifier", 0x28);
  fn.coordinate = { section: ".text", offset: 0x28, inferredSize: true };
  const references = new Map([0, 1, 11, 12, 14, 15, 23, 24].map(n => [n, { reference: "section:.bss", addend: [11, 12].includes(n) ? 8 : [14, 15].includes(n) ? 12 : 0 }]));
  fn.storageReferences = references;
  fn.relocations = new Map([...references].map(([n, ref]) => [n, { type: [0, 11, 14, 23].includes(n) ? 5 : 6, ...ref }]));
  for (const n of [2, 21]) (fn.relocations as Map<number, any>).set(n, { type: 4, reference: `import:service_${n}`, addend: 0, callee: `other_owner::service_${n}` });
  return fn;
}


/** Synthetic code-copy wrapper; no SDK names or original bytes are required. */
function embeddedPatch(options: { symbolic?: boolean; framed?: boolean; payload?: number[] } = {}) {
  const payload = options.payload ?? [sw(1, 4, 26), sw(2, 8, 26), mfc0(2, 13), sw(3, 12, 26), mfc0(3, 14), sw(31, 124, 26)];
  const prefix = options.framed ? [addiu(29, 29, -24), sw(31, 16, 29), jal, nop] : [lui(1, 0x8004), sw(31, 0, 1), jal, nop];
  const suffix = options.framed ? [lw(31, 16, 29), nop, jr(31), addiu(29, 29, 24)] : [lui(31, 0x8004), lw(31, 0, 31), nop, jr(31), nop];
  const words = [...prefix, nop, nop, nop, nop, lw(3, 0, 10), nop, sw(3, 0, 2), addiu(10, 10, 4), I(5, 9, 10, -5), addiu(2, 2, 4), ...suffix];
  const start = words.length * 4, offset = options.symbolic ? 0x120 : 0x80010000;
  const address = (reg: number, value: number) => [lui(reg, Math.floor((value + 0x8000) / 0x10000)), addiu(reg, reg, value)];
  words.splice(4, 4, ...address(10, offset + start), ...address(9, offset + start + payload.length * 4));
  const fn = make([...words, ...payload], "unrelated_copy", offset);
  if (options.symbolic) {
    fn.coordinate = { section: ".text", offset, inferredSize: false };
    const refs = new Map([4, 5, 6, 7].map(n => [n, { reference: "section:.text", addend: offset + start + (n >= 6 ? payload.length * 4 : 0) }]));
    if (!options.framed) for (const n of [0, 1, 14, 15]) refs.set(n, { reference: "section:.bss", addend: 0 });
    fn.storageReferences = refs;
    fn.relocations = new Map([...refs].map(([n, ref]) => [n, { ...ref, type: [0, 4, 6, 14].includes(n) ? 5 : 6 }]));
    (fn.relocations as Map<number, any>).set(2, { type: 4, reference: "import:opaque_service", addend: 0 });
  }
  return { fn, start };
}
const changedWord = (fn: HandwrittenFunction, n: number, word: number): HandwrittenFunction => {
  const bytes = Buffer.from(fn.bytes); bytes.writeUInt32LE(word >>> 0, n * 4); return { ...fn, bytes };
};

test("global return-state + trapping arithmetic + BIOS ABI nominate a patch-shaped original", () => {
  const row = analyzeHandwrittenFunction(patch());
  assert.equal(row.confidence.score, 98);
  assert.equal(row.confidence.level, "high");
  assert.equal(row.assemblyCandidate, true);
  assert.equal(row.analysis.complete, true);
  assert.equal(row.analysis.reachableWords, 28);
  assert.equal(row.analysis.unreachableWords, 2, "section padding is not code evidence");
  assert(has(row, "external-return-state"));
  assert(has(row, "trapping-arithmetic"));
  assert(has(row, "bios-register-transfer"));
  assert.deepEqual(row.facts.calls, [8, 24, 84]);
  assert.deepEqual(row.coordinate, { kind: "section", section: ".text", offset: 0x28, inferredSize: true });
  assert.match(row.originalSha256, /^[a-f0-9]{64}$/);
  assert.match(row.relocationSha256, /^[a-f0-9]{64}$/);
});

test("names, source-state metadata and repetitions do not manufacture confidence", () => {
  const a = patch(), b = { ...a, name: "_patch_scary_asm_kernel", sourceRepresentation: "compiled-C" as const };
  assert.deepEqual(analyzeHandwrittenFunction(a).signals, analyzeHandwrittenFunction(b).signals);
  const trapping = read([...Array.from({ length: 1000 }, () => I(8, 3, 2, 1)), jr(31), nop]);
  assert.equal(trapping.confidence.score, 20);
  assert.equal(trapping.assemblyCandidate, false);
  assert.equal(analyzeHandwrittenFunction(make([I(8, 3, 2, 1), jr(31), nop]), { threshold: 1 }).assemblyCandidate, false, "threshold cannot substitute for structural evidence");
});

test("unresolved REL fields and mismatching full storage addends cannot establish global preservation", () => {
  const fn = patch();
  const { storageReferences: _references, ...missing } = fn;
  assert(!has(analyzeHandwrittenFunction(missing), "external-return-state"));
  const refs = new Map(fn.storageReferences);
  for (const n of [23, 24]) refs.set(n, { reference: "section:.bss", addend: 0x10000 });
  const different = analyzeHandwrittenFunction({ ...fn, storageReferences: refs });
  assert(!has(different, "external-return-state"), "equal low halves do not identify equal globals");
  assert.equal(different.assemblyCandidate, false);
  assert.notEqual(different.relocationSha256, analyzeHandwrittenFunction(fn).relocationSha256);
});

test("raw absolute globals also work without ELF relocations", () => {
  const row = read([lui(1, 0x8004), sw(31, 16, 1), jal, nop, I(8, 2, 2, 1), lui(31, 0x8004), lw(31, 16, 31), nop, jr(31), nop]);
  assert(has(row, "external-return-state"));
  assert.equal(row.confidence.score, 85);
  assert.equal(row.assemblyCandidate, true);
});

test("a framed C function with a return-address diagnostic hook is not a handwritten skeleton", () => {
  const row = read([addiu(29, 29, -24), sw(31, 16, 29), lui(1, 0x8004), sw(31, 0, 1), jal, nop,
    I(8, 2, 2, 1), lw(31, 16, 29), nop, jr(31), addiu(29, 29, 24)]);
  assert(has(row, "entry-ra-capture"));
  assert(has(row, "conventional-call-frame"));
  assert(!has(row, "external-return-state"));
  assert.equal(row.assemblyCandidate, false);
  assert.equal(row.confidence.level, "low");
});

test("a stack alias through another register is not global storage", () => {
  const row = read([move(16, 29), sw(31, 0, 16), jal, nop, I(8, 2, 2, 1), lw(31, 0, 16), nop, jr(31), nop]);
  assert(!has(row, "external-return-state"));
  assert(!has(row, "entry-ra-capture"));
  assert.equal(row.assemblyCandidate, false);
});

test("a jal delay-slot capture sees the NEW link, not the original caller's ra", () => {
  const row = read([lui(16, 0x8004), jal, sw(31, 0, 16), I(8, 2, 2, 1), lw(31, 0, 16), nop, jr(31), nop]);
  assert(!has(row, "external-return-state"));
  assert(!has(row, "entry-ra-capture"));
  assert.equal(row.assemblyCandidate, false);
});

test("conditional store/restore arms do not become a fictitious dominating entry save", () => {
  const row = read([I(4, 0, 4, 3), lui(16, 0x8004), sw(31, 0, 16), nop, jal, nop,
    I(8, 2, 2, 1), lw(31, 0, 16), nop, jr(31), nop]);
  assert(!has(row, "external-return-state"));
  assert.equal(row.assemblyCandidate, false);
});

test("BIOS veneers, syscall, divide guards and GTE macros alone are not sufficient", () => {
  for (const words of [
    [addiu(9, 0, 0x57), addiu(10, 0, 0xb0), jr(10), nop],
    [0x0000000c, jr(31), nop],
    [I(5, 0, 5, 2), nop, 0x0007000d, 0x0085001a, 0x00001012, jr(31), nop],
    [0x4a280030, I(0x32, 26, 4, 0), 0x4802d000, jr(31), nop],
  ]) {
    const row = read(words);
    assert.equal(row.assemblyCandidate, false);
    assert.notEqual(row.confidence.level, "high");
    assert(!has(row, "kernel-gpr-use"), "COP2 register 26 is not GPR k0");
  }
});

test("R3000 exception return uses architectural EPC/kernel register evidence", () => {
  const kernel = read([mfc0(26, 14), nop, jr(26), rfe]);
  assert.equal(kernel.confidence.level, "high");
  assert(kernel.assemblyCandidate);
  assert(has(kernel, "exception-return"));
  const epc = read([mfc0(2, 14), nop, jr(2), rfe]);
  assert(epc.assemblyCandidate, "EPC need not be carried in a kernel GPR");
  const redefined = read([mfc0(2, 14), addiu(2, 0, 123), jr(2), rfe]);
  assert(!has(redefined, "exception-return"));
  assert(!redefined.assemblyCandidate);
  assert(!read([jr(31), rfe]).assemblyCandidate, "rfe alone is not an EPC-return fingerprint");
});

test("context save/restore requires entry s-registers, sp, ra and distinct slots", () => {
  const regs = [16, 17, 18, 19, 20, 21, 29, 31];
  const save = read([...regs.map((r, n) => sw(r, n * 4, 4)), jr(31), nop]);
  assert(has(save, "register-context-save"));
  assert(save.assemblyCandidate);
  const restore = read([...regs.map((r, n) => lw(r, n * 4, 4)), nop, jr(31), nop]);
  assert(has(restore, "register-context-restore"));
  assert(restore.assemblyCandidate);
  const ordinary = read([...regs.filter(r => r < 29).map(r => addiu(r, 0, 1)), ...regs.map((r, n) => sw(r, n * 4, 4)), jr(31), nop]);
  assert(!has(ordinary, "register-context-save"));
  const overlapping = read([...regs.map(r => sw(r, 0, 4)), jr(31), nop]);
  assert(!has(overlapping, "register-context-save"));
});

test("unreachable data and padding never contribute architectural fingerprints", () => {
  const row = read([jr(31), nop, mfc0(26, 14), jr(26), rfe, 0xffffffff, I(8, 2, 2, 1)]);
  assert.equal(row.confidence.score, 0);
  assert.equal(row.analysis.reachableWords, 2);
  assert.equal(row.analysis.unreachableWords, 5);
  assert.equal(row.analysis.complete, true);
});

test("unknown effects, missing slots, out-of-bound branches and indirect dispatch block nomination", () => {
  const base = patch();
  const opaque = { ...base, bytes: Buffer.from(base.bytes) }; opaque.bytes.writeUInt32LE(0xffffffff, 9 * 4);
  const row = analyzeHandwrittenFunction(opaque, { threshold: 1 });
  assert.equal(row.analysis.complete, false);
  assert.notEqual(row.confidence.level, "high");
  assert.equal(row.assemblyCandidate, false);
  const truncated = analyzeHandwrittenFunction({ ...base, bytes: base.bytes.subarray(0, 27 * 4) });
  assert.equal(truncated.analysis.complete, false);
  assert.match(truncated.analysis.limitations.join(" "), /Missing transfer delay slot/);
  assert.equal(truncated.assemblyCandidate, false);
  for (const words of [[I(4, 0, 4, 100), nop, jr(31), nop], [lw(8, 0, 4), jr(8), nop]]) {
    const r = read(words); assert.equal(r.analysis.complete, false); assert.equal(r.assemblyCandidate, false);
  }
});

test("a higher threshold changes eligibility without changing evidence or claiming a probability", () => {
  const original = analyzeHandwrittenFunction(patch()), raised = analyzeHandwrittenFunction(patch(), { threshold: 99 });
  assert.equal(raised.confidence.score, original.confidence.score);
  assert.equal(raised.confidence.scale, "heuristic-not-probability");
  assert.deepEqual(raised.signals, original.signals);
  assert.equal(raised.assemblyCandidate, false);
  for (const threshold of [0, 101, -1, 1.5, NaN]) assert.throws(() => analyzeHandwrittenFunction(patch(), { threshold }), /threshold/);
});

test("copied kernel-context fragments are explicit payload evidence, not new execution roots", () => {
  const { fn, start } = embeddedPatch(), row = analyzeHandwrittenFunction(fn);
  assert.equal(row.confidence.score, 85);
  assert.equal(row.assemblyCandidate, true);
  assert(has(row, "embedded-kernel-context-copy"));
  assert(!has(row, "kernel-gpr-use")); assert(!has(row, "privileged-operations"));
  assert.equal(row.analysis.reachableWords, start / 4);
  assert.equal(row.analysis.unreachableWords, 6);
  const copy = row.embeddedCopies[0]!;
  assert.deepEqual(copy.source, { offset: start, size: 24 });
  assert.deepEqual(copy.loop, { load: 32, store: 40, latch: 48, iterations: 6 });
  assert.equal(copy.interpretation, "kernel-context-fragment");
  assert(copy.evidence.every(e => e.role === "copied-payload" && e.offset >= start));
  assert(row.signals.find(s => s.id === "embedded-kernel-context-copy")!.evidence.some(e => e.role === "copied-payload"));
  assert.deepEqual(analyzeHandwrittenFunction({ ...fn, name: "ordinary_array_copy" }).signals, row.signals);
});

test("ELF code-copy sources use full section addends and nonzero function origins", () => {
  const { fn, start } = embeddedPatch({ symbolic: true }), row = analyzeHandwrittenFunction(fn);
  assert.equal(row.confidence.score, 85);
  assert.equal(row.embeddedCopies[0]!.source.offset, start);
  assert.equal(row.embeddedCopies[0]!.interpretation, "kernel-context-fragment");
  const { storageReferences: _references, ...missing } = fn;
  assert.equal(analyzeHandwrittenFunction(missing).embeddedCopies.length, 0);
  const refs = new Map(fn.storageReferences);
  refs.set(7, { reference: "section:.other", addend: 0x120 + start + 24 });
  assert.equal(analyzeHandwrittenFunction({ ...fn, storageReferences: refs }).embeddedCopies.length, 0);
  const rels = new Map(fn.relocations);
  rels.set(start / 4 + 4, { type: 2, reference: "import:not_literal_code", addend: 0 });
  const relocated = analyzeHandwrittenFunction({ ...fn, relocations: rels });
  assert.equal(relocated.embeddedCopies[0]!.interpretation, "unclassified-bytes");
  assert(!has(relocated, "embedded-kernel-context-copy"));
});

test("ordinary embedded data, GTE words and incomplete context fragments do not gain patch evidence", () => {
  for (const payload of [
    [1, 2, 3, 4, 5, 6],
    [0x4a280030, 0x4802d000, 0x48c2d000, nop, nop, nop],
    [sw(1, 4, 26), sw(2, 8, 26), sw(31, 124, 26), nop, nop, nop],
    [sw(1, 4, 4), sw(2, 8, 4), sw(31, 124, 4), mfc0(3, 14), nop, nop],
    [sw(1, 4, 26), sw(2, 8, 26), sw(3, 12, 26), mfc0(3, 14), nop, nop],
    [sw(1, 4, 26), sw(2, 4, 26), sw(31, 124, 26), mfc0(3, 14), nop, nop], // overlapping slots
    [sw(1, 4, 26), sw(2, 8, 27), sw(31, 124, 26), mfc0(3, 14), nop, nop], // different contexts
    [sw(1, 4, 26), sw(2, 8, 26), sw(31, 124, 26), mfc0(26, 14), nop, nop], // context base clobber
    [mfc0(1, 14), sw(1, 4, 26), sw(2, 8, 26), sw(31, 124, 26), nop, nop], // saved value clobber
  ]) {
    const row = analyzeHandwrittenFunction(embeddedPatch({ payload }).fn);
    assert.equal(row.embeddedCopies[0]!.interpretation, "unclassified-bytes");
    assert(!has(row, "embedded-kernel-context-copy"));
    assert.equal(row.confidence.score, 65); assert.equal(row.assemblyCandidate, false);
  }
});

test("a conventional C wrapper copying the same code bytes is not a handwritten skeleton", () => {
  const row = analyzeHandwrittenFunction(embeddedPatch({ framed: true }).fn, { threshold: 1 });
  assert(has(row, "embedded-kernel-context-copy"));
  assert(has(row, "conventional-call-frame"));
  assert.equal(row.confidence.level, "low"); assert.equal(row.assemblyCandidate, false);
});

test("copy evidence needs exact bounded forwarding, a single entry, and MIPS-I load spacing", () => {
  const { fn, start } = embeddedPatch();
  for (const [n, word] of [
    [9, addiu(3, 0, 42)], // loaded word is overwritten before its store
    [10, sw(4, 0, 2)], // a different value is stored
    [11, addiu(10, 10, 8)], // source stride is not one word
    [13, addiu(2, 2, 8)], // destination stride differs
    [9, addiu(9, 9, 4)], // bound changes inside the loop
    [0, I(4, 0, 4, 9)], // second entry jumps into the middle of the body
    [5, addiu(10, 10, 0x4d)], // misaligned source
    [7, addiu(9, 9, 0x1000)], // out-of-bounds limit
  ] as const) assert.equal(analyzeHandwrittenFunction(changedWord(fn, n, word)).embeddedCopies.length, 0, `word ${n}`);
  // A load immediately followed by its dependent store forwards the OLD
  // register on MIPS I, not the claimed payload word.
  let tooSoon = changedWord(fn, 9, sw(3, 0, 2)); tooSoon = changedWord(tooSoon, 10, nop);
  assert.equal(analyzeHandwrittenFunction(tooSoon).embeddedCopies.length, 0);
  const leaf = make([jr(31), nop, ...Array.from({ length: 6 }, (_, n) => fn.bytes.readUInt32LE(start + n * 4))]);
  assert.equal(analyzeHandwrittenFunction(leaf).confidence.score, 0, "unreferenced instruction-shaped data stays irrelevant");
});

test("word copies also recognize destination preincrement with a delay-slot store", () => {
  let fn = embeddedPatch().fn;
  fn = changedWord(fn, 9, addiu(2, 2, 4));
  fn = changedWord(fn, 10, nop);
  fn = changedWord(fn, 13, sw(3, -4, 2));
  const row = analyzeHandwrittenFunction(fn);
  assert(has(row, "embedded-kernel-context-copy"));
  assert.equal(row.embeddedCopies[0]!.loop.store, 52);
});

test("BIOS selector setup in the delay slot counts, but late target setup does not", () => {
  const slotSelector = read([addiu(10, 0, 0xb0), jr(10), addiu(9, 0, 0x56)]);
  assert(has(slotSelector, "bios-register-transfer"));
  assert.equal(slotSelector.assemblyCandidate, false, "a macro-compatible veneer remains supporting-only");
  assert.deepEqual(slotSelector.signals[0]!.evidence.map(e => e.offset), [4, 8]);
  const lateTarget = read([addiu(9, 0, 0x56), addiu(10, 0, 123), jr(10), addiu(10, 0, 0xb0)]);
  assert(!has(lateTarget, "bios-register-transfer"));
  const overwritten = read([addiu(9, 0, 0x56), addiu(10, 0, 0xb0), jr(10), move(9, 4)]);
  assert(!has(overwritten, "bios-register-transfer"));
});

test("malformed extents return undetermined rather than reading arbitrary bytes", () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(3)]) {
    const row = analyzeHandwrittenFunction({ ...make([jr(31), nop]), bytes });
    assert.equal(row.confidence.level, "undetermined"); assert.equal(row.assemblyCandidate, false);
  }
  const row = analyzeHandwrittenFunction(make([jr(31), nop], "name", 3));
  assert.equal(row.confidence.level, "undetermined");
});
