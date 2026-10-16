import assert from "node:assert/strict";
import { test } from "../testing/runtimeTestContext.js";
import { analyzeHandwrittenFunction, analyzeHandwrittenModule, type HandwrittenFunction } from "./handwrittenAssembly.js";

const I = (op: number, rt: number, rs: number, imm: number) => ((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff)) >>> 0;
const lui = (r: number, hi: number) => I(15, r, 0, hi);
const addiu = (rt: number, rs: number, n: number) => I(9, rt, rs, n);
const lw = (r: number, n: number, base: number) => I(35, r, base, n);
const sw = (r: number, n: number, base: number) => I(43, r, base, n);
const jr = (r: number) => ((r << 21) | 8) >>> 0;
const address = (r: number, value: number) => [lui(r, Math.floor((value + 0x8000) / 0x10000)), addiu(r, r, value)];
const make = (name: string, vram: number, words: number[]): HandwrittenFunction => {
  const bytes = Buffer.alloc(words.length * 4); words.forEach((word, n) => bytes.writeUInt32LE(word >>> 0, n * 4));
  return { name, container: "independent_module", vram, bytes };
};
const changed = (fn: HandwrittenFunction, n: number, word: number) => {
  const bytes = Buffer.from(fn.bytes); bytes.writeUInt32LE(word >>> 0, n * 4); return { ...fn, bytes };
};

/** Independent fixtures: the ordinary entry of the holder returns immediately.
 * Only an explicitly addressed template points to its interior exception path. */
function fixture(options: { bytes?: number; framed?: boolean; target?: number } = {}) {
  const bytes = options.bytes ?? 12, holderAddress = 0x80013000, target = options.target ?? holderAddress + 32;
  const prefix = options.framed ? [addiu(29, 29, -24), sw(31, 16, 29)] : [lui(1, 0x8004), sw(31, 4, 1)];
  const suffix = options.framed ? [lw(31, 16, 29), 0, jr(31), addiu(29, 29, 24)] : [lui(31, 0x8004), lw(31, 4, 31), 0, jr(31), 0];
  const setup = [...prefix, 0x0c001000, 0, ...address(10, holderAddress + 8), ...address(9, holderAddress + 8 + bytes)];
  const installer = make("install_words", 0x80010000, [...setup,
    lw(3, 0, 10), 0, sw(3, 0, 4), addiu(10, 10, 4), I(5, 9, 10, -5), addiu(4, 4, 4), 0x0c001000, 0, ...suffix]);
  const holder = make("clear_counter", holderAddress, [jr(31), 0, ...address(2, target), 0x0040f809, 0, 0, 0,
    0x401a7000, 0, jr(26), 0x42000010]);
  return { installer, holder, functions: [installer, holder], load: setup.length };
}
function deployed(target = 0xa000df8c, destination = 0xdf80) {
  const f = fixture({ target, bytes: 20 });
  const payload = make("word_source", 0x80015000, [jr(31), 0, 0, addiu(2, 0, 42), jr(31), 0]);
  const deployer = make("copy_words", 0x80014000, [...address(10, payload.vram), ...address(9, payload.vram + payload.bytes.length),
    ...address(2, destination), lw(3, 0, 10), 0, sw(3, 0, 2), addiu(10, 10, 4), I(5, 9, 10, -5), addiu(2, 2, 4), jr(31), 0]);
  return { ...f, payload, deployer, functions: [...f.functions, payload, deployer] };
}
const none = (functions: HandwrittenFunction[]) => assert(analyzeHandwrittenModule(functions).every(r => !r.copiedTransfers.length));

test("a copied 12-byte transfer prefix witnesses an interior handler, not execution at its ordinary entry", () => {
  const f = fixture(), alone = analyzeHandwrittenFunction(f.installer), rows = analyzeHandwrittenModule(f.functions);
  assert.equal(alone.confidence.score, 65); assert.equal(rows[0]!.confidence.score, 85); assert(rows[0]!.assemblyCandidate);
  const transfer = rows[0]!.copiedTransfers[0]!;
  assert.equal(transfer.template.offset, 8); assert.equal(transfer.template.copiedBytes, 12);
  assert.equal(transfer.template.templateBytes, 16); assert.equal(transfer.template.delaySlotCopied, false);
  assert.deepEqual(transfer.template.evidence.map(e => e.role), ["copied-payload", "copied-payload", "copied-payload", undefined]);
  assert.equal(transfer.target.kind, "local-entry");
  if (transfer.target.kind === "local-entry") {
    assert.equal(transfer.target.offset, 32); assert.equal(transfer.target.reachableWords, 4);
    assert.deepEqual(transfer.target.exceptionReturns, [40]);
  }
  assert.equal(rows[1]!.confidence.score, 0); assert.equal(rows[1]!.analysis.reachableWords, 2);
  assert(!rows[1]!.signals.some(s => s.id === "exception-return"), "interior opcodes do not inflate the ordinary entry score");
  assert.equal(transfer.witnesses.length, 2);
  assert(transfer.witnesses.every(w => /^[a-f0-9]{64}$/.test(w.originalSha256) && /^[a-f0-9]{64}$/.test(w.relocationSha256)));
  assert.deepEqual(analyzeHandwrittenModule(f.functions.map(fn => ({ ...fn, name: `plain_${fn.name}` }))).map(r => r.confidence.score), [85, 0]);
});

