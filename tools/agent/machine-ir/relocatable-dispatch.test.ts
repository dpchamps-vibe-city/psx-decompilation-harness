import { test } from "../../testing/runtimeTestContext.js";
import assert from "node:assert/strict";
import type { RelocatableObject, ObjectRelocation } from "../../lib/relocatableObject.js";
import type { Elf32Section } from "../../lib/elfSections.js";
import { assemble } from "../matching-reconstruction/fixture-asm.js";
import { decodeFunction } from "../matching-reconstruction/decode.js";
import { recoverRelocatableDispatches } from "./relocatable-dispatch.js";
import { buildMachineIrFrom } from "./index.js";

function fixture(start = 0x100, native = false, scaleInSlot = true) {
  const words = assemble([
    ["slti", "t0", "a0", 3], ["beq", "t0", "zero", "default"],
    ...(!scaleInSlot ? [["nop"] as [string]] : []), ["sll", "v0", "a0", 2],
    ["lui", "at", 0], ["addu", "at", "at", "v0"], ["lw", "v0", 0, "at"], ["nop"], ["jr", "v0"], ["nop"],
    ["addiu", "v0", "zero", 11], ["addiu", "v0", "zero", 22], ["jr", "ra"], ["nop"],
    ["label", "default"], ["addiu", "v0", "zero", 33], ["jr", "ra"], ["nop"],
  ], start);
  words[0]!.raw = ((words[0]!.raw & 0x03ffffff) | (0x0b << 26)) >>> 0; // sltiu
  const insns = decodeFunction(words), data = Buffer.alloc(16);
  const bias = scaleInSlot ? 0 : 4;
  const targets = [start + 9 * 4 + bias, start + 10 * 4 + bias, start + 13 * 4 + bias, start];
  targets.forEach((target, i) => data.writeUInt32LE(native ? 0 : target, i * 4));
  const section = (index: number, flags: number, data: Buffer): Elf32Section =>
    ({ index, type: 1, flags, alignment: 4, offset: 0, size: data.length, link: 0, info: 0, entsize: 0, data });
  const relocations: ObjectRelocation[] = [
    { section: ".text", offset: start + 12 + bias, type: 5, reference: ".rodata@0", ...(native ? { addend: 0 } : {}) },
    { section: ".text", offset: start + 20 + bias, type: 6, reference: ".rodata@0", ...(native ? { addend: 0 } : {}) },
    ...targets.map((target, i) => ({ section: ".rodata", offset: i * 4, type: 2, reference: ".text@0", ...(native ? { addend: target } : {}) })),
  ];
  const code = Buffer.alloc(start + words.length * 4);
  words.forEach(word => code.writeUInt32LE(word.raw, word.vram));
  const object: RelocatableObject = { flags: 0, symbols: [], relocations, sections: new Map([
    [".text", section(1, 6, code)], [".rodata", section(2, 2, data)],
  ]) };
  return { object, insns, targets };
}

test("relocated bounded switches recover exact section targets, not the adjacent table", () => {
  for (const native of [false, true]) {
    const f = fixture(0x100, native), rows = recoverRelocatableDispatches(f.object, ".text", f.insns);
    assert.deepEqual(rows, [{ instructionIndex: 7, table: { section: ".rodata", offset: 0 }, targets: f.targets.slice(0, 3) }]);
    const ir = buildMachineIrFrom("switch", f.insns, { resolveDispatch: index => rows.find(r => r.instructionIndex === index)?.targets });
    const dispatch = ir.ir.cfg.blocks.find(b => b.terminator === "dispatch")!;
    assert.equal(dispatch.successors.length, 3);
    assert.deepEqual(dispatch.successors.map(i => ir.ir.cfg.blocks[i]!.vram), f.targets.slice(0, 3));
    assert.ok(ir.ir.cfg.blocks.some(b => b.vram === f.targets[1]), "a table target in a straight-line block becomes a leader");
    assert.equal(ir.unmodelled.length, 0);
  }
});

