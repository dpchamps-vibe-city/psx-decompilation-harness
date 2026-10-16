import assert from "node:assert/strict";
import { test } from "../testing/runtimeTestContext.js";
import { analyzeHandwrittenFunction, analyzeHandwrittenModule, type HandwrittenFunction } from "./handwrittenAssembly.js";

const I = (op: number, rt: number, rs: number, imm: number) => ((op << 26) | (rs << 21) | (rt << 16) | (imm & 0xffff)) >>> 0;
const lui = (r: number, hi: number) => I(15, r, 0, hi);
const addiu = (rt: number, rs: number, n: number) => I(9, rt, rs, n);
const lw = (r: number, n: number, base: number) => I(35, r, base, n);
const sw = (r: number, n: number, base: number) => I(43, r, base, n);
const jr = (r: number) => ((r << 21) | 8) >>> 0;
const jal = 0x0c001000;
const address = (r: number, value: number) => [lui(r, Math.floor((value + 0x8000) / 0x10000)), addiu(r, r, value)];
const make = (name: string, vram: number, words: number[]): HandwrittenFunction => {
  const bytes = Buffer.alloc(words.length * 4); words.forEach((word, n) => bytes.writeUInt32LE(word >>> 0, n * 4));
  return { name, container: "original_owner", vram, bytes };
};
const changed = (fn: HandwrittenFunction, n: number, word: number) => {
  const bytes = Buffer.from(fn.bytes); bytes.writeUInt32LE(word >>> 0, n * 4); return { ...fn, bytes };
};

/** Independent synthetic fixture: no Psy-Q symbols, disassembler annotations
 * or target bytes. Its executable buffer starts as four nop placeholders. */
function hookFixture(framed = false) {
  const bufferAddress = 0x80014000, trampolineAddress = 0x80012000, targetAddress = 0x80013000;
  const prefix = () => framed ? [addiu(29, 29, -24), sw(31, 16, 29)] : [lui(1, 0x8004), sw(31, 4, 1)];
  const suffix = () => framed ? [lw(31, 16, 29), 0, jr(31), addiu(29, 29, 24)] : [lui(31, 0x8004), lw(31, 4, 31), 0, jr(31), 0];
  const external = () => [lui(2, 0x8004), lw(2, 0, 2), 0];
  const install = prefix();
  install.push(...external(), ...address(10, bufferAddress), ...address(9, bufferAddress + 12));
  const saveLoad = install.length;
  // Save is bounded by the DESTINATION, with its source increment in the slot.
  install.push(lw(3, 0, 2), 0, sw(3, 0, 10), addiu(10, 10, 4), I(5, 9, 10, -5), addiu(2, 2, 4));
  const installSetup = install.length;
  install.push(...external(), ...address(10, trampolineAddress), ...address(9, trampolineAddress + 16));
  const installLoad = install.length;
  install.push(lw(3, 0, 10), 0, sw(3, 0, 2), addiu(10, 10, 4), I(5, 9, 10, -5), addiu(2, 2, 4), jal, 0, ...suffix());
  const stop = [...prefix(), ...external()];
  const restoreSource = stop.length;
  stop.push(...address(10, bufferAddress), ...address(9, bufferAddress + 12));
  const restoreLoad = stop.length;
  stop.push(lw(3, 0, 10), 0, sw(3, 0, 2), addiu(10, 10, 4), I(5, 9, 10, -5), addiu(2, 2, 4), jal, 0, ...suffix());
  const installer = make("install_operation", 0x80010000, install), restorer = make("restore_operation", 0x80011000, stop);
  const trampoline = make("call_template", trampolineAddress, [...address(2, targetAddress), 0x0040f809, 0]);
  const target = make("callback_entry", targetAddress, [jr(31), 0]);
  const buffer = make("runtime_text_buffer", bufferAddress, [0, 0, 0, 0, jr(31), 0]);
  return { functions: [installer, restorer, trampoline, target, buffer], installer, restorer, trampoline, target, buffer,
    saveLoad, installSetup, installLoad, restoreLoad, restoreSource };
}
const withReplacement = (f: ReturnType<typeof hookFixture>, old: HandwrittenFunction, replacement: HandwrittenFunction) =>
  f.functions.map(fn => fn === old ? replacement : fn);
const noHook = (functions: HandwrittenFunction[]) => assert(analyzeHandwrittenModule(functions).every(r => r.codeHooks.length === 0));

test("module save/install/restore relation promotes only the participating frameless functions", () => {
  const f = hookFixture();
  assert.equal(analyzeHandwrittenFunction(f.restorer).confidence.score, 65, "one function alone does not carry the lifecycle witness");
  const rows = analyzeHandwrittenModule(f.functions);
  for (const row of rows.slice(0, 2)) {
    assert.equal(row.confidence.score, 85); assert(row.assemblyCandidate);
    assert.equal(row.codeHooks.length, 1);
    const hook = row.codeHooks[0]!;
    assert.equal(hook.save.bytes, 12); assert.equal(hook.install.bytes, 16); assert.equal(hook.restore.bytes, 12);
    assert.equal(hook.trampoline.target, "callback_entry");
    assert.equal(hook.witnesses.length, 5);
    assert(hook.witnesses.every(w => /^[a-f0-9]{64}$/.test(w.originalSha256) && /^[a-f0-9]{64}$/.test(w.relocationSha256)));
  }
  assert.equal(rows[0]!.codeHooks[0]!.role, "installer"); assert.equal(rows[1]!.codeHooks[0]!.role, "restorer");
  assert.equal(rows[0]!.copiedTransfers.length, 1);
  assert.equal(rows[0]!.signals.filter(s => s.family === "code-patching").reduce((n, s) => n + s.weight, 0), 40);
  assert.equal(rows[0]!.confidence.score, 85, "alternative patching witnesses share one +20 contribution");
  assert(rows.slice(2).every(row => row.confidence.score === 0 && !row.assemblyCandidate), "origin confidence is not inherited by buffers, templates or callees");
  const renamed = analyzeHandwrittenModule(f.functions.map(fn => ({ ...fn, name: `ordinary_C_${fn.name}` })));
  assert.deepEqual(renamed.map(r => r.confidence.score), rows.map(r => r.confidence.score));
});