test("16/20-byte installs explicitly include the nop slot; padded JR transfers are also recognized", () => {
  for (const bytes of [16, 20]) {
    const f = fixture({ bytes }), holder = changed(f.holder, 4, jr(2));
    const row = analyzeHandwrittenModule([f.installer, holder])[0]!;
    assert.equal(row.copiedTransfers[0]!.template.delaySlotCopied, true);
    assert.equal(row.copiedTransfers[0]!.template.copiedBytes, bytes);
    assert.equal(row.confidence.score, 85);
  }
});

test("a fixed transfer resolves only through independently bounded RAM deployment, including PSX aliases", () => {
  for (const target of [0xdf8c, 0x8000df8c, 0xa000df8c]) {
    const f = deployed(target), rows = analyzeHandwrittenModule(f.functions), transfer = rows[0]!.copiedTransfers[0]!;
    assert.equal(rows[0]!.confidence.score, 85); assert.equal(transfer.target.kind, "deployed-entry");
    if (transfer.target.kind === "deployed-entry") {
      assert.equal(transfer.target.function, f.payload.name); assert.equal(transfer.target.offset, 12);
      assert.equal(transfer.target.address, target); assert.equal(transfer.target.physicalAddress, 0xdf8c);
      assert.equal(transfer.target.deployment.entryOffset, 12); assert.equal(transfer.target.deployment.copy.bytes, 24);
    }
    assert.equal(transfer.witnesses.length, 4);
    assert(rows.slice(1).every(r => r.confidence.score === 0 && !r.assemblyCandidate));
  }
  const aliasedDestination = deployed(0xa000df8c, 0x8000df80);
  assert.equal(analyzeHandwrittenModule(aliasedDestination.functions)[0]!.copiedTransfers.length, 1);
});

test("a magic RAM address, ambiguous deployment, non-RAM alias, misalignment or out-of-range entry is not proof", () => {
  const f = deployed();
  none(f.functions.filter(fn => fn !== f.deployer));
  none([...f.functions, { ...f.deployer, name: "another_deployment", vram: 0x80016000 }]);
  for (const address of [0xa000df98, 0xa000df7c, 0xa000df81, 0xc000df8c, 0xbf80df8c, 0xa020df8c]) none(deployed(address).functions);
  none(f.functions.map(fn => fn === f.payload ? changed(fn, 0, 0xffffffff) : fn));
  none(f.functions.filter(fn => fn !== f.payload));
});

test("unreferenced templates, wrong register flow, non-nop tails and incomplete interior paths fail closed", () => {
  const f = fixture();
  none([f.holder]);
  for (const [n, word] of [[3, addiu(2, 3, 32)], [4, jr(3)], [5, addiu(4, 4, 1)], [8, 0xffffffff], [11, 0]] as const)
    none([f.installer, changed(f.holder, n, word)]);
  none([f.installer, { ...f.holder, bytes: f.holder.bytes.subarray(0, 5 * 4) }]);
  const outside = fixture({ target: f.holder.vram + f.holder.bytes.length }); none(outside.functions);
  const padded = fixture({ bytes: 20 }); none([padded.installer, changed(padded.holder, 6, addiu(4, 4, 1))]);
});

test("unresolved relocations cannot turn raw immediate fields into a local or deployed address", () => {
  const f = fixture();
  const holder = { ...f.holder, relocations: new Map([[2, { type: 5, reference: "import:handler", addend: 0 }], [3, { type: 6, reference: "import:handler", addend: 0 }]]) };
  none([f.installer, holder]);
  none([f.installer, { ...holder, storageReferences: new Map([[2, { reference: "section:.text", addend: 32 }], [3, { reference: "section:.data", addend: 32 }]]) }]);
});

test("ordinary C call frames and incomplete installer analysis cannot be promoted by code copying", () => {
  const framed = fixture({ framed: true }), row = analyzeHandwrittenModule(framed.functions, { threshold: 1 })[0]!;
  assert.equal(row.copiedTransfers.length, 1); assert.equal(row.confidence.score, 5); assert(!row.assemblyCandidate);
  const f = fixture(), incomplete = changed(f.installer, 2, 0xffffffff);
  const bad = analyzeHandwrittenModule([incomplete, f.holder])[0]!;
  assert.equal(bad.copiedTransfers.length, 1); assert.equal(bad.analysis.complete, false); assert(!bad.assemblyCandidate);
});

test("transfer evidence requires the original copy's forwarding, extent and load spacing", () => {
  const f = fixture();
  none([changed(f.installer, f.load + 1, addiu(3, 0, 123)), f.holder]);
  const tooSoon = changed(changed(f.installer, f.load + 1, sw(3, 0, 4)), f.load + 2, 0);
  none([tooSoon, f.holder]);
  none([changed(f.installer, 7, addiu(9, 9, 0x300c)), f.holder]); // copies only 4, not 12 bytes
  assert.throws(() => analyzeHandwrittenModule([f.installer, { ...f.holder, container: "unrelated" }]), /same original module/);
});