test("HI16/LO16 carry and named section symbols retain real table coordinates", () => {
  for (const native of [false, true]) {
    const f = fixture(0x100, native), storage = f.object.sections.get(".rodata")!;
    const table = Buffer.alloc(0x9000 + storage.data.length); storage.data.copy(table, 0x9000);
    storage.data = table; storage.size = table.length;
    for (const row of f.object.relocations.filter(r => r.section === ".rodata")) row.offset += 0x9000;
    const code = f.object.sections.get(".text")!.data;
    code.writeUInt32LE(0x3c010001, 0x100 + 12);
    code.writeUInt32LE(0x8c229000, 0x100 + 20);
    if (native) { f.object.relocations[0]!.addend = 0x9000; f.object.relocations[1]!.addend = -0x7000; }
    assert.equal(recoverRelocatableDispatches(f.object, ".text", f.insns)[0]?.table.offset, 0x9000);
  }
  const f = fixture();
  f.object.symbols.push({ name: "table", value: 0, size: 12, binding: 1, type: 1, visibility: 0, section: ".rodata" });
  f.object.relocations[0]!.reference = f.object.relocations[1]!.reference = "named:table";
  assert.equal(recoverRelocatableDispatches(f.object, ".text", f.insns).length, 1);
});

test("the scale can follow an unrelated guard delay slot", () => {
  const f = fixture(0x100, false, false);
  const rows = recoverRelocatableDispatches(f.object, ".text", f.insns);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.targets, f.targets.slice(0, 3));
  f.insns[2]!.op = "addiu"; f.insns[2]!.rt = 4; // slot clobbers the tested index
  assert.deepEqual(recoverRelocatableDispatches(f.object, ".text", f.insns), []);
});

test("incomplete tables, cross-section targets, imports and mutable storage stay unresolved", () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.object.relocations.pop(); f.object.relocations.pop(); },
    (f: ReturnType<typeof fixture>) => { f.object.relocations[2]!.reference = "import:callback"; },
    (f: ReturnType<typeof fixture>) => { f.object.relocations[2]!.reference = ".rodata@0"; },
    (f: ReturnType<typeof fixture>) => { f.object.relocations[2]!.addend = null; },
    (f: ReturnType<typeof fixture>) => { f.object.sections.get(".rodata")!.flags |= 1; },
    (f: ReturnType<typeof fixture>) => { f.insns[2]!.rt = 5; },
    (f: ReturnType<typeof fixture>) => { f.insns[0]!.rs = f.insns[2]!.rt = 8; },
    (f: ReturnType<typeof fixture>) => { f.insns[4]!.rd = 8; },
    (f: ReturnType<typeof fixture>) => { f.object.relocations[0]!.reference = "import:other"; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    assert.deepEqual(recoverRelocatableDispatches(f.object, ".text", f.insns), []);
  }
});

test("bad dispatch targets cannot manufacture CFG edges into delay slots or outside the function", () => {
  const f = fixture();
  for (const target of [f.insns[1]!.vram + 4, f.insns[0]!.vram - 4]) {
    const ir = buildMachineIrFrom("bad-target", f.insns, { resolveDispatch: () => [f.targets[0]!, target] });
    assert.ok(ir.ir.cfg.blocks.some(b => b.terminator === "indirect"));
    assert.ok(!ir.ir.cfg.blocks.some(b => b.terminator === "dispatch"));
  }
});

test("an unresolved jr is explicit in CFG, SSA and diagnostics, never a return", () => {
  const f = fixture(), ir = buildMachineIrFrom("unresolved", f.insns);
  const block = ir.ir.cfg.blocks.find(b => b.terminator === "indirect")!;
  assert.ok(block);
  assert.equal(ir.ir.blockExit[block.index]!.kind, "indirect");
  assert.ok(ir.regions.notes.some(n => n.includes("unresolved indirect jump")));
  assert.ok(ir.unmodelled.some(n => n.op === "jr"));
});