test("a conventional compiled-C calling skeleton can manipulate code without becoming handwritten", () => {
  const rows = analyzeHandwrittenModule(hookFixture(true).functions, { threshold: 1 });
  assert(rows.slice(0, 2).every(r => r.codeHooks.length === 1 && r.confidence.level === "low" && !r.assemblyCandidate));
});

test("counterfactuals require matching buffers, cached destination identities and exact save/restore extents", () => {
  const f = hookFixture();
  noHook(withReplacement(f, f.restorer, changed(f.restorer, f.restoreSource + 1, addiu(10, 10, 0x4010))));
  noHook(withReplacement(f, f.restorer, changed(f.restorer, 3, lw(2, 4, 2))));
  noHook(withReplacement(f, f.installer, changed(f.installer, f.installSetup + 1, lw(2, 4, 2))));
  noHook(withReplacement(f, f.restorer, changed(f.restorer, f.restoreSource + 3, addiu(9, 9, 0x4010))));
  noHook(f.functions.filter(fn => fn !== f.installer));
  noHook(f.functions.filter(fn => fn !== f.restorer));
  noHook(f.functions.filter(fn => fn !== f.buffer));
});

test("equal stack or argument-relative slots in different functions are not a shared cached pointer", () => {
  const f = hookFixture();
  for (const base of [29, 4]) {
    let installer = changed(f.installer, 2, lw(2, 16, base)); installer = changed(installer, 3, 0);
    installer = changed(installer, f.installSetup, lw(2, 16, base)); installer = changed(installer, f.installSetup + 1, 0);
    let restorer = changed(f.restorer, 2, lw(2, 16, base)); restorer = changed(restorer, 3, 0);
    noHook(f.functions.map(fn => fn === f.installer ? installer : fn === f.restorer ? restorer : fn));
  }
});

test("ordinary word arrays, unrelated callbacks and unresolved trampoline relocations cannot establish a hook", () => {
  const f = hookFixture();
  noHook(withReplacement(f, f.trampoline, changed(f.trampoline, 2, jr(2))));
  noHook(withReplacement(f, f.trampoline, changed(f.trampoline, 3, addiu(2, 2, 1))));
  noHook(withReplacement(f, f.trampoline, changed(f.trampoline, 1, addiu(2, 2, 0x3010)))); // not a known entry
  noHook(withReplacement(f, f.buffer, changed(f.buffer, 0, 123)));
  const unresolved = { ...f.trampoline, relocations: new Map([[0, { type: 5, reference: "import:callback", addend: 0 }], [1, { type: 6, reference: "import:callback", addend: 0 }]]) };
  noHook(withReplacement(f, f.trampoline, unresolved));
});

test("the save must dominate installation; mere textual ordering is not lifecycle evidence", () => {
  const f = hookFixture();
  // This new path jumps directly to setup for installation, bypassing the save.
  noHook(withReplacement(f, f.installer, changed(f.installer, 0, I(4, 0, 4, f.installSetup - 1))));
});

test("word-copy clobbers and MIPS-I dependent-load hazards destroy lifecycle evidence", () => {
  const f = hookFixture();
  noHook(withReplacement(f, f.installer, changed(f.installer, f.saveLoad + 1, addiu(3, 0, 42))));
  let tooSoon = changed(f.restorer, f.restoreLoad + 1, sw(3, 0, 2)); tooSoon = changed(tooSoon, f.restoreLoad + 2, 0);
  noHook(withReplacement(f, f.restorer, tooSoon));
});

test("module boundaries and advisory thresholds cannot be bypassed by shared addresses", () => {
  const f = hookFixture();
  assert.throws(() => analyzeHandwrittenModule(f.functions.map((fn, n) => n === 1 ? { ...fn, container: "another_owner" } : fn)), /same original module/);
  const rows = analyzeHandwrittenModule(f.functions, { threshold: 90 });
  assert.equal(rows[1]!.confidence.score, 85); assert.equal(rows[1]!.assemblyCandidate, false);
});

test("adding to a loaded pointer is not a load from the next global slot", () => {
  const fn = make("not_a_return_restore", 0x80010000, [lui(1, 0x8004), sw(31, 4, 1), jal, 0,
    lui(31, 0x8004), lw(31, 0, 31), 0, addiu(31, 31, 4), jr(31), 0]);
  const row = analyzeHandwrittenFunction(fn);
  assert(!row.signals.some(s => s.id === "external-return-state"));
  assert.equal(row.assemblyCandidate, false);
});
